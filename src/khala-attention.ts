// The Khala attention projection is the read-only data model behind /khala and
// Alt+K. It derives actionable project state only from authoritative Archive
// evidence. Execution failures without a current actionable condition stay out of this surface.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Attention projection keeps one read-only summary contract together.
// biome-ignore-all lint/style/noContinue: Projection scans use explicit skip guards over untrusted Archive records.
// biome-ignore-all lint/style/noTernary: Optional presentation fields are assembled without inventing evidence.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Attention precedence is kept in one authoritative projection.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Projection branches remain adjacent to their condition semantics.
// biome-ignore-all lint/complexity/useMaxParams: Projection inputs name their authoritative evidence explicitly.
// biome-ignore-all lint/performance/noAwaitInLoops: Runtime probes remain bounded and preserve Work ordering.
import { createHash } from "node:crypto";
import { type ArchiveSnapshot, createArchiveSnapshot, type MissionProjection } from "./khala-archive-projections.js";
import {
	ConclaveRecoveryStatus,
	type ConclaveWakeRecovery,
	type ExecutorRecord,
	ExecutorStatus,
	isConclaveRecoveryRecord,
	isExecutorRecord,
	isWorkOutcomeRecord,
	type KhalaWorkSubmission,
	type PullRequestRecord,
	type UserWorkerActionKind,
	WorkSubmissionStatus,
} from "./khala-model.js";
import { dismissedConditionIds } from "./khala-user-worker-action.js";

const PULL_REQUEST_REFERENCE_PATTERN = /\/pull\/(\d+)(?:[/?#]|$)/;

type KhalaAttentionItem = Readonly<{ workId: string; title: string; detail: string }>;
type WorkAttentionAction =
	| UserWorkerActionKind
	| "select-model"
	| "try-same-model"
	| "review"
	| "view-attempts"
	| "recover-conclave"
	| "dismiss";
type ProjectAttentionAction = "setup" | "recreate" | "dismiss";
type WorkAttention = Readonly<{
	conditionId: string;
	workId: string;
	title: string;
	summary: string;
	actions: readonly WorkAttentionAction[];
	missionId?: string;
	executionId?: string;
	pullRequestUrl?: string;
	pullRequestReference?: string;
}>;
type ProjectAttention = Readonly<{
	conditionId: string;
	summary: string;
	actions: readonly ProjectAttentionAction[];
	kind: "setup" | "recreate";
}>;
type ExecutionRuntimeProbe = (
	executionId: string,
) => Promise<Readonly<{ kind: "busy" | "idle" | "unreachable" | "unknown"; reason?: string }>>;
type KhalaAttentionView = Readonly<{
	work: readonly WorkAttention[];
	project: readonly ProjectAttention[];
	activeWorkCount: number;
}>;

type KhalaRecoveryAttention = Readonly<{
	kind: "setup" | "recreate" | "executor-model";
	message: string;
	workId?: string;
	missionId?: string;
	executionId?: string;
}>;

interface KhalaAttentionSummary {
	condition: "action-required" | "working";
	reviewRequested: readonly KhalaAttentionItem[];
	stoppedWork: readonly KhalaAttentionItem[];
	recovery?: KhalaRecoveryAttention;
	activeWorkCount: number;
	work: readonly WorkAttention[];
	project: readonly ProjectAttention[];
}

type StoppedWorkEvidence = Readonly<{ acceptedWorkIds: ReadonlySet<string>; exhaustedWorkIds: ReadonlySet<string> }>;

// The summary is a pure read-model over one Archive snapshot; accessors never re-read the file.
function buildKhalaAttention(projectPath: string, projectTrusted = false): KhalaAttentionSummary {
	const archive = createArchiveSnapshot(projectPath, projectTrusted);
	const { latest: submissions, titles } = submissionIndex(archive);
	const missions = latestMissionByWork(archive);
	const acceptedWorkIds = acceptedWorkIdsFrom(archive);
	const exhaustedWorkIds = exhaustedRecoveryWorkIds(archive);
	const reviewRequested = projectReviewRequests(archive, missions, titles, acceptedWorkIds);
	const stoppedWork = projectStoppedWork(submissions, archive, titles, { acceptedWorkIds, exhaustedWorkIds });
	const recovery = projectRecovery(archive, exhaustedWorkIds);
	const work = projectWorkAttention(
		archive,
		missions,
		titles,
		stoppedWork,
		reviewRequested,
		acceptedWorkIds,
		exhaustedWorkIds,
	);
	const project = projectAttention(archive, recovery, exhaustedWorkIds);
	const summary: KhalaAttentionSummary = {
		condition: projectCondition(work, project),
		reviewRequested,
		stoppedWork: [...stoppedWork.values()],
		activeWorkCount: countActiveWork(submissions, acceptedWorkIds, new Set(stoppedWork.keys())),
		work,
		project,
	};
	if (recovery !== undefined) {
		summary.recovery = recovery;
	}
	return summary;
}

function projectCondition(
	work: readonly WorkAttention[],
	project: readonly ProjectAttention[],
): "action-required" | "working" {
	if (work.length > 0 || project.length > 0) {
		return "action-required";
	}
	return "working";
}

function projectWorkAttention(
	archive: ArchiveSnapshot,
	missions: Map<string, MissionProjection>,
	titles: Map<string, string>,
	stoppedWork: Map<string, KhalaAttentionItem>,
	reviewRequested: readonly KhalaAttentionItem[],
	acceptedWorkIds: ReadonlySet<string>,
	exhaustedWorkIds: ReadonlySet<string>,
): WorkAttention[] {
	const dismissed = dismissedConditionIds(archive.listRecords());
	const currentPullRequests = latestPullRequestByWork(archive, missions);
	const coordinationHolds = archive.activeCoordinationHolds();
	const projected = new Map<string, WorkAttention>();
	for (const item of reviewRequested) {
		const pullRequest = currentPullRequests.get(item.workId);
		if (pullRequest === undefined) {
			continue;
		}
		const conditionId = attentionConditionId(
			"review",
			item.workId,
			pullRequest.pullRequestId,
			pullRequest.headCommit ?? "",
		);
		if (!dismissed.has(conditionId)) {
			projected.set(item.workId, {
				conditionId,
				workId: item.workId,
				title: item.title,
				summary: "Ready for your review",
				actions: ["review", "view-attempts", "dismiss"],
				missionId: pullRequest.missionId,
				executionId: pullRequest.executionId,
				...pullRequestAttentionFields(pullRequest),
			});
		}
	}
	for (const [workId, item] of stoppedWork) {
		const conditionId = attentionConditionId("stopped", workId, item.detail);
		if (!(dismissed.has(conditionId) || projected.has(workId))) {
			const missionId = missions.get(workId)?.mission.missionId;
			projected.set(workId, {
				conditionId,
				workId,
				title: item.title,
				summary: item.detail,
				actions: exhaustedWorkIds.has(workId)
					? ["recover-conclave", "view-attempts", "dismiss"]
					: ["view-attempts", "dismiss"],
				...(missionId === undefined ? {} : { missionId }),
				...pullRequestAttentionFields(currentPullRequests.get(workId)),
			});
		}
	}
	const latestExecutions = latestExecutionsById(archive);
	for (const projection of missions.values()) {
		if (
			projection.state !== "current" ||
			acceptedWorkIds.has(projection.mission.workId) ||
			projected.has(projection.mission.workId)
		) {
			continue;
		}
		const execution = latestMissionExecution(latestExecutions, projection.mission.missionId);
		if (execution === undefined || execution.status !== ExecutorStatus.failed) {
			continue;
		}
		let kind = "execution-failed";
		let summary = "The current worker failed; the Mission can continue";
		let actions: WorkAttentionAction[] = ["continue-current-mission", "view-attempts", "dismiss"];
		if (execution.failureCategory === "model-unavailable") {
			kind = "model-unavailable";
			summary = "The current worker model is unavailable; select another model";
			actions = ["select-model", "view-attempts", "dismiss"];
		}
		const coordinationHold = coordinationHolds.find(
			(hold) => hold.workId === execution.workId && hold.missionId === projection.mission.missionId,
		);
		if (coordinationHold !== undefined) {
			kind = "mission-held";
			summary = coordinationHoldSummary(coordinationHold, titles);
			actions = ["view-attempts", "dismiss"];
		}
		const conditionId = attentionConditionId(
			kind,
			execution.workId,
			projection.mission.missionId,
			execution.executionId,
		);
		if (!dismissed.has(conditionId)) {
			projected.set(execution.workId, {
				conditionId,
				workId: execution.workId,
				title: workTitle(titles, execution.workId),
				summary,
				actions,
				missionId: projection.mission.missionId,
				executionId: execution.executionId,
				...pullRequestAttentionFields(currentPullRequests.get(execution.workId)),
			});
		}
	}
	return [...projected.values()];
}

function coordinationHoldSummary(
	hold: ReturnType<ArchiveSnapshot["activeCoordinationHolds"]>[number],
	titles: Map<string, string>,
): string {
	const coordination = hold.coordination.latest;
	if (coordination.relation === "dependency") {
		const upstreamWorkId = coordination.upstreamWorkId ?? coordination.selectedWorkId;
		return `The current Mission is held for upstream Work ${workTitle(titles, upstreamWorkId)}; recovery is blocked`;
	}
	const conflictingWorkId =
		coordination.selectedWorkId === hold.workId ? coordination.relatedWorkId : coordination.selectedWorkId;
	return `The current Mission is held by a peer conflict with ${workTitle(titles, conflictingWorkId)}; recovery is blocked`;
}

function projectAttention(
	archive: ArchiveSnapshot,
	recovery: KhalaRecoveryAttention | undefined,
	exhaustedWorkIds: ReadonlySet<string>,
): ProjectAttention[] {
	if (recovery === undefined || recovery.kind === "executor-model") {
		return [];
	}
	const wake = archive
		.listRecords()
		.filter((record) => record.type === "conclave-wake" && record.workId === recovery.workId)
		.at(-1);
	const conditionId = attentionConditionId(
		"project-recovery",
		recovery.kind,
		recovery.workId ?? "",
		wake?.recordId ?? recovery.message,
	);
	if (recovery.workId !== undefined && exhaustedWorkIds.has(recovery.workId)) {
		return [];
	}
	if (dismissedConditionIds(archive.listRecords()).has(conditionId)) {
		return [];
	}
	return [
		{
			conditionId,
			summary: recovery.message,
			actions: [recovery.kind, "dismiss"],
			kind: recovery.kind,
		},
	];
}

function latestExecutionsById(archive: ArchiveSnapshot): ExecutorRecord[] {
	const latest = new Map<string, ExecutorRecord>();
	for (const execution of archive.listExecutions()) {
		latest.set(execution.executionId, execution);
	}
	return [...latest.values()];
}

function latestMissionExecution(executions: readonly ExecutorRecord[], missionId: string): ExecutorRecord | undefined {
	let latest: ExecutorRecord | undefined;
	for (const execution of executions) {
		if (isExecutorRecord(execution) && execution.missionId === missionId && execution.kind !== "observer") {
			latest = execution;
		}
	}
	return latest;
}

function hasBlockedAwaitingVerdict(archive: ArchiveSnapshot, execution: ExecutorRecord): boolean {
	const signal = archive
		.listSignals()
		.filter((candidate) => candidate.executionId === execution.executionId)
		.at(-1);
	if (signal?.kind !== "blocked") {
		return false;
	}
	return !archive
		.listRecords()
		.some(
			(record) =>
				record.type === "verdict" &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { executionId?: unknown }).executionId === execution.executionId &&
				(record.payload as { signalId?: unknown }).signalId === signal.signalId,
		);
}

async function resolveKhalaAttention(
	projectPath: string,
	projectTrusted = false,
	probeRuntime?: ExecutionRuntimeProbe,
): Promise<KhalaAttentionView> {
	const summary = buildKhalaAttention(projectPath, projectTrusted);
	if (probeRuntime === undefined) {
		return { work: summary.work, project: summary.project, activeWorkCount: summary.activeWorkCount };
	}
	const archive = createArchiveSnapshot(projectPath, projectTrusted);
	const missions = latestMissionByWork(archive);
	const latestExecutions = latestExecutionsById(archive);
	const currentPullRequests = latestPullRequestByWork(archive, missions);
	const dismissed = dismissedConditionIds(archive.listRecords());
	const work = [...summary.work];
	const represented = new Set(work.map((item) => item.workId));
	for (const projection of missions.values()) {
		if (projection.state !== "current") {
			continue;
		}
		const execution = latestMissionExecution(latestExecutions, projection.mission.missionId);
		if (
			execution === undefined ||
			execution.status !== ExecutorStatus.running ||
			represented.has(execution.workId) ||
			hasBlockedAwaitingVerdict(archive, execution)
		) {
			continue;
		}
		let runtime: Awaited<ReturnType<ExecutionRuntimeProbe>>;
		try {
			runtime = await probeRuntime(execution.executionId);
		} catch {
			continue;
		}
		let conditionKind: string;
		let itemSummary: string;
		let actions: WorkAttentionAction[];
		if (runtime.kind === "idle") {
			conditionKind = "execution-idle";
			itemSummary = "Current worker is available; the current attempt can continue";
			actions = ["try-current-execution", "stop-current-execution", "view-attempts", "dismiss"];
		} else if (runtime.kind === "unreachable") {
			conditionKind = "runtime-unreachable";
			itemSummary = "Current worker could not be reached; the Mission can continue";
			actions = ["continue-current-mission", "view-attempts", "dismiss"];
		} else {
			continue;
		}
		const conditionId = attentionConditionId(
			conditionKind,
			execution.workId,
			projection.mission.missionId,
			execution.executionId,
		);
		if (dismissed.has(conditionId)) {
			continue;
		}
		work.push({
			conditionId,
			workId: execution.workId,
			title: workTitle(
				new Map(archive.listSubmissions().map((submission) => [submission.workId, submission.work.title])),
				execution.workId,
			),
			summary: itemSummary,
			actions,
			missionId: projection.mission.missionId,
			executionId: execution.executionId,
			...pullRequestAttentionFields(currentPullRequests.get(execution.workId)),
		});
		represented.add(execution.workId);
	}
	return { work, project: summary.project, activeWorkCount: summary.activeWorkCount };
}

function attentionConditionId(kind: string, ...parts: readonly string[]): string {
	return `attention-${createHash("sha256")
		.update([kind, ...parts].join("\u0000"))
		.digest("hex")}`;
}

function projectReviewRequests(
	archive: ArchiveSnapshot,
	missions: Map<string, MissionProjection>,
	titles: Map<string, string>,
	acceptedWorkIds: ReadonlySet<string>,
): KhalaAttentionItem[] {
	// The latest append-ordered Pull Request record per Work decides review
	// state: a later draft, closed, merged, or changes-requested record
	// suppresses an older reviewable record for the same Work.
	const items: KhalaAttentionItem[] = [];
	for (const pullRequest of latestPullRequestByWork(archive, missions).values()) {
		const item = reviewItemForPullRequest(pullRequest, missions, titles, acceptedWorkIds);
		if (item !== undefined) {
			items.push(item);
		}
	}
	return items;
}

function reviewItemForPullRequest(
	pullRequest: PullRequestRecord,
	missions: Map<string, MissionProjection>,
	titles: Map<string, string>,
	acceptedWorkIds: ReadonlySet<string>,
): KhalaAttentionItem | undefined {
	if (pullRequest.status !== "reviewable") {
		return;
	}
	if (acceptedWorkIds.has(pullRequest.workId)) {
		return;
	}
	const currentMission = missions.get(pullRequest.workId);
	if (currentMission === undefined) {
		return;
	}
	// The Conclave must finish the Mission (Finish Verdict) before handing a
	// reviewable Pull Request to the User.
	if (currentMission.state !== "finished") {
		return;
	}
	return {
		workId: pullRequest.workId,
		title: workTitle(titles, pullRequest.workId),
		detail: pullRequest.url ?? "ready for review",
	};
}

function projectStoppedWork(
	submissions: Map<string, KhalaWorkSubmission>,
	archive: ArchiveSnapshot,
	titles: Map<string, string>,
	evidence: StoppedWorkEvidence,
): Map<string, KhalaAttentionItem> {
	const stoppedWork = new Map<string, KhalaAttentionItem>();
	addRejectedSubmissions(stoppedWork, submissions, titles);
	addRejectedMissions(stoppedWork, archive, titles);
	addExhaustedRecoveries(stoppedWork, evidence.exhaustedWorkIds, titles);
	// A Work Outcome is terminal: accepted Work never surfaces as stopped,
	// regardless of which stopped category produced it.
	for (const workId of evidence.acceptedWorkIds) {
		stoppedWork.delete(workId);
	}
	return stoppedWork;
}

function addRejectedSubmissions(
	stoppedWork: Map<string, KhalaAttentionItem>,
	submissions: Map<string, KhalaWorkSubmission>,
	titles: Map<string, string>,
): void {
	for (const [workId, submission] of submissions) {
		if (submission.status === "rejected" && submission.rejectionReason !== undefined) {
			stoppedWork.set(workId, {
				workId,
				title: workTitle(titles, workId),
				detail: `Rejected by the Conclave: ${submission.rejectionReason}`,
			});
		}
	}
}

function addRejectedMissions(
	stoppedWork: Map<string, KhalaAttentionItem>,
	archive: ArchiveSnapshot,
	titles: Map<string, string>,
): void {
	for (const [workId, projection] of latestMissionByWork(archive)) {
		if (projection.state === "rejected" && !stoppedWork.has(workId)) {
			stoppedWork.set(workId, {
				workId,
				title: workTitle(titles, workId),
				detail: rejectedMissionDetail(projection),
			});
		}
	}
}

function rejectedMissionDetail(projection: MissionProjection): string {
	const verdict = projection.terminalVerdict;
	if (verdict === undefined) {
		return "Stopped after Conclave rejection";
	}
	return `Stopped after Conclave rejection: ${verdict.reason}`;
}

function addExhaustedRecoveries(
	stoppedWork: Map<string, KhalaAttentionItem>,
	exhaustedWorkIds: ReadonlySet<string>,
	titles: Map<string, string>,
): void {
	for (const workId of exhaustedWorkIds) {
		if (!stoppedWork.has(workId)) {
			stoppedWork.set(workId, {
				workId,
				title: workTitle(titles, workId),
				detail: "Conclave submission recovery for this Work was exhausted",
			});
		}
	}
}

function projectRecovery(
	archive: ArchiveSnapshot,
	exhaustedWorkIds: ReadonlySet<string>,
): KhalaRecoveryAttention | undefined {
	const modelRecovery = projectExecutorModelRecovery(archive);
	if (modelRecovery !== undefined) {
		return modelRecovery;
	}
	const wake = archive.latestUnresolvedConclaveWake();
	if (wake === undefined || wake.status !== "failed" || wake.recovery === undefined) {
		return;
	}
	// The Work already surfaces as stopped through its exhausted recovery
	// record; a failed wake for the same Work would only duplicate ineffective
	// /khala-recover guidance.
	if (exhaustedWorkIds.has(wake.workId)) {
		return;
	}
	return {
		kind: recoveryKind(wake.recovery),
		message: wake.failure ?? "The Conclave wake failed.",
	};
}

function projectExecutorModelRecovery(archive: ArchiveSnapshot): KhalaRecoveryAttention | undefined {
	const missions = latestMissionByWork(archive);
	const latestExecutions = latestExecutionsById(archive);
	for (const projection of missions.values()) {
		if (projection.state !== "current") {
			continue;
		}
		const execution = latestMissionExecution(latestExecutions, projection.mission.missionId);
		if (execution?.status === ExecutorStatus.failed && execution.failureCategory === "model-unavailable") {
			return {
				kind: "executor-model",
				message: execution.failureMessage ?? "The configured Executor model is unavailable.",
				workId: execution.workId,
				missionId: projection.mission.missionId,
				executionId: execution.executionId,
			};
		}
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy strict return analysis for no matching recovery.
	return undefined;
}

function recoveryKind(recovery: ConclaveWakeRecovery): "setup" | "recreate" {
	if (recovery === "setup") {
		return "setup";
	}
	return "recreate";
}

function countActiveWork(
	submissions: Map<string, KhalaWorkSubmission>,
	acceptedWorkIds: ReadonlySet<string>,
	stoppedWorkIds: ReadonlySet<string>,
): number {
	let count = 0;
	for (const [workId, submission] of submissions) {
		if (
			(submission.status === WorkSubmissionStatus.queued ||
				submission.status === WorkSubmissionStatus.reviewing ||
				submission.status === WorkSubmissionStatus.admitted) &&
			!acceptedWorkIds.has(workId) &&
			!stoppedWorkIds.has(workId)
		) {
			count += 1;
		}
	}
	return count;
}

function submissionIndex(archive: ArchiveSnapshot): {
	latest: Map<string, KhalaWorkSubmission>;
	titles: Map<string, string>;
} {
	const latest = new Map<string, KhalaWorkSubmission>();
	const titles = new Map<string, string>();
	for (const submission of archive.listSubmissions()) {
		latest.set(submission.workId, submission);
		titles.set(submission.workId, submission.work.title);
	}
	return { latest, titles };
}

// The Work's current Mission is the latest non-superseded Mission.
function latestMissionByWork(archive: ArchiveSnapshot): Map<string, MissionProjection> {
	const latest = new Map<string, MissionProjection>();
	for (const projection of archive.missions()) {
		if (projection.state !== "superseded") {
			latest.set(projection.mission.workId, projection);
		}
	}
	return latest;
}

// PR records outside the Work's current Mission are ignored before the
// append-order collapse, so an old Mission's later PR update cannot suppress
// the current Mission's review action.
function latestPullRequestByWork(
	archive: ArchiveSnapshot,
	missions: Map<string, MissionProjection>,
): Map<string, PullRequestRecord> {
	const latest = new Map<string, PullRequestRecord>();
	for (const pullRequest of archive.listPullRequests()) {
		const currentMission = missions.get(pullRequest.workId);
		if (currentMission !== undefined && currentMission.mission.missionId === pullRequest.missionId) {
			latest.set(pullRequest.workId, pullRequest);
		}
	}
	return latest;
}

function acceptedWorkIdsFrom(archive: ArchiveSnapshot): Set<string> {
	const accepted = new Set<string>();
	for (const record of archive.listRecords()) {
		if (record.type === "work-outcome" && isWorkOutcomeRecord(record.payload)) {
			accepted.add(record.workId);
		}
	}
	return accepted;
}

function exhaustedRecoveryWorkIds(archive: ArchiveSnapshot): Set<string> {
	const exhausted = new Set<string>();
	for (const record of archive.listRecords()) {
		if (
			record.type === "conclave-recovery" &&
			isConclaveRecoveryRecord(record.payload) &&
			record.payload.status === ConclaveRecoveryStatus.exhausted
		) {
			exhausted.add(record.workId);
		}
	}
	return exhausted;
}

function pullRequestReference(pullRequest: PullRequestRecord): string | undefined {
	if (pullRequest.number !== undefined) {
		return `#${pullRequest.number}`;
	}
	const match = pullRequest.url?.match(PULL_REQUEST_REFERENCE_PATTERN);
	return match?.[1] === undefined ? undefined : `#${match[1]}`;
}

function pullRequestAttentionFields(
	pullRequest: PullRequestRecord | undefined,
): Pick<WorkAttention, "pullRequestUrl" | "pullRequestReference"> {
	if (pullRequest === undefined) {
		return {};
	}
	const reference = pullRequestReference(pullRequest);
	return {
		...(pullRequest.url === undefined ? {} : { pullRequestUrl: pullRequest.url }),
		...(reference === undefined ? {} : { pullRequestReference: reference }),
	};
}

function workTitle(titles: Map<string, string>, workId: string): string {
	return titles.get(workId) ?? `Work ${workId}`;
}

export type {
	ExecutionRuntimeProbe,
	KhalaAttentionItem,
	KhalaAttentionSummary,
	KhalaAttentionView,
	KhalaRecoveryAttention,
	ProjectAttention,
	ProjectAttentionAction,
	WorkAttention,
	WorkAttentionAction,
};
export { buildKhalaAttention, resolveKhalaAttention };
