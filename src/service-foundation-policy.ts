import { nanoid } from "nanoid";
import { type PendingArchiveEffect } from "./archive.js";
import {
	type Action,
	type Actor,
	assertPositiveInteger,
	type CommandMeta,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type Mission,
	type MissionState,
	type ProviderObservation,
	type ProviderOutcomeObservation,
	type RecordQuery,
	type RecoveryUpdate,
	type RoleSetting,
	type Signal,
	type SubmitWorkInput,
	type WorkState,
	type WorkView,
} from "./model.js";
import {
	type OperationContext,
	type RuntimeBinding,
	type RuntimeState,
	type RuntimeTurn,
	type ServicePorts,
} from "./ports.js";
import { schedulerEffect } from "./provider-observation-policy.js";
import { type ServiceOptions } from "./service-contracts.js";
import { dispatchCauseResolution } from "./workflow-dispatch.js";

export type RoleCapability = Readonly<{
	role: Actor;
	workId?: string | undefined;
	executionId?: string | undefined;
	nonce?: string | undefined;
}>;

export type ActionSpec = Readonly<{
	kind: Action["kind"];
	enabled: boolean;
	label: string;
	disabledReason?: string | undefined;
}>;

export type VerdictDecision = "continue" | "replace" | "handoff" | "reject";

export type ReviewStatus = "changes-requested" | "merged" | "closed";

export type VerdictTransition = Readonly<{
	execution: Execution;
	state: WorkState;
	missionState: MissionState | undefined;
	lastSignal: Signal | undefined;
	nextAction: string;
}>;

export type ObserverRecoveryResult = Readonly<{
	work: WorkView;
	binding: RuntimeBinding | undefined;
	shouldResume: boolean;
}>;

export type ServiceFailure = Error;

export type PendingEffectHandler<T> = () => Promise<T>;

export type ExecutorDriveContext = Readonly<{ execution: Execution; key: string; turnKey: string }>;

export type WorkWithMission = WorkView & { mission: Mission };

export type OutcomeSettlementWork = WorkView & {
	reviewRequest: NonNullable<WorkView["reviewRequest"]>;
	providerOutcome: ProviderOutcomeObservation;
};

export type OracleInputs = Readonly<{ mission: Mission; reviewRequest: NonNullable<WorkView["reviewRequest"]> }>;

export type ReviewStateFields = Readonly<{ state: WorkState; missionState: MissionState | undefined }>;

export type FeedbackTurnState = { work: WorkView; binding: RuntimeBinding };

export type InitialExecutorTurn = RuntimeTurn & Readonly<{ running: WorkView; binding: RuntimeBinding }>;

export const providerPollAuthority = Symbol("provider-poll-authority");

export const AUTONOMOUS_MONITOR_INTERVAL_MS = 60_000;

export const OBSERVER_AGENT_TIMEOUT_MS = 120_000;

export const SUPPORTED_EFFECT_KINDS: ReadonlySet<string> = new Set([
	"conclave-wake",
	"oracle-wake",
	"scheduler-wake",
	"executor-wake",
	"executor-stop",
	"executor-recovery",
	"observer-wake",
	"feedback-wake",
	"workspace-cleanup",
	"observer-cleanup",
]);

export const DEFAULT_SCOPE = "Repository changes required by the objective.";

export const DEFAULT_VALIDATION = "npm run check";

export type FeedbackWakeDisposition = "superseded" | "resume" | "unavailable";

export type DispatchEligibilityAttention = Readonly<{ error: ErrorEnvelope; nextAction: string }>;

export function systemEffectMeta(effect: PendingArchiveEffect, work: WorkView): CommandMeta {
	return {
		actor: "system",
		commandId: `outbox:${effect.effectId}`,
		expectedWorkRevision: work.revision,
		schemaVersion: 1,
	};
}

export function systemObserverMeta(work: WorkView): CommandMeta {
	return {
		actor: "system",
		commandId: `observer-binding:${work.workId}:${work.revision}`,
		expectedWorkRevision: work.revision,
		schemaVersion: 1,
	};
}

export function executorRecoveryMatches(execution: Execution | undefined, executionId: string): boolean {
	if (execution === undefined) return false;
	if (execution.executionId !== executionId) return false;
	if (execution.runtimeState !== "pending") return false;
	return ["running", "awaiting-review"].includes(execution.state);
}

export function feedbackBelongsToExecution(work: WorkView, executionId: string | undefined): boolean {
	const execution = work.execution;
	if (executionId === undefined || execution === undefined) return false;
	return execution.executionId === executionId;
}

export const WAKE_RESOLUTION_ERRORS: ReadonlyMap<ConclaveWakeCause | "admission", string> = new Map([
	["executor-blocked", "Conclave blocked-work wake returned without recording a durable decision."],
	["executor-ready", "Conclave ready-Signal wake returned without recording a durable Verdict."],
	["executor-failed", "Conclave Executor-failure wake returned without recording a durable decision."],
	["runtime-unreachable", "Conclave runtime-recovery wake returned without recording a recovery decision."],
	["provider-outcome", "Conclave provider-outcome wake returned without recording the Work Outcome."],
	["token-exhausted", "Conclave token-exhaustion wake returned without recording a durable Verdict."],
	["admission", "Conclave wake returned without recording a durable decision."],
]);

export function wakeResolutionMissing(
	work: WorkView,
	current: WorkView,
	cause: ConclaveWakeCause | undefined,
): boolean {
	if (cause === undefined) throw new Error("Conclave dispatch requires an explicit wake cause.");
	return !dispatchCauseResolution(cause, work, current).resolved;
}

export function failedObserverProjection(work: WorkView): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		observer: undefined,
		observerInFlight: false,
		nextAction: "Observer failed; Conclave may retry.",
	};
}

export function hasStartableMissionState(work: WorkView): boolean {
	return ["queued", "active"].includes(work.state) && ["admitted", "active"].includes(work.missionState ?? "");
}

export function correctionCountAvailable(work: WorkView, limit: number): boolean {
	return (work.correctionCount ?? 0) < limit;
}

export function submissionWorkId(input: SubmitWorkInput): string {
	const workId = input.workId?.trim();
	return workId === undefined || workId.length === 0 ? nanoid() : workId;
}

export function configuredMaxConcurrentRuns(
	options: Pick<ServiceOptions, "maxConcurrentExecutions" | "maxConcurrentRuns">,
): number {
	const limit = options.maxConcurrentRuns ?? options.maxConcurrentExecutions;
	return assertPositiveInteger(limit, "maxConcurrentRuns");
}

export function workMaxCorrections(work: WorkView, options: ServiceOptions): number {
	return work.dispatchLimits?.maxCorrections ?? assertPositiveInteger(options.maxCorrections ?? 3, "maxCorrections");
}

export function isWaitingPreparation(candidate: WorkView): boolean {
	return candidate.preparation?.status === "waiting";
}

export function notifyRecoveryCheck(
	onRecoveryUpdate: ((update: RecoveryUpdate) => void) | undefined,
	operation: OperationContext | undefined,
	role: string,
): void {
	onRecoveryUpdate?.({ stage: "checking", message: `Checking the Work's current ${role.toLowerCase()} state.` });
	operation?.onUpdate?.(`Checking the ${role} runtime.`);
}

export function notifyRecoveryStage(
	onRecoveryUpdate: ((update: RecoveryUpdate) => void) | undefined,
	stage: RecoveryUpdate["stage"],
	message: string,
): void {
	onRecoveryUpdate?.({ stage, message });
}

export function recoveredExecution(execution: Execution, binding: RuntimeBinding): Execution {
	return { ...execution, pi: binding, runtimeState: execution.state === "running" ? "pending" : "idle" };
}

export function recoveredExecutionProjection(work: WorkView, execution: Execution, recovered: Execution): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		lastError: undefined,
		execution: recovered,
		nextAction:
			execution.state === "running"
				? "Khala is continuing the Work automatically."
				: "Work is restored and awaiting review.",
	};
}

export async function stopReboundRuntime(
	runtime: ServicePorts["runtime"],
	binding: RuntimeBinding | undefined,
): Promise<void> {
	if (binding !== undefined) await runtime.requestStop(binding).catch(() => undefined);
}

export function workFailure(reason: string): ErrorEnvelope {
	return {
		code: "external-failure",
		summary: `Work failed: ${reason}`,
		retryable: false,
		remediation: "Inspect the Archive for the explicit failure decision.",
		evidenceRefs: [],
	};
}

export function verdictSignalMatches(
	execution: Execution,
	signal: Signal | undefined,
	signalId: string,
	budgetExhausted: boolean,
): boolean {
	if (budgetExhausted) return signalId === "budget-exhausted";
	return signal !== undefined && signal.executionId === execution.executionId && signal.signalId === signalId;
}

export function reviewClearedFields(work: WorkView, changesRequested: boolean) {
	return {
		lastSignal: changesRequested ? undefined : work.lastSignal,
		lastObservation: changesRequested ? undefined : work.lastObservation,
		providerOutcome: changesRequested ? undefined : work.providerOutcome,
	};
}

export function reviewWorkState(changesRequested: boolean): WorkState {
	return changesRequested ? "active" : "awaiting-review";
}

export function requireReviewRequest(reviewRequest: WorkView["reviewRequest"]): NonNullable<WorkView["reviewRequest"]> {
	if (reviewRequest !== undefined) return reviewRequest;
	throw new Error("A review request is required for a review transition.");
}

export function hasRecoverableWork(work: WorkView): work is WorkView & { mission: Mission; execution: Execution } {
	return work.mission !== undefined && work.execution !== undefined;
}

export function isFeedbackExecution(execution: Execution | undefined): execution is Execution & { pi: RuntimeBinding } {
	return execution !== undefined && execution.pi !== undefined;
}

export function hasUnboundObserverReservation(work: WorkView): boolean {
	return work.observerInFlight === true && work.observer === undefined;
}

export function hasBoundObserverReservation(work: WorkView): boolean {
	return work.observerInFlight === true && work.observer !== undefined;
}

export function failedExecution(execution: Execution | undefined): Execution | undefined {
	return execution === undefined
		? undefined
		: { ...execution, state: "failed", blockReason: undefined, endedAt: new Date().toISOString() };
}

export function capabilityParts(
	token: string | undefined,
	createError: (message: string) => Error,
): readonly [encoded: string, signature: string] {
	if (token === undefined) throw createError("The role capability is missing.");
	const [encoded, signature] = token.split(".");
	if (encoded === undefined || signature === undefined) throw createError("The role capability is missing.");
	return [encoded, signature];
}

export function requireBoundWorkId(
	workId: string | undefined,
	boundWorkId: string | undefined,
	createError: (summary: string, remediation: string) => Error,
): string {
	if (workId !== undefined && (boundWorkId === undefined || boundWorkId === workId)) return workId;
	throw createError("This role must read its bound Work at a time.", "Supply the bound Work ID.");
}

export function signalExecution(execution: Execution, kind: Signal["kind"]): Execution {
	return kind === "blocked" ? { ...execution, state: "blocked", blockReason: "signal" } : execution;
}

export function reviewRequestFieldsMatch(
	request: NonNullable<WorkView["reviewRequest"]>,
	execution: Execution,
	headCommit: string,
	targetBranch: string,
): boolean {
	return [
		request.headCommit === headCommit,
		request.sourceBranch === execution.sandbox.branch,
		request.targetBranch === targetBranch,
		request.diffSummary.trim().length > 0,
		request.validation.length > 0,
	].every(Boolean);
}

export function publishedReviewMatches(
	request: NonNullable<WorkView["reviewRequest"]>,
	execution: Execution,
	targetBranch: string,
	headCommit: string,
): boolean {
	return [
		request.sourceBranch === execution.sandbox.branch,
		request.targetBranch === targetBranch,
		request.headCommit === headCommit,
	].every(Boolean);
}

export function isObserverPreAdmissionState(state: WorkState): boolean {
	return state === "submitted" || state === "needs-input";
}

export function isObserverAvailable(work: WorkView): boolean {
	return work.terms.context.length === 0 && work.observerInFlight !== true;
}

export function runtimeStateNeedsRecording(
	execution: Execution | undefined,
	runtimeState: RuntimeState,
): execution is Execution {
	return execution !== undefined && execution.runtimeState !== runtimeState;
}

export function validationResultsPassed(
	results: readonly Readonly<{ passed: boolean }>[],
	commands: readonly string[],
): boolean {
	return results.length === commands.length && results.every((result) => result.passed);
}

export function executorRuntimeEffects(workId: string, revision: number, wakeConclave: boolean) {
	return wakeConclave ? [schedulerEffect(workId, revision, undefined, "runtime-unreachable")] : undefined;
}

export function isAssessmentAuthorized(work: WorkView): boolean {
	return (work.state === "submitted" || work.state === "needs-input") && work.observerInFlight === true;
}

export function hasPendingOperations(
	autonomousCycleRun: Promise<void> | undefined,
	pendingEffectsRun: Promise<void> | undefined,
	backgroundOperations: ReadonlySet<Promise<void>>,
): boolean {
	return autonomousCycleRun !== undefined || pendingEffectsRun !== undefined || backgroundOperations.size > 0;
}

export function pendingOperations(
	autonomousCycleRun: Promise<void> | undefined,
	pendingEffectsRun: Promise<void> | undefined,
	backgroundOperations: ReadonlySet<Promise<void>>,
): readonly Promise<void>[] {
	return [
		...(autonomousCycleRun === undefined ? [] : [autonomousCycleRun]),
		...(pendingEffectsRun === undefined ? [] : [pendingEffectsRun]),
		...backgroundOperations,
	];
}

export function sameObservationIdentity(
	last: ProviderObservation | undefined,
	observation: ProviderObservation,
): last is ProviderObservation {
	return (
		last?.kind === observation.kind &&
		last.providerId === observation.providerId &&
		last.observationId === observation.observationId
	);
}

export function normalizeExecutorQuery(
	query: RecordQuery | undefined,
	workId: string,
	boundExecutionId: string | undefined,
	createError: (summary: string, remediation: string) => Error,
): RecordQuery {
	if (query?.executionId !== undefined && query.executionId !== boundExecutionId)
		throw createError("This Executor must read its bound Execution at a time.", "Supply the bound Execution ID.");
	return { ...query, workId };
}

export function isCancelledWork(work: WorkView): boolean {
	return work.state === "stopped" && work.stopReason === "cancelled";
}

export function canAmendTerms(work: WorkView): boolean {
	return work.mission === undefined && (work.state === "submitted" || work.state === "needs-input");
}

export function amendTermsReason(work: WorkView): string | undefined {
	return work.mission === undefined ? undefined : "Admitted Mission terms are immutable.";
}

export function isTerminalWork(work: WorkView): boolean {
	return ["succeeded", "stopped"].includes(work.state);
}

export function failedOrStoppedExecution(work: WorkView): boolean {
	return work.execution === undefined || ["failed", "stopped"].includes(work.execution.state);
}

export function canRequestInput(work: WorkView): boolean {
	return (work.state === "submitted" || work.state === "needs-input") && work.mission === undefined;
}

export function canStartQueuedExecution(work: WorkView): boolean {
	if (work.state !== "queued") return false;
	if (work.mission === undefined) return false;
	if (work.execution === undefined) return true;
	return work.execution.state === "stopped";
}

export function startExecutionReason(missionActive: boolean, executionReady: boolean): string | undefined {
	if (!missionActive) return "The Mission is no longer active.";
	return executionReady ? undefined : "Work is not ready for an Execution.";
}

export function isRunningOrBlocked(work: WorkView): boolean {
	return work.execution?.state === "running" || work.execution?.state === "blocked";
}

export function hasActiveExecutionBinding(work: WorkView): boolean {
	const execution = work.execution;
	return execution?.pi !== undefined && ["running", "awaiting-review"].includes(execution.state);
}

export function isRecoverableExecution(
	execution: Execution | undefined,
): execution is Execution & { pi: RuntimeBinding } {
	return execution?.pi !== undefined && ["running", "awaiting-review"].includes(execution.state);
}

export function recoveryReason(enabled: boolean): string | undefined {
	return enabled ? undefined : "Only stopped Work from cancellation or an unreachable runtime can be recovered.";
}

export function renameReason(work: WorkView): string | undefined {
	return work.state === "succeeded" ? "Succeeded Work cannot be renamed." : undefined;
}

export function reviewReason(work: WorkView): string | undefined {
	return work.state === "awaiting-review" ? undefined : "Work is not awaiting review.";
}

export function requestInputReason(work: WorkView): string | undefined {
	return work.mission === undefined ? undefined : "Mission terms are already admitted.";
}

export function isActiveMission(work: WorkView): boolean {
	return work.missionState === "admitted" || work.missionState === "active";
}

export function feedbackReason(enabled: boolean): string | undefined {
	return enabled ? undefined : "No undelivered, actionable provider feedback is available.";
}

export const ROLE_SETTING_CHANGES = {
	conclave: { model: (value) => ({ conclaveModel: value }), thinking: (value) => ({ conclaveThinking: value }) },
	executor: { model: (value) => ({ executorModel: value }), thinking: (value) => ({ executorThinking: value }) },
	observer: { model: (value) => ({ observerModel: value }), thinking: (value) => ({ observerThinking: value }) },
	oracle: { model: (value) => ({ oracleModel: value }), thinking: (value) => ({ oracleThinking: value }) },
} satisfies Record<GovernedRole, Readonly<Record<RoleSetting, (value: string) => Partial<ServiceOptions>>>>;

export function normalizeCaughtError(error: Error | string): Error {
	return error instanceof Error ? error : new Error(error);
}

export function externalFailureEnvelope(message: string): ErrorEnvelope {
	const summary =
		message.length === 0 ? "External Khala operation failed." : `External Khala operation failed: ${message}`;
	return {
		code: "external-failure",
		summary,
		retryable: true,
		remediation: "Inspect the evidence, reconcile the runtime or provider, and retry explicitly.",
		evidenceRefs: [],
	};
}

export function providerWakeMessage(work: WorkView, observationId: string | undefined): string {
	if (observationId !== undefined)
		return `Process provider observation ${observationId} for Work ${work.workId}. Read the Archive, assess whether it fits the Mission, and use deliver-feedback with this observation ID only for bounded, actionable changes.`;
	if (work.lastObservation?.kind === "review-comment")
		return `Process new provider feedback for Work ${work.workId}. Read the Archive, assess whether it fits the Mission, and use deliver-feedback only for bounded, actionable changes.`;
	return `Process queued Work ${work.workId}. Read the Archive first. Admit it if its Mission terms are complete, request-input when User intent is insufficient, then start its Execution when budget permits. Never treat this message as authority.`;
}
