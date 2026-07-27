import { nanoid } from "nanoid";
import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import { readCurrentMission } from "./khala-archive-projections.js";
import type { KhalaWork, MissionRecord, VerdictRecord } from "./khala-model.js";
import type { MissionAssignmentInput } from "./khala-verdict.js";

function materializeMissingRetrySuccessor(
	projectPath: string,
	projectTrusted: boolean,
	verdict: VerdictRecord,
): boolean {
	const { missionId, governingMandateId, successorAssignment } = verdict;
	if (missionId === undefined || governingMandateId === undefined || successorAssignment === undefined) {
		return false;
	}
	return withArchiveLock(projectPath, projectTrusted, () => {
		const current = readCurrentMission(projectPath, verdict.workId, projectTrusted);
		if (current === undefined || current.state !== "retry-pending" || current.mission.missionId !== missionId) {
			return false;
		}
		const successorMissionId = nanoid();
		const successor: MissionRecord = {
			missionId: successorMissionId,
			workId: verdict.workId,
			mandateId: governingMandateId,
			predecessorMissionId: missionId,
			causedByVerdictId: verdict.verdictId,
			assignment: successorAssignment,
			assignedParticipantId: `executor:${successorMissionId}`,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "mission", workId: successor.workId, payload: successor },
			projectTrusted,
		);
		return true;
	});
}

function normalizeAssignment(assignment: MissionAssignmentInput | undefined): KhalaWork | undefined {
	if (assignment === undefined) {
		return;
	}
	return {
		title: assignment.title.trim(),
		objective: assignment.objective.trim(),
		context: assignment.context.trim(),
		scope: assignment.scope.trim(),
		acceptanceCriteria: assignment.acceptanceCriteria.map((item) => item.trim()),
		constraints: assignment.constraints.map((item) => item.trim()),
		plan: assignment.plan.map((item) => item.trim()),
		validation: assignment.validation.map((item) => item.trim()),
	};
}

export { materializeMissingRetrySuccessor, normalizeAssignment };
