import type { ArchivePort, PendingArchiveEffect } from "./archive.js";
import { InvocationLaunchError } from "./dispatch.js";
import type { ActionInput, CommandMeta, RecoveryUpdate, WorkView } from "./model.js";
import type { AgentRuntimePort, OperationContext, RuntimeBinding, RuntimeState } from "./ports.js";
import type { RuntimeStorage } from "./runtime-storage.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable, type ServiceOptions } from "./service-contracts.js";
import { observerEffects, readEffectBinding, readTextList } from "./service-dispatch-policy.js";
import {
	failedObserverProjection,
	hasUnboundObserverReservation,
	isAssessmentAuthorized,
	isObserverAvailable,
	isObserverPreAdmissionState,
	notifyRecoveryCheck,
	notifyRecoveryStage,
	OBSERVER_AGENT_TIMEOUT_MS,
	type ObserverRecoveryResult,
	systemObserverMeta,
} from "./service-foundation-policy.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { observerDriveKeyFor } from "./service-lifecycle-policy.js";
import { observerDriveIsCurrent, throwIfOperationAborted } from "./service-runtime-policy.js";
import {
	caughtError,
	invocationAllowance,
	isRuntimeUnavailable,
	observerEffect,
	requiredNonBlank,
	requiredText,
	sameRuntimeBinding,
} from "./service-state-policy.js";

type ObserverCallbacks = Readonly<{
	runInBackground: (operation: Promise<void>) => void;
	processPendingEffects: () => Promise<void>;
	recordCleanupSuccess: (workId: string, effectId: string, kind: string) => void;
}>;

export class ServiceObserver {
	private readonly drivingObservers = new Set<string>();
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly invocations: InvocationCoordinator;
	private readonly runtime: AgentRuntimePort;
	private readonly getOptions: () => ServiceOptions;
	private readonly runtimeStorage: RuntimeStorage;
	private readonly callbacks: ObserverCallbacks;

	constructor(
		archive: ArchivePort,
		core: ArchiveCore,
		invocations: InvocationCoordinator,
		runtime: AgentRuntimePort,
		getOptions: () => ServiceOptions,
		runtimeStorage: RuntimeStorage,
		callbacks: ObserverCallbacks,
	) {
		this.archive = archive;
		this.core = core;
		this.invocations = invocations;
		this.runtime = runtime;
		this.getOptions = getOptions;
		this.runtimeStorage = runtimeStorage;
		this.callbacks = callbacks;
	}

	async launch(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		this.requireLaunch(work);
		const options = this.getOptions();
		this.core.validateModel("observer", options.observerModel, options.observerThinking);
		const reserved: WorkView = {
			...work,
			revision: work.revision + 1,
			observerInFlight: true,
			nextAction: "Observer is inspecting the repository.",
		};
		return this.core.append({
			meta,
			kind: "execution",
			workId: work.workId,
			payload: { role: "observer", state: "reserved" },
			projection: reserved,
			summary: "Observer launch reserved.",
			effects: [observerEffect(work.workId, reserved.revision)],
		}).projection;
	}

	async processWake(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		if (work.observerInFlight !== true || work.observer !== undefined) return;
		const options = this.getOptions();
		this.core.validateModel("observer", options.observerModel, options.observerThinking);
		await new Promise<void>((resolve, reject) => {
			this.callbacks.runInBackground(
				this.drive(
					work,
					undefined,
					{
						actor: "system",
						commandId: `outbox:${effect.effectId}`,
						expectedWorkRevision: work.revision,
						schemaVersion: 1,
					},
					resolve,
				).catch(reject),
			);
		});
	}

	async processCleanup(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const binding = readEffectBinding(effect.payload);
		if (work.observer !== undefined && !sameRuntimeBinding(work.observer, binding)) {
			this.callbacks.recordCleanupSuccess(work.workId, effect.effectId, effect.kind);
			return;
		}
		await this.runtime.requestStop(binding);
		this.callbacks.recordCleanupSuccess(work.workId, effect.effectId, effect.kind);
	}

	async handleWakeFailure(effect: PendingArchiveEffect, workId: string | undefined, message: string): Promise<void> {
		if (workId === undefined) return;
		try {
			const current = this.core.inspectWork(workId);
			if (current.observerInFlight !== true) return;
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				observerInFlight: false,
				nextAction: "Observer failed; Conclave may retry.",
			};
			this.core.append({
				meta: {
					actor: "system",
					commandId: `observer-failure:${effect.effectId}:${current.revision}`,
					expectedWorkRevision: current.revision,
					schemaVersion: 1,
				},
				kind: "error",
				workId,
				payload: { message },
				projection: next,
				summary: "Observer runtime failed.",
				effects: observerEffects(workId, next.revision, current.observer),
			});
		} catch {
			// Recovery preserves the reservation if its failure cannot be recorded.
		}
	}

	recordAssessment(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "observer");
		this.core.checkRevision(work, meta);
		this.requireAssessmentAuthorization(work);
		this.requireNoAssessment(work);
		const summary = requiredNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		this.requireAssessmentEvidence(evidence);
		const context =
			`${work.terms.context}\n\nRepository assessment:\n${summary}\nEvidence:\n${evidence.map((item) => `- ${item}`).join("\n")}`
				.trim()
				.slice(0, 16_000);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			terms: { ...work.terms, context },
			observer: undefined,
			observerInFlight: false,
			nextAction: "Conclave must reread the Observer assessment.",
		};
		return this.core.append({
			meta,
			kind: "assessment",
			workId: work.workId,
			payload: { summary, evidence },
			projection: next,
			summary: "Observer recorded one bounded repository assessment.",
			evidenceRefs: evidence,
			effects: observerEffects(work.workId, next.revision, work.observer),
		}).projection;
	}

	async reconcileReservation(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		await this.callbacks.processPendingEffects();
		const reconciled = this.core.inspectWork(work.workId);
		if (!hasUnboundObserverReservation(reconciled)) return reconciled;
		const next: WorkView = {
			...reconciled,
			revision: reconciled.revision + 1,
			observerInFlight: false,
			nextAction: "Observer reservation was reconciled; Conclave may retry.",
		};
		return this.core.append({
			meta: {
				...meta,
				commandId: `${meta.commandId}:observer-reservation`,
				expectedWorkRevision: reconciled.revision,
			},
			kind: "error",
			workId: reconciled.workId,
			payload: { message: "Observer reservation had no persisted runtime binding." },
			projection: next,
			summary: "Observer reservation was reconciled.",
		}).projection;
	}

	async recover(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		notifyRecoveryCheck(onRecoveryUpdate, operation, "Observer");
		const binding = this.requireBinding(work);
		const observerState = await this.runtime.getState(binding, operation);
		if (observerState === "working") return work;
		const options = this.getOptions();
		this.core.validateModel("observer", options.observerModel, options.observerThinking);
		const rebound = await this.reconcileRuntime(work, meta, observerState, onRecoveryUpdate, operation);
		if (rebound.binding !== undefined && rebound.shouldResume)
			this.callbacks.runInBackground(this.drive(rebound.work, rebound.binding));
		return rebound.work;
	}

	private requireLaunch(work: WorkView): void {
		if (!isObserverPreAdmissionState(work.state))
			throw this.core.error(
				"invalid-state",
				"Only submitted Work can launch an Observer.",
				false,
				"Inspect the current Work state.",
			);
		if (!isObserverAvailable(work))
			throw this.core.error(
				"invalid-state",
				"Work cannot launch another Observer.",
				false,
				"Admit the Work or reconcile the current Observer.",
			);
		if (this.getOptions().observerModel.length > 0) return;
		throw this.core.error(
			"external-failure",
			"No Observer model is configured.",
			false,
			"Configure observerModel or provide the child Pi model explicitly.",
		);
	}

	private async reconcileRuntime(
		work: WorkView,
		meta: CommandMeta,
		observerState: RuntimeState,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<ObserverRecoveryResult> {
		const binding = this.requireBinding(work);
		if (!isRuntimeUnavailable(observerState)) return { work, binding, shouldResume: observerState === "idle" };
		notifyRecoveryStage(onRecoveryUpdate, "stopping", "Closing the unavailable assessment safely.");
		await this.runtime.requestStop(binding).catch(() => undefined);
		notifyRecoveryStage(onRecoveryUpdate, "restoring", "Restoring the Work's assessment.");
		const options = this.getOptions();
		const rebound = {
			...(await this.runtime.ensureSession(
				{
					cwd: options.projectPath,
					model: options.observerModel,
					thinking: options.observerThinking,
					role: "observer",
					promptIdentity: options.observerPromptIdentity,
					agentTimeoutMs: OBSERVER_AGENT_TIMEOUT_MS,
					allowedPaths: work.terms.allowedPaths,
					sandboxRoot: options.projectPath,
					bindingScope: { workId: work.workId },
					tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
					sessionPath: binding.sessionPath,
				},
				operation,
			)),
			promptIdentity: options.observerPromptIdentity,
		};
		try {
			throwIfOperationAborted(operation);
			const current = this.core.append({
				meta: { ...meta, commandId: `${meta.commandId}:observer`, expectedWorkRevision: work.revision },
				kind: "execution",
				workId: work.workId,
				payload: rebound,
				projection: { ...work, revision: work.revision + 1, observer: rebound },
				summary: "Observer runtime was reattached.",
			}).projection;
			return { work: current, binding: current.observer, shouldResume: true };
		} catch (error) {
			await this.runtime.requestStop(rebound).catch(() => undefined);
			throw error;
		}
	}

	private requireBinding(work: WorkView): RuntimeBinding {
		if (work.observer !== undefined) return work.observer;
		throw new Error("The Observer runtime is not bound to this Work.");
	}

	private async bindRuntime(work: WorkView, binding: RuntimeBinding, meta: CommandMeta): Promise<WorkView> {
		const current = this.core.inspectWork(work.workId);
		if (current.observerInFlight !== true || current.observer !== undefined) {
			await this.runtime.requestStop(binding).catch(() => undefined);
			throw new RunGateUnavailable();
		}
		return this.core.append({
			meta: { ...meta, commandId: `${meta.commandId}:binding`, expectedWorkRevision: current.revision },
			kind: "execution",
			workId: current.workId,
			payload: binding,
			projection: {
				...current,
				revision: current.revision + 1,
				observer: binding,
				nextAction: "Observer assessment is pending.",
			},
			summary: "Observer runtime is bound.",
		}).projection;
	}

	private async prepareInvocation(
		work: WorkView,
		existingBinding: RuntimeBinding | undefined,
		meta: CommandMeta | undefined,
		operation: OperationContext,
	): Promise<Readonly<{ binding: RuntimeBinding; live: WorkView }>> {
		const current = this.core.inspectWork(work.workId);
		const options = this.getOptions();
		const binding =
			existingBinding ??
			(await this.runtime.ensureSession(
				{
					cwd: options.projectPath,
					model: options.observerModel,
					thinking: options.observerThinking,
					role: "observer",
					promptIdentity: options.observerPromptIdentity,
					agentTimeoutMs: OBSERVER_AGENT_TIMEOUT_MS,
					allowedPaths: current.terms.allowedPaths,
					sandboxRoot: options.projectPath,
					bindingScope: { workId: current.workId },
					tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
					sessionPath: this.runtimeStorage.persistentSessionPath("observer", current.workId),
				},
				operation,
			));
		const live =
			existingBinding === undefined
				? await this.bindRuntime(current, binding, meta ?? systemObserverMeta(current))
				: this.core.inspectWork(work.workId);
		return { binding, live };
	}

	private async drive(
		work: WorkView,
		existingBinding?: RuntimeBinding,
		meta?: CommandMeta,
		started?: () => void,
	): Promise<void> {
		const driveKey = observerDriveKeyFor(work, existingBinding);
		if (this.drivingObservers.has(driveKey)) return;
		this.drivingObservers.add(driveKey);
		let binding = existingBinding;
		try {
			await this.invocations.dispatch(
				work,
				{ workId: work.workId, role: "observer", allowance: invocationAllowance(work) },
				async ({ runId, allowance }, operation) => {
					const prepared = await this.prepareInvocationForDispatch(work, existingBinding, meta, operation);
					binding = prepared.binding;
					started?.();
					return this.runtime.send(
						prepared.binding,
						`Inspect Work ${prepared.live.workId} read-only. Record exactly one bounded assessment with concrete repository evidence using Archive revision ${prepared.live.revision}, then stop.\nInvocation run ID: ${runId}.`,
						{ tokenAllowance: allowance, runId },
						operation,
					);
				},
			);
			this.finishDriveIfBound(work, binding);
		} catch (error) {
			await this.handleDriveError(work, binding, error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.drivingObservers.delete(driveKey);
			await this.stopIfBound(binding);
			queueMicrotask(() => void this.callbacks.processPendingEffects().catch(() => undefined));
		}
	}

	private async prepareInvocationForDispatch(
		work: WorkView,
		existingBinding: RuntimeBinding | undefined,
		meta: CommandMeta | undefined,
		operation: OperationContext,
	): Promise<Readonly<{ binding: RuntimeBinding; live: WorkView }>> {
		try {
			return await this.prepareInvocation(work, existingBinding, meta, operation);
		} catch (error) {
			throw new InvocationLaunchError(new Error(String(error)));
		}
	}

	private finishDriveIfBound(work: WorkView, binding: RuntimeBinding | undefined): void {
		if (binding !== undefined) this.finishDrive(work, binding);
	}

	private async handleDriveError(work: WorkView, binding: RuntimeBinding | undefined, error: Error): Promise<never> {
		if (error instanceof RunGateUnavailable) throw error;
		if (binding !== undefined) await this.failDrive(work, binding, caughtError(error.message));
		throw error;
	}

	private async stopIfBound(binding: RuntimeBinding | undefined): Promise<void> {
		if (binding !== undefined) await this.runtime.requestStop(binding).catch(() => undefined);
	}

	private finishDrive(work: WorkView, binding: RuntimeBinding): void {
		const current = this.archive.project(work.workId);
		if (current?.observerInFlight !== true || !sameRuntimeBinding(current.observer, binding)) return;
		const next: WorkView = {
			...current,
			revision: current.revision + 1,
			observer: undefined,
			observerInFlight: false,
			nextAction: "Observer completed without an assessment; Conclave may retry.",
		};
		this.core.append({
			meta: {
				actor: "system",
				commandId: `observer-empty:${current.workId}:${current.revision}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			kind: "error",
			workId: current.workId,
			payload: { message: "Observer completed without recording an assessment." },
			projection: next,
			summary: "Observer completed without an assessment.",
			effects: observerEffects(current.workId, next.revision, binding),
		});
	}

	private async failDrive(work: WorkView, binding: RuntimeBinding, error: Error): Promise<void> {
		const current = this.archive.project(work.workId);
		if (!observerDriveIsCurrent(current, binding)) return;
		const next = failedObserverProjection(current);
		try {
			this.core.append({
				meta: {
					actor: "system",
					commandId: `observer-runtime-failure:${current.workId}:${current.revision}`,
					expectedWorkRevision: current.revision,
					schemaVersion: 1,
				},
				kind: "error",
				workId: current.workId,
				payload: { message: error.message },
				projection: next,
				summary: "Observer runtime failed.",
				effects: observerEffects(work.workId, next.revision, binding),
			});
		} catch {
			await this.runtime.requestStop(binding).catch(() => undefined);
		}
	}

	private requireAssessmentAuthorization(work: WorkView): void {
		if (isAssessmentAuthorized(work)) return;
		throw this.core.error(
			"invalid-state",
			"No Observer assessment is currently authorized.",
			false,
			"Launch the Observer for this Work.",
		);
	}

	private requireNoAssessment(work: WorkView): void {
		if (this.archive.query({ workId: work.workId, kinds: ["assessment"] }).items.length === 0) return;
		throw this.core.error(
			"invalid-state",
			"This Work already has an Observer assessment.",
			false,
			"Stop the Observer and let Conclave reread the Archive.",
		);
	}

	private requireAssessmentEvidence(evidence: readonly string[]): void {
		if (evidence.length > 0) return;
		throw this.core.error(
			"invalid-input",
			"An Observer assessment must include repository evidence.",
			false,
			"Include at least one concrete repository path or command result.",
		);
	}
}
