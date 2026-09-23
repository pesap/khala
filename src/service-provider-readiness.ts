import type { ArchivePort } from "./archive.js";
import { isJsonObject, isObservation, isReviewRequest } from "./archive-codec.js";
import type { JsonObject, JsonValue, ProviderCiObservation, RecordView, WorkView } from "./model.js";
import { providerCheckIsVerified, providerObservationExactlyMatchesReview } from "./provider-observation-policy.js";
import { observationFingerprint } from "./service-runtime-policy.js";

type ReviewRequest = NonNullable<WorkView["reviewRequest"]>;
type ProviderChecksEvidence = Readonly<{ observation: ProviderCiObservation; sequence: number }>;
type ReadinessScan = Readonly<{
	checks?: ProviderChecksEvidence | undefined;
	publicationSequence?: number | undefined;
	decision?: boolean | undefined;
}>;

export function providerEvidenceAllowsReady(
	archive: ArchivePort,
	work: WorkView,
	request: ReviewRequest,
	requireProviderCi = true,
): boolean {
	let cursor: string | undefined;
	let scan: ReadinessScan = {};
	do {
		const page = archive.query(readinessQuery(work), cursor);
		scan = scanReadinessRecords(page.items, scan, request, work, requireProviderCi);
		if (scan.decision !== undefined) return scan.decision;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return explicitlyConfiguredNoCiAllowsReady(scan, requireProviderCi);
}

function explicitlyConfiguredNoCiAllowsReady(scan: ReadinessScan, requireProviderCi: boolean): boolean {
	return !requireProviderCi && scan.publicationSequence !== undefined && scan.checks === undefined;
}

export function providerCiObservationNeedsRefresh(
	archive: ArchivePort,
	work: WorkView,
	observation: ProviderCiObservation,
): boolean {
	const request = work.reviewRequest;
	if (request === undefined) return false;
	if (!providerObservationExactlyMatchesReview(observation, request)) return false;
	const sequences = latestProviderEvidenceSequences(archive, work, request, observation);
	return observationPredatesPublication(sequences);
}

type ProviderEvidenceSequences = Readonly<{
	observationSequence?: number | undefined;
	latestCurrentObservationSequence?: number | undefined;
	publicationSequence?: number | undefined;
}>;
type CompleteProviderEvidenceSequences = Readonly<{
	observationSequence: number;
	latestCurrentObservationSequence: number;
	publicationSequence: number;
}>;

function latestProviderEvidenceSequences(
	archive: ArchivePort,
	work: WorkView,
	request: ReviewRequest,
	observation: ProviderCiObservation,
): ProviderEvidenceSequences {
	let cursor: string | undefined;
	let sequences: ProviderEvidenceSequences = {};
	do {
		const page = archive.query(readinessQuery(work), cursor);
		sequences = scanProviderEvidenceSequences(page.items, sequences, request, work, observation);
		if (hasProviderEvidenceSequences(sequences)) return sequences;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return sequences;
}

function scanProviderEvidenceSequences(
	records: readonly RecordView[],
	initial: ProviderEvidenceSequences,
	request: ReviewRequest,
	work: WorkView,
	observation: ProviderCiObservation,
): ProviderEvidenceSequences {
	let sequences = initial;
	for (const record of records) {
		sequences = scanProviderEvidenceSequence(record, sequences, request, work, observation);
		if (hasProviderEvidenceSequences(sequences)) return sequences;
	}
	return sequences;
}

function scanProviderEvidenceSequence(
	record: RecordView,
	initial: ProviderEvidenceSequences,
	request: ReviewRequest,
	work: WorkView,
	observation: ProviderCiObservation,
): ProviderEvidenceSequences {
	return {
		observationSequence: initial.observationSequence ?? providerChecksSequence(record, request, observation),
		latestCurrentObservationSequence:
			initial.latestCurrentObservationSequence ?? currentProviderChecksSequence(record, request),
		publicationSequence: initial.publicationSequence ?? currentPublicationSequence(record, request, work),
	};
}

function providerChecksSequence(
	record: RecordView,
	request: ReviewRequest,
	observation: ProviderCiObservation,
): number | undefined {
	const recorded = matchingProviderChecksObservation(record, request);
	return recorded !== undefined && observationFingerprint(recorded) === observationFingerprint(observation)
		? record.sequence
		: undefined;
}

function currentProviderChecksSequence(record: RecordView, request: ReviewRequest): number | undefined {
	return matchingProviderChecksObservation(record, request) === undefined ? undefined : record.sequence;
}

function matchingProviderChecksObservation(
	record: RecordView,
	request: ReviewRequest,
): ProviderCiObservation | undefined {
	const observation = providerChecksObservation(record);
	return observation !== undefined && providerObservationExactlyMatchesReview(observation, request)
		? observation
		: undefined;
}

function providerChecksObservation(record: RecordView): ProviderCiObservation | undefined {
	if (record.kind !== "observation" || !isObservation(record.payload)) return undefined;
	return record.payload.kind === "ci-status" ? record.payload : undefined;
}

function currentPublicationSequence(record: RecordView, request: ReviewRequest, work: WorkView): number | undefined {
	return isCurrentPublication(record, request, work) ? record.sequence : undefined;
}

function observationPredatesPublication(sequences: ProviderEvidenceSequences): boolean {
	if (!hasProviderEvidenceSequences(sequences)) return false;
	return (
		sequences.observationSequence === sequences.latestCurrentObservationSequence &&
		sequences.observationSequence <= sequences.publicationSequence
	);
}

function hasProviderEvidenceSequences(
	sequences: ProviderEvidenceSequences,
): sequences is CompleteProviderEvidenceSequences {
	return (
		sequences.observationSequence !== undefined &&
		sequences.latestCurrentObservationSequence !== undefined &&
		sequences.publicationSequence !== undefined
	);
}

function readinessQuery(work: WorkView) {
	return {
		workId: work.workId,
		missionId: work.mission?.missionId,
		executionId: work.execution?.executionId,
		kinds: ["observation", "review-request"] as const,
		order: "desc" as const,
	};
}

function scanReadinessRecords(
	records: readonly RecordView[],
	initial: ReadinessScan,
	request: ReviewRequest,
	work: WorkView,
	requireProviderCi: boolean,
): ReadinessScan {
	let scan = initial;
	for (const record of records) {
		scan = scanReadinessRecord(record, scan, request, work, requireProviderCi);
		if (scan.decision !== undefined) return scan;
	}
	return scan;
}

function scanReadinessRecord(
	record: RecordView,
	initial: ReadinessScan,
	request: ReviewRequest,
	work: WorkView,
	requireProviderCi: boolean,
): ReadinessScan {
	const checks = initial.checks ?? providerChecks(record);
	const publicationSequence =
		initial.publicationSequence ?? (isCurrentPublication(record, request, work) ? record.sequence : undefined);
	return {
		checks,
		publicationSequence,
		decision: readinessDecision(publicationSequence, checks, request, requireProviderCi),
	};
}

function readinessDecision(
	publicationSequence: number | undefined,
	checks: ProviderChecksEvidence | undefined,
	request: ReviewRequest,
	requireProviderCi: boolean,
): boolean | undefined {
	if (publicationSequence === undefined || checks === undefined) return undefined;
	if (checks.sequence <= publicationSequence) return staleNoCiAllowsReady(checks, requireProviderCi);
	return checksAllowReady(checks.observation, request);
}

function staleNoCiAllowsReady(checks: ProviderChecksEvidence, requireProviderCi: boolean): boolean {
	return !requireProviderCi && noChecksReported(checks.observation);
}

function providerChecks(record: RecordView): ProviderChecksEvidence | undefined {
	const observation = providerChecksObservation(record);
	return observation === undefined ? undefined : { observation, sequence: record.sequence };
}

function noChecksReported(observation: ProviderCiObservation): boolean {
	const checks = observation.details?.checks;
	return checks === undefined || checks.length === 0;
}

function checksAllowReady(checks: ProviderCiObservation, request: ReviewRequest): boolean {
	return [
		isSuccessfulProviderStatus(checks.status),
		providerObservationExactlyMatchesReview(checks, request),
		checks.details?.pullRequest.status === request.status,
		reportedChecksAreVerified(checks.details?.checks),
	].every(Boolean);
}

function isSuccessfulProviderStatus(status: ProviderCiObservation["status"]): boolean {
	return status === "draft" || status === "open";
}

function reportedChecksAreVerified(
	checks: NonNullable<ProviderCiObservation["details"]>["checks"] | undefined,
): boolean {
	return checks !== undefined && checks.length > 0 && checks.every(providerCheckIsVerified);
}

function isCurrentPublication(record: RecordView, request: ReviewRequest, work: WorkView): boolean {
	if (record.kind !== "review-request" || !publicationIsBoundToWork(record, work)) return false;
	const payload = reviewPayload(record.payload);
	return payload !== undefined && currentPublicationIdentityMatches(payload, request);
}

function publicationIsBoundToWork(record: RecordView, work: WorkView): boolean {
	return record.executionId === work.execution?.executionId && record.missionId === work.mission?.missionId;
}

function currentPublicationIdentityMatches(payload: JsonObject, request: ReviewRequest): boolean {
	return (
		providerPublicationMatches(payload, request) &&
		payload["status"] === request.status &&
		branchPublicationMatches(payload, request) &&
		headPublicationMatches(payload, request)
	);
}

function providerPublicationMatches(payload: JsonObject, request: ReviewRequest): boolean {
	return (
		payload["provider"] === request.provider &&
		payload["providerId"] === request.providerId &&
		payload["url"] === request.url &&
		payload["repository"] === request.repository
	);
}

function branchPublicationMatches(payload: JsonObject, request: ReviewRequest): boolean {
	return payload["sourceBranch"] === request.sourceBranch && payload["targetBranch"] === request.targetBranch;
}

function headPublicationMatches(payload: JsonObject, request: ReviewRequest): boolean {
	return payload["baseCommit"] === request.baseCommit && payload["headCommit"] === request.headCommit;
}

function reviewPayload(value: JsonValue): JsonObject | undefined {
	if (!isJsonObject(value) || !isReviewRequest(value)) return undefined;
	return value;
}
