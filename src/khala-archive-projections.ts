// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Mission projection validates mutually exclusive durable lifecycle paths in one read.
import { listArchiveRecords } from "./khala-archive.js";
import {
	type ExecutorRecord,
	isExecutorRecord,
	isLearningRecord,
	isMandateRecord,
	isMissionRecord,
	isPullRequestRecord,
	isSignal,
	isVerdict,
	isVerdictDelivery,
	isWorkOutcomeRecord,
	isWorkSubmission,
	type KhalaArchiveRecord,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MandateRecord,
	type MissionRecord,
	type PullRequestRecord,
	type SignalRecord,
	type VerdictDeliveryRecord,
	type VerdictRecord,
	type WorkOutcomeRecord,
} from "./khala-model.js";

type MissionProjectionState = "current" | "superseded" | "finished" | "rejected" | "retry-pending";
type MissionProjection = Readonly<{
	mission: MissionRecord;
	state: MissionProjectionState;
	successorMissionId?: string;
	terminalVerdict?: VerdictRecord;
}>;

function listSubmissionRecords(projectPath: string, projectTrusted = false): KhalaWorkSubmission[] {
	return projectRecords(projectPath, "submission", isWorkSubmission, projectTrusted);
}

function listExecutionRecords(projectPath: string, projectTrusted = false): ExecutorRecord[] {
	return projectRecords(projectPath, "execution", isExecutorRecord, projectTrusted);
}

function listSignalRecords(projectPath: string, projectTrusted = false): SignalRecord[] {
	return projectRecords(projectPath, "signal", isSignal, projectTrusted);
}

function listLearningRecordsFromArchive(projectPath: string, projectTrusted = false): LearningRecord[] {
	return projectRecords(projectPath, "learning", isLearningRecord, projectTrusted);
}

function listVerdictRecords(projectPath: string, projectTrusted = false): VerdictRecord[] {
	return projectRecords(projectPath, "verdict", isVerdict, projectTrusted);
}

function listVerdictDeliveryRecords(projectPath: string, projectTrusted = false): VerdictDeliveryRecord[] {
	return projectRecords(projectPath, "verdict-delivery", isVerdictDelivery, projectTrusted);
}

function listLatestVerdictDeliveryRecords(projectPath: string, projectTrusted = false): VerdictDeliveryRecord[] {
	const latest = new Map<string, VerdictDeliveryRecord>();
	for (const record of listVerdictDeliveryRecords(projectPath, projectTrusted)) {
		latest.set(record.verdictId, record);
	}
	return [...latest.values()];
}

function listPullRequestRecords(projectPath: string, projectTrusted = false): PullRequestRecord[] {
	return projectRecords(projectPath, "pull-request", isPullRequestRecord, projectTrusted);
}

function listWorkOutcomeRecords(projectPath: string, projectTrusted = false): WorkOutcomeRecord[] {
	return projectRecords(projectPath, "work-outcome", isWorkOutcomeRecord, projectTrusted);
}

function listMandateRecords(projectPath: string, projectTrusted = false): MandateRecord[] {
	return projectRecords(projectPath, "mandate", isMandateRecord, projectTrusted);
}

function listMissionRecords(projectPath: string, projectTrusted = false): MissionRecord[] {
	return projectRecords(projectPath, "mission", isMissionRecord, projectTrusted);
}

function readMandate(projectPath: string, mandateId: string, projectTrusted = false): MandateRecord | undefined {
	let mandate: MandateRecord | undefined;
	for (const candidate of listMandateRecords(projectPath, projectTrusted)) {
		if (candidate.mandateId === mandateId) {
			mandate = candidate;
		}
	}
	return mandate;
}

function readLatestMandate(projectPath: string, workId: string, projectTrusted = false): MandateRecord | undefined {
	let latest: MandateRecord | undefined;
	for (const mandate of listMandateRecords(projectPath, projectTrusted)) {
		if (mandate.workId === workId && (latest === undefined || mandate.revision >= latest.revision)) {
			latest = mandate;
		}
	}
	return latest;
}

function readMission(projectPath: string, missionId: string, projectTrusted = false): MissionRecord | undefined {
	let mission: MissionRecord | undefined;
	for (const candidate of listMissionRecords(projectPath, projectTrusted)) {
		if (candidate.missionId === missionId) {
			mission = candidate;
		}
	}
	return mission;
}

type MissionProjectionMaps = Readonly<{
	successors: Map<string, MissionRecord>;
	terminalVerdicts: Map<string, VerdictRecord>;
	retryVerdicts: Map<string, VerdictRecord>;
}>;

function validateMissionRelationships(missions: MissionRecord[], verdicts: VerdictRecord[]): MissionProjectionMaps {
	const missionsById = new Map<string, MissionRecord>();
	for (const mission of missions) {
		if (missionsById.has(mission.missionId)) {
			throw new Error(`Mission ${mission.missionId} is duplicated in the Archive.`);
		}
		missionsById.set(mission.missionId, mission);
	}
	const verdictsById = new Map<string, VerdictRecord>();
	for (const verdict of verdicts) {
		if (verdictsById.has(verdict.verdictId)) {
			throw new Error(`Verdict ${verdict.verdictId} is duplicated in the Archive.`);
		}
		verdictsById.set(verdict.verdictId, verdict);
	}
	const successors = new Map<string, MissionRecord>();
	for (const mission of missions) {
		if (mission.predecessorMissionId !== undefined) {
			const predecessor = missionsById.get(mission.predecessorMissionId);
			if (predecessor === undefined || predecessor.workId !== mission.workId) {
				throw new Error(`Mission ${mission.missionId} has an invalid predecessor Mission.`);
			}
			if (mission.causedByVerdictId === undefined) {
				throw new Error(`Mission ${mission.missionId} is missing its causal Retry Verdict.`);
			}
			const cause = verdictsById.get(mission.causedByVerdictId);
			if (
				cause === undefined ||
				cause.decision !== "retry" ||
				cause.workId !== mission.workId ||
				cause.missionId !== predecessor.missionId
			) {
				throw new Error(`Mission ${mission.missionId} has an invalid causal Retry Verdict.`);
			}
			if (successors.has(mission.predecessorMissionId)) {
				throw new Error(`Mission ${mission.predecessorMissionId} has duplicate successor Missions.`);
			}
			successors.set(mission.predecessorMissionId, mission);
		}
	}
	const terminalVerdicts = new Map<string, VerdictRecord>();
	const retryVerdicts = new Map<string, VerdictRecord>();
	for (const verdict of verdicts) {
		if (verdict.missionId !== undefined) {
			const mission = missionsById.get(verdict.missionId);
			if (mission === undefined || mission.workId !== verdict.workId) {
				throw new Error(`Verdict ${verdict.verdictId} references an invalid Mission.`);
			}
			if (verdict.decision === "finish" || verdict.decision === "reject") {
				if (terminalVerdicts.has(verdict.missionId)) {
					throw new Error(`Mission ${verdict.missionId} has duplicate terminal Verdicts.`);
				}
				terminalVerdicts.set(verdict.missionId, verdict);
			}
			if (verdict.decision === "retry") {
				if (retryVerdicts.has(verdict.missionId)) {
					throw new Error(`Mission ${verdict.missionId} has duplicate Retry Verdicts.`);
				}
				retryVerdicts.set(verdict.missionId, verdict);
			}
		}
	}
	for (const [missionId, retry] of retryVerdicts) {
		if (terminalVerdicts.has(missionId) && retry.sourcePullRequestId === undefined) {
			throw new Error(`Mission ${missionId} has both Retry and terminal Verdicts.`);
		}
	}
	return { successors, terminalVerdicts, retryVerdicts };
}

function projectMissions(projectPath: string, projectTrusted = false): MissionProjection[] {
	const missions = listMissionRecords(projectPath, projectTrusted);
	const verdicts = listVerdictRecords(projectPath, projectTrusted);
	const { successors, terminalVerdicts, retryVerdicts } = validateMissionRelationships(missions, verdicts);
	return missions.map((mission) => {
		const successor = successors.get(mission.missionId);
		if (successor !== undefined) {
			return { mission, state: "superseded", successorMissionId: successor.missionId };
		}
		const retry = retryVerdicts.get(mission.missionId);
		if (retry !== undefined) {
			return { mission, state: "retry-pending", terminalVerdict: retry };
		}
		const terminal = terminalVerdicts.get(mission.missionId);
		if (terminal?.decision === "finish") {
			return { mission, state: "finished", terminalVerdict: terminal };
		}
		if (terminal?.decision === "reject") {
			return { mission, state: "rejected", terminalVerdict: terminal };
		}
		return { mission, state: "current" };
	});
}

function readCurrentMission(
	projectPath: string,
	workId: string,
	projectTrusted = false,
): MissionProjection | undefined {
	let latest: MissionProjection | undefined;
	for (const projection of projectMissions(projectPath, projectTrusted)) {
		if (projection.mission.workId === workId && projection.state !== "superseded") {
			latest = projection;
		}
	}
	return latest;
}

function findArchiveRecords(
	projectPath: string,
	recordIds: ReadonlySet<string>,
	projectTrusted = false,
): KhalaArchiveRecord[] {
	return listArchiveRecords(projectPath, projectTrusted).filter((record) => recordIds.has(record.recordId));
}

function projectRecords<T>(
	projectPath: string,
	type: KhalaArchiveRecord["type"],
	guard: (value: unknown) => value is T,
	projectTrusted: boolean,
): T[] {
	return listArchiveRecords(projectPath, projectTrusted).flatMap((record) => {
		if (record.type === type && guard(record.payload)) {
			return [record.payload];
		}
		return [];
	});
}

export type { MissionProjection, MissionProjectionState };
export {
	findArchiveRecords,
	listExecutionRecords,
	listLatestVerdictDeliveryRecords,
	listLearningRecordsFromArchive,
	listMandateRecords,
	listMissionRecords,
	listPullRequestRecords,
	listSignalRecords,
	listSubmissionRecords,
	listVerdictDeliveryRecords,
	listVerdictRecords,
	listWorkOutcomeRecords,
	projectMissions,
	readCurrentMission,
	readLatestMandate,
	readMandate,
	readMission,
};
