import type { ConclaveWakeCause, WorkBudget, WorkBudgetView, WorkView } from "./model.js";

export type DispatchEligibility = "eligible" | "preparation-waiting" | "reservation-waiting" | "budget-exhausted";
export type ReplacementEligibility = Readonly<{
	status: "eligible" | "blocked" | "unknown";
	reason: string;
}>;

export function workBudgetView(budget: WorkBudget): WorkBudgetView {
	return {
		...budget,
		availableTokens: budget.maxTokens - budget.consumedTokens - budget.reservedTokens,
		overrunTokens: Math.max(0, budget.consumedTokens - budget.maxTokens),
	};
}

export function dispatchEligibility(work: WorkView): DispatchEligibility {
	if (work.preparation?.status === "waiting") return "preparation-waiting";
	const available = workBudgetView(work.budget).availableTokens;
	return budgetEligibility(work, invocationAllowance(work.budget.maxTokens, available), available);
}

export function dispatchEligibilityReason(eligibility: DispatchEligibility): string {
	if (eligibility === "eligible")
		return "Work budget and preparation permit dispatch; shared invocation capacity is checked separately.";
	if (eligibility === "preparation-waiting") return "Executor preparation is waiting for explicit User recovery.";
	if (eligibility === "reservation-waiting")
		return "Work dispatch is waiting for an existing invocation reservation to settle or be reconciled.";
	return "Work budget has no available invocation allowance; the User must amend the Work budget.";
}

export function invocationAllowance(maxTokens: number, available: number): number {
	return Math.min(Math.max(1, Math.floor(maxTokens / 2)), available);
}

export function workInvocationAllowance(budget: WorkBudget): number {
	return invocationAllowance(budget.maxTokens, workBudgetView(budget).availableTokens);
}

export function replacementEligibility(work: WorkView): ReplacementEligibility {
	const budget = workBudgetView(work.budget);
	const eligibility = dispatchEligibility(work);
	const remaining = remainingCorrectionAllowance(work);
	const reasons = [
		correctionEligibilityReason(remaining),
		tokenBudgetEligibilityReason(budget),
		preparationEligibilityReason(eligibility),
	].filter((reason): reason is string => reason !== undefined);
	const reason = reasons.join(" ");
	const status = replacementEligibilityStatus(remaining, eligibility);
	return {
		status,
		reason:
			reason ||
			"Current correction, Work-token, and Executor-preparation gates permit replacement; Work lifecycle, current Signal, FIFO, project invocation capacity, and concurrent Execution admission still apply.",
	};
}

function replacementEligibilityStatus(
	remaining: number | undefined,
	eligibility: DispatchEligibility,
): ReplacementEligibility["status"] {
	if (remaining === undefined) return "unknown";
	return remaining > 0 && eligibility === "eligible" ? "eligible" : "blocked";
}

function remainingCorrectionAllowance(work: WorkView): number | undefined {
	const limit = work.dispatchLimits?.maxCorrections;
	return limit === undefined ? undefined : Math.max(0, limit - (work.correctionCount ?? 0));
}

function correctionEligibilityReason(remaining: number | undefined): string | undefined {
	if (remaining === undefined) return "The Work does not record a correction allowance.";
	if (remaining === 0) return "The Work correction allowance is exhausted.";
	return undefined;
}

function tokenBudgetEligibilityReason(budget: WorkBudgetView): string | undefined {
	if (budget.availableTokens > 0) return undefined;
	if (budget.reservedTokens > 0)
		return "Work-token dispatch is waiting for held invocation reservations to settle or be reconciled.";
	return "The Work token budget has no available capacity; the User must amend it.";
}

function preparationEligibilityReason(eligibility: DispatchEligibility): string | undefined {
	return eligibility === "preparation-waiting" ? dispatchEligibilityReason(eligibility) : undefined;
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
		super(dispatchEligibilityReason(eligibility));
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
