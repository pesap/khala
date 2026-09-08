import { type ArchivePort } from "./archive.js";
import {
	type ActionInput,
	type Actor,
	assertPositiveInteger,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type JsonObject,
	type JsonValue,
	type ProviderObservation,
	type ProviderReviewCommentObservation,
	type RecordQuery,
	type RoleSetting,
	type Signal,
	type SubmitWorkInput,
	type WorkView,
} from "./model.js";
import { type OperationContext, type OracleResult, type RuntimeBinding, type RuntimeState } from "./ports.js";
import { schedulerEffect } from "./provider-observation-policy.js";
import { ApplicationError, type ServiceOptions } from "./service-contracts.js";
import {
	type ActionSpec,
	amendTermsReason,
	canAmendTerms,
	canRequestInput,
	configuredMaxConcurrentRuns,
	type FeedbackWakeDisposition,
	failedOrStoppedExecution,
	hasActiveExecutionBinding,
	hasStartableMissionState,
	isCancelledWork,
	isRunningOrBlocked,
	isTerminalWork,
	normalizeExecutorQuery,
	providerWakeMessage,
	type ReviewStateFields,
	type ReviewStatus,
	ROLE_SETTING_CHANGES,
	recoveryReason,
	renameReason,
	requireBoundWorkId,
	reviewReason,
	reviewRequestFieldsMatch,
	reviewWorkState,
	type VerdictDecision,
	type VerdictTransition,
	WAKE_RESOLUTION_ERRORS,
	type WorkWithMission,
	wakeResolutionMissing,
} from "./service-foundation-policy.js";
import {
	directedWakeMessage,
	executorStopEffect,
	feedbackEffect,
	hasFailedExecution,
	hasFailedWorkStop,
	isRuntimeUnavailable,
	queueSchedulerEffect,
	sameRuntimeBinding,
} from "./service-state-policy.js";
import { DispatchEligibilityError, dispatchEligibility } from "./workflow-dispatch.js";

export function oraclePayload(
	result: OracleResult,
	promptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>,
): JsonObject {
	return {
		promptIdentity,
		verdict: result.verdict,
		findings: result.findings.map((finding) => ({
			severity: finding.severity,
			summary: finding.summary,
			evidence: finding.evidence,
		})),
		validationGaps: [...result.validationGaps],
		durationMs: result.durationMs,
		output: result.output.slice(0, 16_000),
	};
}

export function providerOutcomeWakeMarker(workId: string, observationId: string): string {
	return `provider-outcome-wake:${workId}:${observationId}`;
}

export function monitorFailureMarker(subject: string, workId: string): string {
	return `monitor-failure:${subject}:${workId}`;
}

export function monitorFailureEnvelope(work: WorkView, subject: string, message: string): ErrorEnvelope {
	return {
		code: "external-failure",
		source: subject === "Provider" ? "provider-monitor" : undefined,
		summary: `${subject} monitor failed: ${message}`,
		retryable: true,
		remediation: "Khala will retry automatically; inspect Evidence if the failure persists.",
		evidenceRefs: work.reviewRequest === undefined ? [] : [work.reviewRequest.providerId],
	};
}

export function isRevisionConflictApplicationError(error: Error): boolean {
	return error instanceof ApplicationError && error.envelope.code === "revision-conflict";
}

export function observationFingerprint(observation: ProviderObservation): string {
	return JSON.stringify({
		observationId: observation.observationId,
		kind: observation.kind,
		providerId: observation.providerId,
		status: observation.status,
		summary: observation.summary,
		repository: observation.repository,
		sourceBranch: observation.sourceBranch,
		targetBranch: observation.targetBranch,
		baseCommit: observation.baseCommit,
		headCommit: observation.headCommit,
		mergeCommit: observation.mergeCommit,
		feedback: observation.feedback,
		details: observation.details,
		author: observation.author,
		authorAssociation: observation.authorAssociation,
		reviewState: observation.reviewState,
		actionable: observation.actionable,
	});
}

export function canRecordFeedback(execution: Execution | undefined): boolean {
	return execution !== undefined && (execution.state === "running" || execution.state === "blocked");
}

export function feedbackDispositionDetails(
	disposition: "retry" | "superseded",
): Readonly<{ nextAction: string; summary: string }> {
	return disposition === "superseded"
		? {
				nextAction: "Provider feedback was superseded by terminal Work; inspect the Archive.",
				summary: "Authorized provider feedback was superseded by terminal Work.",
			}
		: {
				nextAction: "Authorized review feedback remains recorded. Reconcile the next Executor.",
				summary: "Authorized review feedback was retained for reconciliation.",
			};
}

export function hasFeedbackIdentifier(
	payload: JsonObject,
	observationId: string | undefined,
	deliveryId: string | undefined,
): boolean {
	return (
		(deliveryId !== undefined && payload["deliveryId"] === deliveryId) ||
		(observationId !== undefined && payload["observationId"] === observationId)
	);
}

export function isReviewComment(
	observation: ProviderObservation | undefined,
): observation is ProviderReviewCommentObservation {
	return observation?.kind === "review-comment";
}

export function validationMatchesExecution(
	validation: NonNullable<WorkView["lastValidation"]>,
	execution: Execution,
	headCommit: string,
): boolean {
	return validation.executionId === execution.executionId && validation.headCommit === headCommit;
}

export function validationPassed(work: WorkView, validation: NonNullable<WorkView["lastValidation"]>): boolean {
	return (
		validation.sourceVerified === true &&
		validation.results.length === work.terms.validation.length &&
		validation.results.every((result) => result.passed)
	);
}

export function validationAuthorizesHead(work: WorkView, execution: Execution, headCommit: string): boolean {
	const validation = work.lastValidation;
	return (
		validation !== undefined &&
		validationMatchesExecution(validation, execution, headCommit) &&
		validationPassed(work, validation)
	);
}

export function isCurrentSignal(work: WorkView): boolean {
	return work.execution !== undefined && work.lastSignal?.executionId === work.execution.executionId;
}

export function isOpenReview(
	reviewRequest: WorkView["reviewRequest"],
): reviewRequest is NonNullable<WorkView["reviewRequest"]> {
	return reviewRequest?.status === "draft" || reviewRequest?.status === "open";
}

export function outcomeEvidenceError(): ApplicationError {
	return new ApplicationError({
		code: "invalid-state",
		summary: "A Work Outcome requires provider-confirmed merge evidence.",
		retryable: false,
		remediation: "Poll and inspect the provider outcome first.",
		evidenceRefs: [],
	});
}

export function completedExecution(execution: Execution | undefined): Execution | undefined {
	return execution === undefined ? undefined : { ...execution, state: "completed", endedAt: new Date().toISOString() };
}

export function isLiveMissionWork(work: WorkView): boolean {
	return (
		(work.state === "active" || work.state === "awaiting-review") &&
		(work.missionState === "active" || work.missionState === "awaiting-review")
	);
}

export async function waitForDrain(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
		timer.unref();
	});
	const drained = await Promise.race([operation.then(() => true), timeout]);
	if (timer !== undefined) clearTimeout(timer);
	return drained;
}

export function cleanupLabel(kind: string): string {
	return kind === "workspace-cleanup" ? "Sandbox" : "Observer";
}

export function stoppedWorkAction(reason: WorkView["stopReason"]): string {
	return reason === "failed" ? "Work failed by explicit decision." : "Work cancelled by the User.";
}

export function cleanupFailureMatches(work: WorkView | undefined, effectId: string): work is WorkView {
	return work?.lastError?.evidenceRefs.includes(effectId) === true;
}

export function actionFingerprint(action: string, input: SubmitWorkInput | ActionInput | undefined): string {
	return JSON.stringify({ action, input: input ?? {} }, (_key, value: JsonValue) =>
		isJsonObject(value)
			? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
			: value,
	);
}

export function throwIfOperationAborted(operation: OperationContext | undefined): void {
	if (operation?.signal?.aborted === true) throw new Error("Khala operation was cancelled.");
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function executorStopMatches(
	execution: Execution | undefined,
	executionId: string,
	binding: RuntimeBinding,
): boolean {
	return (
		execution?.executionId === executionId &&
		execution.state === "awaiting-review" &&
		sameRuntimeBinding(execution.pi, binding)
	);
}

export function activeFeedbackWakeDisposition(work: WorkView): FeedbackWakeDisposition {
	if (work.execution?.state === "running") return "resume";
	return isTerminalWork(work) ? "superseded" : "unavailable";
}

export function assertConclaveWakeResolution(
	work: WorkView,
	current: WorkView,
	cause: ConclaveWakeCause | undefined,
): void {
	if (!wakeResolutionMissing(work, current, cause)) return;
	if (dispatchEligibility(current) === "budget-exhausted") throw new DispatchEligibilityError("budget-exhausted");
	throw unresolvedWakeError(cause);
}

function unresolvedWakeError(cause: ConclaveWakeCause | undefined): Error {
	const wakeType = cause ?? "admission";
	return new Error(WAKE_RESOLUTION_ERRORS.get(wakeType) ?? "Conclave wake resolution is missing.");
}

export function observerDriveIsCurrent(work: WorkView | undefined, binding: RuntimeBinding): work is WorkView {
	if (work === undefined) return false;
	if (work.observerInFlight !== true) return false;
	return sameRuntimeBinding(work.observer, binding);
}

export function isStartableMission(work: WorkView): work is WorkWithMission {
	return work.mission !== undefined && hasStartableMissionState(work) && work.preparation?.status !== "waiting";
}

export function nextCorrectionCount(work: WorkView, decision: VerdictDecision): number | undefined {
	return decision === "replace" ? (work.correctionCount ?? 0) + 1 : work.correctionCount;
}

export function hasQueuedMission(work: WorkView): work is WorkWithMission {
	return work.state === "queued" && work.mission !== undefined;
}

export function submissionDispatchLimits(options: ServiceOptions) {
	return {
		maxConcurrentRuns: configuredMaxConcurrentRuns(options),
		maxCorrections: assertPositiveInteger(options.maxCorrections ?? 3, "maxCorrections"),
	};
}

export function workMaxConcurrentRuns(work: WorkView, options: ServiceOptions): number {
	return work.dispatchLimits?.maxConcurrentRuns ?? configuredMaxConcurrentRuns(options);
}

export function hasExecutionAllowance(work: WorkWithMission): boolean {
	const allowance = Math.floor(work.budget.maxTokens / 2);
	const available = work.budget.maxTokens - work.budget.consumedTokens - work.budget.reservedTokens;
	return Math.min(allowance, available) > 0;
}

export function isQueuedMission(candidate: WorkView): candidate is WorkWithMission {
	return candidate.state === "queued" && candidate.mission !== undefined;
}

export function hasAdmittedMission(candidate: WorkWithMission): boolean {
	return ["admitted", "active"].includes(candidate.missionState ?? "");
}

export function queuedExecutionProjection(work: WorkWithMission, execution: Execution): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		state: "active",
		missionState: "active",
		preparation: undefined,
		reviewRequest: undefined,
		lastSignal: undefined,
		lastObservation: undefined,
		providerOutcome: undefined,
		lastValidation: undefined,
		lastError: undefined,
		execution,
		nextAction: "Executor is starting.",
	};
}

export function failedRecoveryExecution(execution: Execution, executorState: RuntimeState): Execution {
	return {
		...execution,
		state: "failed",
		runtimeState: isRuntimeUnavailable(executorState) ? executorState : "unreachable",
		endedAt: new Date().toISOString(),
	};
}

export const verdictTransitions = {
	continue: (work: WorkView, execution: Execution): VerdictTransition => ({
		execution: { ...execution, state: "running", blockReason: undefined },
		state: "active",
		missionState: work.missionState,
		lastSignal: undefined,
		nextAction: "Executor continues.",
	}),
	handoff: (work: WorkView, execution: Execution): VerdictTransition => ({
		execution: { ...execution, state: "awaiting-review", blockReason: undefined },
		state: "awaiting-review",
		missionState: "awaiting-review",
		lastSignal: work.lastSignal,
		nextAction: "Awaiting User review.",
	}),
	reject: (work: WorkView, execution: Execution): VerdictTransition => ({
		execution: { ...execution, state: "failed", blockReason: undefined, endedAt: new Date().toISOString() },
		state: "active",
		missionState: "rejected",
		lastSignal: work.lastSignal,
		nextAction: "Mission rejected; Conclave decision is required for Work closure.",
	}),
	replace: (work: WorkView, execution: Execution): VerdictTransition => ({
		execution: { ...execution, state: "stopped", blockReason: undefined, endedAt: new Date().toISOString() },
		state: "queued",
		missionState: work.missionState,
		lastSignal: work.lastSignal,
		nextAction: "Replacement Execution is queued under the same Mission.",
	}),
} satisfies Record<VerdictDecision, (work: WorkView, execution: Execution) => VerdictTransition>;

export function handoffIsReady(
	work: WorkView,
	execution: Execution,
	signal: Signal | undefined,
	providerEvidenceValid: boolean,
): boolean {
	return [
		signal?.kind === "ready",
		execution.state === "running",
		isOpenReview(work.reviewRequest),
		providerEvidenceValid,
		validationAuthorizesHead(work, execution, work.reviewRequest?.headCommit ?? ""),
	].every(Boolean);
}

export function reviewStatusValue(status: ReviewStatus): "open" | "merged" | "closed" {
	return status === "changes-requested" ? "open" : status;
}

export function reviewExecution(work: WorkView, status: ReviewStatus): Execution | undefined {
	return work.execution === undefined || status !== "changes-requested"
		? work.execution
		: { ...work.execution, state: "running" };
}

export function reviewStateFields(work: WorkView, changesRequested: boolean): ReviewStateFields {
	return {
		state: reviewWorkState(changesRequested),
		missionState: changesRequested ? "active" : work.missionState,
	};
}

export function reviewNextAction(status: ReviewStatus): string {
	return {
		"changes-requested": "Executor may address authorized review feedback.",
		merged: "Conclave must verify provider merge evidence and record the Outcome.",
		closed: "Review closed without acceptance.",
	}[status];
}

export function reviewFeedbackDelivery(
	work: WorkView,
	status: ReviewStatus,
	revision: number,
	feedback: readonly string[],
) {
	return status === "changes-requested"
		? feedbackEffect(work.workId, revision, work.execution?.executionId, undefined, feedback)
		: undefined;
}

export function reviewEffects(
	work: WorkView,
	revision: number,
	feedbackDelivery: ReturnType<typeof feedbackEffect> | undefined,
) {
	if (feedbackDelivery !== undefined) return [feedbackDelivery];
	return [
		schedulerEffect(work.workId, revision),
		...(work.execution?.pi === undefined ? [] : [executorStopEffect(work.workId, revision, work.execution)]),
	];
}

export function feedbackExecutionIsActive(work: WorkView, execution: Execution): boolean {
	return (execution.state === "running" || execution.state === "awaiting-review") && !isTerminalWork(work);
}

export function normalizeScopedQuery(
	query: RecordQuery | undefined,
	actor: Actor,
	boundWorkId: string | undefined,
	boundExecutionId: string | undefined,
	createError: (summary: string, remediation: string) => Error,
): RecordQuery {
	const workId = requireBoundWorkId(query?.workId, boundWorkId, createError);
	return actor === "executor"
		? normalizeExecutorQuery(query, workId, boundExecutionId, createError)
		: { ...query, workId };
}

export function signalEffects(workId: string, revision: number, kind: Signal["kind"]) {
	return {
		blocked: [schedulerEffect(workId, revision, undefined, "executor-blocked"), queueSchedulerEffect(workId, revision)],
		ready: [schedulerEffect(workId, revision, undefined, "executor-ready")],
		progress: undefined,
	}[kind];
}

export function reviewRequestIsCurrent(
	request: WorkView["reviewRequest"],
	execution: Execution,
	headCommit: string,
	targetBranch: string,
): boolean {
	if (request === undefined) return false;
	return reviewRequestFieldsMatch(request, execution, headCommit, targetBranch);
}

export function readyReviewRequestMatches(
	request: NonNullable<WorkView["reviewRequest"]>,
	execution: Execution,
	targetBranch: string,
): boolean {
	return [
		isOpenReview(request),
		request.sourceBranch === execution.sandbox.branch,
		request.targetBranch === targetBranch,
	].every(Boolean);
}

export function latestObservationFingerprint(
	archive: ArchivePort,
	workId: string,
	observation: ProviderObservation,
): string | undefined {
	const previous = archive.findLatestObservation(
		workId,
		observation.kind,
		observation.providerId,
		observation.observationId,
	);
	return previous === undefined ? undefined : observationFingerprint(previous);
}

export function unavailableRuntime(work: WorkView, runtimeState: RuntimeState | undefined): boolean {
	const execution = work.execution;
	return hasActiveExecutionBinding(work) && isRuntimeUnavailable(runtimeState ?? execution?.runtimeState);
}

export function canAmendMission(work: WorkView): boolean {
	return work.mission !== undefined && !isTerminalWork(work) && failedOrStoppedExecution(work);
}

export function canLaunchObserver(work: WorkView): boolean {
	return canRequestInput(work) && work.terms.context.length === 0 && work.observerInFlight !== true;
}

export function canRestartExecution(work: WorkView): boolean {
	return (
		work.state === "active" &&
		work.mission !== undefined &&
		failedOrStoppedExecution(work) &&
		work.execution !== undefined
	);
}

function hasRecoverablePreparation(work: WorkView): boolean {
	if (!hasQueuedMission(work)) return false;
	return work.preparation?.status === "waiting";
}

export function userActionSpecs(work: WorkView, runtimeUnavailable: boolean): readonly ActionSpec[] {
	const terminal = isTerminalWork(work);
	const recoverable = isCancelledWork(work) || runtimeUnavailable || hasRecoverablePreparation(work);
	return [
		{
			kind: "amend-terms",
			enabled: canAmendTerms(work),
			label: "Amend Work terms",
			disabledReason: amendTermsReason(work),
		},
		{ kind: "recover", enabled: recoverable, label: "Recover Work", disabledReason: recoveryReason(recoverable) },
		{
			kind: "rename-work",
			enabled: work.state !== "succeeded",
			label: "Rename Work",
			disabledReason: renameReason(work),
		},
		{
			kind: "fail-work",
			enabled: !terminal,
			label: "Fail Work",
			disabledReason: "Terminal Work cannot be failed again.",
		},
		{
			kind: "amend-budget",
			enabled: !terminal,
			label: "Amend Work budget",
			disabledReason: "Terminal Work cannot be amended.",
		},
		{
			kind: "record-review",
			enabled: work.state === "awaiting-review",
			label: "Record provider review",
			disabledReason: reviewReason(work),
		},
		{ kind: "cancel", enabled: !terminal, label: "Cancel Work" },
	];
}

export function verdictReady(work: WorkView): boolean {
	return (isCurrentSignal(work) || work.execution?.blockReason === "budget-exhausted") && isRunningOrBlocked(work);
}

export function verdictReason(work: WorkView): string {
	return isCurrentSignal(work) || work.execution?.blockReason === "budget-exhausted"
		? "The current Execution is not awaiting a Verdict."
		: "No current Signal is available.";
}

export function roleSettingChange(role: GovernedRole, setting: RoleSetting, value: string): Partial<ServiceOptions> {
	return ROLE_SETTING_CHANGES[role][setting](value);
}

export function workHasFailure(work: WorkView): boolean {
	return work.lastError !== undefined || hasFailedWorkStop(work) || hasFailedExecution(work);
}

export function matchesExecutorStop(
	current: Execution,
	execution: Execution,
	binding: RuntimeBinding,
	allowedStates: readonly Execution["state"][],
): boolean {
	return [
		current.executionId === execution.executionId,
		allowedStates.includes(current.state),
		sameRuntimeBinding(current.pi, binding),
	].every(Boolean);
}

export function conclaveWakeMessage(
	work: WorkView,
	observationId: string | undefined,
	reason: ConclaveWakeCause | undefined,
): string {
	return directedWakeMessage(work.workId, reason) ?? providerWakeMessage(work, observationId);
}
