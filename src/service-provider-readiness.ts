import type { ArchivePort } from "./archive.js";
import { isJsonObject, isObservation, isReviewRequest } from "./archive-codec.js";
import type {
	JsonObject,
	JsonValue,
	ProviderCiObservation,
	ProviderObservation,
	RecordView,
	WorkView,
} from "./model.js";
import { providerObservationMatchesReview } from "./provider-observation-policy.js";

type ReviewRequest = NonNullable<WorkView["reviewRequest"]>;
type ScanState = Readonly<{ checks?: ProviderCiObservation | undefined; decision?: boolean | undefined }>;

export function providerEvidenceAllowsReady(archive: ArchivePort, work: WorkView, request: ReviewRequest): boolean {
	let cursor: string | undefined;
	let state: ScanState = {};
	do {
		const page = archive.query(
			{ workId: work.workId, kinds: ["observation", "review-request"], order: "desc" },
			cursor,
		);
		state = scanRecords(page.items, state, request, work.execution?.executionId);
		if (state.decision !== undefined) return state.decision;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return state.checks === undefined;
}

function scanRecords(
	records: readonly RecordView[],
	initial: ScanState,
	request: ReviewRequest,
	executionId: string | undefined,
): ScanState {
	let state = initial;
	for (const record of records) {
		state = scanRecord(record, state, request, executionId);
		if (state.decision !== undefined) return state;
	}
	return state;
}

function scanRecord(
	record: RecordView,
	state: ScanState,
	request: ReviewRequest,
	executionId: string | undefined,
): ScanState {
	const checks = state.checks ?? providerChecks(record, request.providerId);
	if (!isCurrentPublication(record, request, executionId)) return { checks };
	if (checks === undefined) return { decision: true };
	return { checks, decision: checksAllowReady(checks, request) };
}

function providerChecks(record: RecordView, providerId: string): ProviderCiObservation | undefined {
	if (record.kind !== "observation") return undefined;
	if (!isObservation(record.payload)) return undefined;
	return isProviderChecksObservation(record.payload, providerId) ? record.payload : undefined;
}

function isProviderChecksObservation(
	observation: ProviderObservation,
	providerId: string,
): observation is ProviderCiObservation {
	return [observation.kind === "ci-status", observation.providerId === providerId].every(Boolean);
}

function checksAllowReady(checks: ProviderCiObservation, request: ReviewRequest): boolean {
	return checks.status !== "checks-failed" && providerObservationMatchesReview(checks, request);
}

function isCurrentPublication(record: RecordView, request: ReviewRequest, executionId: string | undefined): boolean {
	if (record.kind !== "review-request") return false;
	if (record.executionId !== executionId) return false;
	const payload = reviewPayload(record.payload);
	if (payload === undefined) return false;
	return [
		payload["provider"] === request.provider,
		payload["providerId"] === request.providerId,
		payload["repository"] === request.repository,
		payload["sourceBranch"] === request.sourceBranch,
		payload["targetBranch"] === request.targetBranch,
		payload["baseCommit"] === request.baseCommit,
		payload["headCommit"] === request.headCommit,
	].every(Boolean);
}

function reviewPayload(value: JsonValue): JsonObject | undefined {
	if (!isJsonObject(value) || !isReviewRequest(value)) return undefined;
	return value;
}
