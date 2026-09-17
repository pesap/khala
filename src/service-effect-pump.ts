import { nanoid } from "nanoid";
import { type ArchivePort, InvocationCapacityExceeded, type PendingArchiveEffect } from "./archive.js";
import type { CommandMeta, ConclaveWakeCause, ErrorEnvelope, JsonObject, WorkView } from "./model.js";
import type { ServicePorts } from "./ports.js";
import { isTextValue } from "./provider-observation-policy.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable } from "./service-contracts.js";
import {
	dispatchEligibilityAttention,
	readEffectBinding,
	readEffectWakeCause,
	readOptionalEffectBinding,
	staleConclaveWake,
} from "./service-dispatch-policy.js";
import { ServiceExecution } from "./service-execution.js";
import { ExecutorRuntimeCoordinator } from "./service-executor-runtime.js";
import { ServiceFeedback } from "./service-feedback.js";
import {
	type DispatchEligibilityAttention,
	executorRecoveryMatches,
	isTerminalWork,
	type PendingEffectHandler,
	type ServiceFailure,
	SUPPORTED_EFFECT_KINDS,
} from "./service-foundation-policy.js";
import { InvocationCoordinator } from "./service-invocation-coordinator.js";
import {
	conclaveWakeApplicable,
	feedbackWakeDisposition,
	isSchedulerCandidate,
	modelEffectEligibility,
	readCleanupSandbox,
	readOptionalEffectText,
} from "./service-lifecycle-policy.js";
import { ServiceObserver } from "./service-observer.js";
import { ServiceRecovery } from "./service-recovery.js";
import { assertConclaveWakeResolution, executorStopMatches, isQueuedMission } from "./service-runtime-policy.js";
import {
	dispatchGateIdentity,
	isDispatchDeferral,
	pendingConclaveWakeKey,
	readEffectExecutionId,
	readEffectFeedback,
	readEffectWorkId,
	sameDispatchAttention,
} from "./service-state-policy.js";
import { type DispatchEligibility, DispatchEligibilityError, dispatchEligibility } from "./workflow-dispatch.js";

type EffectPumpCallbacks = Readonly<{
	acquireSupervision: () => boolean;
	wakeConclave: (
		workId: string,
		commandId: string,
		observationId?: string,
		reason?: ConclaveWakeCause,
	) => Promise<void>;
	processOracleWake: (effect: PendingArchiveEffect, work: WorkView) => Promise<void>;
	recordCleanupSuccess: (workId: string, effectId: string, kind: string) => void;
	recordCleanupFailure: (work: WorkView, effectId: string, failure: Error, kind: string) => void;
	recordWakeFailure: (
		workId: string,
		failure: Error,
		meta: CommandMeta,
		reason: ConclaveWakeCause | undefined,
		observationId: string | undefined,
		dispatchEffectId: string,
	) => WorkView;
}>;

export class ServiceEffectPump {
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly invocations: InvocationCoordinator;
	private readonly executorRuntime: ExecutorRuntimeCoordinator;
	private readonly feedback: ServiceFeedback;
	private readonly observer: ServiceObserver;
	private readonly execution: ServiceExecution;
	private readonly recovery: ServiceRecovery;
	private readonly workspace: ServicePorts["workspace"];
	private readonly callbacks: EffectPumpCallbacks;
	private readonly heartbeat: Map<string, string>;
	private pendingRun: Promise<void> | undefined;
	private requested = false;
	private closing = false;
	constructor(input: {
		archive: ArchivePort;
		core: ArchiveCore;
		invocations: InvocationCoordinator;
		executorRuntime: ExecutorRuntimeCoordinator;
		feedback: ServiceFeedback;
		observer: ServiceObserver;
		execution: ServiceExecution;
		recovery: ServiceRecovery;
		workspace: ServicePorts["workspace"];
		heartbeat: Map<string, string>;
		callbacks: EffectPumpCallbacks;
	}) {
		this.archive = input.archive;
		this.core = input.core;
		this.invocations = input.invocations;
		this.executorRuntime = input.executorRuntime;
		this.feedback = input.feedback;
		this.observer = input.observer;
		this.execution = input.execution;
		this.recovery = input.recovery;
		this.workspace = input.workspace;
		this.heartbeat = input.heartbeat;
		this.callbacks = input.callbacks;
	}
	get activeRun(): Promise<void> | undefined {
		return this.pendingRun;
	}
	stop(): void {
		this.closing = true;
	}
	async processPendingEffects(): Promise<void> {
		if (!this.callbacks.acquireSupervision()) return;
		// Stop requests must reach a role even while its turn occupies the serialized pump.
		this.invocations.abortStoppedWork();
		if (this.pendingRun !== undefined) {
			this.requested = true;
			await this.executorRuntime.stopStoppedTurns();
			return this.pendingRun;
		}
		const run = this.drainPendingEffectsUntilIdle();
		this.pendingRun = run;
		try {
			await run;
		} finally {
			if (this.pendingRun === run) this.pendingRun = undefined;
		}
	}

	private async drainPendingEffectsUntilIdle(): Promise<void> {
		// Nested wake requests may add work, but cannot immediately retry an effect
		// that already failed during this supervisor activation.
		const deferred = new Set<string>();
		do {
			this.requested = false;
			await this.drainPendingEffects(deferred);
		} while (this.requested && !this.closing);
	}
	private async drainPendingEffects(deferred: Set<string>): Promise<void> {
		const owner = `khala-worker:${nanoid()}`;
		const dispatchedConclaveWakes = new Map<string, string>();
		while (!this.closing) {
			const effects = this.archive.pendingEffects(owner, [...deferred]);
			if (effects.length === 0) return;
			if (await this.drainPendingEffectsBatch(effects, owner, dispatchedConclaveWakes))
				effects.forEach((effect) => deferred.add(effect.effectId));
		}
	}

	private async drainPendingEffectsBatch(
		effects: readonly PendingArchiveEffect[],
		owner: string,
		dispatchedConclaveWakes: Map<string, string>,
	): Promise<boolean> {
		let paused = false;
		for (const effect of effects)
			if (await this.drainPendingEffectItem(effect, owner, dispatchedConclaveWakes)) paused = true;
		return paused;
	}

	private async drainPendingEffectItem(
		effect: PendingArchiveEffect,
		owner: string,
		dispatchedConclaveWakes: Map<string, string>,
	): Promise<boolean> {
		if (this.deferFailedConclaveWake(effect, owner)) return true;
		if (this.deferDuplicateConclaveWake(effect, owner, dispatchedConclaveWakes)) return true;
		if (!SUPPORTED_EFFECT_KINDS.has(effect.kind)) {
			this.archive.releaseEffect(effect.effectId, owner);
			this.recordUnsupportedEffect(effect);
			return true;
		}
		// A blocked model decision must not strand already-claimed cleanup or other Works.
		return this.processPendingEffect(effect, owner, dispatchedConclaveWakes);
	}

	private deferFailedConclaveWake(effect: PendingArchiveEffect, owner: string): boolean {
		const failure = this.archive.findCommand(`outbox-failure:${effect.effectId}`);
		if (failure === undefined) return false;
		if (isTerminalWork(this.core.inspectWork(failure.record.workId))) return false;
		this.archive.releaseEffect(effect.effectId, owner);
		return true;
	}

	private recordUnsupportedEffect(effect: Readonly<{ effectId: string; kind: string; payload: JsonObject }>): void {
		const workId = effect.payload["workId"];
		if (!isTextValue(workId)) return;
		const work = this.archive.project(workId);
		if (work === undefined) return;
		const marker = `unsupported-effect:${effect.effectId}`;
		if (this.heartbeat.has(marker)) return;
		this.appendUnsupportedEffect(work, effect, marker);
	}

	private appendUnsupportedEffect(
		work: WorkView,
		effect: Readonly<{ effectId: string; kind: string; payload: JsonObject }>,
		marker: string,
	): void {
		const failure: ErrorEnvelope = {
			code: "integrity-failure",
			summary: `Unsupported Archive effect ${effect.kind} was retained for inspection.`,
			retryable: false,
			remediation: "Upgrade Khala to a version that supports this effect before retrying the worker.",
			evidenceRefs: [effect.effectId],
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: failure,
			nextAction: "An unsupported Archive effect requires operator reconciliation.",
		};
		try {
			this.core.append({
				meta: {
					actor: "system",
					commandId: `${marker}:${work.revision}`,
					expectedWorkRevision: work.revision,
					schemaVersion: 1,
				},
				kind: "error",
				workId: work.workId,
				missionId: work.mission?.missionId,
				executionId: work.execution?.executionId,
				payload: { effectId: effect.effectId, kind: effect.kind, error: failure },
				projection: next,
				evidenceRefs: failure.evidenceRefs,
				summary: failure.summary,
			});
			this.heartbeat.set(marker, failure.summary);
		} catch {
			// Leave both the effect and diagnostic available for the next pass.
		}
	}

	private deferDuplicateConclaveWake(
		effect: PendingArchiveEffect,
		owner: string,
		dispatchedConclaveWakes: Map<string, string>,
	): boolean {
		const wakeKey = pendingConclaveWakeKey(effect);
		if (wakeKey === undefined) return false;
		const dispatchedEffect = dispatchedConclaveWakes.get(wakeKey);
		if (dispatchedEffect === undefined || dispatchedEffect === effect.effectId) {
			dispatchedConclaveWakes.set(wakeKey, effect.effectId);
			return false;
		}
		this.archive.releaseEffect(effect.effectId, owner);
		return true;
	}

	private async processPendingEffect(
		effect: PendingArchiveEffect,
		owner: string,
		dispatchedConclaveWakes: Map<string, string>,
	): Promise<boolean> {
		let workId: string | undefined;
		let observationId: string | undefined;
		let feedbackExecutionId: string | undefined;
		let wakeReason: ConclaveWakeCause | undefined;
		let leaseLost = false;
		const lease = setInterval(() => {
			try {
				if (!this.archive.renewEffect(effect.effectId, owner)) leaseLost = true;
			} catch {
				leaseLost = true;
			}
		}, 60_000);
		try {
			workId = readEffectWorkId(effect.payload);
			observationId = readOptionalEffectText(effect.payload, "observationId");
			feedbackExecutionId = readOptionalEffectText(effect.payload, "executionId");
			wakeReason = effect.kind === "conclave-wake" ? readEffectWakeCause(effect.payload) : undefined;
			const work = this.core.inspectWork(workId);
			await this.performPendingEffect(
				effect,
				work,
				workId,
				observationId,
				feedbackExecutionId,
				wakeReason,
				dispatchedConclaveWakes,
			);
			this.assertPendingEffectOutcome(effect, work, workId, wakeReason);
			this.completePendingEffect(effect, owner, leaseLost);
			clearInterval(lease);
			return false;
		} catch (error) {
			clearInterval(lease);
			return this.handlePendingEffectFailure(
				effect,
				owner,
				workId,
				observationId,
				wakeReason,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private completePendingEffect(effect: PendingArchiveEffect, owner: string, leaseLost: boolean): void {
		if (leaseLost) throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
		if (!this.archive.completeEffect(effect.effectId, owner))
			throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
	}

	private async performPendingEffect(
		effect: PendingArchiveEffect,
		work: WorkView,
		workId: string,
		observationId: string | undefined,
		feedbackExecutionId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
		dispatchedConclaveWakes: Map<string, string>,
	): Promise<void> {
		if (staleConclaveWake(effect, work, wakeReason)) return;
		const eligibility = modelEffectEligibility(effect, work);
		if (eligibility !== "eligible") throw new DispatchEligibilityError(eligibility);
		const handlers = new Map<string, PendingEffectHandler<void>>([
			["conclave-wake", () => this.processConclaveWake(effect, work, workId, observationId, wakeReason)],
			["oracle-wake", () => this.callbacks.processOracleWake(effect, work)],
			["scheduler-wake", () => this.processSchedulerWake(effect, dispatchedConclaveWakes)],
			["workspace-cleanup", () => this.processWorkspaceCleanup(effect, work)],
			["observer-cleanup", () => this.observer.processCleanup(effect, work)],
			["executor-stop", () => this.processExecutorStop(effect, work)],
			["executor-recovery", () => this.processExecutorRecovery(effect, work)],
			["feedback-wake", () => this.processFeedbackWake(work, feedbackExecutionId, observationId, effect)],
			["executor-wake", () => this.processExecutorWake(effect, work)],
			["observer-wake", () => this.observer.processWake(effect, work)],
		]);
		const handler = handlers.get(effect.kind) ?? (() => this.processQueuedExecutionWake(effect, work));
		await handler();
	}

	private async processConclaveWake(
		effect: PendingArchiveEffect,
		work: WorkView,
		workId: string,
		observationId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
	): Promise<void> {
		if (!conclaveWakeApplicable(work, wakeReason)) return;
		await this.callbacks.wakeConclave(workId, `outbox:${effect.effectId}:${work.revision}`, observationId, wakeReason);
	}

	private async processSchedulerWake(
		effect: PendingArchiveEffect,
		dispatchedConclaveWakes: Map<string, string>,
	): Promise<void> {
		const trigger = this.core.inspectWork(readEffectWorkId(effect.payload));
		this.invocations.requireCapacity(trigger);
		const queued = this.archive
			.listProjects()
			.filter(isQueuedMission)
			.sort((left, right) => left.queuedSequence - right.queuedSequence);
		queued.forEach((candidate) => this.recordSchedulerEligibility(effect, candidate));
		const candidate = queued.find(isSchedulerCandidate);
		if (candidate === undefined) return;
		const wakeKey = `${candidate.workId}:admission`;
		if (dispatchedConclaveWakes.has(wakeKey)) return;
		dispatchedConclaveWakes.set(wakeKey, effect.effectId);
		await this.wakeScheduledConclave(effect, candidate);
	}

	private async wakeScheduledConclave(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		try {
			await this.callbacks.wakeConclave(work.workId, `outbox:${effect.effectId}:${work.revision}`);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.recordScheduledWakeFailure(effect, work.workId, failure);
			throw failure;
		}
	}

	private recordScheduledWakeFailure(effect: PendingArchiveEffect, workId: string, failure: Error): void {
		if (isDispatchDeferral(failure)) return;
		const current = this.core.inspectWork(workId);
		this.callbacks.recordWakeFailure(
			workId,
			failure,
			{
				actor: "conclave",
				commandId: `outbox-failure:${effect.effectId}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			"admission",
			undefined,
			effect.effectId,
		);
	}

	private recordSchedulerEligibility(effect: PendingArchiveEffect, work: WorkView): void {
		const eligibility = dispatchEligibility(work);
		if (eligibility !== "eligible") this.recordDispatchEligibilityAttention(effect, work, eligibility);
	}

	private recordDispatchEligibilityAttention(
		effect: PendingArchiveEffect,
		work: WorkView,
		eligibility: Exclude<DispatchEligibility, "eligible">,
	): void {
		if (isTerminalWork(work)) return;
		const attention = dispatchEligibilityAttention(work, eligibility, effect.effectId);
		if (!this.hasDispatchAttention(work, eligibility) && !sameDispatchAttention(work.lastError, attention.error))
			this.appendDispatchEligibilityAttention(work, attention, eligibility);
	}

	private completeIneligibleEffect(effect: PendingArchiveEffect, owner: string): void {
		if (!this.archive.completeEffect(effect.effectId, owner))
			throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
	}

	private hasDispatchAttention(work: WorkView, eligibility: Exclude<DispatchEligibility, "eligible">): boolean {
		return this.archive.findCommand(`dispatch-ineligible:${dispatchGateIdentity(work, eligibility)}`) !== undefined;
	}

	private appendDispatchEligibilityAttention(
		work: WorkView,
		attention: DispatchEligibilityAttention,
		eligibility: Exclude<DispatchEligibility, "eligible">,
	): void {
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: attention.error,
			nextAction: attention.nextAction,
		};
		this.core.append({
			meta: {
				actor: "system",
				commandId: `dispatch-ineligible:${dispatchGateIdentity(work, eligibility)}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { ...attention.error, dispatchGate: dispatchGateIdentity(work, eligibility) },
			projection: next,
			evidenceRefs: attention.error.evidenceRefs,
			summary: attention.error.summary,
		});
	}

	private async processWorkspaceCleanup(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const binding = readOptionalEffectBinding(effect.payload);
		if (binding !== undefined)
			await this.executorRuntime.stopAfterTurn(work, binding, ["completed", "failed", "stopped"]);
		await this.workspace.removeSandbox(readCleanupSandbox(effect.payload));
		this.callbacks.recordCleanupSuccess(work.workId, effect.effectId, effect.kind);
	}

	private async processExecutorStop(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const binding = readEffectBinding(effect.payload);
		const executionId = readEffectExecutionId(effect.payload);
		if (executorStopMatches(work.execution, executionId, binding))
			await this.executorRuntime.stopAfterTurn(work, binding, ["awaiting-review"]);
	}

	private async processExecutorRecovery(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const executionId = readEffectExecutionId(effect.payload);
		if (!executorRecoveryMatches(work.execution, executionId)) return;
		await this.recovery.recoverExecutorRuntime(work, {
			actor: "system",
			commandId: `outbox:${effect.effectId}`,
			expectedWorkRevision: work.revision,
			schemaVersion: 1,
		});
	}

	private async processFeedbackWake(
		work: WorkView,
		feedbackExecutionId: string | undefined,
		observationId: string | undefined,
		effect: PendingArchiveEffect,
	): Promise<void> {
		const feedback = readEffectFeedback(effect.payload);
		const disposition = feedbackWakeDisposition(work, feedbackExecutionId);
		if (disposition === "superseded") {
			this.feedback.recordSuperseded(work, feedback, effect.effectId, observationId);
			return;
		}
		if (disposition === "resume") {
			await this.feedback.resumeExecutor(work, feedback, effect.effectId, observationId);
			return;
		}
		this.feedback.recordUnavailable(work, feedback, effect.effectId, observationId);
		throw new Error("The Executor is not running; feedback delivery remains pending.");
	}

	private async processExecutorWake(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		await this.execution.processWake(effect, work);
	}

	private async processQueuedExecutionWake(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		await this.execution.processWake(effect, work);
	}

	private assertPendingEffectOutcome(
		effect: PendingArchiveEffect,
		work: WorkView,
		workId: string,
		wakeReason: ConclaveWakeCause | undefined,
	): void {
		if (effect.kind !== "conclave-wake") return;
		if (staleConclaveWake(effect, work, wakeReason)) return;
		const current = this.core.inspectWork(workId);
		assertConclaveWakeResolution(work, current, wakeReason);
	}

	private async handlePendingEffectFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string | undefined,
		observationId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
		error: ServiceFailure,
	): Promise<boolean> {
		if (error instanceof DispatchEligibilityError)
			return this.handleDispatchEligibilityFailure(effect, owner, workId, error.eligibility);
		return this.handleOrdinaryPendingEffectFailure(effect, owner, workId, observationId, wakeReason, error);
	}

	private handleDispatchEligibilityFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string | undefined,
		eligibility: Exclude<DispatchEligibility, "eligible">,
	): boolean {
		const work = this.core.inspectWork(workId ?? readEffectWorkId(effect.payload));
		if (isTerminalWork(work)) {
			this.completeIneligibleEffect(effect, owner);
			return false;
		}
		this.recordDispatchEligibilityAttention(effect, work, eligibility);
		this.archive.releaseEffect(effect.effectId, owner);
		return true;
	}

	private async handleOrdinaryPendingEffectFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string | undefined,
		observationId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
		error: ServiceFailure,
	): Promise<boolean> {
		const message = error.message;
		if (error instanceof RunGateUnavailable || error instanceof InvocationCapacityExceeded) {
			this.archive.releaseEffect(effect.effectId, owner);
			return true;
		}
		const handlers = new Map<string, PendingEffectHandler<boolean>>([
			["workspace-cleanup", () => this.handleCleanupEffectFailure(effect, owner, workId, message)],
			["observer-cleanup", () => this.handleCleanupEffectFailure(effect, owner, workId, message)],
			[
				"feedback-wake",
				async () => {
					this.archive.releaseEffect(effect.effectId, owner);
					return true;
				},
			],
			[
				"observer-wake",
				async () => {
					await this.observer.handleWakeFailure(effect, workId, message);
					this.archive.releaseEffect(effect.effectId, owner);
					return true;
				},
			],
			[
				"conclave-wake",
				async () => {
					await this.handleConclaveWakeFailure(effect, owner, workId, observationId, wakeReason, error);
					return true;
				},
			],
		]);
		const handler = handlers.get(effect.kind);
		if (handler !== undefined) return handler();
		this.archive.releaseEffect(effect.effectId, owner);
		return true;
	}

	private async handleCleanupEffectFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string | undefined,
		message: string,
	): Promise<boolean> {
		this.archive.releaseEffect(effect.effectId, owner);
		const work = workId === undefined ? undefined : this.archive.project(workId);
		if (work !== undefined) {
			try {
				this.callbacks.recordCleanupFailure(work, effect.effectId, new Error(message), effect.kind);
			} catch {
				// Keep the released effect retryable when its diagnostic record cannot be appended.
			}
		}
		return true;
	}

	private async handleConclaveWakeFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string | undefined,
		observationId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
		error: ServiceFailure,
	): Promise<void> {
		if (workId === undefined) {
			this.archive.releaseEffect(effect.effectId, owner);
			return;
		}
		try {
			await this.recordConclaveWakeFailure(effect, owner, workId, observationId, wakeReason, error);
		} catch {
			// Preserve the pending effect when its Work cannot be reconciled.
			this.archive.releaseEffect(effect.effectId, owner);
		}
	}

	private async recordConclaveWakeFailure(
		effect: PendingArchiveEffect,
		owner: string,
		workId: string,
		observationId: string | undefined,
		wakeReason: ConclaveWakeCause | undefined,
		error: ServiceFailure,
	): Promise<void> {
		const current = this.core.inspectWork(workId);
		if (["succeeded", "stopped"].includes(current.state)) {
			if (!this.archive.completeEffect(effect.effectId, owner))
				throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
			return;
		}
		this.archive.releaseEffect(effect.effectId, owner);
		this.callbacks.recordWakeFailure(
			workId,
			error,
			{
				actor: "conclave",
				commandId: `outbox-failure:${effect.effectId}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			wakeReason,
			observationId,
			effect.effectId,
		);
	}
}
