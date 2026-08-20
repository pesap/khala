// The Khala attention projection is the read-only data model behind /khala and
// Alt+K. It derives actionable project state only from authoritative Archive
// evidence. Retryable/raw Execution failures stay out of this surface.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Attention projection keeps one read-only summary contract together.
import { type ArchiveSnapshot, createArchiveSnapshot, type MissionProjection } from "./khala-archive-projections.js";
import {
	ConclaveRecoveryStatus,
	type ConclaveWakeRecovery,
	ExecutorStatus,
	isConclaveRecoveryRecord,
	isWorkOutcomeRecord,
	type KhalaWorkSubmission,
	type PullRequestRecord,
	WorkSubmissionStatus,
} from "./khala-model.js";

type KhalaAttentionItem = Readonly<{ workId: string; title: string; detail: string }>;

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
	const summary: KhalaAttentionSummary = {
		condition: projectCondition(reviewRequested, stoppedWork, recovery),
		reviewRequested,
		stoppedWork: [...stoppedWork.values()],
		activeWorkCount: countActiveWork(submissions, acceptedWorkIds, new Set(stoppedWork.keys())),
	};
	if (recovery !== undefined) {
		summary.recovery = recovery;
	}
	return summary;
}

function projectCondition(
	reviewRequested: readonly KhalaAttentionItem[],
	stoppedWork: Map<string, KhalaAttentionItem>,
	recovery: KhalaRecoveryAttention | undefined,
): "action-required" | "working" {
	if (reviewRequested.length > 0 || stoppedWork.size > 0 || recovery !== undefined) {
		return "action-required";
	}
	return "working";
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
	// /khala-recreate guidance.
	if (exhaustedWorkIds.has(wake.workId)) {
		return;
	}
	return {
		kind: recoveryKind(wake.recovery),
		message: wake.failure ?? "The Conclave wake failed.",
	};
}

function projectExecutorModelRecovery(archive: ArchiveSnapshot): KhalaRecoveryAttention | undefined {
	const latest = new Map<string, ReturnType<ArchiveSnapshot["listExecutions"]>[number]>();
	for (const execution of archive.listExecutions()) {
		latest.set(execution.executionId, execution);
	}
	for (const execution of [...latest.values()].reverse()) {
		if (
			execution.kind !== "observer" &&
			execution.status === ExecutorStatus.failed &&
			execution.failureCategory === "model-unavailable" &&
			execution.missionId !== undefined
		) {
			return {
				kind: "executor-model",
				message: execution.failureMessage ?? "The configured Executor model is unavailable.",
				workId: execution.workId,
				missionId: execution.missionId,
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

function workTitle(titles: Map<string, string>, workId: string): string {
	return titles.get(workId) ?? `Work ${workId}`;
}

export type { KhalaAttentionItem, KhalaAttentionSummary, KhalaRecoveryAttention };
export { buildKhalaAttention };
