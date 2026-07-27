import { listArchiveRecords } from "./khala-archive.js";
import {
	type CounselRecord,
	type ExecutorRecord,
	isCounselRecord,
	isExecutorRecord,
	isLearningRecord,
	isMandateRecord,
	isMissionRecord,
	isSignal,
	isVerdict,
	isWorkSubmission,
	type KhalaArchiveRecord,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MandateRecord,
	type MissionRecord,
	type SignalRecord,
	type VerdictRecord,
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

function listCounselRecords(projectPath: string, projectTrusted = false): CounselRecord[] {
	return listArchiveRecords(projectPath, projectTrusted).flatMap((record) => {
		if (record.type === "counsel" && isCounselRecord(record.payload)) {
			return [record.payload];
		}
		return [];
	});
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

function projectMissions(projectPath: string, projectTrusted = false): MissionProjection[] {
	const missions = listMissionRecords(projectPath, projectTrusted);
	const verdicts = listVerdictRecords(projectPath, projectTrusted);
	const successors = new Map<string, MissionRecord>();
	for (const mission of missions) {
		if (mission.predecessorMissionId !== undefined) {
			successors.set(mission.predecessorMissionId, mission);
		}
	}
	const terminalVerdicts = new Map<string, VerdictRecord>();
	const retryVerdicts = new Map<string, VerdictRecord>();
	for (const verdict of verdicts) {
		if (verdict.missionId !== undefined) {
			if (verdict.decision === "finish" || verdict.decision === "reject") {
				terminalVerdicts.set(verdict.missionId, verdict);
			}
			if (verdict.decision === "retry") {
				retryVerdicts.set(verdict.missionId, verdict);
			}
		}
	}
	return missions.map((mission) => {
		const successor = successors.get(mission.missionId);
		if (successor !== undefined) {
			return { mission, state: "superseded", successorMissionId: successor.missionId };
		}
		const terminal = terminalVerdicts.get(mission.missionId);
		if (terminal?.decision === "finish") {
			return { mission, state: "finished", terminalVerdict: terminal };
		}
		if (terminal?.decision === "reject") {
			return { mission, state: "rejected", terminalVerdict: terminal };
		}
		const retry = retryVerdicts.get(mission.missionId);
		if (retry !== undefined) {
			return { mission, state: "retry-pending", terminalVerdict: retry };
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
	listCounselRecords,
	listExecutionRecords,
	listLearningRecordsFromArchive,
	listMandateRecords,
	listMissionRecords,
	listSignalRecords,
	listSubmissionRecords,
	listVerdictRecords,
	projectMissions,
	readCurrentMission,
	readLatestMandate,
	readMandate,
	readMission,
};
