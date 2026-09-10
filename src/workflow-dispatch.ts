import type { ConclaveWakeCause, WorkView } from "./model.js";

export type DispatchEligibility = "eligible" | "preparation-waiting" | "reservation-waiting" | "budget-exhausted";

export function dispatchEligibility(work: WorkView): DispatchEligibility {
	if (work.preparation?.status === "waiting") return "preparation-waiting";
	const allowance = Math.floor(work.budget.maxTokens / 2);
	const available = work.budget.maxTokens - work.budget.consumedTokens - work.budget.reservedTokens;
	return budgetEligibility(work, allowance, available);
}

function budgetEligibility(
	work: WorkView,
	allowance: number,
	available: number,
): Exclude<DispatchEligibility, "preparation-waiting"> {
	if (Math.min(allowance, available) > 0) return "eligible";
	return work.budget.reservedTokens > 0 ? "reservation-waiting" : "budget-exhausted";
}

export class DispatchEligibilityError extends Error {
	readonly eligibility: Exclude<DispatchEligibility, "eligible">;

	constructor(eligibility: Exclude<DispatchEligibility, "eligible">) {
		super(
			eligibility === "preparation-waiting"
				? "Executor preparation is waiting for explicit User recovery."
				: eligibility === "reservation-waiting"
					? "Work dispatch is waiting for an existing invocation reservation to settle."
					: "Work budget has no available invocation allowance.",
		);
		this.name = "DispatchEligibilityError";
		this.eligibility = eligibility;
	}
}

/** Every queued Conclave effect has one cause and one explicit outcome. */
export type DispatchCause = ConclaveWakeCause;
export type DispatchResolution = "decision" | "acknowledgement";
export type DispatchCauseState = Readonly<{
	cause: DispatchCause;
	resolution: DispatchResolution;
	resolved: boolean;
}>;

type Resolver = (before: WorkView, after: WorkView) => boolean;
const resolvers = {
	admission: {
		resolution: "decision",
		resolved: (_before, after) => after.state !== "submitted" || after.observerInFlight === true,
	},
	"executor-blocked": { resolution: "decision", resolved: (before, after) => !sameBlockedSignal(before, after) },
	"executor-ready": { resolution: "decision", resolved: (before, after) => !sameReadySignal(before, after) },
	"executor-failed": { resolution: "decision", resolved: (before, after) => !sameExecutionFailure(before, after) },
	"runtime-unreachable": { resolution: "decision", resolved: (before, after) => !sameRuntimeFailure(before, after) },
	"token-exhausted": { resolution: "decision", resolved: (before, after) => !sameTokenExhaustion(before, after) },
	"oracle-result": { resolution: "acknowledgement", resolved: oracleResultRecorded },
	"provider-ci": { resolution: "acknowledgement", resolved: providerObservationAcknowledged },
	"provider-feedback": { resolution: "acknowledgement", resolved: providerObservationAcknowledged },
	"provider-outcome": { resolution: "decision", resolved: (_before, after) => after.state === "succeeded" },
	"provider-closed": { resolution: "decision", resolved: (before, after) => before.state !== after.state },
} satisfies Record<DispatchCause, Readonly<{ resolution: DispatchResolution; resolved: Resolver }>>;

export function dispatchCauseResolution(cause: DispatchCause, before: WorkView, after: WorkView): DispatchCauseState {
	const rule = resolvers[cause];
	return { cause, resolution: rule.resolution, resolved: rule.resolved(before, after) };
}

function sameExecution(before: WorkView, after: WorkView): boolean {
	return [
		before.execution?.executionId !== undefined,
		before.execution?.executionId === after.execution?.executionId,
	].every(Boolean);
}
function sameSignal(before: WorkView, after: WorkView): boolean {
	return [before.lastSignal?.signalId !== undefined, before.lastSignal?.signalId === after.lastSignal?.signalId].every(
		Boolean,
	);
}
function sameBlockedSignal(before: WorkView, after: WorkView): boolean {
	return [
		before.execution?.state === "blocked",
		after.execution?.state === "blocked",
		sameExecution(before, after),
		sameSignal(before, after),
	].every(Boolean);
}
function sameReadySignal(before: WorkView, after: WorkView): boolean {
	return [
		before.execution?.state === "running",
		after.execution?.state === "running",
		sameExecution(before, after),
		sameSignal(before, after),
	].every(Boolean);
}
function sameExecutionFailure(before: WorkView, after: WorkView): boolean {
	return [
		before.execution?.state === "failed",
		after.execution?.state === "failed",
		sameExecution(before, after),
	].every(Boolean);
}
function sameRuntimeFailure(before: WorkView, after: WorkView): boolean {
	return [
		sameExecution(before, after),
		after.execution?.runtimeState === "unreachable",
		!["succeeded", "stopped"].includes(after.state),
	].every(Boolean);
}
function sameTokenExhaustion(before: WorkView, after: WorkView): boolean {
	return [
		before.execution?.blockReason === "budget-exhausted",
		after.execution?.blockReason === "budget-exhausted",
		sameExecution(before, after),
	].every(Boolean);
}
function oracleResultRecorded(before: WorkView, after: WorkView): boolean {
	return !sameReadySignal(before, after);
}
function providerObservationAcknowledged(before: WorkView, after: WorkView): boolean {
	return [
		before.lastObservation?.observationId !== undefined,
		before.lastObservation?.observationId === after.lastObservation?.observationId,
	].every(Boolean);
}
