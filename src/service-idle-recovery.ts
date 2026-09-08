import type { WorkView } from "./model.js";
import type { RuntimeState } from "./ports.js";
import { tokenUsageTotal } from "./service-state-policy.js";

export function isResumableIdleExecutor(work: WorkView, runtimeState?: RuntimeState): boolean {
	const execution = work.execution;
	if (execution === undefined) return false;
	if (execution.pi === undefined) return false;
	return [
		work.state === "active",
		work.missionState === "active",
		execution.state === "running",
		idleRuntimeMatches(execution.runtimeState, runtimeState),
		hasNoActiveInvocations(work),
		execution.blockReason === undefined,
		hasExecutionAllowance(execution),
		hasWorkAllowance(work),
		signalAllowsResume(work, execution.executionId),
	].every(Boolean);
}

function hasExecutionAllowance(execution: NonNullable<WorkView["execution"]>): boolean {
	if (execution.usage === undefined) return execution.tokenAllowance > 0;
	return execution.tokenAllowance > tokenUsageTotal(execution.usage);
}

function hasWorkAllowance(work: WorkView): boolean {
	const available = work.budget.maxTokens - work.budget.consumedTokens - work.budget.reservedTokens;
	return Math.min(Math.floor(work.budget.maxTokens / 2), available) > 0;
}

function idleRuntimeMatches(recorded: RuntimeState | undefined, observed: RuntimeState | undefined): boolean {
	if (observed !== undefined) return observed === "idle";
	return recorded === "idle";
}

function hasNoActiveInvocations(work: WorkView): boolean {
	if (work.activeInvocations === undefined) return true;
	return work.activeInvocations.length === 0;
}

function signalAllowsResume(work: WorkView, executionId: string): boolean {
	const signal = work.lastSignal;
	if (signal === undefined || signal.executionId !== executionId) return true;
	return signal.kind !== "ready" && signal.kind !== "blocked";
}
