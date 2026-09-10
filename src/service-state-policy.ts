import { InvocationCapacityExceeded, type PendingArchiveEffect } from "./archive.js";
import {
	type ActionInput,
	type Actor,
	assertNonBlank,
	assertPositiveInteger,
	type CommandMeta,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type JsonObject,
	type JsonValue,
	type MissionSpecificity,
	type SubmitWorkInput,
	type TokenUsage,
	type WorkTerms,
	type WorkView,
} from "./model.js";
import { type RuntimeBinding, type RuntimeState } from "./ports.js";
import { isTextValue, schedulerEffect } from "./provider-observation-policy.js";
import { ActionInputError, RunGateUnavailable } from "./service-contracts.js";
import { type DispatchEligibility, DispatchEligibilityError, dispatchEligibility } from "./workflow-dispatch.js";

export function directedWakeMessage(workId: string, reason: ConclaveWakeCause | undefined): string | undefined {
	const messages = new Map<ConclaveWakeCause, string>([
		[
			"executor-blocked",
			`Inspect the current blocked Signal for Work ${workId}. Read the Archive, then use khala_perform_action with the current Signal's signalId to make one durable state-appropriate decision: continue, replace, reject, or explicitly fail Work. Do not return without recording the decision.`,
		],
		[
			"executor-ready",
			`Inspect the current ready Signal for Work ${workId}. Read the Archive, then use khala_perform_action with action verdict and that Signal's signalId to record one durable Verdict: handoff, continue, replace, or reject. Do not return without recording the decision.`,
		],
		[
			"oracle-result",
			`Inspect the completed Oracle advisory for Work ${workId}. Read the Archive and current ready Signal, then use khala_perform_action with action verdict and that Signal's signalId to record one durable Verdict: handoff, continue, replace, or reject. Treat the Oracle result as advisory evidence and do not return without recording the decision.`,
		],
		[
			"executor-failed",
			`Inspect the failed Executor Execution for Work ${workId}. Read the Archive, then use khala_perform_action with action start-execution to replace it under the unchanged Mission, or use fail-work if the Work cannot continue. Do not return without recording the decision.`,
		],
		[
			"runtime-unreachable",
			`Inspect the Executor runtime for Work ${workId}. If it is unreachable, use khala_perform_action with recover; keep the same Execution and do not ask the User to intervene.`,
		],
		[
			"provider-closed",
			`Inspect the closed provider review for Work ${workId}. Read the Archive first and reconcile the current Mission; do not treat closure as acceptance.`,
		],
		[
			"provider-ci",
			`Inspect the failed provider checks for Work ${workId}. Read the Archive first and reconcile the current Mission; do not treat failed checks as acceptance.`,
		],
		[
			"provider-outcome",
			`Process the provider merge outcome for Work ${workId}. Read the Archive first. If the current review request and provider outcome both confirm the reviewed head was merged, use khala_perform_action with action record-outcome. The provider observation is evidence; only the explicit Conclave Outcome settles the Work.`,
		],
		[
			"token-exhausted",
			`Inspect token exhaustion for Work ${workId}. Read the Archive, then use khala_perform_action with action verdict and signalId budget-exhausted to replace the exhausted Execution or reject the Mission. Do not return without recording the decision.`,
		],
	]);
	return reason === undefined ? undefined : messages.get(reason);
}

export function isScopedArchiveActor(actor: Actor): boolean {
	return actor === "conclave" || actor === "executor" || actor === "observer";
}

export function isUnscopedArchiveActor(actor: Actor): boolean {
	return actor === "user" || actor === "monitor";
}

export function hasRuntimeChange(work: WorkView, runtimeState: RuntimeState | undefined): runtimeState is RuntimeState {
	return runtimeState !== undefined && runtimeState !== work.execution?.runtimeState;
}

export function hasFailedWorkStop(work: WorkView): boolean {
	return work.state === "stopped" && work.stopReason === "failed";
}

export function hasFailedExecution(work: WorkView): boolean {
	return work.execution?.state === "failed";
}

export function isConcurrentExecution(state: Execution["state"] | undefined): boolean {
	return state === "queued" || state === "running" || state === "awaiting-review";
}

export function runtimeNeedsInspection(work: WorkView): boolean {
	const execution = work.execution;
	return execution?.pi !== undefined && ["running", "awaiting-review"].includes(execution.state);
}

export function runtimeBinding(work: WorkView): RuntimeBinding {
	const binding = work.execution?.pi;
	if (binding === undefined) throw new Error("The Work has no bound runtime.");
	return binding;
}

export function roleActionRemediation(actor: Actor, expected: Actor): string {
	const key = `${actor}:${expected}`;
	return (
		{
			"user:executor":
				"Executor Signals and review requests come from the bound Executor session. Read the Archive or poll the provider instead of recording Executor evidence as the User.",
			"user:conclave":
				"Conclave actions run in the bound Conclave session. Read the Archive and wait for the autonomous Conclave wake.",
		}[key] ?? "Use the role-bound application adapter."
	);
}

export type ConclaveWakeErrorKind =
	| "blocked"
	| "ready"
	| "execution"
	| "runtime"
	| "outcome"
	| "feedback"
	| "token"
	| "admission";

export function isGovernedRole(value: string): value is GovernedRole {
	return ["conclave", "observer", "executor", "oracle"].includes(value);
}

export function readCapabilityText(value: JsonValue | undefined): string | undefined {
	return value === undefined ? undefined : isTextValue(value) ? value : undefined;
}

export function termContext(value: string | undefined): string {
	return value?.trim() ?? "";
}

export function nonBlankCriteria(values: readonly string[]): readonly string[] {
	if (values.length === 0 || values.some((entry) => entry.trim().length === 0))
		throw new Error("acceptanceCriteria must contain at least one nonblank item.");
	return values.map((entry) => assertNonBlank(entry, "acceptanceCriteria item"));
}

export function normalizeTermList(values: readonly string[] | undefined, key: string): readonly string[] {
	return (values ?? []).map((entry) => assertNonBlank(entry, key));
}

export function positiveTermTokens(value: number | undefined, fallback: number): number {
	const maxTokens = value ?? fallback;
	assertPositiveInteger(maxTokens, "maxTokens");
	return maxTokens;
}

export function requireNonEmptyTermList(values: readonly string[], key: string): void {
	if (values.length === 0) throw new ActionInputError(`${key} must contain at least one item.`);
}

export function requireMissionContext(context: string): void {
	if (context.length === 0)
		throw new ActionInputError(
			"Mission context cannot be cleared; create a new Work if it is no longer authoritative.",
		);
}

export function hasTermChange(input: ActionInput): boolean {
	return [
		input.objective,
		input.context,
		input.scope,
		input.acceptanceCriteria,
		input.constraints,
		input.validation,
		input.allowedPaths,
	].some((value) => value !== undefined);
}

export function hasActiveExecution(work: WorkView): boolean {
	return work.execution !== undefined && !["failed", "stopped"].includes(work.execution.state);
}

export function normalizeAllowedPath(path: string): string {
	const value = path
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/");
	const pathspecCharacters = ["!", "~", "^", ":", "*", "?", "[", "]"];
	const invalidSyntax = [
		/^(?:$|\.\.(?:\/|$)|\/)/.test(value),
		value !== "." && value.split("/").some((segment) => segment === "." || segment === ".."),
		pathspecCharacters.some((character) => value.includes(character)),
	].some(Boolean);
	if (invalidSyntax) throw new ActionInputError(`allowedPaths contains an invalid path: ${path}`);
	return value === "." ? "." : value.replace(/\/$/, "");
}

export function missionSpecificity(_terms: WorkTerms): MissionSpecificity {
	return { status: "explicit", missing: [] };
}

export function amendedMissionSpecificity(
	previous: MissionSpecificity,
	input: ActionInput | undefined,
): MissionSpecificity {
	const provided = {
		scope: input?.scope !== undefined,
		validation: input?.validation !== undefined,
	};
	const missing = previous.missing.filter((field) => {
		// SAFETY: mission specificity can only name fields represented in this map.
		return provided[field as keyof typeof provided] !== true;
	});
	return { status: missing.length === 0 ? "explicit" : "defaults-used", missing };
}

export function missingScope(input: SubmitWorkInput): string | undefined {
	return input.scope?.trim() ? undefined : "scope";
}

export function missingValidation(input: SubmitWorkInput): string | undefined {
	return input.validation !== undefined && input.validation.length > 0 ? undefined : "validation";
}

export function isAllowedPath(path: string, allowedPaths: readonly string[]): boolean {
	const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	return allowedPaths.some(
		(allowed) => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`),
	);
}

export function executorTurnKey(workId: string, executionId: string): string {
	return `${workId}:${executionId}`;
}

export function sameRuntimeBinding(left: RuntimeBinding | undefined, right: RuntimeBinding | undefined): boolean {
	if (left === undefined || right === undefined) return false;
	return [
		left.sessionId === right.sessionId,
		left.sessionPath === right.sessionPath,
		left.processGroupId === right.processGroupId,
		left.processStartTime === right.processStartTime,
		left.capabilityNonce === right.capabilityNonce,
		left.processMarker === right.processMarker,
	].every(Boolean);
}

export function caughtError(error: string): Error {
	return new Error(error);
}

export function runtimeBindingKey(binding: RuntimeBinding | undefined): string {
	return JSON.stringify(binding ?? null);
}

export function hasMonitorableExecution(work: WorkView): boolean {
	return ["awaiting-review", "running"].includes(
		work.state === "awaiting-review" ? work.state : (work.execution?.state ?? ""),
	);
}

export function monitorMeta(work: WorkView, subject: string, bucket: number): CommandMeta {
	return {
		actor: "monitor",
		commandId: `monitor:${subject}:${work.workId}:${bucket}`,
		expectedWorkRevision: work.revision,
		schemaVersion: 1,
	};
}

export function isRuntimeUnavailable(state: RuntimeState | undefined): boolean {
	return state === "unreachable" || state === "unknown";
}

export function hasRuntimeAction(work: WorkView): boolean {
	return work.execution !== undefined && ["running", "awaiting-review"].includes(work.execution.state);
}

export function executorIsWorking(nextAction: string): boolean {
	return ["Executor is working.", "Executor is resuming authorized review feedback."].includes(nextAction);
}

export function preparedExecutorTurn(
	work: WorkView,
): Readonly<{ current: WorkView & { execution: Execution }; binding: RuntimeBinding }> | undefined {
	const execution = work.execution;
	const binding = execution?.pi;
	if (execution === undefined || binding === undefined) return undefined;
	return { current: { ...work, execution }, binding };
}

export function executorTurnExecution(execution: Execution, exhausted: boolean): Execution {
	return {
		...execution,
		state: exhausted ? "blocked" : execution.state,
		blockReason: exhausted ? "budget-exhausted" : undefined,
		runtimeState: "idle",
	};
}

export function sameSignal(current: WorkView, work: WorkView): boolean {
	return current.lastSignal?.signalId === work.lastSignal?.signalId;
}

export function executorTurnSummary(executionId: string, exhausted: boolean): string {
	return exhausted
		? `Execution ${executionId} exhausted its token allowance.`
		: `Execution ${executionId} turn completed; runtime is idle.`;
}

export function executorTurnEffects(workId: string, revision: number, exhausted: boolean) {
	return exhausted ? [schedulerEffect(workId, revision, undefined, "token-exhausted")] : undefined;
}

export function tokenUsageTotal(usage: TokenUsage): number {
	return usage.inputTokens + usage.outputTokens;
}

export function invocationAllowance(work: WorkView): number {
	const eligibility = dispatchEligibility(work);
	if (eligibility !== "eligible") throw new DispatchEligibilityError(eligibility);
	const available = work.budget.maxTokens - work.budget.consumedTokens - work.budget.reservedTokens;
	return Math.min(Math.floor(work.budget.maxTokens / 2), available);
}

export function isDispatchDeferral(failure: Error): boolean {
	return (
		failure instanceof DispatchEligibilityError ||
		failure instanceof RunGateUnavailable ||
		failure instanceof InvocationCapacityExceeded
	);
}

export function pendingConclaveWakeKey(effect: PendingArchiveEffect): string | undefined {
	if (effect.kind !== "conclave-wake") return undefined;
	return `${effect.payload["workId"] ?? ""}:${effect.payload["reason"] ?? ""}`;
}

export function sameDispatchAttention(left: ErrorEnvelope | undefined, right: ErrorEnvelope): boolean {
	return left?.code === right.code && left.summary === right.summary && left.remediation === right.remediation;
}

export function dispatchGateIdentity(work: WorkView, eligibility: Exclude<DispatchEligibility, "eligible">): string {
	return `${work.workId}:${eligibility}:${work.preparation?.prerequisiteId ?? ""}:${work.budget.maxTokens}:${work.budget.consumedTokens}:${work.budget.reservedTokens}`;
}

export function isDispatchBudgetAttention(error: ErrorEnvelope | undefined): boolean {
	if (error === undefined) return false;
	if (error.code === "external-failure" && error.summary.startsWith("Conclave token-exhaustion decision failed: "))
		return true;
	const summaries = new Map<ErrorEnvelope["code"], string>([
		["budget-exhausted", "Model dispatch is waiting for additional Work budget."],
		["external-failure", "Model dispatch is waiting for an existing invocation to settle."],
	]);
	return summaries.get(error.code) === error.summary;
}

export function executorSessionInput(work: WorkView, execution: Execution) {
	return {
		cwd: execution.sandbox.path,
		model: execution.model,
		thinking: execution.thinking,
		role: "executor" as const,
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
		sessionPath: execution.pi?.sessionPath,
	};
}

export function failureMessage(failure: string): string {
	return failure || "The Executor failed without a provider error message.";
}

export function missionSpecificityMessage(missingTerms: readonly string[]): string {
	return missingTerms.length === 0
		? "Mission terms were explicit; inspect the runtime failure before changing scope."
		: `Mission relied on default ${missingTerms.join(" and ")}; make those terms explicit before retrying.`;
}

export function queueSchedulerEffect(workId: string, revision: number) {
	return { effectId: `scheduler-wake:${workId}:${revision}`, kind: "scheduler-wake", payload: { workId } };
}

export function executorEffect(workId: string, revision: number) {
	return { effectId: `executor-wake:${workId}:${revision}`, kind: "executor-wake", payload: { workId } };
}

export function executorRecoveryEffect(workId: string, revision: number, executionId: string) {
	return {
		effectId: `executor-recovery:${workId}:${executionId}:${revision}`,
		kind: "executor-recovery",
		payload: { workId, executionId },
	};
}

export function observerEffect(workId: string, revision: number) {
	return { effectId: `observer-wake:${workId}:${revision}`, kind: "observer-wake", payload: { workId } };
}

export function oracleEffect(workId: string, revision: number, pending: NonNullable<WorkView["oraclePending"]>) {
	return {
		effectId: `oracle-wake:${workId}:${pending.requestId}:${revision}`,
		kind: "oracle-wake",
		payload: { workId, ...pending },
	};
}

export function feedbackEffect(
	workId: string,
	revision: number,
	executionId: string | undefined,
	observationId: string | undefined,
	feedback: readonly string[],
) {
	return {
		effectId: `feedback-wake:${workId}:${revision}`,
		kind: "feedback-wake",
		payload: { workId, executionId, observationId, feedback },
	};
}

export function sandboxCleanupEffect(workId: string, executionId: string, sandbox: Execution["sandbox"]) {
	return {
		effectId: `workspace-cleanup:${workId}:orphan-${executionId}`,
		kind: "workspace-cleanup",
		payload: { workId, path: sandbox.path, baseCommit: sandbox.baseCommit, branch: sandbox.branch },
	};
}

export function cleanupBindingIdentity(binding: RuntimeBinding | undefined): string {
	if (binding === undefined) return "unbound";
	return binding.processMarker ?? binding.sessionId;
}

export function cleanupBindingPayload(binding: RuntimeBinding | undefined) {
	if (binding === undefined) return {};
	return {
		sessionId: binding.sessionId,
		sessionPath: binding.sessionPath,
		processGroupId: binding.processGroupId,
		processStartTime: binding.processStartTime,
		capabilityNonce: binding.capabilityNonce,
		processMarker: binding.processMarker,
	};
}

export function executorStopEffect(workId: string, revision: number, execution: Execution) {
	if (execution.pi === undefined) throw new Error("An Executor stop effect requires a runtime binding.");
	return {
		effectId: `executor-stop:${workId}:${execution.executionId}:${revision}`,
		kind: "executor-stop",
		payload: {
			workId,
			executionId: execution.executionId,
			sessionId: execution.pi.sessionId,
			sessionPath: execution.pi.sessionPath,
			processGroupId: execution.pi.processGroupId,
			processStartTime: execution.pi.processStartTime,
			capabilityNonce: execution.pi.capabilityNonce,
			processMarker: execution.pi.processMarker,
		},
	};
}

export function needsSchedulerWake(execution: Execution): boolean {
	return ["awaiting-review", "blocked", "completed", "failed", "stopped"].includes(execution.state);
}

export function needsExecutorStop(execution: Execution): boolean {
	return execution.state === "awaiting-review" && execution.pi !== undefined;
}

export function needsWorkspaceCleanup(execution: Execution): boolean {
	return ["completed", "failed", "stopped"].includes(execution.state);
}

export function readEffectWorkId(payload: JsonObject): string {
	const value = payload["workId"];
	if (value === undefined || value !== String(value) || value.trim().length === 0) {
		throw new Error("Conclave wake effect is missing a Work ID.");
	}
	return String(value);
}

export function readEffectExecutionId(payload: JsonObject): string {
	const value = payload["executionId"];
	if (value === undefined || value !== String(value) || value.trim().length === 0) {
		throw new Error("Executor recovery effect is missing an Execution ID.");
	}
	return String(value);
}

export function readEffectFeedback(payload: JsonObject): readonly string[] {
	const value = payload["feedback"];
	if (!Array.isArray(value)) throw new Error("Feedback effect is missing its feedback list.");
	return value.map((entry) => {
		if (!isTextValue(entry)) throw new Error("Feedback effect contains non-text evidence.");
		return entry;
	});
}

export function readEffectText(payload: JsonObject, key: string): string {
	const value = payload[key];
	if (!isTextValue(value) || value.trim().length === 0) throw new Error(`Cleanup effect is missing ${key}.`);
	return value;
}

export function readEffectInteger(value: JsonValue, key: string): number {
	if (value !== Number(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
		throw new Error(`Cleanup effect ${key} is invalid.`);
	return Number(value);
}

export function readEffectTextValue(value: JsonValue, key: string): string {
	if (!isTextValue(value) || value.trim().length === 0) throw new Error(`Cleanup effect ${key} is invalid.`);
	return value;
}

export function requiredText(value: string | undefined, key: string): string {
	if (value === undefined) throw new ActionInputError(`Action input ${key} must be text.`);
	return value;
}

export function requiredNonBlank(value: string, key: string): string {
	try {
		return assertNonBlank(value, key);
	} catch (error) {
		throw new ActionInputError(error instanceof Error ? error.message : `${key} must not be blank.`);
	}
}

export function readActionChoice<const T extends string>(value: string, choices: readonly T[], label: string): T {
	const choice = choices.find((candidate) => candidate === value);
	if (choice === undefined) throw new ActionInputError(`${label} ${value} is invalid.`);
	return choice;
}
