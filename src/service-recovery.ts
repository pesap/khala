import type { ArchivePort } from "./archive.js";
import type { ActionCommand, Actor, CommandMeta, Execution, RecoveryUpdate, WorkView } from "./model.js";
import type { OperationContext, RuntimeBinding, RuntimeState, ServicePorts } from "./ports.js";
import type { RunLedger } from "./run-ledger.js";
import { ArchiveCore } from "./service-archive-core.js";
import { executionFailure, lifecycleEffects } from "./service-dispatch-policy.js";
import { ServiceExecution } from "./service-execution.js";
import { ExecutorRuntimeCoordinator } from "./service-executor-runtime.js";
import {
	hasBoundObserverReservation,
	hasRecoverableWork,
	hasUnboundObserverReservation,
	isCancelledWork,
	isRecoverableExecution,
	isTerminalWork,
	notifyRecoveryCheck,
	notifyRecoveryStage,
	recoveredExecution,
	recoveredExecutionProjection,
	stopReboundRuntime,
} from "./service-foundation-policy.js";
import { isResumableIdleExecutor } from "./service-idle-recovery.js";
import { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { reconcileCompletedInvocations } from "./service-invocation-recovery.js";
import { ServiceObserver } from "./service-observer.js";
import { failedRecoveryExecution, throwIfOperationAborted } from "./service-runtime-policy.js";
import { executorRecoveryEffect, isRuntimeUnavailable, sameRuntimeBinding } from "./service-state-policy.js";
import { WorkCompletion } from "./service-work-completion.js";

function hasActiveInvocations(work: WorkView): boolean {
	return (work.activeInvocations?.length ?? 0) > 0;
}

function hasHeldInvocationAttention(work: WorkView): boolean {
	return (
		work.lastError?.code === "external-failure" &&
		work.lastError.summary === "Model dispatch is waiting for an existing invocation to settle."
	);
}

function sameExecutorExecution(left: Execution, right: Execution): boolean {
	return [left.executionId === right.executionId, sameRuntimeBinding(left.pi, right.pi)].every(Boolean);
}

function cancelledExecutionMatches(current: WorkView, prior: WorkView): boolean {
	if (prior.execution === undefined) return current.execution === undefined;
	if (current.execution === undefined) return false;
	return sameExecutorExecution(current.execution, prior.execution);
}

function isPendingExecutorPlaceholder(execution: Execution): boolean {
	const binding = execution.pi;
	if (binding === undefined || binding.sessionId !== `pending:${execution.executionId}`) return false;
	return [
		execution.runtimeState,
		binding.processGroupId,
		binding.processStartTime,
		binding.capabilityNonce,
		binding.processMarker,
	].every((value) => value === undefined);
}

function nextActionAfterInvocationGate(work: WorkView): string {
	return isTerminalWork(work) ? work.nextAction : "Work dispatch is pending.";
}

type RecoveryCallbacks = Readonly<{
	requireSupervision: () => void;
	runInBackground: (operation: Promise<void>) => void;
}>;

export class ServiceRecovery {
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly runtime: ServicePorts["runtime"];
	private readonly ledger: RunLedger;
	private readonly invocations: InvocationCoordinator;
	private readonly executorRuntime: ExecutorRuntimeCoordinator;
	private readonly execution: ServiceExecution;
	private readonly observer: ServiceObserver;
	private readonly completion: WorkCompletion;
	private readonly callbacks: RecoveryCallbacks;

	constructor(input: {
		archive: ArchivePort;
		core: ArchiveCore;
		runtime: ServicePorts["runtime"];
		ledger: RunLedger;
		invocations: InvocationCoordinator;
		executorRuntime: ExecutorRuntimeCoordinator;
		execution: ServiceExecution;
		observer: ServiceObserver;
		completion: WorkCompletion;
		callbacks: RecoveryCallbacks;
	}) {
		this.archive = input.archive;
		this.core = input.core;
		this.runtime = input.runtime;
		this.ledger = input.ledger;
		this.invocations = input.invocations;
		this.executorRuntime = input.executorRuntime;
		this.execution = input.execution;
		this.observer = input.observer;
		this.completion = input.completion;
		this.callbacks = input.callbacks;
	}

	async authorizeExecutorRecovery(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		const execution = this.recoverableExecution(work);
		await this.requireUnavailableRuntime(execution.pi, operation);
		return this.appendAuthorizedRecovery(work, meta, execution).projection;
	}

	async recoverAction(work: WorkView, command: ActionCommand, operation?: OperationContext): Promise<WorkView> {
		if (isCancelledWork(work)) return this.recoverCancelledWork(work, command, operation);
		if (work.preparation?.status === "waiting") return this.execution.recoverPreparation(work, command.meta, operation);
		return this.recoverPreparedAction(work, command, operation);
	}

	async recoverWork(
		workId: string,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireAnyActor(meta, ["user", "conclave"]);
		if (meta.actor === "user") this.callbacks.requireSupervision();
		throwIfOperationAborted(operation);
		onRecoveryUpdate?.({ stage: "checking", message: "Checking the current Work state." });
		let work = this.core.inspectWork(workId);
		this.core.checkRevision(work, meta);
		work = await this.reconcileRecoveryInvocations(work, operation);
		return this.recoveryPath(work, { ...meta, expectedWorkRevision: work.revision }, onRecoveryUpdate, operation);
	}

	private async recoverPreparedAction(
		work: WorkView,
		command: ActionCommand,
		operation?: OperationContext,
	): Promise<WorkView> {
		if (this.userCanResumeIdle(work, command.meta.actor))
			return this.recoverIdleExecutorAction(work, command, operation);
		return this.recoverRuntime(work, command.meta, command.onRecoveryUpdate, operation);
	}

	private async recoverCancelledWork(
		work: WorkView,
		command: ActionCommand,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireActor(command.meta, "user");
		this.callbacks.requireSupervision();
		throwIfOperationAborted(operation);
		this.requireSettledCancelledInvocations(work);
		const execution = work.execution;
		if (execution?.pi !== undefined && this.cancelledExecutionNeedsStop(execution))
			await this.executorRuntime.stopAfterTurn(work, execution.pi, ["stopped"]);
		throwIfOperationAborted(operation);
		const current = this.core.inspectWork(work.workId);
		this.core.checkRevision(current, command.meta);
		this.requireSameCancelledExecution(current, work);
		return this.completion.recoverStopped(current, command.meta, command.onRecoveryUpdate);
	}

	private cancelledExecutionNeedsStop(execution: Execution): boolean {
		if (!isPendingExecutorPlaceholder(execution)) return true;
		return (
			this.archive.query({ executionId: execution.executionId, kinds: ["invocation"], order: "desc" }).items.length > 0
		);
	}

	private requireSettledCancelledInvocations(work: WorkView): void {
		if (!hasActiveInvocations(work)) return;
		throw this.core.error(
			"invalid-state",
			"Cancelled Work cannot be recovered until every invocation has settled.",
			false,
			"Wait for active turns to stop; use Reconcile held usage if settlement remains uncertain.",
		);
	}

	private requireSameCancelledExecution(current: WorkView, prior: WorkView): void {
		if (isCancelledWork(current) && cancelledExecutionMatches(current, prior)) return;
		throw this.core.error(
			"invalid-state",
			"The cancelled Work changed while its Executor was stopping.",
			false,
			"Refresh the Work before recovering it.",
		);
	}

	private userCanResumeIdle(work: WorkView, actor: Actor): boolean {
		return actor === "user" && isResumableIdleExecutor(work, "idle");
	}

	private async recoverIdleExecutorAction(
		work: WorkView,
		command: ActionCommand,
		operation?: OperationContext,
	): Promise<WorkView> {
		const binding = this.core.requireExecution(work, "running").pi;
		if (binding === undefined) return this.recoverRuntime(work, command.meta, command.onRecoveryUpdate, operation);
		const runtimeState = await this.runtime.getState(binding, operation);
		const current = this.core.inspectWork(work.workId);
		this.core.checkRevision(current, command.meta);
		if (!this.currentExecutorBindingMatches(current, binding))
			throw this.core.error(
				"invalid-state",
				"The Executor binding changed before recovery.",
				false,
				"Refresh the Work and retry its current recovery action.",
			);
		if (!isResumableIdleExecutor(current, runtimeState))
			return this.recoverRuntime(current, command.meta, command.onRecoveryUpdate, operation);
		return this.recoverWork(current.workId, command.meta, command.onRecoveryUpdate, operation);
	}

	private currentExecutorBindingMatches(work: WorkView, binding: RuntimeBinding): boolean {
		return work.execution !== undefined && sameRuntimeBinding(work.execution.pi, binding);
	}

	private async recoverRuntime(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireAnyActor(meta, ["user", "conclave"]);
		onRecoveryUpdate?.({ stage: "checking", message: "Checking whether this Work can be recovered." });
		if (work.execution?.state === "queued") return this.recoverWork(work.workId, meta, onRecoveryUpdate, operation);
		const execution = this.recoverableExecution(work);
		await this.requireUnavailableRuntimeForRecovery(execution.pi, operation);
		return this.recoverWork(work.workId, meta, onRecoveryUpdate, operation);
	}

	private async reconcileRecoveryInvocations(
		work: WorkView,
		operation: OperationContext | undefined,
	): Promise<WorkView> {
		const invocations = work.activeInvocations ?? [];
		if (invocations.some((invocation) => this.invocations.activeRuns.has(invocation.runId))) return work;
		if (invocations.length === 0) return work;
		const reconciled = await reconcileCompletedInvocations(
			work,
			this.ledger,
			this.runtime,
			this.invocations.activeRuns,
			operation,
		);
		return this.clearInvocationGateAttention(reconciled);
	}

	private recoveryPath(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> | WorkView {
		if (isTerminalWork(work)) return work;
		if (hasUnboundObserverReservation(work)) return this.observer.reconcileReservation(work, meta);
		if (hasBoundObserverReservation(work)) return this.observer.recover(work, meta, onRecoveryUpdate, operation);
		return this.recoverWithoutObserver(work, meta, onRecoveryUpdate, operation);
	}

	private recoverWithoutObserver(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		if (work.execution?.state === "queued") return this.execution.recoverQueued(work);
		return meta.actor === "conclave"
			? this.authorizeExecutorRecovery(work, meta, operation)
			: this.recoverExecutorRuntime(work, meta, onRecoveryUpdate, operation);
	}

	async recoverExecutorRuntime(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		if (!hasRecoverableWork(work)) return work;
		if (work.execution.state === "queued") return this.execution.recoverQueued(work);
		if (!isRecoverableExecution(work.execution)) return work;
		notifyRecoveryCheck(onRecoveryUpdate, operation, "Executor");
		const executorState = await this.runtime.getState(work.execution.pi, operation);
		throwIfOperationAborted(operation);
		return this.recoverExecutorByState(work, meta, work.execution, executorState, onRecoveryUpdate, operation);
	}

	private async recoverExecutorByState(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution & { pi: RuntimeBinding },
		executorState: RuntimeState,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		if (executorState === "working") return this.executorRuntime.recordRuntimeState(work, "working");
		if (executorState === "idle") return this.recoverIdleExecutorAfterProbe(work, execution);
		if (!isRuntimeUnavailable(executorState)) return work;
		return this.rebindExecutorRuntime(work, meta, execution, executorState, onRecoveryUpdate, operation);
	}

	private recoverIdleExecutorAfterProbe(work: WorkView, execution: Execution & { pi: RuntimeBinding }): WorkView {
		const current = this.archive.project(work.workId);
		if (current === undefined) return work;
		const currentExecution = current.execution;
		if (currentExecution === undefined) return current;
		if (!sameExecutorExecution(currentExecution, execution)) return current;
		return this.recoverIdleExecutor(current, currentExecution);
	}

	private recoverIdleExecutor(work: WorkView, execution: Execution): WorkView {
		if (execution.state === "running" && isResumableIdleExecutor(work, "idle")) {
			this.callbacks.runInBackground(this.execution.drive(work));
			return work;
		}
		return execution.runtimeState === "idle" ? work : this.executorRuntime.recordRuntimeState(work, "idle");
	}

	private async rebindExecutorRuntime(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution & { pi: RuntimeBinding },
		executorState: RuntimeState,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
		operation?: OperationContext,
	): Promise<WorkView> {
		notifyRecoveryStage(onRecoveryUpdate, "stopping", "Closing the unavailable Work attempt safely.");
		await this.stopInactiveExecutorTurn(work, execution);
		notifyRecoveryStage(onRecoveryUpdate, "restoring", "Restoring the Work's Executor.");
		this.core.validateModel("executor", execution.model, execution.thinking);
		let rebound: RuntimeBinding | undefined;
		try {
			rebound = await this.ensureExecutorBinding(work, execution, operation);
			notifyRecoveryStage(onRecoveryUpdate, "confirming", "Confirming the restored Work can continue.");
			await this.confirmExecutorRuntime(rebound, operation);
			return this.appendExecutorRecovery(work, meta, execution, rebound, onRecoveryUpdate);
		} catch (error) {
			return this.reconcileExecutorRecoveryError(
				work,
				meta,
				execution,
				executorState,
				rebound,
				operation,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private async confirmExecutorRuntime(binding: RuntimeBinding, operation?: OperationContext): Promise<void> {
		if (isRuntimeUnavailable(await this.runtime.getState(binding, operation)))
			throw new Error("The recovered Executor runtime is still unavailable.");
	}

	private async reconcileExecutorRecoveryError(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution & { pi: RuntimeBinding },
		executorState: RuntimeState,
		rebound: RuntimeBinding | undefined,
		operation: OperationContext | undefined,
		error: Error,
	): Promise<WorkView> {
		if (operation?.signal?.aborted === true) return this.abortExecutorRecovery(rebound, error);
		return this.recordExecutorRecoveryFailure(work, meta, execution, executorState, rebound, error);
	}

	private async abortExecutorRecovery(rebound: RuntimeBinding | undefined, error: Error): Promise<never> {
		if (rebound !== undefined) await this.runtime.requestStop(rebound).catch(() => undefined);
		throw error;
	}

	private async stopInactiveExecutorTurn(work: WorkView, execution: Execution): Promise<void> {
		if (execution.pi === undefined) return;
		if (!this.executorRuntime.hasActiveTurn(work.workId, execution.executionId))
			await this.runtime.requestStop(execution.pi).catch(() => undefined);
	}

	private async ensureExecutorBinding(
		work: WorkView,
		execution: Execution & { pi: RuntimeBinding },
		operation?: OperationContext,
	): Promise<RuntimeBinding> {
		return this.runtime.ensureSession(
			{
				cwd: execution.sandbox.path,
				model: execution.model,
				thinking: execution.thinking,
				role: "executor",
				promptIdentity: execution.promptIdentity,
				allowedPaths: work.terms.allowedPaths,
				sandboxRoot: execution.sandbox.path,
				bindingScope: { workId: work.workId, executionId: execution.executionId },
				tools: [
					"read",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"khala_read_archive",
					"khala_record_signal",
					"khala_perform_action",
				],
				sessionPath: execution.pi.sessionPath,
			},
			operation,
		);
	}

	private appendExecutorRecovery(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution & { pi: RuntimeBinding },
		rebound: RuntimeBinding,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): WorkView {
		const recovered = recoveredExecution(execution, rebound);
		const next = recoveredExecutionProjection(work, execution, recovered);
		notifyRecoveryStage(onRecoveryUpdate, "finishing", "Saving the recovery result.");
		const result = this.core.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: recovered,
			projection: next,
			summary: `Execution ${execution.executionId} runtime was reconciled.`,
		}).projection;
		if (execution.state === "running") this.callbacks.runInBackground(this.execution.drive(result));
		return result;
	}

	private async recordExecutorRecoveryFailure(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution & { pi: RuntimeBinding },
		executorState: RuntimeState,
		rebound: RuntimeBinding | undefined,
		error: Error,
	): Promise<WorkView> {
		await stopReboundRuntime(this.runtime, rebound);
		const failed = failedRecoveryExecution(execution, executorState);
		const failure = executionFailure(work, execution.executionId, error.message);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: failed,
			lastError: failure,
			nextAction: "Execution runtime unavailable; replace it explicitly.",
		};
		return this.core.append({
			meta,
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: failure,
			projection: next,
			summary: `Execution ${execution.executionId} runtime could not be reconciled.`,
			effects: lifecycleEffects(work.workId, next.revision, failed, undefined, true, "executor-failed"),
		}).projection;
	}

	private appendAuthorizedRecovery(work: WorkView, meta: CommandMeta, execution: Execution) {
		const nextExecution: Execution = { ...execution, runtimeState: "pending" };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: nextExecution,
			lastError: undefined,
			nextAction: "Conclave authorized parent Executor recovery.",
		};
		return this.core.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: "Conclave authorized parent Executor recovery.",
			effects: [executorRecoveryEffect(work.workId, next.revision, execution.executionId)],
		});
	}

	private recoverableExecution(work: WorkView): Execution & { pi: RuntimeBinding } {
		const execution = work.execution;
		if (isRecoverableExecution(execution)) return execution;
		throw this.core.error(
			"invalid-state",
			"No recoverable Executor runtime is bound to this Work.",
			false,
			"Inspect the current Execution before recovering it.",
		);
	}

	private async requireUnavailableRuntime(binding: RuntimeBinding, operation?: OperationContext): Promise<void> {
		if (isRuntimeUnavailable(await this.runtime.getState(binding, operation))) return;
		throw this.core.error(
			"invalid-state",
			"The Executor runtime is currently reachable and does not need recovery.",
			false,
			"Inspect the current runtime state before recovering it.",
		);
	}

	private async requireUnavailableRuntimeForRecovery(
		binding: RuntimeBinding,
		operation?: OperationContext,
	): Promise<void> {
		if (isRuntimeUnavailable(await this.runtime.getState(binding, operation))) return;
		throw this.core.error(
			"invalid-state",
			"The Executor runtime is reachable and does not need recovery.",
			false,
			"Refresh the Work and use the available action for its current state.",
		);
	}

	private clearInvocationGateAttention(work: WorkView): WorkView {
		if (hasActiveInvocations(work) || !hasHeldInvocationAttention(work)) return work;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: undefined,
			nextAction: nextActionAfterInvocationGate(work),
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
