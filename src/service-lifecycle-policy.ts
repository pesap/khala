import { type PendingArchiveEffect, RevisionConflict } from "./archive.js";
import {
	type ActionInput,
	type CommandMeta,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type JsonObject,
	type JsonValue,
	type Mission,
	type MissionSpecificity,
	type ProviderObservation,
	type ProviderReviewCommentObservation,
	type RecordView,
	type Signal,
	type SubmitWorkInput,
	type TokenUsage,
	type WorkSummary,
	type WorkView,
} from "./model.js";
import { type RuntimeBinding, type RuntimeState, type ServicePorts } from "./ports.js";
import {
	isActionableReviewComment,
	isTextValue,
	reviewObservationMatchesRequest,
	validProviderOutcomeObservation,
} from "./provider-observation-policy.js";
import { ActionInputError, ApplicationError } from "./service-contracts.js";
import {
	canStartQueuedExecution,
	DEFAULT_SCOPE,
	DEFAULT_VALIDATION,
	type DispatchEligibilityAttention,
	type ExecutorDriveContext,
	type FeedbackWakeDisposition,
	feedbackBelongsToExecution,
	isTerminalWork,
	isWaitingPreparation,
	type OutcomeSettlementWork,
	type ReviewStatus,
	type RoleCapability,
	requireReviewRequest,
	reviewClearedFields,
	type WorkWithMission,
	wakeResolutionMissing,
} from "./service-foundation-policy.js";
import {
	activeFeedbackWakeDisposition,
	canAmendMission,
	canLaunchObserver,
	canRecordFeedback,
	canRestartExecution,
	completedExecution,
	hasAdmittedMission,
	hasFeedbackIdentifier,
	isCurrentSignal,
	isJsonObject,
	isOpenReview,
	isQueuedMission,
	isReviewComment,
	isRevisionConflictApplicationError,
	matchesExecutorStop,
	observationFingerprint,
	reviewExecution,
	reviewNextAction,
	reviewStateFields,
	reviewStatusValue,
	stoppedWorkAction,
	validationAuthorizesHead,
	waitForDrain,
	workHasFailure,
} from "./service-runtime-policy.js";
import {
	type ConclaveWakeErrorKind,
	cleanupBindingPayload,
	executorIsWorking,
	executorTurnKey,
	failureMessage,
	hasTermChange,
	isGovernedRole,
	missingScope,
	missingValidation,
	missionSpecificityMessage,
	normalizeAllowedPath,
	normalizeTermList,
	readActionChoice,
	readEffectInteger,
	readEffectText,
	readEffectTextValue,
	requiredNonBlank,
	requiredText,
	requireMissionContext,
	runtimeBindingKey,
	sameRuntimeBinding,
	sameSignal,
	tokenUsageTotal,
} from "./service-state-policy.js";
import { type DispatchEligibility, dispatchEligibility } from "./workflow-dispatch.js";

export function wakeErrorKindFor(
	reason: ConclaveWakeCause | undefined,
	observation: ProviderObservation | undefined,
): ConclaveWakeErrorKind {
	const byReason = new Map<ConclaveWakeCause, ConclaveWakeErrorKind>([
		["executor-blocked", "blocked"],
		["executor-ready", "ready"],
		["executor-failed", "execution"],
		["runtime-unreachable", "runtime"],
		["provider-outcome", "outcome"],
		["provider-feedback", "feedback"],
		["token-exhausted", "token"],
	]);
	const reasonKind = reason === undefined ? undefined : byReason.get(reason);
	if (reasonKind !== undefined) return reasonKind;
	return isActionableReviewComment(observation) ? "feedback" : "admission";
}

function conclaveWakeErrorFor(kind: ConclaveWakeErrorKind, message: string): ErrorEnvelope {
	const details = {
		blocked: {
			summary: `Conclave blocked-work decision failed: ${message}`,
			remediation: "Inspect the current blocked Signal and retry its durable Conclave decision.",
		},
		ready: {
			summary: `Conclave ready-Signal decision failed: ${message}`,
			remediation: "Inspect the current ready Signal and retry its durable Verdict.",
		},
		execution: {
			summary: `Conclave Executor-failure decision failed: ${message}`,
			remediation: "Inspect the failed Executor evidence and retry replacement or failure explicitly.",
		},
		runtime: {
			summary: `Conclave runtime recovery failed: ${message}`,
			remediation:
				"Inspect Evidence and retry the autonomous runtime inspection. Do not restart the primary Pi session.",
		},
		outcome: {
			summary: `Conclave outcome settlement failed: ${message}`,
			remediation:
				"Inspect the Archive, restore the Conclave runtime if needed, and retry provider outcome settlement.",
		},
		feedback: {
			summary: `Conclave feedback assessment failed: ${message}`,
			remediation: "Inspect Evidence, restore the Conclave runtime if needed, and retry delivery explicitly.",
		},
		token: {
			summary: `Conclave token-exhaustion decision failed: ${message}`,
			remediation: "Inspect the current token-exhausted Execution and retry its durable Verdict.",
		},
		admission: {
			summary: `Conclave admission failed: ${message}`,
			remediation:
				"Inspect Evidence in /khala and reconcile held invocation usage before authorizing another attempt; amend or stop the Work if needed.",
		},
	} satisfies Record<ConclaveWakeErrorKind, Readonly<{ summary: string; remediation: string }>>;
	return { code: "external-failure", ...details[kind], retryable: false, evidenceRefs: [] };
}

export function readCapabilityRole(value: JsonValue | undefined): GovernedRole | undefined {
	return isTextValue(value) && isGovernedRole(value) ? value : undefined;
}

export function termScope(value: string | undefined): string {
	return value?.trim() || DEFAULT_SCOPE;
}

export function normalizeValidation(value: readonly string[] | undefined): readonly string[] {
	return normalizeTermList(value ?? [DEFAULT_VALIDATION], "validation item");
}

export function requireTermChanges(input: ActionInput | undefined): ActionInput {
	if (input === undefined || !hasTermChange(input)) throw new ActionInputError("At least one Work term is required.");
	return input;
}

export function validateMissionContext(changedContext: string | undefined, context: string): void {
	if (changedContext !== undefined) requireMissionContext(context);
}

export function changedText(current: string, value: string | undefined, key: string): string {
	return value === undefined ? current : requiredNonBlank(value, key);
}

export function normalizeAllowedPaths(paths: readonly string[]): readonly string[] {
	if (paths.length === 0) throw new ActionInputError("allowedPaths must contain at least one path.");
	return [...new Set(paths.map(normalizeAllowedPath))];
}

function readActionTextList(values: readonly string[], key: string): readonly string[] {
	return values.map((entry) => requiredNonBlank(entry, `${key} item`));
}

export function rawMissionSpecificity(input: SubmitWorkInput): MissionSpecificity {
	const missing = [missingScope(input), missingValidation(input)].filter(
		(value): value is string => value !== undefined,
	);
	return { status: missing.length === 0 ? "explicit" : "defaults-used", missing };
}

function executionDriveKey(workId: string, execution: Execution): string {
	return `${workId}:${execution.executionId}:${runtimeBindingKey(execution.pi)}`;
}

function observerDriveKey(workId: string, binding: RuntimeBinding): string {
	return `${workId}:${runtimeBindingKey(binding)}`;
}

export const IDLE_EXECUTOR_RECOVERY_ACTION = "Executor is idle; use Actions > Recover to continue.";

function idleExecutorRuntimeAction(nextAction: string): string {
	return executorIsWorking(nextAction) ? IDLE_EXECUTOR_RECOVERY_ACTION : nextAction;
}

function currentExecutorMatches(execution: Execution, expected: Execution | undefined): boolean {
	return [
		execution.state === "running",
		execution.executionId === expected?.executionId,
		sameRuntimeBinding(execution.pi, expected?.pi),
	].every(Boolean);
}

export function executionIsExhausted(execution: Execution, usage: TokenUsage | undefined): boolean {
	return usage !== undefined ? tokenUsageTotal(usage) >= execution.tokenAllowance : false;
}

export function executorTurnNextAction(current: WorkView, exhausted: boolean, work: WorkView): string {
	if (exhausted) return "Execution token allowance exhausted; Conclave must replace it or amend the Work budget.";
	return sameSignal(current, work) ? IDLE_EXECUTOR_RECOVERY_ACTION : current.nextAction;
}

export function conclaveWakeApplicable(work: WorkView, reason: ConclaveWakeCause | undefined): boolean {
	if (isTerminalWork(work)) return false;
	if (reason === "admission") return ["submitted", "queued"].includes(work.state);
	if (["provider-ci", "provider-feedback", "provider-outcome", "provider-closed"].some((cause) => cause === reason))
		return true;
	return wakeResolutionMissing(work, work, reason);
}

export function modelEffectEligibility(effect: PendingArchiveEffect, work: WorkView): DispatchEligibility {
	if (isTerminalWork(work)) return "eligible";
	return ["conclave-wake", "oracle-wake", "executor-wake", "observer-wake", "feedback-wake"].includes(effect.kind)
		? dispatchEligibility(work)
		: "eligible";
}

export function preparationDispatchAttention(work: WorkView, effectId: string): DispatchEligibilityAttention {
	return {
		error: {
			code: "external-failure",
			summary: "Executor preparation is waiting for User recovery.",
			retryable: false,
			remediation: "Correct the prerequisite, then explicitly recover this Work.",
			evidenceRefs: [work.preparation?.prerequisiteId ?? effectId],
		},
		nextAction: "Executor preparation failed; User recovery is required.",
	};
}

export function remainingExecutionAllowance(execution: Execution): number {
	const allowance =
		execution.tokenAllowance -
		tokenUsageTotal(execution.usage ?? { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
	if (allowance <= 0) throw new Error("Execution token allowance is exhausted.");
	return allowance;
}

export function executionFailureLearning(work: WorkView, failure: string) {
	const missingTerms = work.mission?.specificity?.missing ?? [];
	return {
		failure: failureMessage(failure),
		missionSpecificity: missionSpecificityMessage(missingTerms),
		nextMissionGuidance:
			"If the failure exposed missing intent, make that constraint explicit before starting a replacement Execution.",
	} satisfies Readonly<{ failure: string; missionSpecificity: string; nextMissionGuidance: string }>;
}

export function cleanupPayload(workId: string, execution: Execution) {
	const binding = execution.pi;
	return {
		workId,
		path: execution.sandbox.path,
		baseCommit: execution.sandbox.baseCommit,
		branch: execution.sandbox.branch,
		...cleanupBindingPayload(binding),
	};
}

export function observerCleanupEffect(workId: string, binding: RuntimeBinding) {
	return {
		effectId: `observer-cleanup:${workId}:${runtimeBindingKey(binding)}`,
		kind: "observer-cleanup",
		payload: {
			workId,
			sessionId: binding.sessionId,
			sessionPath: binding.sessionPath,
			processGroupId: binding.processGroupId,
			processStartTime: binding.processStartTime,
			capabilityNonce: binding.capabilityNonce,
			processMarker: binding.processMarker,
		},
	};
}

export function readCleanupSandbox(payload: JsonObject): Execution["sandbox"] {
	return {
		path: readEffectText(payload, "path"),
		baseCommit: readEffectText(payload, "baseCommit"),
		branch: readEffectText(payload, "branch"),
	};
}

export function optionalEffectInteger(payload: JsonObject, key: string): number | undefined {
	const value = payload[key];
	return value === undefined ? undefined : readEffectInteger(value, key);
}

export function optionalEffectText(payload: JsonObject, key: string): string | undefined {
	const value = payload[key];
	return value === undefined ? undefined : readEffectTextValue(value, key);
}

export function readOptionalEffectText(payload: JsonObject, key: string): string | undefined {
	const value = payload[key];
	return value === undefined ? undefined : readEffectTextValue(value, key);
}

export function actionTextList(value: readonly string[] | undefined, key: string): readonly string[] {
	if (value === undefined) throw new ActionInputError(`Action input ${key} must be a list of text.`);
	return value.map((entry) => requiredNonBlank(entry, `${key} item`));
}

export function readSignalKind(input: ActionInput | undefined): Signal["kind"] {
	return readActionChoice(requiredText(input?.kind, "kind"), ["progress", "blocked", "ready"], "Signal kind");
}

export function readDecision(input: ActionInput | undefined): "continue" | "replace" | "handoff" | "reject" {
	return readActionChoice(
		requiredText(input?.decision, "decision"),
		["continue", "replace", "handoff", "reject"],
		"Verdict decision",
	);
}

export function readReviewStatus(input: ActionInput | undefined): "changes-requested" | "merged" | "closed" {
	return readActionChoice(
		requiredText(input?.status, "status"),
		["changes-requested", "merged", "closed"],
		"Review status",
	);
}

export function isRevisionConflictError(error: Error): boolean {
	return error instanceof RevisionConflict || isRevisionConflictApplicationError(error);
}

export function matchesExecutorCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): boolean {
	const execution = work.execution;
	return [
		capability.workId === work.workId,
		capability.executionId === execution?.executionId,
		meta.roleNonce === capability.nonce,
		capability.nonce === execution?.pi?.capabilityNonce,
	].every(Boolean);
}

export function sameObservation(left: ProviderObservation, right: ProviderObservation): boolean {
	return observationFingerprint(left) === observationFingerprint(right);
}

export function isFeedbackObservation(record: RecordView, observationId: string): boolean {
	return isJsonObject(record.payload) && record.payload["observationId"] === observationId;
}

export function isPendingFeedbackReservation(record: RecordView, observationId: string): boolean {
	const payload = record.payload;
	if (!isJsonObject(payload)) return false;
	return (
		payload["observationId"] === observationId &&
		payload["delivered"] === false &&
		payload["disposition"] !== "superseded"
	);
}

export function isFeedbackDeliveryCurrent(
	work: WorkView | undefined,
	executionId: string,
	binding: RuntimeBinding,
): work is WorkView & { execution: Execution } {
	if (work === undefined) return false;
	return [
		work.execution?.executionId === executionId,
		canRecordFeedback(work.execution),
		sameRuntimeBinding(work.execution?.pi, binding),
	].every(Boolean);
}

export function pendingDeliveryMatchesExecution(record: RecordView, executionId: string | undefined): boolean {
	const payload = record.payload;
	if (!isJsonObject(payload)) return false;
	const deliveryExecutionId = payload["executionId"];
	return deliveryExecutionId === undefined || deliveryExecutionId === executionId;
}

export function matchesFeedbackDelivery(
	record: RecordView,
	observationId: string | undefined,
	deliveryId: string | undefined,
	delivered: boolean,
): boolean {
	const payload = record.payload;
	if (!isJsonObject(payload)) return false;
	if (payload["delivered"] !== delivered) return false;
	return hasFeedbackIdentifier(payload, observationId, deliveryId);
}

export function isReviewFeedback(
	observation: ProviderObservation | undefined,
): observation is ProviderReviewCommentObservation & { actionable: true; feedback: readonly string[] } {
	if (!isReviewComment(observation)) return false;
	if (observation.actionable !== true) return false;
	return Boolean(observation.feedback?.length);
}

function isCurrentValidation(work: WorkView, execution: Execution, headCommit: string): boolean {
	return validationAuthorizesHead(work, execution, headCommit);
}

export function isCurrentReadySignal(work: WorkView): boolean {
	return isCurrentSignal(work) && work.lastSignal?.kind === "ready";
}

export function isCurrentProviderOutcome(work: WorkView): work is OutcomeSettlementWork {
	const request = work.reviewRequest;
	const outcome = work.providerOutcome;
	if (request === undefined) return false;
	if (outcome === undefined) return false;
	return validProviderOutcomeObservation(request, outcome) && reviewObservationMatchesRequest(outcome, request);
}

export function succeededWork(work: WorkView): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		state: "succeeded",
		missionState: "succeeded",
		execution: completedExecution(work.execution),
		lastError: undefined,
		nextAction: "Work succeeded.",
	};
}

export async function closeRuntimeAfterDrain(
	runtime: Readonly<{ close: () => Promise<void> }>,
	operations: Promise<void>,
	timeoutMs: number,
): Promise<void> {
	const drained = await waitForDrain(operations, timeoutMs);
	if (!drained) await runtime.close();
	await operations;
	if (drained) await runtime.close();
}

export function cleanupRestoredWorkAction(work: WorkView): string {
	if (work.state === "succeeded") return "Work succeeded.";
	if (work.state !== "stopped") return "Conclave may retry the Work.";
	return stoppedWorkAction(work.stopReason);
}

export function feedbackWakeDisposition(work: WorkView, executionId: string | undefined): FeedbackWakeDisposition {
	if (!feedbackBelongsToExecution(work, executionId)) return "superseded";
	return activeFeedbackWakeDisposition(work);
}

export function executorDriveContext(work: WorkView): ExecutorDriveContext | undefined {
	const execution = work.execution;
	if (execution === undefined || execution.pi === undefined) return undefined;
	return {
		execution,
		key: executionDriveKey(work.workId, execution),
		turnKey: executorTurnKey(work.workId, execution.executionId),
	};
}

export function isSchedulerCandidate(candidate: WorkView): candidate is WorkWithMission {
	if (!isQueuedMission(candidate)) return false;
	return (
		hasAdmittedMission(candidate) && !isWaitingPreparation(candidate) && dispatchEligibility(candidate) === "eligible"
	);
}

export function reviewProjection(work: WorkView, status: ReviewStatus): WorkView {
	const changesRequested = status === "changes-requested";
	const reviewRequest = requireReviewRequest(work.reviewRequest);
	return {
		...work,
		revision: work.revision + 1,
		reviewRequest: { ...reviewRequest, status: reviewStatusValue(status) },
		...reviewClearedFields(work, changesRequested),
		...reviewStateFields(work, changesRequested),
		execution: reviewExecution(work, status),
		nextAction: reviewNextAction(status),
	};
}

export function isOracleInputReady(work: WorkView): work is WorkView & {
	mission: Mission;
	execution: Execution;
	reviewRequest: NonNullable<WorkView["reviewRequest"]>;
} {
	return [
		work.mission !== undefined,
		isCurrentReadySignal(work),
		work.execution?.state === "running",
		isOpenReview(work.reviewRequest),
	].every(Boolean);
}

export function validationEvidenceIsCurrent(
	runValidation: ServicePorts["workspace"]["runValidation"],
	work: WorkView,
	execution: Execution,
	head: string,
): boolean {
	return runValidation !== undefined && isCurrentValidation(work, execution, head);
}

export function canStartExecution(work: WorkView): boolean {
	return canStartQueuedExecution(work) || canRestartExecution(work);
}

export function amendMissionReason(work: WorkView): string | undefined {
	const enabled = canAmendMission(work);
	return enabled ? undefined : "The Mission is not amendable now.";
}

export function observerReason(work: WorkView): string | undefined {
	return canLaunchObserver(work) ? undefined : "Work already contains context or an Observer is running.";
}

export function oracleInputsReady(work: WorkView): boolean {
	return isCurrentReadySignal(work) && isOpenReview(work.reviewRequest);
}

export function workSummary(work: WorkView, queuePositions: ReadonlyMap<string, number>): WorkSummary {
	return {
		workId: work.workId,
		title: work.terms.title,
		state: work.state,
		stopReason: work.stopReason,
		missionState: work.missionState,
		executionState: work.execution?.state,
		hasFailure: workHasFailure(work),
		revision: work.revision,
		queuePosition: queuePositions.get(work.workId),
		budget: work.budget,
		nextAction: work.nextAction,
	};
}

export function canStopExecutor(
	current: WorkView | undefined,
	execution: Execution,
	binding: RuntimeBinding,
	allowedStates: readonly Execution["state"][],
): boolean {
	const currentExecution = current?.execution;
	if (currentExecution === undefined) return false;
	return matchesExecutorStop(currentExecution, execution, binding, allowedStates);
}

export function conclaveWakeError(failure: Error, kind: ConclaveWakeErrorKind): ErrorEnvelope {
	if (failure instanceof ApplicationError) return failure.envelope;
	return conclaveWakeErrorFor(kind, failure.message.slice(0, 2_000));
}

export function normalizePaths(value: readonly string[] | undefined): readonly string[] {
	return normalizeAllowedPaths(value ?? ["."]);
}

export function changedList(
	current: readonly string[],
	value: readonly string[] | undefined,
	key: string,
): readonly string[] {
	return value === undefined ? current : readActionTextList(value, key);
}

export function readOptionalActionTextList(values: readonly string[] | undefined, key: string): readonly string[] {
	return values === undefined ? [] : readActionTextList(values, key);
}

export function observerDriveKeyFor(work: WorkView, binding: RuntimeBinding | undefined): string {
	return observerDriveKey(work.workId, binding ?? { sessionId: `pending:${work.workId}`, sessionPath: work.workId });
}

export function hasMonitorableReview(work: WorkView): boolean {
	const status = work.reviewRequest?.status;
	if (status === "merged") return !isCurrentProviderOutcome(work);
	return status === "draft" || status === "open";
}

export function activeExecutorRuntimeAction(nextAction: string, runtimeState: RuntimeState): string {
	if (runtimeState === "idle") return idleExecutorRuntimeAction(nextAction);
	if (runtimeState === "working" && nextAction === IDLE_EXECUTOR_RECOVERY_ACTION) return "Executor is working.";
	return nextAction;
}

export function isCurrentExecutor(
	execution: Execution | undefined,
	expected: Execution | undefined,
): execution is Execution {
	if (execution === undefined) return false;
	return currentExecutorMatches(execution, expected);
}
