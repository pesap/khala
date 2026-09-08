import { type ArchivePort, type PendingArchiveEffect } from "./archive.js";
import { InvocationLaunchError } from "./dispatch.js";
import {
	type Action,
	type ActionCommand,
	type ActionInput,
	type Actor,
	type CommandMeta,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type Page,
	type RecordQuery,
	type RecordSummaryView,
	type RecordView,
	type RecoveryUpdate,
	type RoleSetting,
	type RoleSettingsMap,
	type ServiceResult,
	type SubmitWorkInput,
	type WorkSummary,
	type WorkView,
} from "./model.js";
import { type OperationContext, type RuntimeBinding, type RuntimeState, type ServicePorts } from "./ports.js";
import { schedulerEffect } from "./provider-observation-policy.js";
import { RunLedger } from "./run-ledger.js";
import { createRuntimeStorage, type RuntimeStorage } from "./runtime-storage.js";
import { ServiceActions } from "./service-actions.js";
import { ArchiveCore } from "./service-archive-core.js";
import { ServiceConfiguration } from "./service-configuration.js";
import type { ServiceOptions } from "./service-contracts.js";
import { ServiceDecisions } from "./service-decisions.js";
import { cleanupRestoredAction, oracleRequestCurrent } from "./service-dispatch-policy.js";
import { ServiceEffectPump } from "./service-effect-pump.js";
import { ServiceExecution } from "./service-execution.js";
import { ExecutorRuntimeCoordinator } from "./service-executor-runtime.js";
import { ServiceFeedback } from "./service-feedback.js";
import {
	AUTONOMOUS_MONITOR_INTERVAL_MS,
	hasPendingOperations,
	isTerminalWork,
	pendingOperations,
} from "./service-foundation-policy.js";
import { ServiceGovernance } from "./service-governance.js";
import { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { reconcileInvocation } from "./service-invocation-recovery.js";
import { closeRuntimeAfterDrain, conclaveWakeError, wakeErrorKindFor } from "./service-lifecycle-policy.js";
import { ServiceMonitoring } from "./service-monitoring.js";
import { ServiceObserver } from "./service-observer.js";
import { ServiceRecovery } from "./service-recovery.js";
import {
	actionFingerprint,
	cleanupFailureMatches,
	cleanupLabel,
	conclaveWakeMessage,
	oraclePayload,
	throwIfOperationAborted,
} from "./service-runtime-policy.js";
import { invocationAllowance } from "./service-state-policy.js";
import { ServiceSubmission } from "./service-submission.js";
import { WorkCompletion } from "./service-work-completion.js";
import { ServiceWorkspaceActions } from "./service-workspace-actions.js";

export type { ServiceOptions } from "./service-contracts.js";
export { ActionInputError, ApplicationError, RunGateUnavailable, resultText } from "./service-contracts.js";

function hasActiveInvocations(work: WorkView): boolean {
	return work.activeInvocations !== undefined && work.activeInvocations.length > 0;
}

function hasHeldInvocationAttention(work: WorkView): boolean {
	return (
		work.lastError?.code === "external-failure" &&
		work.lastError.summary === "Model dispatch is waiting for an existing invocation to settle."
	);
}

function reconciledExecutorBinding(work: WorkView, fact: ReturnType<RunLedger["find"]>): RuntimeBinding | undefined {
	if (fact === undefined) return undefined;
	return matchingExecutorBinding(work, fact.role, fact.executionId);
}

function matchingExecutorBinding(
	work: WorkView,
	role: string,
	executionId: string | undefined,
): RuntimeBinding | undefined {
	if (role !== "executor") return undefined;
	const execution = work.execution;
	if (execution === undefined) return undefined;
	return matchingExecutionBinding(execution, executionId);
}

function matchingExecutionBinding(execution: Execution, executionId: string | undefined): RuntimeBinding | undefined {
	if (execution.pi === undefined) return undefined;
	return executionId === execution.executionId ? execution.pi : undefined;
}

export class ApplicationService {
	private readonly heartbeat = new Map<string, string>();
	private readonly backgroundOperations = new Set<Promise<void>>();
	private readonly monitorTimer: ReturnType<typeof setInterval> | undefined;
	private closing = false;
	private readonly archive: ArchivePort;
	private readonly ports: ServicePorts;
	private readonly runtimeStorage: RuntimeStorage;
	private readonly configuration: ServiceConfiguration;
	private readonly ledger: RunLedger;
	private readonly core: ArchiveCore;
	private readonly completion: WorkCompletion;
	private readonly monitoring: ServiceMonitoring;
	private readonly invocations: InvocationCoordinator;
	private readonly executorRuntime: ExecutorRuntimeCoordinator;
	private readonly actions: ServiceActions;
	private readonly feedback: ServiceFeedback;
	private readonly submission: ServiceSubmission;
	private readonly observer: ServiceObserver;
	private readonly governance: ServiceGovernance;
	private readonly execution: ServiceExecution;
	private readonly workspaceActions: ServiceWorkspaceActions;
	private readonly recovery: ServiceRecovery;
	private readonly effectPump: ServiceEffectPump;
	private readonly decisions: ServiceDecisions;

	constructor(archive: ArchivePort, ports: ServicePorts, options: ServiceOptions) {
		this.archive = archive;
		this.ports = ports;
		this.configuration = new ServiceConfiguration(options);
		this.runtimeStorage = createRuntimeStorage(options.projectPath);
		this.ledger = new RunLedger(archive);
		this.core = new ArchiveCore(archive, ports.models, options.rolePublicKey);
		this.completion = new WorkCompletion(this.core);
		this.invocations = new InvocationCoordinator(archive, this.core, this.ledger, options);
		this.executorRuntime = new ExecutorRuntimeCoordinator(archive, this.core, this.invocations, ports.runtime);
		this.feedback = new ServiceFeedback(
			archive,
			this.core,
			ports.runtime,
			this.invocations,
			this.executorRuntime,
			this.heartbeat,
		);
		this.actions = new ServiceActions(this.core, (work, observation) =>
			this.feedback.canDeliverFeedback(work, observation),
		);
		this.submission = new ServiceSubmission(archive, this.core, () => this.configuration.options);
		this.observer = new ServiceObserver(
			archive,
			this.core,
			this.invocations,
			ports.runtime,
			() => this.configuration.options,
			this.runtimeStorage,
			{
				runInBackground: (operation) => this.runInBackground(operation),
				processPendingEffects: () => this.processPendingEffects(),
				recordCleanupSuccess: (workId, effectId, kind) => this.recordCleanupSuccess(workId, effectId, kind),
			},
		);
		this.governance = new ServiceGovernance(this.core);
		this.execution = new ServiceExecution({
			archive,
			core: this.core,
			workspace: ports.workspace,
			runtime: ports.runtime,
			runtimeStorage: this.runtimeStorage,
			invocations: this.invocations,
			executorRuntime: this.executorRuntime,
			getOptions: () => this.configuration.options,
			runInBackground: (operation) => this.runInBackground(operation),
			processPendingEffects: () => this.processPendingEffects(),
			inspectWork: (workId) => this.inspectWork(workId),
		});
		this.workspaceActions = new ServiceWorkspaceActions(
			this.core,
			archive,
			ports.workspace,
			ports.codeHost,
			() => this.configuration.options,
		);
		this.recovery = new ServiceRecovery({
			archive,
			core: this.core,
			runtime: ports.runtime,
			ledger: this.ledger,
			invocations: this.invocations,
			executorRuntime: this.executorRuntime,
			execution: this.execution,
			observer: this.observer,
			completion: this.completion,
			callbacks: {
				requireSupervision: () => this.requireSupervision(),
				runInBackground: (operation) => this.runInBackground(operation),
			},
		});
		this.decisions = new ServiceDecisions({
			archive,
			core: this.core,
			getOptions: () => this.configuration.options,
			execution: this.execution,
			validateHandoffSource: (work, execution, operation) =>
				this.workspaceActions.validateHandoffSource(work, execution, operation),
		});
		this.effectPump = new ServiceEffectPump({
			archive,
			core: this.core,
			invocations: this.invocations,
			executorRuntime: this.executorRuntime,
			feedback: this.feedback,
			observer: this.observer,
			execution: this.execution,
			recovery: this.recovery,
			workspace: ports.workspace,
			heartbeat: this.heartbeat,
			callbacks: {
				acquireSupervision: () => this.acquireSupervision(),
				wakeConclave: (workId, commandId, observationId, reason) =>
					this.wakeConclave(workId, commandId, observationId, reason),
				processOracleWake: (effect, work) => this.processOracleWake(effect, work),
				recordCleanupSuccess: (workId, effectId, kind) => this.recordCleanupSuccess(workId, effectId, kind),
				recordCleanupFailure: (work, effectId, failure, kind) =>
					this.recordCleanupFailure(work, effectId, failure, kind),
				recordWakeFailure: (workId, failure, meta, reason, observationId, dispatchEffectId) =>
					this.recordWakeFailure(workId, failure, meta, reason, observationId, dispatchEffectId),
			},
		});
		this.monitoring = new ServiceMonitoring(this.core, archive, ports, {
			acquireSupervision: () => this.acquireSupervision(),
			processPendingEffects: () => this.processPendingEffects(),
			recordRuntimeState: (work, state, unavailable) =>
				this.executorRuntime.recordRuntimeState(work, state, unavailable),
		});
		if (options.autonomousMonitor !== false) {
			const timer = setInterval(
				() =>
					void this.runAutonomousCycle().catch((error) =>
						this.monitoring.recordServiceMonitorFailure(error instanceof Error ? error : new Error(String(error))),
					),
				AUTONOMOUS_MONITOR_INTERVAL_MS,
			);
			timer.unref();
			this.monitorTimer = timer;
		}
	}

	private acquireSupervision(): boolean {
		if (this.closing) return false;
		return this.configuration.options.supervision === "candidate" && this.archive.acquireSupervision();
	}

	private requireSupervision(): void {
		if (this.acquireSupervision()) return;
		throw this.core.error(
			"invalid-state",
			"Runtime recovery requires the owning Archive supervisor.",
			false,
			"Use the owning User Pi session, or wait for its shutdown before recovering this Work.",
		);
	}

	getRoleSettings(): RoleSettingsMap {
		return this.configuration.getRoleSettings();
	}
	updateRoleSetting(role: GovernedRole, setting: RoleSetting, value: string): void {
		this.configuration.updateRoleSetting(role, setting, value);
	}
	submitWork(input: SubmitWorkInput, meta: CommandMeta): WorkView {
		return this.submission.submit(input, meta);
	}

	listWork(): readonly WorkSummary[] {
		return this.core.listWork();
	}

	inspectWork(workId: string): WorkView {
		return this.core.inspectWork(workId);
	}
	async inspectRuntime(workId: string, meta?: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		return this.monitoring.inspectRuntime(workId, meta, operation);
	}

	async runAutonomousCycle(): Promise<void> {
		await this.monitoring.runAutonomousCycle();
	}
	readRecords(query: RecordQuery | undefined, meta: CommandMeta, cursor?: string): Page<RecordView> {
		return this.core.readRecords(query, meta, cursor);
	}

	readRecordSummaries(query: RecordQuery | undefined, meta: CommandMeta): Page<RecordSummaryView> {
		return this.core.readRecordSummaries(query, meta);
	}

	availableActions(workId: string, actor: Actor, revision?: number, runtimeState?: RuntimeState): readonly Action[] {
		return this.actions.available(workId, actor, revision, runtimeState);
	}

	async perform(command: ActionCommand, operation?: OperationContext): Promise<ServiceResult<WorkView>> {
		try {
			throwIfOperationAborted(operation);
			const fingerprint = actionFingerprint(command.action, command.input);
			const prior = this.archive.findCommand(command.meta.commandId, fingerprint);
			if (prior !== undefined) return this.replayCommand(command, prior);
			const value = await this.performOrThrow(
				{ ...command, meta: { ...command.meta, commandFingerprint: fingerprint } },
				operation,
			);
			return { value };
		} catch (error) {
			return this.core.performError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private replayCommand(
		command: ActionCommand,
		prior: NonNullable<ReturnType<ArchivePort["findCommand"]>>,
	): ServiceResult<WorkView> {
		if (prior.record.workId !== command.workId)
			throw this.core.error(
				"invalid-input",
				`Command ${command.meta.commandId} was already used for Work ${prior.record.workId}.`,
				false,
				"Use a new command ID for this Work.",
			);
		if (prior.record.actor !== command.meta.actor)
			throw this.core.error(
				"forbidden",
				"A command can only be replayed by the actor that created it.",
				false,
				"Use a new command ID in the current role session.",
			);
		const current = this.inspectWork(command.workId);
		if (command.meta.actor !== "user") this.core.requireRoleBinding(command.meta, current);
		return { value: this.replayProjection(command, current, prior.projection) };
	}

	private replayProjection(command: ActionCommand, current: WorkView, prior: WorkView): WorkView {
		return command.action === "reconcile-invocation" ? current : prior;
	}

	private runInBackground(operation: Promise<void>): void {
		this.backgroundOperations.add(operation);
		void operation.finally(() => this.backgroundOperations.delete(operation)).catch(() => undefined);
	}

	private async wakeConclave(
		workId: string,
		commandId: string,
		observationId?: string,
		reason: ConclaveWakeCause = "admission",
	): Promise<void> {
		const work = this.inspectWork(workId);
		this.core.validateModel(
			"conclave",
			this.configuration.options.conclaveModel,
			this.configuration.options.conclaveThinking,
		);
		let binding: RuntimeBinding | undefined;
		try {
			await this.invocations.dispatch(
				work,
				{ workId, role: "conclave", allowance: invocationAllowance(work) },
				async (reservation, operation) => {
					try {
						binding = await this.ports.runtime.ensureSession(
							{
								cwd: this.configuration.options.projectPath,
								model: this.configuration.options.conclaveModel,
								thinking: this.configuration.options.conclaveThinking,
								role: "conclave",
								promptIdentity: this.configuration.options.conclavePromptIdentity,
								bindingScope: { workId },
								tools: ["khala_read_archive", "khala_inspect_runtime", "khala_perform_action", "khala_run_oracle"],
							},
							operation,
						);
					} catch (error) {
						throw new InvocationLaunchError(new Error(String(error)));
					}
					const live = this.inspectWork(workId);
					return this.ports.runtime.send(
						binding,
						`${conclaveWakeMessage(live, observationId, reason)}\nInvocation run ID: ${reservation.runId}.`,
						{ tokenAllowance: reservation.allowance, runId: reservation.runId },
						operation,
					);
				},
			);
			this.heartbeat.set(commandId, `Conclave wake sent for Work ${work.workId}.`);
		} finally {
			if (binding !== undefined) await this.ports.runtime.requestStop(binding).catch(() => undefined);
		}
	}

	async processPendingEffects(): Promise<void> {
		return this.effectPump.processPendingEffects();
	}

	private async processOracleWake(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const pending = work.oraclePending;
		if (pending === undefined) return;
		if (!oracleRequestCurrent(work, pending)) return this.supersedeOracleRequest(work, pending);
		const result = await this.invocations.dispatch(
			work,
			{
				workId: work.workId,
				role: "oracle",
				missionId: pending.missionId,
				executionId: pending.executionId,
				allowance: invocationAllowance(work),
			},
			(reservation, operation) => {
				const current = this.inspectWork(work.workId);
				if (!oracleRequestCurrent(current, pending))
					throw new InvocationLaunchError(new Error("Oracle request was superseded before launch."));
				const inputs = this.decisions.requireOracleInputs(current);
				return this.ports.oracle.review(
					{
						subject: pending.subject,
						mission: inputs.mission,
						diff: inputs.reviewRequest.diffSummary,
						validation: inputs.reviewRequest.validation,
						providerEvidence: current.lastObservation === undefined ? [] : [current.lastObservation.summary],
					},
					this.configuration.options.oracleModel,
					this.configuration.options.oracleThinking,
					{ tokenAllowance: reservation.allowance, runId: reservation.runId },
					operation,
				);
			},
		);
		const current = this.inspectWork(work.workId);
		if (!oracleRequestCurrent(current, pending)) return this.supersedeOracleRequest(current, pending);
		const next: WorkView = {
			...current,
			revision: current.revision + 1,
			oraclePending: undefined,
			nextAction: "Conclave must decide the Verdict.",
		};
		this.core.append({
			meta: {
				actor: "system",
				commandId: `oracle-result:${effect.effectId}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			kind: "oracle-review",
			workId: current.workId,
			missionId: pending.missionId,
			executionId: pending.executionId,
			payload: oraclePayload(result, this.configuration.options.oraclePromptIdentity),
			projection: next,
			summary: `Oracle advisory result: ${result.verdict}.`,
			effects: [schedulerEffect(current.workId, next.revision, undefined, "oracle-result")],
		});
	}

	private supersedeOracleRequest(work: WorkView, pending: NonNullable<WorkView["oraclePending"]>): void {
		if (work.oraclePending?.requestId !== pending.requestId) return;
		this.core.append({
			meta: {
				actor: "system",
				commandId: `oracle-superseded:${pending.requestId}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "oracle-review",
			workId: work.workId,
			missionId: pending.missionId,
			executionId: pending.executionId,
			payload: { requestId: pending.requestId, status: "superseded" },
			projection: { ...work, revision: work.revision + 1, oraclePending: undefined },
			summary: "Oracle request was superseded by a newer lifecycle decision.",
		});
	}

	async pollProvider(workId: string, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		return this.monitoring.pollProvider(workId, meta, operation);
	}
	async recoverWork(
		workId: string,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		return this.recovery.recoverWork(workId, meta, onRecoveryUpdate, operation);
	}

	private recordWakeFailure(
		workId: string,
		failure: Error,
		meta: CommandMeta,
		reason: ConclaveWakeCause | undefined,
		observationId: string | undefined,
		dispatchEffectId: string,
	): WorkView {
		const work = this.inspectWork(workId);
		if (isTerminalWork(work)) return work;
		this.core.checkRevision(work, meta);
		const error = conclaveWakeError(failure, wakeErrorKindFor(reason, work.lastObservation));
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: error,
			nextAction: "Conclave decision failed; inspect Evidence and choose amendment, recovery, or failure.",
		};
		return this.core.append({
			meta,
			kind: "error",
			workId,
			payload: { ...error, dispatchEffectId, dispatchCause: reason ?? "admission" },
			evidenceRefs: observationId === undefined ? error.evidenceRefs : [...error.evidenceRefs, observationId],
			projection: next,
			summary: error.summary,
			// The original outbox effect remains pending. Creating another wake here
			// multiplies the same failed decision on every drain and starves cleanup.
		}).projection;
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.effectPump.stop();
		if (this.monitorTimer !== undefined) clearInterval(this.monitorTimer);
		const operations = this.waitForOperations();
		await closeRuntimeAfterDrain(this.ports.runtime, operations, this.configuration.options.shutdownGraceMs ?? 5_000);
		this.archive.close();
	}
	private async waitForOperations(): Promise<void> {
		while (hasPendingOperations(this.monitoring.activeRun, this.effectPump.activeRun, this.backgroundOperations))
			await Promise.allSettled(
				pendingOperations(this.monitoring.activeRun, this.effectPump.activeRun, this.backgroundOperations),
			);
	}

	private recordCleanupFailure(work: WorkView, effectId: string, failure: Error, kind: string): void {
		const message = failure.message.trim().slice(0, 2_000) || "Cleanup returned no error detail.";
		const marker = `cleanup-failure:${effectId}`;
		if (this.heartbeat.get(marker) === message) return;
		const label = cleanupLabel(kind);
		const failureEnvelope: ErrorEnvelope = {
			code: "external-failure",
			summary: `${label} cleanup failed: ${message}`,
			retryable: true,
			remediation: "Khala will retry cleanup automatically; inspect Evidence if the failure persists.",
			evidenceRefs: [effectId],
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: failureEnvelope,
			nextAction: `${label} cleanup failed; retrying automatically.`,
		};
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
			payload: { effectId, kind, message, previousNextAction: work.nextAction },
			evidenceRefs: [effectId],
			projection: next,
			summary: failureEnvelope.summary,
		});
		this.heartbeat.set(marker, message);
	}

	private recordCleanupSuccess(workId: string, effectId: string, kind: string): void {
		const work = this.archive.project(workId);
		if (!cleanupFailureMatches(work, effectId)) return;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: undefined,
			nextAction: cleanupRestoredAction(work, kind),
		};
		this.core.append({
			meta: {
				actor: "system",
				commandId: `cleanup-completed:${effectId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "execution",
			workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { effectId, kind, status: "completed" },
			projection: next,
			evidenceRefs: [effectId],
			summary: `${cleanupLabel(kind)} cleanup completed after retry.`,
		});
	}

	private async performOrThrow(command: ActionCommand, operation?: OperationContext): Promise<WorkView> {
		const work = this.inspectWork(command.workId);
		this.core.checkRevision(work, command.meta);
		this.authorizeActionCommand(command, work);
		return this.actionHandler(command, work, operation)();
	}

	private authorizeActionCommand(command: ActionCommand, work: WorkView): void {
		if (command.meta.actor !== "user") this.core.requireRoleBinding(command.meta, work);
	}

	private actionHandler(
		command: ActionCommand,
		work: WorkView,
		operation: OperationContext | undefined,
	): () => Promise<WorkView> {
		const handlers = {
			admit: async () => this.governance.admit(work, command.meta),
			"request-input": async () => this.governance.requestInput(work, command.meta, command.input),
			"amend-terms": async () => this.governance.amendTerms(work, command.meta, command.input),
			"amend-mission": async () => this.governance.amendMission(work, command.meta, command.input),
			"launch-observer": async () => this.observer.launch(work, command.meta),
			"record-assessment": async () => this.observer.recordAssessment(work, command.meta, command.input),
			"start-execution": async () => this.execution.start(work, command.meta, operation),
			"record-signal": async () => this.workspaceActions.recordSignal(work, command.meta, command.input, operation),
			"commit-sandbox": async () => this.workspaceActions.commitSandbox(work, command.meta, operation),
			"run-validation": async () => this.workspaceActions.runValidation(work, command.meta, operation),
			"create-review-request": async () => this.workspaceActions.createReviewRequest(work, command.meta, operation),
			"run-oracle": async () => this.decisions.runOracle(work, command.meta, command.input, operation),
			verdict: async () => this.decisions.verdict(work, command.meta, command.input, operation),
			"deliver-feedback": async () => this.feedback.deliverFeedback(work, command.meta, command.input),
			"record-review": async () => this.governance.recordReview(work, command.meta, command.input),
			"record-outcome": async () => this.completion.recordOutcome(work, command.meta),
			cancel: async () => this.completion.cancel(work, command.meta),
			recover: async () => this.recovery.recoverAction(work, command, operation),
			"reconcile-invocation": async () => this.reconcileInvocationAction(work, command.meta, command.input, operation),
			"rename-work": async () => this.completion.renameWork(work, command.meta, command.input),
			"amend-budget": async () => this.completion.amendBudget(work, command.meta, command.input),
			"fail-work": async () => this.completion.failWork(work, command.meta, command.input),
		} satisfies Record<Action["kind"], () => Promise<WorkView>>;
		return handlers[command.action];
	}

	private async reconcileInvocationAction(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
		operation: OperationContext | undefined,
	): Promise<WorkView> {
		this.core.requireActor(meta, "user");
		this.requireSupervision();
		const reconciled = await reconcileInvocation(work, meta, input, this.ledger, this.ports.runtime, operation);
		const refreshed = await this.refreshReconciledExecutorRuntime(reconciled, input?.runId, operation).catch(
			() => reconciled,
		);
		const current = this.clearInvocationGateAttention(refreshed);
		queueMicrotask(() => void this.processPendingEffects().catch(() => undefined));
		return current;
	}

	private async refreshReconciledExecutorRuntime(
		work: WorkView,
		runId: string | undefined,
		operation: OperationContext | undefined,
	): Promise<WorkView> {
		if (runId === undefined) return work;
		if (isTerminalWork(work)) return work;
		const fact = this.ledger.find(runId.trim());
		const binding = reconciledExecutorBinding(work, fact);
		if (binding === undefined) return work;
		const state = await this.ports.runtime.getState(binding, operation).catch(() => "unknown" as const);
		return this.executorRuntime.recordRuntimeState(work, state);
	}

	private clearInvocationGateAttention(work: WorkView): WorkView {
		if (hasActiveInvocations(work)) return work;
		if (!hasHeldInvocationAttention(work)) return work;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: undefined,
			nextAction: isTerminalWork(work) ? work.nextAction : "Work dispatch is pending.",
		};
		return this.core.append({
			meta: {
				actor: "system",
				commandId: `invocation-gate-restored:${work.workId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "execution",
			workId: work.workId,
			payload: { dispatch: "eligible" },
			projection: next,
			summary: "Held invocation dispatch gate was restored.",
		}).projection;
	}
}
