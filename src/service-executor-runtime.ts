import type { ArchivePort } from "./archive.js";
import { InvocationLaunchError } from "./dispatch.js";
import type { CommandMeta, Execution, WorkView } from "./model.js";
import type { OperationContext, RuntimeBinding, RuntimeState, RuntimeTurn, ServicePorts } from "./ports.js";
import type { ReservedInvocation } from "./run-ledger.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable } from "./service-contracts.js";
import {
	currentExecutorTurnIsCurrent,
	executorRuntimeNextAction,
	executorTurnProjection,
} from "./service-dispatch-policy.js";
import { executorRuntimeEffects, runtimeStateNeedsRecording } from "./service-foundation-policy.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { canStopExecutor, executionIsExhausted, remainingExecutionAllowance } from "./service-lifecycle-policy.js";
import {
	executorSessionInput,
	executorTurnEffects,
	executorTurnExecution,
	executorTurnKey,
	executorTurnSummary,
	invocationAllowance,
	preparedExecutorTurn,
} from "./service-state-policy.js";

export type ExecutorInvocationInput = Readonly<{
	work: WorkView;
	execution: Execution;
}>;
type ExecutorStopContext = Readonly<{ execution: Execution; explicitStop: boolean }>;

function isExplicitStopReason(reason: WorkView["stopReason"]): boolean {
	return reason === "cancelled" || reason === "failed";
}

export class ExecutorRuntimeCoordinator {
	private readonly activeTurns = new Map<string, Set<Promise<void>>>();
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly invocations: InvocationCoordinator;
	private readonly runtime: ServicePorts["runtime"];

	constructor(
		archive: ArchivePort,
		core: ArchiveCore,
		invocations: InvocationCoordinator,
		runtime: ServicePorts["runtime"],
	) {
		this.archive = archive;
		this.core = core;
		this.invocations = invocations;
		this.runtime = runtime;
	}

	async ensureBinding(work: WorkView, execution: Execution, operation?: OperationContext): Promise<RuntimeBinding> {
		try {
			return await this.runtime.ensureSession(executorSessionInput(work, execution), operation);
		} catch (error) {
			throw new InvocationLaunchError(new Error(String(error)));
		}
	}

	async dispatchTurn(input: ExecutorInvocationInput): Promise<RuntimeBinding | undefined> {
		const prepared = this.prepareTurn(input.work, input.execution);
		if (prepared === undefined) return undefined;
		const { current, binding } = prepared;
		await this.invocations.dispatch(
			current,
			{
				workId: current.workId,
				role: "executor",
				executionId: input.execution.executionId,
				missionId: current.mission?.missionId,
				allowance: Math.min(remainingExecutionAllowance(input.execution), invocationAllowance(current)),
			},
			(reservation, operation) => this.sendReservedTurn(current, input.execution, binding, reservation, operation),
		);
		this.recordTurn(current);
		return binding;
	}

	async runTracked(workId: string, executionId: string, operation: () => Promise<void>): Promise<void> {
		const key = executorTurnKey(workId, executionId);
		let finish: () => void = () => undefined;
		const tracked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.addTurn(key, tracked);
		try {
			await operation();
		} finally {
			finish();
			this.removeTurn(key, tracked);
		}
	}

	hasActiveTurn(workId: string, executionId: string): boolean {
		return (this.activeTurns.get(executorTurnKey(workId, executionId))?.size ?? 0) > 0;
	}

	async waitForActiveTurns(workId: string, executionId: string): Promise<void> {
		await this.waitForTurns(workId, executionId);
	}

	async stopStoppedTurns(): Promise<void> {
		// A resumed turn can occupy the pump that owns its cleanup effect.
		// Deliver the acknowledged stop first; the same pump still owns durable cleanup.
		const stopped = this.archive.listProjects().filter((work) => isExplicitStopReason(work.stopReason));
		const results = await Promise.allSettled(stopped.map((work) => this.stopStoppedTurn(work)));
		const failures: unknown[] = [];
		for (const result of results) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		if (failures.length > 0) throw new Error(`Executor stop requests failed: ${failures.map(String).join("; ")}`);
	}

	private async stopStoppedTurn(work: WorkView): Promise<void> {
		const execution = work.execution;
		if (execution?.pi === undefined) return;
		if (!this.hasActiveTurn(work.workId, execution.executionId)) return;
		await this.stopAfterTurn(work, execution.pi, ["failed", "stopped"]);
	}

	async stopAfterTurn(
		work: WorkView,
		binding: RuntimeBinding,
		allowedStates: readonly Execution["state"][],
	): Promise<void> {
		const context = this.stopContext(work, binding, allowedStates);
		if (context === undefined) return;
		if (context.explicitStop) return this.stopExplicit(work, context.execution, binding);
		await this.stopSettled(work, context.execution, binding, allowedStates);
	}

	private stopContext(
		work: WorkView,
		binding: RuntimeBinding,
		allowedStates: readonly Execution["state"][],
	): ExecutorStopContext | undefined {
		const execution = work.execution;
		if (execution === undefined) return;
		const current = this.archive.project(work.workId);
		if (!canStopExecutor(current, execution, binding, allowedStates)) return;
		return {
			execution,
			explicitStop: isExplicitStopReason(current?.stopReason),
		};
	}

	private async stopExplicit(work: WorkView, execution: Execution, binding: RuntimeBinding): Promise<void> {
		await this.runtime.requestStop(binding);
		await this.waitForTurns(work.workId, execution.executionId);
	}

	private async stopSettled(
		work: WorkView,
		execution: Execution,
		binding: RuntimeBinding,
		allowedStates: readonly Execution["state"][],
	): Promise<void> {
		await this.waitForTurns(work.workId, execution.executionId);
		const settled = this.archive.project(work.workId);
		if (canStopExecutor(settled, execution, binding, allowedStates)) await this.runtime.requestStop(binding);
	}

	recordRuntimeState(work: WorkView, runtimeState: RuntimeState, wakeConclave = false): WorkView {
		const execution = work.execution;
		if (!runtimeStateNeedsRecording(execution, runtimeState)) return work;
		const nextExecution: Execution = { ...execution, runtimeState };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: nextExecution,
			nextAction: executorRuntimeNextAction(work, runtimeState, wakeConclave),
		};
		return this.core.append({
			meta: systemMeta(`executor-runtime:${execution.executionId}:${work.revision}:${runtimeState}`, work.revision),
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: `Executor runtime is ${runtimeState}.`,
			effects: executorRuntimeEffects(work.workId, next.revision, wakeConclave),
		}).projection;
	}

	recordTurn(work: WorkView): WorkView {
		const current = this.archive.project(work.workId);
		if (!currentExecutorTurnIsCurrent(current, work.execution)) return work;
		const execution = current.execution;
		const exhausted = executionIsExhausted(execution, execution.usage);
		const nextExecution = executorTurnExecution(execution, exhausted);
		const next = executorTurnProjection(current, nextExecution, exhausted, work);
		return this.core.append({
			meta: systemMeta(`executor-turn:${execution.executionId}:${current.revision}`, current.revision),
			kind: "execution",
			workId: current.workId,
			missionId: current.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: executorTurnSummary(execution.executionId, exhausted),
			effects: executorTurnEffects(current.workId, next.revision, exhausted),
		}).projection;
	}

	private prepareTurn(
		work: WorkView,
		execution: Execution,
	): Readonly<{ current: WorkView & { execution: Execution }; binding: RuntimeBinding }> | undefined {
		const current = this.archive.project(work.workId);
		if (!currentExecutorTurnIsCurrent(current, execution)) return undefined;
		return preparedExecutorTurn(this.recordRuntimeState(current, "working"));
	}

	isInvocationActive(runId: string): boolean {
		return this.invocations.isActive(runId);
	}

	private async sendReservedTurn(
		work: WorkView,
		execution: Execution,
		binding: RuntimeBinding,
		reservation: Pick<ReservedInvocation, "runId" | "allowance">,
		operation: OperationContext,
	): Promise<RuntimeTurn> {
		const live = this.archive.project(work.workId);
		if (!currentExecutorTurnIsCurrent(live, execution)) throw new RunGateUnavailable();
		return this.runtime.send(
			binding,
			executorPrompt(live, execution.executionId, reservation.runId),
			{ tokenAllowance: reservation.allowance, runId: reservation.runId },
			operation,
		);
	}

	private async waitForTurns(workId: string, executionId: string): Promise<void> {
		const key = executorTurnKey(workId, executionId);
		for (;;) {
			const turns = this.activeTurns.get(key);
			if (turns === undefined || turns.size === 0) return;
			await Promise.all(turns);
		}
	}

	private addTurn(key: string, turn: Promise<void>): void {
		const turns = this.activeTurns.get(key) ?? new Set<Promise<void>>();
		turns.add(turn);
		this.activeTurns.set(key, turns);
	}

	private removeTurn(key: string, turn: Promise<void>): void {
		const turns = this.activeTurns.get(key);
		if (turns === undefined) return;
		turns.delete(turn);
		if (turns.size === 0) this.activeTurns.delete(key);
	}
}

function executorPrompt(work: WorkView, executionId: string, runId: string): string {
	return `Work ${work.workId}, Execution ${executionId} is bound. Read the Archive, inspect the sandbox, implement the Mission, validate it, publish the draft review request, and send evidence-bearing Signals. The current Work revision is ${work.revision}.\nInvocation run ID: ${runId}.`;
}

function systemMeta(commandId: string, expectedWorkRevision: number): CommandMeta {
	return { actor: "system", commandId, expectedWorkRevision, schemaVersion: 1 };
}
