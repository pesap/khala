import type { ArchivePort } from "./archive.js";
import { isJsonObject, isObservation, isReviewRequest, isValidationRun } from "./archive-codec.js";
import type { ProviderCiObservation, RecordView, ValidationRun, WorkView } from "./model.js";
import {
	type CiRepairAuthorization,
	executionStartCommandId,
	isStartedByAuthorization,
} from "./service-ci-repair-policy.js";
import { validationPassed } from "./service-runtime-policy.js";

type RepairActionSequences = Readonly<{
	commit: number | undefined;
	validation: number | undefined;
	publication: number | undefined;
}>;
type CompleteRepairActionSequences = Readonly<{
	commit: number;
	validation: number;
	publication: number;
}>;
type RepairActionKind = "execution" | "validation" | "review-request";
type RepairRecordMatcher = (record: RecordView) => boolean;

export function ciRepairCompletionFailure(
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
): string | undefined {
	if (executorReportedBlock(work, authorization)) return "Executor reported that the bounded CI repair is blocked.";
	return completionFailure(archive, work, authorization);
}

function executorReportedBlock(work: WorkView, authorization: CiRepairAuthorization): boolean {
	return work.lastSignal?.executionId === authorization.executionId && work.lastSignal.kind === "blocked";
}

function completionFailure(
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
): string | undefined {
	return repairIsReconciled(archive, work, authorization)
		? undefined
		: "Executor turn ended without a governed commit, exact-commit validation, and same-draft PR reconciliation.";
}

function repairIsReconciled(archive: ArchivePort, work: WorkView, authorization: CiRepairAuthorization): boolean {
	const request = work.reviewRequest;
	const validation = work.lastValidation;
	if (request === undefined || validation === undefined) return false;
	return [
		currentWorkMatchesAuthorization(work, authorization),
		currentDraftPreservesReview(archive, request, authorization),
		validationMatchesDraftHead(validation, authorization, request.headCommit),
		validationPassed(work, validation),
		governedRepairActionsAreRecorded(archive, work, authorization, request, validation),
	].every(Boolean);
}

function currentWorkMatchesAuthorization(work: WorkView, authorization: CiRepairAuthorization): boolean {
	return currentMissionIsBound(work, authorization) && missionRemainsLive(work);
}

function currentMissionIsBound(work: WorkView, authorization: CiRepairAuthorization): boolean {
	return (
		work.mission?.missionId === authorization.missionId && work.execution?.executionId === authorization.executionId
	);
}

function missionRemainsLive(work: WorkView): boolean {
	return (
		["active", "awaiting-review"].includes(work.state) &&
		["active", "awaiting-review"].includes(work.missionState ?? "")
	);
}

function currentDraftPreservesReview(
	archive: ArchivePort,
	request: NonNullable<WorkView["reviewRequest"]>,
	authorization: CiRepairAuthorization,
): boolean {
	if (!draftHeadChanged(request, authorization)) return false;
	const source = authorizationObservation(archive, authorization);
	if (source === undefined) return false;
	return currentDraftMatchesOriginalObservation(source, request, authorization);
}

function currentDraftMatchesOriginalObservation(
	source: ProviderCiObservation,
	request: NonNullable<WorkView["reviewRequest"]>,
	authorization: CiRepairAuthorization,
): boolean {
	return [
		source.status === "checks-failed",
		source.details?.pullRequest.status === "draft",
		source.observationId === authorization.observationId,
		source.headCommit === authorization.headCommit,
		request.providerId === source.providerId,
		request.url === source.details?.pullRequest.url,
		request.repository === source.repository,
		request.sourceBranch === source.sourceBranch,
		request.targetBranch === source.targetBranch,
		request.baseCommit === source.baseCommit,
	].every(Boolean);
}

function draftHeadChanged(
	request: NonNullable<WorkView["reviewRequest"]>,
	authorization: CiRepairAuthorization,
): boolean {
	return request.status === "draft" && request.headCommit !== authorization.headCommit;
}

function authorizationObservation(
	archive: ArchivePort,
	authorization: CiRepairAuthorization,
): ProviderCiObservation | undefined {
	let cursor: string | undefined;
	do {
		const page = archive.query(
			{
				workId: authorization.workId,
				missionId: authorization.missionId,
				executionId: authorization.executionId,
				kinds: ["observation"],
				order: "desc",
			},
			cursor,
		);
		const record = page.items.find((item) => item.sequence === authorization.observationSequence);
		if (record !== undefined) return ciObservationRecord(record);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return undefined;
}

function ciObservationRecord(record: RecordView): ProviderCiObservation | undefined {
	if (record.kind !== "observation" || !isObservation(record.payload)) return undefined;
	return record.payload.kind === "ci-status" ? record.payload : undefined;
}

function validationMatchesDraftHead(
	validation: ValidationRun,
	authorization: CiRepairAuthorization,
	headCommit: string,
): boolean {
	return validation.executionId === authorization.executionId && validation.headCommit === headCommit;
}

function governedRepairActionsAreRecorded(
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
	request: NonNullable<WorkView["reviewRequest"]>,
	validation: ValidationRun,
): boolean {
	const started = archive.findCommand(executionStartCommandId(authorization.workId, authorization.executionId));
	if (started === undefined || !isStartedByAuthorization(started.record, authorization)) return false;
	const sequences = repairActionSequences(archive, work, authorization, request, validation, started.record.sequence);
	return repairActionSequencesAreOrdered(sequences);
}

function repairActionSequences(
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
	request: NonNullable<WorkView["reviewRequest"]>,
	validation: ValidationRun,
	startedSequence: number,
): RepairActionSequences {
	return {
		commit: findRepairActionSequence(archive, work, authorization, startedSequence, "execution", (record) =>
			isGovernedCommitRecord(record, validation.headCommit),
		),
		validation: findRepairActionSequence(archive, work, authorization, startedSequence, "validation", (record) =>
			isGovernedValidationRecord(record, validation),
		),
		publication: findRepairActionSequence(archive, work, authorization, startedSequence, "review-request", (record) =>
			isGovernedPublicationRecord(record, request),
		),
	};
}

function findRepairActionSequence(
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
	startedSequence: number,
	kind: RepairActionKind,
	matches: RepairRecordMatcher,
): number | undefined {
	let cursor: string | undefined;
	do {
		const page = archive.query(
			{
				workId: work.workId,
				missionId: authorization.missionId,
				executionId: authorization.executionId,
				kinds: [kind],
				order: "desc",
			},
			cursor,
		);
		const record = page.items.find((item) => item.sequence > startedSequence && matches(item));
		if (record !== undefined) return record.sequence;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return undefined;
}

function isGovernedCommitRecord(record: RecordView, headCommit: string): boolean {
	return isExecutorRecord(record, "execution") && record.evidenceRefs.includes(headCommit);
}

function isGovernedValidationRecord(record: RecordView, validation: ValidationRun): boolean {
	return isExecutorRecord(record, "validation") && validationRecordMatches(record, validation);
}

function validationRecordMatches(record: RecordView, validation: ValidationRun): boolean {
	return (
		isValidationRun(record.payload) &&
		isJsonObject(record.payload) &&
		JSON.stringify(record.payload) === JSON.stringify(validation)
	);
}

function isGovernedPublicationRecord(record: RecordView, request: NonNullable<WorkView["reviewRequest"]>): boolean {
	return isExecutorRecord(record, "review-request") && publicationRecordMatches(record, request);
}

function publicationRecordMatches(record: RecordView, request: NonNullable<WorkView["reviewRequest"]>): boolean {
	return (
		isReviewRequest(record.payload) &&
		isJsonObject(record.payload) &&
		JSON.stringify(record.payload) === JSON.stringify(request)
	);
}

function isExecutorRecord(record: RecordView, kind: RepairActionKind): boolean {
	return record.kind === kind && record.actor === "executor";
}

function repairActionSequencesAreOrdered(sequences: RepairActionSequences): boolean {
	if (!hasCompleteRepairActionSequences(sequences)) return false;
	return sequences.commit < sequences.validation && sequences.validation < sequences.publication;
}

function hasCompleteRepairActionSequences(
	sequences: RepairActionSequences,
): sequences is CompleteRepairActionSequences {
	return Object.values(sequences).every((sequence) => sequence !== undefined);
}
