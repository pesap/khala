import { type PendingArchiveEffect } from "./archive.js";
import {
	type ActionInput,
	assertNonBlank,
	type ConclaveWakeCause,
	type ErrorEnvelope,
	type Execution,
	isConclaveWakeCause,
	type JsonObject,
	type ProviderObservation,
	type ProviderReviewCommentObservation,
	type RecordView,
	type SubmitWorkInput,
	type WorkTerms,
	type WorkView,
} from "./model.js";
import { type RuntimeBinding, type RuntimeState, type ServicePorts } from "./ports.js";
import { reviewObservationMatchesRequest, schedulerEffect } from "./provider-observation-policy.js";
import {
	type DispatchEligibilityAttention,
	isActiveMission,
	type OutcomeSettlementWork,
	type ServiceFailure,
	startExecutionReason,
	type VerdictDecision,
	type WorkWithMission,
} from "./service-foundation-policy.js";
import {
	actionTextList,
	activeExecutorRuntimeAction,
	canStartExecution,
	changedList,
	changedText,
	cleanupPayload,
	cleanupRestoredWorkAction,
	conclaveWakeApplicable,
	executionFailureLearning,
	executorTurnNextAction,
	hasMonitorableReview,
	isCurrentExecutor,
	isCurrentProviderOutcome,
	isFeedbackDeliveryCurrent,
	isFeedbackObservation,
	isOracleInputReady,
	isPendingFeedbackReservation,
	isReviewFeedback,
	isSchedulerCandidate,
	normalizeAllowedPaths,
	normalizePaths,
	normalizeValidation,
	observerCleanupEffect,
	optionalEffectInteger,
	optionalEffectText,
	oracleInputsReady,
	pendingDeliveryMatchesExecution,
	preparationDispatchAttention,
	readOptionalEffectText,
	requireTermChanges,
	termScope,
	validateMissionContext,
	validationEvidenceIsCurrent,
} from "./service-lifecycle-policy.js";
import {
	hasExecutionAllowance,
	isLiveMissionWork,
	isOpenReview,
	outcomeEvidenceError,
} from "./service-runtime-policy.js";
import {
	cleanupBindingIdentity,
	executorEffect,
	executorStopEffect,
	hasMonitorableExecution,
	hasRuntimeAction,
	isConcurrentExecution,
	isRuntimeUnavailable,
	needsExecutorStop,
	needsSchedulerWake,
	needsWorkspaceCleanup,
	nonBlankCriteria,
	normalizeTermList,
	positiveTermTokens,
	queueSchedulerEffect,
	readEffectText,
	requireNonEmptyTermList,
	termContext,
} from "./service-state-policy.js";
import { type DispatchEligibility } from "./workflow-dispatch.js";

export function executorTurnProjection(
	current: WorkView,
	nextExecution: Execution,
	exhausted: boolean,
	work: WorkView,
): WorkView {
	return {
		...current,
		revision: current.revision + 1,
		execution: nextExecution,
		nextAction: executorTurnNextAction(current, exhausted, work),
	};
}

export function staleConclaveWake(
	effect: PendingArchiveEffect,
	work: WorkView,
	reason: ConclaveWakeCause | undefined,
): boolean {
	return effect.kind === "conclave-wake" && !conclaveWakeApplicable(work, reason);
}

export function dispatchEligibilityAttention(
	work: WorkView,
	eligibility: Exclude<DispatchEligibility, "eligible">,
	effectId: string,
): DispatchEligibilityAttention {
	if (eligibility === "preparation-waiting") return preparationDispatchAttention(work, effectId);
	if (eligibility === "reservation-waiting")
		return {
			error: {
				code: "external-failure",
				summary: "Model dispatch is waiting for an existing invocation to settle.",
				retryable: false,
				remediation:
					"Wait for the existing invocation to settle or be explicitly reconciled; do not start another run.",
				evidenceRefs: [effectId],
			},
			nextAction: "Work dispatch is waiting for an existing invocation to settle.",
		};
	return {
		error: {
			code: "budget-exhausted",
			summary: "Model dispatch is waiting for additional Work budget.",
			retryable: false,
			remediation: "Amend the Work budget above its consumed and reserved tokens, then retry dispatch.",
			evidenceRefs: [effectId],
		},
		nextAction: "Work budget is exhausted; amend the budget before retrying dispatch.",
	};
}

export function executionFailure(work: WorkView, executionId: string, error: Error | string): ErrorEnvelope {
	const failure = String(error instanceof Error ? error.message : error)
		.trim()
		.slice(0, 2_000);
	return {
		code: "external-failure",
		summary: `Execution ${executionId} failed${failure.length === 0 ? "." : `: ${failure}`}`,
		retryable: true,
		remediation: "Inspect Evidence, then replace the Execution or amend the Mission before retrying.",
		evidenceRefs: [executionId],
		learning: executionFailureLearning(work, failure),
	};
}

function cleanupEffect(workId: string, execution: Execution) {
	return {
		effectId: `workspace-cleanup:${workId}:${execution.executionId}:${cleanupBindingIdentity(execution.pi)}`,
		kind: "workspace-cleanup",
		payload: cleanupPayload(workId, execution),
	};
}

export function observerEffects(workId: string, revision: number, binding: RuntimeBinding | undefined) {
	const effects = [schedulerEffect(workId, revision)];
	if (binding !== undefined) effects.push(observerCleanupEffect(workId, binding));
	return effects;
}

export function readEffectBinding(payload: JsonObject): RuntimeBinding {
	return {
		sessionId: readEffectText(payload, "sessionId"),
		sessionPath: readEffectText(payload, "sessionPath"),
		processGroupId: optionalEffectInteger(payload, "processGroupId"),
		processStartTime: optionalEffectText(payload, "processStartTime"),
		capabilityNonce: optionalEffectText(payload, "capabilityNonce"),
		processMarker: optionalEffectText(payload, "processMarker"),
	};
}

export function readEffectWakeCause(payload: JsonObject): ConclaveWakeCause {
	const value = readOptionalEffectText(payload, "reason");
	if (value !== undefined && isConclaveWakeCause(value)) return value;
	throw new Error("Conclave wake effect is missing a valid finite cause.");
}

export function readTextList(input: ActionInput | undefined, key: "evidence" | "feedback"): readonly string[] {
	return actionTextList(key === "evidence" ? input?.evidence : input?.feedback, key);
}

export function isCurrentFeedbackTurn(
	work: WorkView | undefined,
	executionId: string,
	binding: RuntimeBinding,
): work is WorkView & { execution: Execution } {
	return isFeedbackDeliveryCurrent(work, executionId, binding) && work.execution.state === "running";
}

export function pendingFeedbackMatches(
	record: RecordView,
	observationId: string,
	executionId: string | undefined,
): boolean {
	return (
		isFeedbackObservation(record, observationId) &&
		isPendingFeedbackReservation(record, observationId) &&
		pendingDeliveryMatchesExecution(record, executionId)
	);
}

export function isCurrentReviewFeedback(
	work: WorkView,
	observation: ProviderObservation | undefined,
): observation is ProviderReviewCommentObservation & {
	actionable: true;
	feedback: readonly string[];
} {
	const reviewRequest = work.reviewRequest;
	if (!isOpenReview(reviewRequest)) return false;
	if (!isReviewFeedback(observation)) return false;
	if (observation.providerId !== reviewRequest.providerId) return false;
	return reviewObservationMatchesRequest(observation, reviewRequest);
}

export function isProviderOutcomeSettlementPending(work: WorkView): work is OutcomeSettlementWork {
	return isLiveMissionWork(work) && work.reviewRequest?.status === "merged" && isCurrentProviderOutcome(work);
}

export function cleanupRestoredAction(work: WorkView, kind: string): string {
	return kind === "observer-cleanup"
		? "Conclave must reread the Observer assessment."
		: cleanupRestoredWorkAction(work);
}

function queuedWorkIsNext(work: WorkWithMission, projects: readonly WorkView[]): boolean {
	const firstEligible = projects
		.filter(isSchedulerCandidate)
		.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
	return work.state !== "queued" || firstEligible === undefined || firstEligible.workId === work.workId;
}

export function reviewFeedback(input: ActionInput | undefined): readonly string[] {
	return input?.feedback === undefined ? [] : readTextList(input, "feedback");
}

export function readyReviewEvidence(
	work: WorkView,
	execution: Execution,
	request: NonNullable<WorkView["reviewRequest"]>,
	head: string,
	providerEvidenceValid: boolean,
	runValidation: ServicePorts["workspace"]["runValidation"],
): boolean {
	return [
		request.headCommit === head,
		providerEvidenceValid,
		request.diffSummary.trim().length > 0,
		request.validation.length > 0,
		validationEvidenceIsCurrent(runValidation, work, execution, head),
	].every(Boolean);
}

export function startExecutionEnabled(work: WorkView): boolean {
	return isActiveMission(work) && canStartExecution(work);
}

export function startExecutionReasonForWork(work: WorkView): string | undefined {
	return startExecutionReason(isActiveMission(work), canStartExecution(work));
}

export function oracleReady(work: WorkView): boolean {
	return work.oraclePending === undefined && oracleInputsReady(work) && work.execution?.state === "running";
}

export function normalizeTerms(input: SubmitWorkInput, defaultWorkTokens: number): WorkTerms {
	return {
		title: assertNonBlank(input.title, "title"),
		objective: assertNonBlank(input.objective, "objective"),
		context: termContext(input.context),
		scope: termScope(input.scope),
		acceptanceCriteria: nonBlankCriteria(input.acceptanceCriteria),
		constraints: normalizeTermList(input.constraints, "constraints item"),
		validation: normalizeValidation(input.validation),
		allowedPaths: normalizePaths(input.allowedPaths),
		maxTokens: positiveTermTokens(input.maxTokens, defaultWorkTokens),
	};
}

export function mergeTermChanges(terms: WorkTerms, input: ActionInput | undefined, mission: boolean): WorkTerms {
	const changes = requireTermChanges(input);
	const context = changes.context === undefined ? terms.context : changes.context.trim();
	const merged = {
		objective: changedText(terms.objective, changes.objective, "objective"),
		context,
		scope: changedText(terms.scope, changes.scope, "scope"),
		acceptanceCriteria: changedList(terms.acceptanceCriteria, changes.acceptanceCriteria, "acceptanceCriteria"),
		constraints: changedList(terms.constraints, changes.constraints, "constraints"),
		validation: changedList(terms.validation, changes.validation, "validation"),
		allowedPaths: changes.allowedPaths === undefined ? terms.allowedPaths : normalizeAllowedPaths(changes.allowedPaths),
	};
	requireNonEmptyTermList(merged.acceptanceCriteria, "acceptanceCriteria");
	requireNonEmptyTermList(merged.validation, "validation");
	if (mission) validateMissionContext(changes.context, merged.context);
	return { ...terms, ...merged };
}

export function shouldMonitorProvider(work: WorkView): boolean {
	return [
		hasMonitorableReview(work),
		!["succeeded", "stopped"].includes(work.state),
		hasMonitorableExecution(work),
	].every(Boolean);
}

function activeRuntimeAction(work: WorkView, runtimeState: RuntimeState): string {
	if (work.execution?.state !== "running") return work.nextAction;
	return activeExecutorRuntimeAction(work.nextAction, runtimeState);
}

export function currentExecutorTurnIsCurrent(
	current: WorkView | undefined,
	execution: Execution | undefined,
): current is WorkView & { execution: Execution } {
	if (current === undefined) return false;
	return isCurrentExecutor(current.execution, execution);
}

export function failedExecutorProjection(work: WorkView, execution: Execution, error: ServiceFailure): WorkView {
	const failed: Execution = {
		...execution,
		usage: work.execution?.usage,
		state: "failed",
		runtimeState: "unreachable",
		endedAt: new Date().toISOString(),
	};
	return {
		...work,
		revision: work.revision + 1,
		execution: failed,
		lastError: executionFailure(work, execution.executionId, error.message),
		nextAction: "Executor runtime failed; Conclave may replace it.",
	};
}

export function oracleRequestCurrent(work: WorkView, pending: NonNullable<WorkView["oraclePending"]>): boolean {
	if (!isOracleInputReady(work)) return false;
	return [
		work.oraclePending?.requestId === pending.requestId,
		work.mission.missionId === pending.missionId,
		work.execution.executionId === pending.executionId,
		work.lastSignal?.signalId === pending.signalId,
		work.reviewRequest.headCommit === pending.headCommit,
	].every(Boolean);
}

function executionEffectsForState(workId: string, revision: number, execution: Execution) {
	const effects = [];
	if (needsSchedulerWake(execution)) effects.push(queueSchedulerEffect(workId, revision));
	if (needsExecutorStop(execution)) effects.push(executorStopEffect(workId, revision, execution));
	if (needsWorkspaceCleanup(execution)) effects.push(cleanupEffect(workId, execution));
	return effects;
}

export function readOptionalEffectBinding(payload: JsonObject): RuntimeBinding | undefined {
	if (payload["sessionId"] === undefined && payload["sessionPath"] === undefined) return;
	return readEffectBinding(payload);
}

export function requireOutcomeEvidence(work: WorkView): OutcomeSettlementWork {
	if (!isProviderOutcomeSettlementPending(work)) throw outcomeEvidenceError();
	return work;
}

function canScheduleExecution(work: WorkWithMission, projects: readonly WorkView[]): boolean {
	return queuedWorkIsNext(work, projects) && work.preparation?.status !== "waiting";
}

export function oracleReason(oracleReady: boolean, inputsReady: boolean): string | undefined {
	if (oracleReady) return undefined;
	return inputsReady
		? "The current Execution is not running."
		: "Oracle review is available after a current ready Signal and open review request.";
}

function runtimeAction(work: WorkView, runtimeState: RuntimeState): string {
	if (!hasRuntimeAction(work)) return work.nextAction;
	if (runtimeState === "unreachable") return "Executor runtime is unreachable. Recover it from Actions.";
	if (runtimeState === "unknown") return "Executor runtime state is unknown. Recover it from Actions.";
	return activeRuntimeAction(work, runtimeState);
}

function executionLifecycleEffects(workId: string, revision: number, execution: Execution | undefined) {
	if (execution === undefined) return [];
	return executionEffectsForState(workId, revision, execution);
}

export function executionAdmissionAvailable(
	work: WorkWithMission,
	projects: readonly WorkView[],
	maxConcurrentExecutions: number,
): boolean {
	if (!canScheduleExecution(work, projects)) return false;
	if (
		projects.filter((candidate) => isConcurrentExecution(candidate.execution?.state)).length >= maxConcurrentExecutions
	)
		return false;
	return hasExecutionAllowance(work);
}

export function executorRuntimeNextAction(work: WorkView, runtimeState: RuntimeState, wakeConclave: boolean): string {
	return isRuntimeUnavailable(runtimeState) && wakeConclave
		? "Executor runtime is unreachable. Conclave is inspecting recovery."
		: runtimeAction(work, runtimeState);
}

export function updatedRuntimeView(work: WorkView, runtimeState: RuntimeState): WorkView {
	const execution = work.execution;
	if (
		execution === undefined ||
		(execution.runtimeState === runtimeState && runtimeAction(work, runtimeState) === work.nextAction)
	)
		return work;
	return { ...work, execution: { ...execution, runtimeState }, nextAction: runtimeAction(work, runtimeState) };
}

export function lifecycleEffects(
	workId: string,
	revision: number,
	execution: Execution | undefined,
	observer?: RuntimeBinding,
	wakeConclave = true,
	wakeReason?: ConclaveWakeCause,
) {
	return [
		...(wakeConclave ? [schedulerEffect(workId, revision, undefined, wakeReason)] : []),
		...executionLifecycleEffects(workId, revision, execution),
		...(observer === undefined ? [] : [observerCleanupEffect(workId, observer)]),
	];
}

export function verdictEffects(workId: string, revision: number, decision: VerdictDecision, execution: Execution) {
	return decision === "continue" ? [executorEffect(workId, revision)] : lifecycleEffects(workId, revision, execution);
}
