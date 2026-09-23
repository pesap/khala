import type { ArchivePort } from "./archive.js";
import type { WorkView } from "./model.js";
import { ArchiveCore } from "./service-archive-core.js";
import {
	type CiRepairAuthorization,
	ciRepairStatusSummary,
	executionStartCommandId,
	isStartedByAuthorization,
	type RepairStatus,
	repairStatusCommandId,
	statusProjection,
	TERMINAL_REPAIR_STATUSES,
} from "./service-ci-repair-policy.js";

export type RepairStatusAppend = Readonly<{ work: WorkView; appended: boolean }>;

export function hasCiRepairStatus(
	archive: ArchivePort,
	authorization: CiRepairAuthorization,
	status: RepairStatus,
): boolean {
	const found = archive.findCommand(repairStatusCommandId(authorization, status));
	return found !== undefined && (status !== "started" || isStartedByAuthorization(found.record, authorization));
}

export function hasTerminalCiRepairStatus(archive: ArchivePort, authorization: CiRepairAuthorization): boolean {
	return TERMINAL_REPAIR_STATUSES.some((status) => hasCiRepairStatus(archive, authorization, status));
}

export function appendStartedCiRepairStatus(
	core: ArchiveCore,
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
): RepairStatusAppend {
	const current = core.inspectWork(work.workId);
	if (hasTerminalCiRepairStatus(archive, authorization)) return { work: current, appended: false };
	if (archive.findCommand(executionStartCommandId(authorization.workId, authorization.executionId)) !== undefined)
		return { work: current, appended: false };
	return appendStatusRecord(core, work, authorization, "started");
}

export function appendCiRepairStatus(
	core: ArchiveCore,
	archive: ArchivePort,
	work: WorkView,
	authorization: CiRepairAuthorization,
	status: RepairStatus,
	reason?: string,
): RepairStatusAppend {
	const current = core.inspectWork(work.workId);
	if (hasTerminalCiRepairStatus(archive, authorization)) return { work: current, appended: false };
	if (archive.findCommand(repairStatusCommandId(authorization, status)) !== undefined)
		return { work: current, appended: false };
	return appendStatusRecord(core, current, authorization, status, reason);
}

function appendStatusRecord(
	core: ArchiveCore,
	work: WorkView,
	authorization: CiRepairAuthorization,
	status: RepairStatus,
	reason?: string,
): RepairStatusAppend {
	const commandId = repairStatusCommandId(authorization, status);
	const result = core.append({
		meta: { actor: "system", commandId, expectedWorkRevision: work.revision, schemaVersion: 1 },
		kind: "delivery",
		workId: work.workId,
		missionId: authorization.missionId,
		executionId: authorization.executionId,
		payload: {
			kind: "ci-repair",
			status,
			authorizationId: authorization.authorizationId,
			observationId: authorization.observationId,
			observationSequence: authorization.observationSequence,
			reason: reason?.slice(0, 2_000),
		},
		evidenceRefs: [authorization.observationId],
		projection: statusProjection(work, authorization, status),
		summary: ciRepairStatusSummary(status),
	});
	return { work: result.projection, appended: !result.duplicate };
}
