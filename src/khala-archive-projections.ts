// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Mission projection validates mutually exclusive durable lifecycle paths in one read.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Durable projections remain one read-model boundary.
// biome-ignore-all lint/style/noTernary: Projection branches keep optional prospective records explicit.
// biome-ignore-all lint/style/noContinue: Projection filtering keeps inactive bindings out of the active result.
import { listArchiveRecords } from "./khala-archive.js";
import {
	type ConclaveWakeRecord,
	type CoordinationRecord,
	type ExecutorRecord,
	type InterventionIssuanceRecord,
	type InterventionOutcomeRecord,
	isConclaveWakeRecord,
	isCoordinationRecord,
	isExecutorRecord,
	isInterventionRecord,
	isLearningRecord,
	isMandateRecord,
	isMissionRecord,
	isPullRequestRecord,
	isSignal,
	isUserPriorityEnforcementRecord,
	isUserPriorityRecord,
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
	type UserPriorityEnforcementRecord,
	type UserPriorityRecord,
	type VerdictDeliveryRecord,
	type VerdictRecord,
	type WorkOutcomeRecord,
} from "./khala-model.js";

type MissionProjectionState = "current" | "superseded" | "finished" | "rejected" | "retry-pending";
// One append-ordered point-in-time view of the Archive: accessors never re-read the file, so
// records appended after snapshot creation are invisible to it. Accessors return the stored
// payload references (no defensive copies), matching the aliasing behavior of direct Archive reads.
type ArchiveSnapshot = Readonly<{
	listRecords: () => readonly KhalaArchiveRecord[];
	latestUnresolvedConclaveWake: () => ConclaveWakeRecord | undefined;
	listExecutions: () => ExecutorRecord[];
	listSignals: () => SignalRecord[];
	listPullRequests: () => PullRequestRecord[];
	listSubmissions: () => KhalaWorkSubmission[];
	listCoordinations: () => CoordinationRecord[];
	activeCoordinationHolds: () => CoordinationHold[];
	listInterventions: () => (InterventionIssuanceRecord | InterventionOutcomeRecord)[];
	missions: () => MissionProjection[];
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
		latestUnresolvedConclaveWake: () => findLatestUnresolvedConclaveWake(records),
		listExecutions: () => projectRecordsFromRecords(records, "execution", isExecutorRecord),
		listSignals: () => projectRecordsFromRecords(records, "signal", isSignal),
		listPullRequests: () => projectRecordsFromRecords(records, "pull-request", isPullRequestRecord),
		listSubmissions: () => projectRecordsFromRecords(records, "submission", isWorkSubmission),
		listCoordinations: () => projectRecordsFromRecords(records, "coordination", isCoordinationRecord),
		activeCoordinationHolds: () => activeCoordinationHoldsFromRecords(records),
		listInterventions: () => projectRecordsFromRecords(records, "intervention", isInterventionRecord),
		missions: () => projectMissionsFromRecords(records),
	};
}

function findLatestUnresolvedConclaveWake(records: readonly KhalaArchiveRecord[]): ConclaveWakeRecord | undefined {
	const seenWorkIds = new Set<string>();
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (record?.type !== "conclave-wake" || !isConclaveWakeRecord(record.payload)) {
			continue;
		}
		if (seenWorkIds.has(record.workId)) {
			continue;
		}
		seenWorkIds.add(record.workId);
		if (record.payload.status === "failed") {
			return record.payload;
		}
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy strict return analysis when no failure remains.
	return undefined;
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

function listUserPriorityRecords(projectPath: string, projectTrusted = false): UserPriorityRecord[] {
	return projectRecords(projectPath, "user-priority", isUserPriorityRecord, projectTrusted);
}

function listUserPriorityEnforcementRecords(
	projectPath: string,
	projectTrusted = false,
): UserPriorityEnforcementRecord[] {
	return projectRecords(projectPath, "user-priority-enforcement", isUserPriorityEnforcementRecord, projectTrusted);
}

function readUserPriorityEnforcement(
	projectPath: string,
	priorityId: string,
	projectTrusted = false,
): UserPriorityEnforcementRecord | undefined {
	let latest: UserPriorityEnforcementRecord | undefined;
	for (const record of listUserPriorityEnforcementRecords(projectPath, projectTrusted)) {
		if (record.priorityId === priorityId) {
			latest = record;
		}
	}
	return latest;
}

function isUserPriorityEnforced(projectPath: string, priorityId: string, projectTrusted = false): boolean {
	const enforcement = readUserPriorityEnforcement(projectPath, priorityId, projectTrusted);
	return enforcement?.phase === "enforced" || enforcement?.phase === "terminal";
}

// The current phase of a User Priority is its latest append-ordered record.
function readUserPriority(
	projectPath: string,
	priorityId: string,
	projectTrusted = false,
): UserPriorityRecord | undefined {
	let latest: UserPriorityRecord | undefined;
	for (const record of listUserPriorityRecords(projectPath, projectTrusted)) {
		if (record.priorityId === priorityId) {
			latest = record;
		}
	}
	return latest;
}

// Applied is derived from a Coordination override that references the priority;
// it is never stored on the User Priority record.
function isUserPriorityApplied(projectPath: string, priorityId: string, projectTrusted = false): boolean {
	return listCoordinationRecords(projectPath, projectTrusted).some(
		(record) => record.phase === "override" && record.priorityId === priorityId,
	);
}

function pendingUserPriorities(projectPath: string, projectTrusted = false): UserPriorityRecord[] {
	const latest = new Map<string, UserPriorityRecord>();
	for (const record of listUserPriorityRecords(projectPath, projectTrusted)) {
		latest.set(record.priorityId, record);
	}
	return [...latest.values()].filter(
		(record) =>
			record.status === "pending" &&
			!isUserPriorityApplied(projectPath, record.priorityId, projectTrusted) &&
			!isUserPriorityEnforced(projectPath, record.priorityId, projectTrusted),
	);
}

function pendingUserPriorityEnforcements(projectPath: string, projectTrusted = false): UserPriorityRecord[] {
	const latest = new Map<string, UserPriorityRecord>();
	for (const record of listUserPriorityRecords(projectPath, projectTrusted)) {
		latest.set(record.priorityId, record);
	}
	return [...latest.values()].filter(
		(record) =>
			record.status === "pending" &&
			isUserPriorityApplied(projectPath, record.priorityId, projectTrusted) &&
			!isUserPriorityEnforced(projectPath, record.priorityId, projectTrusted),
	);
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
	// One append-ordered snapshot per composite projection; private local maps replace repeated scans.
	const records = listArchiveRecords(projectPath, projectTrusted);
	const latestExecutions = new Map<string, ExecutorRecord>();
	for (const execution of projectRecordsFromRecords(records, "execution", isExecutorRecord)) {
		latestExecutions.set(execution.executionId, execution);
	}
	const missions = projectMissionsFromRecords(records);
	const pullRequests = projectRecordsFromRecords(records, "pull-request", isPullRequestRecord);
	const outcomes = projectRecordsFromRecords(records, "work-outcome", isWorkOutcomeRecord);
	const latestPullRequestByExecution = new Map<string, PullRequestRecord>();
	for (const pullRequest of pullRequests) {
		latestPullRequestByExecution.set(pullRequest.executionId, pullRequest);
	}
	const mergedBaseKeys = new Set<string>();
	for (const pullRequest of pullRequests) {
		if (
			pullRequest.status === "merged" &&
			pullRequest.headCommit !== undefined &&
			pullRequest.mergeCommit !== undefined
		) {
			mergedBaseKeys.add(
				upstreamBaseKey(pullRequest.workId, pullRequest.missionId, pullRequest.executionId, pullRequest.headCommit),
			);
		}
	}
	for (const outcome of outcomes) {
		if (outcome.mergeCommit.length > 0) {
			mergedBaseKeys.add(
				upstreamBaseKey(outcome.workId, outcome.missionId, outcome.executionId, outcome.finalHeadCommit),
			);
		}
	}
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
		const handoff = latestPullRequestByExecution.get(execution.executionId);
		const currentOrReviewable =
			execution.status === "starting" ||
			execution.status === "running" ||
			(execution.status === "finished" && handoff?.status === "reviewable");
		if (!currentOrReviewable || handoff?.status === "closed") {
			continue;
		}
		const merged = mergedBaseKeys.has(upstreamBaseKey(base.workId, base.missionId, base.executionId, base.headCommit));
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

// JSON-serialized array key: injective for any strings, unlike a separator-joined key that
// adversarial identifiers (e.g. containing the separator) could make ambiguous.
function upstreamBaseKey(workId: string, missionId: string, executionId: string, headCommit: string): string {
	return JSON.stringify([workId, missionId, executionId, headCommit]);
}

function activeCoordinationHolds(projectPath: string, projectTrusted = false): CoordinationHold[] {
	return activeCoordinationHoldsFromRecords(listArchiveRecords(projectPath, projectTrusted));
}

function activeCoordinationHoldsFromRecords(records: readonly KhalaArchiveRecord[]): CoordinationHold[] {
	const holds: CoordinationHold[] = [];
	const missions = projectMissionsFromRecords(records);
	for (const coordination of projectCoordinationsFromRecords(records)) {
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

function projectCoordinationsFromRecords(records: readonly KhalaArchiveRecord[]): CoordinationProjection[] {
	const grouped = new Map<string, CoordinationRecord[]>();
	for (const record of projectRecordsFromRecords(records, "coordination", isCoordinationRecord)) {
		const group = grouped.get(record.coordinationId) ?? [];
		group.push(record);
		grouped.set(record.coordinationId, group);
	}
	const projections = [...grouped.values()].map((group) => {
		const latest = group.at(-1);
		if (latest === undefined) {
			throw new Error("Coordination projection encountered an empty record group.");
		}
		const resolved = latest.phase === "resolution";
		return { coordinationId: latest.coordinationId, records: group, latest, active: !resolved, resolved };
	});
	validateCoordinationGraph(projections);
	return projections;
}

function projectCoordinations(projectPath: string, projectTrusted = false): CoordinationProjection[] {
	return projectCoordinationsFromRecords(listArchiveRecords(projectPath, projectTrusted));
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

function projectMissionsFromRecords(records: readonly KhalaArchiveRecord[]): MissionProjection[] {
	const missions = projectRecordsFromRecords(records, "mission", isMissionRecord);
	const verdicts = projectRecordsFromRecords(records, "verdict", isVerdict);
	const coordinations = projectRecordsFromRecords(records, "coordination", isCoordinationRecord);
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

function projectMissions(projectPath: string, projectTrusted = false): MissionProjection[] {
	return projectMissionsFromRecords(listArchiveRecords(projectPath, projectTrusted));
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
	isUserPriorityApplied,
	isUserPriorityEnforced,
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
	listUserPriorityEnforcementRecords,
	listUserPriorityRecords,
	listVerdictDeliveryRecords,
	listVerdictRecords,
	listWorkOutcomeRecords,
	pendingUserPriorities,
	pendingUserPriorityEnforcements,
	projectActiveUpstreamBases,
	projectCoordinations,
	projectCoordinationsFromRecords,
	projectInterventions,
	projectMissions,
	projectMissionsFromRecords,
	projectRecordsFromRecords,
	readCurrentMission,
	readLatestMandate,
	readMandate,
	readMission,
	readUserPriority,
	readUserPriorityEnforcement,
	validateCoordinationGraph,
	validateProspectiveCoordinationGraph,
};
