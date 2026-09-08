import { nanoid } from "nanoid";
import { type ArchivePort, ExecutionAdmissionConflict, type PendingArchiveEffect } from "./archive.js";
import { InvocationLaunchError } from "./dispatch.js";
import type { CommandMeta, Execution, WorkView } from "./model.js";
import type { OperationContext, RuntimeBinding, ServicePorts } from "./ports.js";
import type { ReservedInvocation } from "./run-ledger.js";
import type { RuntimeStorage } from "./runtime-storage.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable, type ServiceOptions } from "./service-contracts.js";
import {
	currentExecutorTurnIsCurrent,
	executionAdmissionAvailable,
	executionFailure,
	failedExecutorProjection,
	lifecycleEffects,
} from "./service-dispatch-policy.js";
import { ExecutorRuntimeCoordinator } from "./service-executor-runtime.js";
import {
	type ExecutorDriveContext,
	type InitialExecutorTurn,
	type ServiceFailure,
	systemEffectMeta,
	type WorkWithMission,
} from "./service-foundation-policy.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { executorDriveContext } from "./service-lifecycle-policy.js";
import {
	hasQueuedMission,
	isStartableMission,
	queuedExecutionProjection,
	throwIfOperationAborted,
} from "./service-runtime-policy.js";
import { executorEffect, invocationAllowance, sandboxCleanupEffect } from "./service-state-policy.js";

type PreparedExecution = Readonly<{ execution: Execution; queued: WorkView }>;

export class ServiceExecution {
	private readonly drivingExecutions = new Map<string, Promise<void>>();
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly workspace: ServicePorts["workspace"];
	private readonly runtime: ServicePorts["runtime"];
	private readonly runtimeStorage: RuntimeStorage;
	private readonly invocations: InvocationCoordinator;
	private readonly executorRuntime: ExecutorRuntimeCoordinator;
	private readonly getOptions: () => ServiceOptions;
	private readonly runInBackground: (operation: Promise<void>) => void;
	private readonly processPendingEffects: () => Promise<void>;
	private readonly inspectWork: (workId: string) => WorkView;

	constructor(input: {
		archive: ArchivePort;
		core: ArchiveCore;
		workspace: ServicePorts["workspace"];
		runtime: ServicePorts["runtime"];
		runtimeStorage: RuntimeStorage;
		invocations: InvocationCoordinator;
		executorRuntime: ExecutorRuntimeCoordinator;
		getOptions: () => ServiceOptions;
		runInBackground: (operation: Promise<void>) => void;
		processPendingEffects: () => Promise<void>;
		inspectWork: (workId: string) => WorkView;
	}) {
		this.archive = input.archive;
		this.core = input.core;
		this.workspace = input.workspace;
		this.runtime = input.runtime;
		this.runtimeStorage = input.runtimeStorage;
		this.invocations = input.invocations;
		this.executorRuntime = input.executorRuntime;
		this.getOptions = input.getOptions;
		this.runInBackground = input.runInBackground;
		this.processPendingEffects = input.processPendingEffects;
		this.inspectWork = input.inspectWork;
	}

	async start(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		const startable = this.requireStartableMission(work);
		if (this.executionAlreadyStarted(startable.execution)) return startable;
		return this.startAvailable(startable, meta, operation);
	}

	private async startAvailable(
		work: WorkWithMission,
		meta: CommandMeta,
		operation?: OperationContext,
	): Promise<WorkView> {
		if (work.preparation?.status === "waiting") return work;
		const options = this.getOptions();
		if (!executionAdmissionAvailable(work, this.archive.listProjects(), options.maxConcurrentExecutions)) return work;
		this.core.validateModel("executor", options.executorModel, options.executorThinking);
		return this.prepareAndAppend(work, meta, operation);
	}

	async recoverPreparation(work: WorkView, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireActor(meta, "user");
		if (!hasQueuedMission(work))
			throw this.core.error(
				"invalid-state",
				"Only queued Work with failed preparation can be recovered.",
				false,
				"Inspect the current Work state.",
			);
		let prepared: PreparedExecution;
		try {
			prepared = await this.prepare(work, operation);
		} catch (error) {
			return this.handleRecoveryPreparationFailure(
				work.workId,
				meta,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		return this.appendPrepared(work, meta, prepared, operation);
	}

	async processWake(effect: PendingArchiveEffect, work: WorkView): Promise<void> {
		const state = work.execution?.state;
		if (state === "queued") {
			await this.launchQueued(work, systemEffectMeta(effect, work));
			return;
		}
		if (state === "running") await this.drive(work);
	}

	async recoverQueued(work: WorkView): Promise<WorkView> {
		await this.processPendingEffects();
		return this.inspectWork(work.workId);
	}

	async drive(work: WorkView): Promise<void> {
		const context = executorDriveContext(work);
		if (context === undefined || this.drivingExecutions.has(context.key)) return;
		const turn = this.executorRuntime.runTracked(work.workId, context.execution.executionId, async () => {
			try {
				await this.executorRuntime.dispatchTurn({ work, execution: context.execution });
				queueMicrotask(() => void this.processPendingEffects().catch(() => undefined));
			} catch (error) {
				await this.failTurn(work, context.execution, error instanceof Error ? error : new Error(String(error)));
			}
		});
		this.drivingExecutions.set(context.key, turn);
		try {
			await turn;
		} finally {
			this.finishDrive(context, turn);
		}
	}

	private async prepareAndAppend(
		work: WorkWithMission,
		meta: CommandMeta,
		operation?: OperationContext,
	): Promise<WorkView> {
		let prepared: PreparedExecution;
		try {
			prepared = await this.prepare(work, operation);
		} catch (error) {
			return this.handleStartPreparationFailure(
				work.workId,
				meta,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		return this.appendPrepared(work, meta, prepared, operation);
	}

	private handleRecoveryPreparationFailure(workId: string, meta: CommandMeta, error: Error): WorkView {
		const current = this.inspectWork(workId);
		if (current.preparation?.status === "waiting") return current;
		if (!hasQueuedMission(current)) return current;
		return this.recordPreparationWaiting(current, meta, error);
	}

	private handleStartPreparationFailure(workId: string, meta: CommandMeta, error: Error): WorkView {
		const current = this.inspectWork(workId);
		if (current.preparation?.status === "waiting") return current;
		if (!isStartableMission(current)) return current;
		return this.recordPreparationWaiting(current, meta, error);
	}

	private recordPreparationWaiting(work: WorkWithMission, meta: CommandMeta, error: Error): WorkView {
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			preparation: {
				status: "waiting",
				prerequisiteId: `${work.mission.missionId}:${work.revision}`,
				operation: "dependencies",
				diagnostic: error.message.slice(0, 2_000),
				recovery: "user",
			},
			nextAction: "Executor preparation failed; User recovery is required.",
			lastError: {
				code: "external-failure",
				summary: "Executor preparation failed before launch.",
				retryable: false,
				remediation: "Review the prerequisite evidence and explicitly recover after correcting the environment.",
				evidenceRefs: [work.mission.missionId],
			},
		};
		return this.core.append({
			meta: { ...meta, actor: meta.actor === "user" ? "user" : "system" },
			kind: "error",
			workId: work.workId,
			missionId: work.mission.missionId,
			payload: {
				cause: "preparation-failed",
				prerequisiteId: next.preparation?.prerequisiteId,
				diagnostic: error.message,
			},
			projection: next,
			summary: "Executor preparation is waiting for explicit User recovery.",
		}).projection;
	}

	private async prepare(work: WorkWithMission, operation?: OperationContext): Promise<PreparedExecution> {
		const executionId = nanoid();
		let sandbox: Execution["sandbox"] | undefined;
		try {
			const options = this.getOptions();
			const preflight = await this.workspace.preflight(options.projectPath, options.targetBranch, operation);
			sandbox = await this.workspace.ensureSandbox(
				{
					workId: work.workId,
					executionId,
					mission: work.mission,
					projectPath: options.projectPath,
					baseCommit: preflight.headCommit,
				},
				operation,
			);
			await this.workspace.prepareSandbox(sandbox, operation);
			const allowance = Math.min(
				Math.floor(work.budget.maxTokens / 2),
				work.budget.maxTokens - work.budget.consumedTokens - work.budget.reservedTokens,
			);
			if (allowance <= 0) throw new Error("Work budget has no available Executor allowance.");
			const execution: Execution = {
				executionId,
				workId: work.workId,
				missionId: work.mission.missionId,
				state: "queued",
				pi: {
					sessionId: `pending:${executionId}`,
					sessionPath: this.runtimeStorage.persistentSessionPath("executor", `${work.workId}:${executionId}`),
				},
				model: options.executorModel,
				thinking: options.executorThinking,
				tokenAllowance: allowance,
				promptIdentity: options.executorPromptIdentity,
				sandbox,
			};
			return { execution, queued: queuedExecutionProjection(work, execution) };
		} catch (error) {
			if (sandbox !== undefined) await this.reconcileSandboxCleanup(work.workId, executionId, sandbox);
			throw error;
		}
	}

	private async appendPrepared(
		work: WorkWithMission,
		meta: CommandMeta,
		prepared: PreparedExecution,
		operation?: OperationContext,
	): Promise<WorkView> {
		let result: ReturnType<ArchiveCore["append"]>;
		try {
			throwIfOperationAborted(operation);
			result = this.core.append({
				meta,
				kind: "execution",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId: prepared.execution.executionId,
				payload: prepared.execution,
				projection: prepared.queued,
				summary: `Execution ${prepared.execution.executionId} queued.`,
				effects: [executorEffect(work.workId, prepared.queued.revision)],
				executionGuard: {
					maxConcurrentExecutions: this.getOptions().maxConcurrentExecutions,
					enforceFifo: work.state === "queued",
				},
			});
		} catch (error) {
			return this.handleAppendFailure(
				work,
				prepared.execution,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		if (result.duplicate)
			await this.reconcileSandboxCleanup(work.workId, prepared.execution.executionId, prepared.execution.sandbox);
		return result.projection;
	}

	private async handleAppendFailure(work: WorkView, execution: Execution, error: Error): Promise<WorkView> {
		await this.reconcileSandboxCleanup(work.workId, execution.executionId, execution.sandbox, error.message);
		if (error instanceof ExecutionAdmissionConflict) return this.inspectWork(work.workId);
		throw error;
	}

	private async reconcileSandboxCleanup(
		workId: string,
		executionId: string,
		sandbox: Execution["sandbox"],
		reason?: string,
	): Promise<void> {
		try {
			await this.workspace.removeSandbox(sandbox);
			return;
		} catch (error) {
			const current = this.inspectWork(workId);
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				nextAction: "Reserved sandbox cleanup is pending.",
			};
			this.core.append({
				meta: {
					actor: "system",
					commandId: `sandbox-cleanup:${executionId}:${current.revision}`,
					expectedWorkRevision: current.revision,
					schemaVersion: 1,
				},
				kind: "error",
				workId,
				payload: { executionId, message: reason ?? (error instanceof Error ? error.message : String(error)) },
				projection: next,
				summary: "Reserved sandbox cleanup was deferred to the outbox.",
				effects: [sandboxCleanupEffect(workId, executionId, sandbox)],
			});
		}
	}

	private launchQueued(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		const execution = this.core.requireExecution(work, "queued");
		return new Promise<WorkView>((resolve, reject) => {
			const turn = this.executorRuntime
				.runTracked(work.workId, execution.executionId, () => this.runInitialInvocation(work, meta, execution, resolve))
				.catch(reject);
			this.runInBackground(turn);
		});
	}

	private async runInitialInvocation(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		started: (work: WorkView) => void,
	): Promise<void> {
		try {
			const result = await this.invocations.dispatch(
				work,
				{
					workId: work.workId,
					role: "executor",
					missionId: execution.missionId,
					executionId: execution.executionId,
					allowance: Math.min(execution.tokenAllowance, invocationAllowance(work)),
				},
				(reservation, operation) => this.sendInitialTurn(work, meta, execution, reservation, started, operation),
			);
			this.executorRuntime.recordTurn(result.running);
			queueMicrotask(() => void this.processPendingEffects().catch(() => undefined));
		} catch (error) {
			if (error instanceof RunGateUnavailable) throw error;
			await this.reconcileInitialFailure(
				work,
				meta,
				execution,
				error instanceof Error ? error : new Error(String(error)),
			);
			queueMicrotask(() => void this.processPendingEffects().catch(() => undefined));
			throw this.core.error(
				"external-failure",
				"The Executor runtime could not be started.",
				true,
				"Inspect the failure evidence and retry the Execution.",
			);
		}
	}

	private async sendInitialTurn(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		reservation: Pick<ReservedInvocation, "runId" | "allowance">,
		started: (work: WorkView) => void,
		operation: OperationContext,
	): Promise<InitialExecutorTurn> {
		const current = this.inspectWork(work.workId);
		if (current.execution?.executionId !== execution.executionId || current.execution.state !== "queued")
			throw new RunGateUnavailable();
		const binding = await this.executorRuntime.ensureBinding(current, execution, operation);
		const running = this.startInitial(current, meta, execution, binding);
		started(running);
		const live = this.inspectWork(work.workId);
		const turn = await this.runtime.send(
			binding,
			`Work ${live.workId}, Execution ${execution.executionId} is bound. Read the Archive, inspect the sandbox, implement the Mission, validate it, publish the draft review request, and send evidence-bearing Signals. The current Work revision is ${live.revision}.\nInvocation run ID: ${reservation.runId}.`,
			{ tokenAllowance: reservation.allowance, runId: reservation.runId },
			operation,
		);
		return { ...turn, running, binding };
	}

	private startInitial(work: WorkView, meta: CommandMeta, execution: Execution, binding: RuntimeBinding): WorkView {
		try {
			return this.startRunning(work, meta, execution, binding, false);
		} catch (error) {
			void this.runtime.requestStop(binding).catch(() => undefined);
			throw new InvocationLaunchError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private startRunning(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		binding: RuntimeBinding,
		drive = true,
	): WorkView {
		const running: Execution = {
			...execution,
			state: "running",
			runtimeState: "working",
			pi: binding,
			startedAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: running,
			nextAction: "Executor is working.",
		};
		const result = this.core.append({
			meta: { ...meta, commandId: `${meta.commandId}:running`, expectedWorkRevision: work.revision },
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: running,
			projection: next,
			summary: `Execution ${execution.executionId} is running.`,
		}).projection;
		if (drive) this.runInBackground(this.drive(result));
		return result;
	}

	private async reconcileInitialFailure(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		error: Error,
	): Promise<void> {
		const current = this.inspectWork(work.workId);
		const state = current.execution?.state;
		if (state === "queued") {
			await this.failQueued(current, meta, execution, error);
			return;
		}
		if (state !== "running") return;
		await this.failTurn(current, this.core.requireExecution(current, "running"), error);
	}

	private async failQueued(
		work: WorkView,
		meta: CommandMeta,
		execution: Execution,
		error: ServiceFailure,
	): Promise<void> {
		const failed: Execution = {
			...execution,
			state: "failed",
			blockReason: undefined,
			endedAt: new Date().toISOString(),
		};
		const failure = executionFailure(work, execution.executionId, error.message);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: failed,
			lastError: failure,
			nextAction: "Execution failed; Conclave may replace it.",
		};
		this.core.append({
			meta: { ...meta, commandId: `${meta.commandId}:failed`, expectedWorkRevision: work.revision },
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: failure,
			projection: next,
			summary: `Execution ${execution.executionId} failed to start.`,
			effects: lifecycleEffects(work.workId, next.revision, next.execution, undefined, true, "executor-failed"),
		});
	}

	private finishDrive(context: ExecutorDriveContext, turn: Promise<void>): void {
		if (this.drivingExecutions.get(context.key) === turn) this.drivingExecutions.delete(context.key);
	}

	private async failTurn(work: WorkView, execution: Execution, error: ServiceFailure): Promise<void> {
		const binding = execution.pi;
		if (binding === undefined) return;
		await this.runtime.requestStop(binding).catch(() => undefined);
		const current = this.archive.project(work.workId);
		if (!this.executorTurnRemainsCurrent(current, execution)) return;
		const failed = failedExecutorProjection(current, execution, error);
		this.core.append({
			meta: {
				actor: "system",
				commandId: `executor-failure:${execution.executionId}:${current.revision}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			kind: "error",
			workId: current.workId,
			missionId: current.mission?.missionId,
			executionId: execution.executionId,
			payload: this.failurePayload(failed),
			projection: failed,
			summary: "Executor runtime failed after launch.",
			effects: lifecycleEffects(current.workId, failed.revision, failed.execution, undefined, true, "executor-failed"),
		});
		void this.processPendingEffects().catch(() => undefined);
	}

	private executionAlreadyStarted(execution: Execution | undefined): boolean {
		if (execution === undefined) return false;
		return ["queued", "running", "awaiting-review"].includes(execution.state);
	}

	private executorTurnRemainsCurrent(work: WorkView | undefined, execution: Execution): work is WorkView {
		return currentExecutorTurnIsCurrent(work, execution);
	}

	private failurePayload(work: WorkView): NonNullable<WorkView["lastError"]> | { message: string } {
		return work.lastError === undefined ? { message: "Executor runtime failed." } : work.lastError;
	}

	private requireStartableMission(work: WorkView): WorkWithMission {
		if (isStartableMission(work)) return work;
		throw this.core.error(
			"invalid-state",
			"Only an active Mission can start an Execution.",
			false,
			"Admit the Work or create a new Mission.",
		);
	}
}
