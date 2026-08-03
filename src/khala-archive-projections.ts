// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Mission projection validates mutually exclusive durable lifecycle paths in one read.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Durable projections remain one read-model boundary.
// biome-ignore-all lint/style/noTernary: Projection branches keep optional prospective records explicit.
// biome-ignore-all lint/style/noContinue: Projection filtering keeps inactive bindings out of the active result.
import { listArchiveRecords } from "./khala-archive.js";
import {
	type CoordinationRecord,
	type ExecutorRecord,
	type InterventionIssuanceRecord,
	type InterventionOutcomeRecord,
	isCoordinationRecord,
	isExecutorRecord,
	isInterventionRecord,
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
	type UpstreamExecutionBase,
	type VerdictDeliveryRecord,
	type VerdictRecord,
	type WorkOutcomeRecord,
} from "./khala-model.js";

type MissionProjectionState = "current" | "superseded" | "finished" | "rejected" | "retry-pending";
type ArchiveSnapshot = Readonly<{
	listRecords: () => readonly KhalaArchiveRecord[];
	listExecutions: () => ExecutorRecord[];
	listSignals: () => SignalRecord[];
	listPullRequests: () => PullRequestRecord[];
	listSubmissions: () => KhalaWorkSubmission[];
	listCoordinations: () => CoordinationRecord[];
	listInterventions: () => (InterventionIssuanceRecord | InterventionOutcomeRecord)[];
}>;
type MissionProjection = Readonly<{
	mission: MissionRecord;
	state: MissionProjectionState;
	successorMissionId?: string;
	terminalVerdict?: VerdictRecord;
}>;
type CoordinationProjection = Readonly<{
	coordinationId: string;
	records: readonly CoordinationRecord[];
	latest: CoordinationRecord;
	active: boolean;
	resolved: boolean;
}>;
type CoordinationHold = Readonly<{
	coordination: CoordinationProjection;
	workId: string;
	missionId: string;
}>;
type InterventionProjection = Readonly<{
	interventionId: string;
	issuance: InterventionIssuanceRecord;
	outcome?: InterventionOutcomeRecord;
	outstanding: boolean;
}>;

function createArchiveSnapshot(projectPath: string, projectTrusted = false): ArchiveSnapshot {
	const records = listArchiveRecords(projectPath, projectTrusted);
	return {
		listRecords: () => records,
		listExecutions: () => projectRecordsFromRecords(records, "execution", isExecutorRecord),
		listSignals: () => projectRecordsFromRecords(records, "signal", isSignal),
		listPullRequests: () => projectRecordsFromRecords(records, "pull-request", isPullRequestRecord),
		listSubmissions: () => projectRecordsFromRecords(records, "submission", isWorkSubmission),
		listCoordinations: () => projectRecordsFromRecords(records, "coordination", isCoordinationRecord),
		listInterventions: () => projectRecordsFromRecords(records, "intervention", isInterventionRecord),
	};
}

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

function listCoordinationRecords(projectPath: string, projectTrusted = false): CoordinationRecord[] {
	return projectRecords(projectPath, "coordination", isCoordinationRecord, projectTrusted);
}

function listInterventionRecords(
	projectPath: string,
	projectTrusted = false,
): (InterventionIssuanceRecord | InterventionOutcomeRecord)[] {
	return projectRecords(projectPath, "intervention", isInterventionRecord, projectTrusted);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Active base projection keeps merge, review, and Mission-state fences together.
function projectActiveUpstreamBases(projectPath: string, projectTrusted = false): UpstreamExecutionBase[] {
	const latestExecutions = new Map<string, ExecutorRecord>();
	for (const execution of listExecutionRecords(projectPath, projectTrusted)) {
		latestExecutions.set(execution.executionId, execution);
	}
	const missions = projectMissions(projectPath, projectTrusted);
	const pullRequests = listPullRequestRecords(projectPath, projectTrusted);
	const outcomes = listWorkOutcomeRecords(projectPath, projectTrusted);
	const active: UpstreamExecutionBase[] = [];
	for (const execution of latestExecutions.values()) {
		const base = execution.upstreamBase;
		if (base === undefined || execution.status === "failed") {
			continue;
		}
		const mission = missions.find((projection) => projection.mission.missionId === execution.missionId);
		if (
			mission === undefined ||
			mission.state === "superseded" ||
			mission.state === "rejected" ||
			mission.state === "retry-pending"
		) {
			continue;
		}
		const handoff = [...pullRequests]
			.reverse()
			.find((pullRequest) => pullRequest.executionId === execution.executionId);
		const currentOrReviewable =
			execution.status === "starting" ||
			execution.status === "running" ||
			(execution.status === "finished" && handoff?.status === "reviewable");
		if (!currentOrReviewable || handoff?.status === "closed") {
			continue;
		}
		const merged =
			pullRequests.some(
				(pullRequest) =>
					pullRequest.workId === base.workId &&
					pullRequest.missionId === base.missionId &&
					pullRequest.executionId === base.executionId &&
					pullRequest.status === "merged" &&
					pullRequest.headCommit === base.headCommit &&
					pullRequest.mergeCommit !== undefined,
			) ||
			outcomes.some(
				(outcome) =>
					outcome.workId === base.workId &&
					outcome.missionId === base.missionId &&
					outcome.executionId === base.executionId &&
					outcome.finalHeadCommit === base.headCommit &&
					outcome.mergeCommit.length > 0,
			);
		if (!merged) {
			active.push(base);
		}
	}
	return active.sort((left, right) =>
		`${left.workId}\u0000${left.missionId}\u0000${left.executionId}`.localeCompare(
			`${right.workId}\u0000${right.missionId}\u0000${right.executionId}`,
		),
	);
}

function activeCoordinationHolds(projectPath: string, projectTrusted = false): CoordinationHold[] {
	const holds: CoordinationHold[] = [];
	const missions = projectMissions(projectPath, projectTrusted);
	for (const coordination of projectCoordinations(projectPath, projectTrusted)) {
		const { latest } = coordination;
		if (!coordination.active || latest.phase === "release" || latest.phase === "resolution") {
			continue;
		}
		if (latest.relation === "dependency") {
			holds.push(currentCoordinationHold(coordination, latest.workId, latest.missionId, missions));
			continue;
		}
		let waitingWorkId = latest.workId;
		let waitingMissionId = latest.missionId;
		if (latest.selectedWorkId === latest.workId) {
			waitingWorkId = latest.relatedWorkId;
			waitingMissionId = latest.relatedMissionId;
		}
		holds.push(currentCoordinationHold(coordination, waitingWorkId, waitingMissionId, missions));
	}
	return holds;
}

function currentCoordinationHold(
	coordination: CoordinationProjection,
	workId: string,
	missionId: string,
	missions: readonly MissionProjection[],
): CoordinationHold {
	const current = missions
		.filter((projection) => projection.mission.workId === workId && projection.state !== "superseded")
		.at(-1)?.mission;
	return { coordination, workId: current?.workId ?? workId, missionId: current?.missionId ?? missionId };
}

function projectCoordinations(projectPath: string, projectTrusted = false): CoordinationProjection[] {
	const grouped = new Map<string, CoordinationRecord[]>();
	for (const record of listCoordinationRecords(projectPath, projectTrusted)) {
		const group = grouped.get(record.coordinationId) ?? [];
		group.push(record);
		grouped.set(record.coordinationId, group);
	}
	const projections = [...grouped.values()].map((records) => {
		const latest = records.at(-1);
		if (latest === undefined) {
			throw new Error("Coordination projection encountered an empty record group.");
		}
		const resolved = latest.phase === "resolution";
		return { coordinationId: latest.coordinationId, records, latest, active: !resolved, resolved };
	});
	validateCoordinationGraph(projections);
	return projections;
}

function validateProspectiveCoordinationGraph(
	records: readonly CoordinationRecord[],
	prospective?: CoordinationRecord,
): void {
	const combined = [...records];
	if (prospective !== undefined) {
		combined.push(prospective);
	}
	const latestById = new Map<string, CoordinationRecord>();
	for (const record of combined) {
		latestById.set(record.coordinationId, record);
	}
	validateCoordinationGraph(
		[...latestById.values()].map((latest) => ({
			coordinationId: latest.coordinationId,
			records: [latest],
			latest,
			active: latest.phase !== "resolution",
			resolved: latest.phase === "resolution",
		})),
	);
}

function validateCoordinationGraph(projections: readonly CoordinationProjection[]): void {
	const edges = new Map<string, string>();
	for (const projection of projections) {
		const { latest } = projection;
		if (!projection.active || latest.relation !== "dependency" || latest.phase === "resolution") {
			continue;
		}
		if (latest.workId === latest.relatedWorkId) {
			throw new Error(`Coordination ${latest.coordinationId} creates a self-dependency.`);
		}
		const prior = edges.get(latest.workId);
		if (prior !== undefined && prior !== latest.relatedWorkId) {
			throw new Error(`Work ${latest.workId} has conflicting active upstream Coordinations.`);
		}
		edges.set(latest.workId, latest.relatedWorkId);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (workId: string): void => {
		if (visiting.has(workId)) {
			throw new Error(`Active Coordination dependency cycle includes Work ${workId}.`);
		}
		if (visited.has(workId)) {
			return;
		}
		visiting.add(workId);
		const upstream = edges.get(workId);
		if (upstream !== undefined) {
			visit(upstream);
		}
		visiting.delete(workId);
		visited.add(workId);
	};
	for (const workId of edges.keys()) {
		visit(workId);
	}
}

function projectInterventions(projectPath: string, projectTrusted = false): InterventionProjection[] {
	const grouped = new Map<string, (InterventionIssuanceRecord | InterventionOutcomeRecord)[]>();
	for (const record of listInterventionRecords(projectPath, projectTrusted)) {
		const group = grouped.get(record.interventionId) ?? [];
		group.push(record);
		grouped.set(record.interventionId, group);
	}
	return [...grouped.values()].map((records) => {
		const issuance = records.find((record): record is InterventionIssuanceRecord => record.phase === "issuance");
		if (issuance === undefined) {
			throw new Error("Intervention projection is missing its issuance.");
		}
		const outcome = records.find((record): record is InterventionOutcomeRecord => record.phase === "outcome");
		if (outcome === undefined) {
			return { interventionId: issuance.interventionId, issuance, outstanding: true };
		}
		return { interventionId: issuance.interventionId, issuance, outcome, outstanding: false };
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

type MissionProjectionMaps = Readonly<{
	successors: Map<string, MissionRecord>;
	terminalVerdicts: Map<string, VerdictRecord>;
	retryVerdicts: Map<string, VerdictRecord>;
}>;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Relationship validation keeps causal fences together.
function validateMissionRelationships(
	missions: MissionRecord[],
	verdicts: VerdictRecord[],
	coordinations: CoordinationRecord[],
): MissionProjectionMaps {
	const missionsById = new Map<string, MissionRecord>();
	for (const mission of missions) {
		if (missionsById.has(mission.missionId)) {
			throw new Error(`Mission ${mission.missionId} is duplicated in the Archive.`);
		}
		missionsById.set(mission.missionId, mission);
	}
	const coordinationsById = new Map<string, CoordinationRecord[]>();
	for (const coordination of coordinations) {
		if (coordination.phase === "invalidation") {
			const invalidations = coordinationsById.get(coordination.coordinationId) ?? [];
			invalidations.push(coordination);
			coordinationsById.set(coordination.coordinationId, invalidations);
		}
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
			if (mission.causedByVerdictId !== undefined) {
				const cause = verdictsById.get(mission.causedByVerdictId);
				if (
					cause === undefined ||
					cause.decision !== "retry" ||
					cause.workId !== mission.workId ||
					cause.missionId !== predecessor.missionId
				) {
					throw new Error(`Mission ${mission.missionId} has an invalid causal Retry Verdict.`);
				}
			} else if (mission.causedByCoordinationId === undefined) {
				throw new Error(`Mission ${mission.missionId} is missing its causal successor evidence.`);
			} else {
				const causes = coordinationsById.get(mission.causedByCoordinationId) ?? [];
				const applicableCause = causes.find(
					(cause) =>
						cause.relation === "dependency" &&
						cause.workId === mission.workId &&
						cause.missionId === predecessor.missionId &&
						cause.upstreamHead !== undefined &&
						cause.affectedDependents?.some(
							(dependent) =>
								dependent.missionId === predecessor.missionId && dependent.supersededHead === cause.upstreamHead,
						),
				);
				if (applicableCause === undefined) {
					throw new Error(`Mission ${mission.missionId} has an invalid causal Coordination invalidation.`);
				}
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
	const coordinations = listCoordinationRecords(projectPath, projectTrusted);
	const { successors, terminalVerdicts, retryVerdicts } = validateMissionRelationships(
		missions,
		verdicts,
		coordinations,
	);
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
	return projectRecordsFromRecords(listArchiveRecords(projectPath, projectTrusted), type, guard);
}

function projectRecordsFromRecords<T>(
	records: readonly KhalaArchiveRecord[],
	type: KhalaArchiveRecord["type"],
	guard: (value: unknown) => value is T,
): T[] {
	return records.flatMap((record) => {
		if (record.type === type && guard(record.payload)) {
			return [record.payload];
		}
		return [];
	});
}

export type {
	ArchiveSnapshot,
	CoordinationHold,
	CoordinationProjection,
	InterventionProjection,
	MissionProjection,
	MissionProjectionState,
};
export {
	activeCoordinationHolds,
	createArchiveSnapshot,
	findArchiveRecords,
	listCoordinationRecords,
	listExecutionRecords,
	listInterventionRecords,
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
	projectActiveUpstreamBases,
	projectCoordinations,
	projectInterventions,
	projectMissions,
	readCurrentMission,
	readLatestMandate,
	readMandate,
	readMission,
	validateCoordinationGraph,
	validateProspectiveCoordinationGraph,
};
