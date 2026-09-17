import type {
	ConclaveWakeCause,
	ErrorEnvelope,
	JsonObject,
	JsonValue,
	ProviderCiObservation,
	ProviderObservation,
	ProviderOutcomeObservation,
	WorkView,
} from "./model.js";

export type ProviderObservationClassification = Readonly<{
	identityDrift: boolean;
	checksFailed: boolean;
	evidenceReconciled: boolean;
}>;

export function providerObservationEvidence(work: WorkView, observation: ProviderObservation): readonly string[] {
	const reviewUrl = work.reviewRequest?.url;
	return [reviewUrl, observation.observationId].filter((value): value is string => value !== undefined);
}

export function isProviderMonitorError(error: ErrorEnvelope): boolean {
	return error.source === "provider-monitor" || error.summary.startsWith("Provider monitor failed:");
}

function isProviderIdentityError(error: ErrorEnvelope | undefined): boolean {
	return error?.code === "integrity-failure" && error.summary === "Provider review identity changed after publication.";
}

function isProviderChecksError(error: ErrorEnvelope | undefined): boolean {
	return error?.code === "external-failure" && error.summary === "Provider checks failed.";
}

function providerIdentityError(work: WorkView, observation: ProviderObservation): ErrorEnvelope {
	return {
		code: "integrity-failure",
		summary: "Provider review identity changed after publication.",
		retryable: false,
		remediation: "Reconcile the review request before sending ready evidence or recording an Outcome.",
		evidenceRefs: providerObservationEvidence(work, observation),
	};
}

function providerChecksError(work: WorkView, observation: ProviderObservation): ErrorEnvelope {
	return {
		code: "external-failure",
		summary: "Provider checks failed.",
		retryable: false,
		remediation: "Inspect the provider checks and reconcile the Work before handoff.",
		evidenceRefs: providerObservationEvidence(work, observation),
	};
}

export function classifyProviderObservation(
	observation: ProviderObservation,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): ProviderObservationClassification {
	const identityDrift = providerObservationIdentityDrift(observation, reviewRequest);
	const checksFailed = providerObservationChecksFailed(observation);
	return {
		identityDrift,
		checksFailed,
		evidenceReconciled: observation.kind === "ci-status" && !identityDrift && !checksFailed,
	};
}

function providerObservationIdentityDrift(
	observation: ProviderObservation,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): boolean {
	return observation.kind === "ci-status" && !providerObservationMatchesReview(observation, reviewRequest);
}

function providerObservationChecksFailed(observation: ProviderObservation): boolean {
	return observation.kind === "ci-status" && observation.status === "checks-failed";
}

export function changedProviderObservation(
	observation: ProviderObservation,
	normalized: ProviderObservation,
): ProviderObservation {
	return {
		...normalized,
		changed: true,
		observedAt: new Date().toISOString(),
		feedback: observation.feedback === undefined ? undefined : boundedFeedback(observation.feedback),
	};
}

export function providerObservationProjection(
	work: WorkView,
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		lastObservation: observation,
		lastError: providerObservationError(work, observation, classification),
		providerOutcome: observation.kind === "provider-outcome" ? observation : work.providerOutcome,
		reviewRequest: providerObservationReviewRequest(work.reviewRequest, observation),
		nextAction: providerObservationAction(work, observation, classification),
	};
}

function providerObservationError(
	work: WorkView,
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): ErrorEnvelope | undefined {
	if (classification.identityDrift) return providerIdentityError(work, observation);
	if (classification.checksFailed) return providerChecksError(work, observation);
	return providerReconciledError(work.lastError, classification);
}

function providerReconciledError(
	error: ErrorEnvelope | undefined,
	classification: ProviderObservationClassification,
): ErrorEnvelope | undefined {
	if (classification.evidenceReconciled && hasProviderReconciliationError(error)) return undefined;
	return retainedProviderError(error);
}

function retainedProviderError(error: ErrorEnvelope | undefined): ErrorEnvelope | undefined {
	return error !== undefined && !isProviderMonitorError(error) ? error : undefined;
}

function providerObservationReviewRequest(
	reviewRequest: WorkView["reviewRequest"],
	observation: ProviderObservation,
): WorkView["reviewRequest"] {
	if (reviewRequest === undefined) return undefined;
	if (observation.kind === "provider-outcome") return mergedReviewRequest(reviewRequest);
	return observation.kind === "ci-status" ? updateCiReviewRequest(reviewRequest, observation) : reviewRequest;
}

function mergedReviewRequest(
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): NonNullable<WorkView["reviewRequest"]> {
	return { ...reviewRequest, status: "merged" };
}

function updateCiReviewRequest(
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
	observation: ProviderObservation,
): NonNullable<WorkView["reviewRequest"]> {
	if (observation.status === "closed" || observation.status === "merged")
		return { ...reviewRequest, status: observation.status };
	return reviewRequest;
}

function providerObservationAction(
	work: WorkView,
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): string {
	const special = providerSpecialAction(work, observation, classification);
	if (special !== undefined) return special;
	return providerStatusAction(work.nextAction, observation.status);
}

function providerSpecialAction(
	work: WorkView,
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): string | undefined {
	const classificationAction = providerClassificationAction(classification);
	if (classificationAction !== undefined) return classificationAction;
	const reconciled = reconciledProviderAction(work.lastError, classification);
	return (
		reconciled ?? (isActionableReviewComment(observation) ? "Conclave is assessing provider feedback." : undefined)
	);
}

function providerClassificationAction(classification: ProviderObservationClassification): string | undefined {
	if (classification.identityDrift)
		return "Provider review identity changed; Conclave must reconcile the review request.";
	if (classification.checksFailed) return "Provider checks failed; Conclave must reconcile the Work.";
	return undefined;
}

function reconciledProviderAction(
	error: ErrorEnvelope | undefined,
	classification: ProviderObservationClassification,
): string | undefined {
	return classification.evidenceReconciled && hasProviderReconciliationError(error)
		? "Provider evidence was reconciled; Conclave may continue."
		: undefined;
}

const PROVIDER_STATUS_ACTIONS: ReadonlyMap<ProviderObservation["status"], string> = new Map([
	["closed", "Provider review is closed; Conclave is reconciling the Work."],
	["merged", "Provider merge observed; Conclave is recording the Outcome."],
	["checks-failed", "Provider checks failed; Conclave is reconciling the Work."],
]);

function providerStatusAction(nextAction: string, status: ProviderObservation["status"]): string {
	return PROVIDER_STATUS_ACTIONS.get(status) ?? nextAction;
}

export function providerObservationEffects(
	workId: string,
	revision: number,
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
) {
	if (!providerObservationNeedsWake(observation, classification)) return undefined;
	return [
		schedulerEffect(
			workId,
			revision,
			observation.kind === "review-comment" ? observation.observationId : undefined,
			providerWakeReason(observation, classification),
		),
	];
}

function providerObservationNeedsWake(
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): boolean {
	if (observation.kind === "provider-outcome") return true;
	if (isActionableReviewComment(observation)) return true;
	return providerCiObservationNeedsWake(observation, classification);
}

function providerCiObservationNeedsWake(
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): boolean {
	if (observation.kind !== "ci-status") return false;
	return providerCiNeedsWake(classification) || providerReviewStatusFromCi(observation.status) !== undefined;
}

function providerCiNeedsWake(classification: ProviderObservationClassification): boolean {
	return classification.identityDrift || classification.checksFailed;
}

function providerReviewStatusFromCi(
	status: ProviderCiObservation["status"],
): NonNullable<WorkView["reviewRequest"]>["status"] | undefined {
	if (status === "closed") return "closed";
	if (status === "merged") return "merged";
	return undefined;
}

function providerWakeReason(
	observation: ProviderObservation,
	classification: ProviderObservationClassification,
): ConclaveWakeCause | undefined {
	const byKind = new Map<ProviderObservation["kind"], ConclaveWakeCause>([
		["review-comment", "provider-feedback"],
		["provider-outcome", "provider-outcome"],
	]);
	const kindReason = byKind.get(observation.kind);
	if (kindReason !== undefined) return kindReason;
	if (observation.kind !== "ci-status") return undefined;
	return providerCiWakeReason(observation, classification);
}

function providerCiWakeReason(
	observation: ProviderCiObservation,
	classification: ProviderObservationClassification,
): ConclaveWakeCause | undefined {
	if (classification.identityDrift || classification.checksFailed) return "provider-ci";
	return observation.status === "closed" ? "provider-closed" : undefined;
}

export function validProviderOutcomeObservation(
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
	observation: ProviderOutcomeObservation,
): boolean {
	return [
		observation.kind === "provider-outcome",
		observation.status === "merged",
		observation.repository === reviewRequest.repository,
		observation.sourceBranch === reviewRequest.sourceBranch,
		observation.targetBranch === reviewRequest.targetBranch,
		observation.headCommit === reviewRequest.headCommit,
		isTextValue(observation.mergeCommit) && observation.mergeCommit.trim().length > 0,
	].every(Boolean);
}

function hasProviderReconciliationError(error: ErrorEnvelope | undefined): boolean {
	return isProviderIdentityError(error) || isProviderChecksError(error);
}

export function recoveredProviderObservation(
	observation: ProviderObservation | undefined,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
	commandId: string,
): ProviderObservation {
	if (observation === undefined)
		return {
			observationId: `provider-monitor-recovered:${commandId}`,
			kind: "monitor-failure",
			providerId: reviewRequest.providerId,
			status: "recovered",
			summary: "Provider polling succeeded; no new provider observations were reported.",
			changed: false,
			observedAt: new Date().toISOString(),
		};
	return {
		...normalizeProviderObservation(observation, reviewRequest),
		changed: false,
		observedAt: new Date().toISOString(),
		feedback: observation.feedback === undefined ? undefined : boundedFeedback(observation.feedback),
	};
}

export function providerRecoveryProjection(
	work: WorkView,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
	recoveredObservation: ProviderObservation,
): WorkView {
	return {
		...work,
		revision: work.revision + 1,
		lastObservation: recoveredObservation,
		lastError: undefined,
		providerOutcome: recoveredObservation.kind === "provider-outcome" ? recoveredObservation : work.providerOutcome,
		reviewRequest: providerRecoveryReviewRequest(reviewRequest, recoveredObservation),
		nextAction: providerPollRecoveryAction(work, recoveredObservation),
	};
}

function providerRecoveryReviewRequest(
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
	observation: ProviderObservation,
): NonNullable<WorkView["reviewRequest"]> {
	if (observation.kind === "provider-outcome") return { ...reviewRequest, status: "merged" };
	if (observation.kind !== "ci-status") return reviewRequest;
	const status = providerReviewStatusFromCi(observation.status);
	return status === undefined ? reviewRequest : { ...reviewRequest, status };
}

export function providerRecoverySummary(
	observation: ProviderObservation | undefined,
	recoveredObservation: ProviderObservation,
): string {
	return observation === undefined
		? recoveredObservation.summary
		: `Provider observation confirmed: ${recoveredObservation.kind}.`;
}

export function providerPollRecoveryAction(work: WorkView, observation: ProviderObservation): string {
	if (isActionableReviewComment(observation)) return "Conclave is assessing provider feedback.";
	return work.execution?.state === "running" ? "Khala is continuing the Work automatically." : work.nextAction;
}

export function isActionableReviewComment(observation: ProviderObservation | undefined): boolean {
	return observation?.kind === "review-comment" && observation.actionable !== false;
}

export function observationKey(workId: string, observation: ProviderObservation): string {
	return `${workId}:${observation.kind}:${observation.providerId}:${observation.observationId}`;
}

function boundedFeedback(feedback: readonly string[]): readonly string[] {
	return feedback
		.map((item) => item.trim().slice(0, 2_000))
		.filter((item) => item.length > 0)
		.slice(0, 20);
}

export function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

export function schedulerEffect(
	workId: string,
	revision: number,
	observationId?: string,
	reason: ConclaveWakeCause = "admission",
) {
	const payload: JsonObject = { workId, observationId, reason };
	return {
		effectId: `conclave-wake:${workId}:${revision}`,
		kind: "conclave-wake",
		payload,
	};
}

export function reviewObservationMatchesRequest(
	observation: ProviderObservation,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): boolean {
	return [
		observation.repository === reviewRequest.repository,
		observation.sourceBranch === reviewRequest.sourceBranch,
		observation.targetBranch === reviewRequest.targetBranch,
		observation.headCommit === reviewRequest.headCommit,
		observation.baseCommit === undefined ||
			reviewRequest.baseCommit === undefined ||
			observation.baseCommit === reviewRequest.baseCommit,
	].every(Boolean);
}

export function providerObservationMatchesReview(
	observation: ProviderObservation,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): boolean {
	return [
		matchesProviderField(observation.repository, reviewRequest.repository),
		matchesProviderField(observation.sourceBranch, reviewRequest.sourceBranch),
		matchesProviderField(observation.targetBranch, reviewRequest.targetBranch),
		matchesProviderField(observation.headCommit, reviewRequest.headCommit),
		observation.baseCommit === undefined ||
			reviewRequest.baseCommit === undefined ||
			observation.baseCommit === reviewRequest.baseCommit,
	].every(Boolean);
}

function matchesProviderField(observed: string | undefined, expected: string): boolean {
	return observed === undefined || observed === expected;
}

export function normalizeProviderObservation(
	observation: ProviderObservation,
	reviewRequest: NonNullable<WorkView["reviewRequest"]>,
): ProviderObservation {
	return observation.kind === "review-comment" && !reviewObservationMatchesRequest(observation, reviewRequest)
		? { ...observation, actionable: false }
		: observation;
}
