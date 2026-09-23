import type { ArchivePort } from "./archive.js";
import type { ProviderCiObservation, WorkView } from "./model.js";
import { failedProviderChecks } from "./provider-observation-policy.js";
import {
	type CiRepairAuthorization,
	type CurrentCiFailure,
	currentCiObservation,
	currentFailureScope,
	matchesCurrentFailureRecord,
	parseAuthorization,
} from "./service-ci-repair-policy.js";

export function currentCiFailure(
	archive: ArchivePort,
	work: WorkView,
	observationId: string,
): CurrentCiFailure | undefined {
	const observation = currentCiObservation(work, observationId);
	const scope = currentFailureScope(work);
	if (observation === undefined || scope === undefined) return undefined;
	return findCurrentCiFailureRecord(archive, work, scope.missionId, scope.executionId, observation);
}

function findCurrentCiFailureRecord(
	archive: ArchivePort,
	work: WorkView,
	missionId: string,
	executionId: string,
	observation: ProviderCiObservation,
): CurrentCiFailure | undefined {
	let cursor: string | undefined;
	while (true) {
		const page = archive.query(
			{ workId: work.workId, missionId, executionId, kinds: ["observation"], order: "desc" },
			cursor,
		);
		const record = page.items.find((item) =>
			matchesCurrentFailureRecord(item, work, missionId, executionId, observation),
		);
		if (record !== undefined) return { record, observation, failedChecks: failedProviderChecks(observation) };
		if (page.nextCursor === undefined) return undefined;
		cursor = page.nextCursor;
	}
}

export function archiveHasExecutionAuthorization(
	archive: ArchivePort,
	query: Parameters<ArchivePort["query"]>[0],
): boolean {
	let cursor: string | undefined;
	do {
		const page = archive.query(query, cursor);
		if (page.items.some((record) => parseAuthorization(record) !== undefined)) return true;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return false;
}

export function archiveHasAuthorization(
	archive: ArchivePort,
	query: Parameters<ArchivePort["query"]>[0],
	authorizationId: CiRepairAuthorization["authorizationId"],
): boolean {
	let cursor: string | undefined;
	do {
		const page = archive.query(query, cursor);
		if (page.items.some((record) => parseAuthorization(record)?.authorizationId === authorizationId)) return true;
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return false;
}
