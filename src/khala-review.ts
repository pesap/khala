// biome-ignore-all lint/style/noExcessiveLinesPerFile: Review and Outcome records share one authoritative lifecycle boundary.
// biome-ignore-all lint/style/noTernary: Optional external VCS evidence is projected without inventing absent fields.
// biome-ignore-all lint/style/noNestedTernary: Optional field fallback projections remain explicit and side-effect free.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Review transitions validate role, VCS, and acceptance fences together.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Review transitions keep their durable field mapping atomic.
// biome-ignore-all lint/suspicious/noShadow: Outcome and Pull Request projections intentionally use domain-local names.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import {
	listPullRequestRecords,
	listWorkOutcomeRecords,
	readMandate,
	readMission,
} from "./khala-archive-projections.js";
import { readExecutorRecord } from "./khala-executor-registry.js";
import type { PullRequestRecord, PullRequestStatusValue, WorkOutcomeRecord } from "./khala-model.js";
import { KhalaRole, readSessionRole } from "./khala-role.js";

const PULL_REQUEST_REVIEW_PARAMETERS = Type.Object({
	workId: Type.String(),
	executionId: Type.String(),
	missionId: Type.String(),
	status: Type.Union([
		Type.Literal("reviewable"),
		Type.Literal("draft"),
		Type.Literal("open"),
		Type.Literal("changes-requested"),
		Type.Literal("merged"),
		Type.Literal("closed"),
	]),
	url: Type.Optional(Type.String()),
	number: Type.Optional(Type.Integer({ minimum: 1 })),
	sourceBranch: Type.Optional(Type.String()),
	targetBranch: Type.Optional(Type.String()),
	headCommit: Type.Optional(Type.String()),
	mergeCommit: Type.Optional(Type.String()),
	changedFiles: Type.Array(Type.String()),
	diffSummary: Type.String(),
	validationResults: Type.Array(Type.String()),
	reviewFeedback: Type.Array(Type.String()),
	unresolvedGaps: Type.Array(Type.String()),
	reviewer: Type.Optional(Type.String()),
});
const WORK_OUTCOME_PARAMETERS = Type.Object({
	workId: Type.String(),
	pullRequestId: Type.String(),
	acceptingActor: Type.String(),
});
type PullRequestReviewInput = Static<typeof PULL_REQUEST_REVIEW_PARAMETERS>;
type WorkOutcomeInput = Static<typeof WORK_OUTCOME_PARAMETERS>;
type ReviewWake = (projectPath: string, workId: string, projectTrusted?: boolean) => Promise<void> | void;

type ReviewPreparationInput = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	workId: string;
	missionId: string;
	executionId: string;
	sourceBranch: string;
	targetBranch: string;
	planningCommit: string;
	url?: string;
	number?: number;
	previousPullRequestUrl?: string;
}>;

type ReviewFinalizationInput = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	executionId: string;
	headCommit: string;
	summary: string;
	evidence: readonly string[];
	url?: string;
	number?: number;
}>;

function registerKhalaReview(
	pi: ExtensionAPI,
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean,
	wake: ReviewWake,
): void {
	pi.registerTool({
		name: "khala_record_pull_request_review",
		label: "Record Pull Request Review",
		description: "Record structured Maintainer review, merge, or closure evidence for a Khala Pull Request.",
		promptSnippet: "Record Pull Request review or merge evidence",
		executionMode: "sequential",
		parameters: PULL_REQUEST_REVIEW_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordPullRequestReview(params, context, wake);
		},
	});
	pi.registerTool({
		name: "khala_record_work_outcome",
		label: "Record Khala Work Outcome",
		description: "Record the Conclave's durable acceptance statement after a verified Pull Request merge.",
		promptSnippet: "Record the accepted Khala Work Outcome",
		executionMode: "sequential",
		parameters: WORK_OUTCOME_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordWorkOutcome(params, context, isDedicatedConclaveSession);
		},
	});
}

function recordReviewPreparation(input: ReviewPreparationInput): PullRequestRecord {
	const existing = latestPullRequest(input.projectPath, input.executionId, input.projectTrusted);
	if (existing !== undefined) {
		return existing;
	}
	const record: PullRequestRecord = {
		pullRequestId: nanoid(),
		workId: input.workId,
		missionId: input.missionId,
		executionId: input.executionId,
		status: "draft",
		...(input.url === undefined ? {} : { url: input.url, number: input.number }),
		...(input.previousPullRequestUrl === undefined ? {} : { relatedPullRequestUrl: input.previousPullRequestUrl }),
		...(input.url === undefined ? {} : { remoteConfirmedAt: new Date().toISOString() }),
		sourceBranch: input.sourceBranch,
		targetBranch: input.targetBranch,
		planningCommit: input.planningCommit,
		changedFiles: [],
		diffSummary: "",
		validationResults: [],
		reviewFeedback: [],
		unresolvedGaps: [],
		recordedAt: new Date().toISOString(),
	};
	appendPullRequestRecord(input.projectPath, record, input.projectTrusted);
	return record;
}

function markPullRequestReviewable(input: {
	projectPath: string;
	projectTrusted: boolean;
	workId: string;
	missionId: string;
	executionId: string;
}): PullRequestRecord {
	const existing = latestPullRequest(input.projectPath, input.executionId, input.projectTrusted);
	if (existing !== undefined) {
		if (
			existing.status === "merged" ||
			existing.status === "closed" ||
			existing.status === "reviewable" ||
			existing.status === "open" ||
			existing.status === "changes-requested"
		) {
			return existing;
		}
		const reviewable = { ...existing, status: "reviewable" as const, recordedAt: new Date().toISOString() };
		appendPullRequestRecord(input.projectPath, reviewable, input.projectTrusted);
		return reviewable;
	}
	const prepared = recordReviewPreparation({
		...input,
		sourceBranch: "",
		targetBranch: "",
		planningCommit: "",
	});
	const reviewable = { ...prepared, status: "reviewable" as const, recordedAt: new Date().toISOString() };
	appendPullRequestRecord(input.projectPath, reviewable, input.projectTrusted);
	return reviewable;
}

function recordReviewFinalization(input: ReviewFinalizationInput): PullRequestRecord | undefined {
	const existing = latestPullRequest(input.projectPath, input.executionId, input.projectTrusted);
	if (existing === undefined) {
		return;
	}
	const next: PullRequestRecord = {
		...existing,
		...(input.url === undefined ? {} : { url: input.url, remoteConfirmedAt: new Date().toISOString() }),
		...(input.number === undefined ? {} : { number: input.number }),
		headCommit: input.headCommit,
		diffSummary: input.summary,
		validationResults: input.evidence,
		recordedAt: new Date().toISOString(),
	};
	appendPullRequestRecord(input.projectPath, next, input.projectTrusted);
	return next;
}

function recordPullRequestReview(input: PullRequestReviewInput, context: ExtensionContext, wake: ReviewWake) {
	if (readSessionRole(context) !== KhalaRole.maintainer) {
		throw new Error("Only a Maintainer session may record Pull Request review or merge evidence.");
	}
	const status = input.status as PullRequestStatusValue;
	if (
		input.workId.trim().length === 0 ||
		input.executionId.trim().length === 0 ||
		input.missionId.trim().length === 0
	) {
		throw new Error("Pull Request review requires Work, Execution, and Mission identifiers.");
	}
	const reviewFeedback = normalizeArray(input.reviewFeedback);
	const validationResults = normalizeArray(input.validationResults);
	if (status === "merged" && (input.mergeCommit === undefined || input.mergeCommit.trim().length === 0)) {
		throw new Error("A merged Pull Request requires a merge commit.");
	}
	if (status === "merged" && validationResults.length === 0) {
		throw new Error("A merged Pull Request requires validation evidence.");
	}
	if (status === "merged" && (input.headCommit === undefined || input.headCommit.trim().length === 0)) {
		throw new Error("A merged Pull Request requires the final head commit.");
	}
	if (status === "changes-requested" && reviewFeedback.length === 0) {
		throw new Error("Changes-requested review requires review feedback.");
	}
	const projectTrusted = isProjectTrusted(context);
	const execution = readExecutorRecord(context.cwd, input.executionId, projectTrusted);
	if (execution === undefined || execution.workId !== input.workId) {
		throw new Error("The Pull Request review requires an existing Execution for the same Work.");
	}
	const mission = readMission(context.cwd, input.missionId, projectTrusted);
	if (mission === undefined || mission.workId !== input.workId) {
		throw new Error("The Pull Request review requires an existing Mission for the same Work.");
	}
	if (
		execution.kind === "observer" ||
		execution.purpose?.kind !== "mission" ||
		execution.purpose.missionId !== input.missionId
	) {
		throw new Error("The Pull Request review requires a matching Executor Mission execution.");
	}
	const existing = latestPullRequest(context.cwd, input.executionId, projectTrusted);
	if (existing !== undefined && (existing.workId !== input.workId || existing.missionId !== input.missionId)) {
		throw new Error("The Pull Request review does not match the registered Work Mission.");
	}
	let reviewUrl = input.url?.trim();
	if ((reviewUrl === undefined || reviewUrl.length === 0) && existing?.url !== undefined) {
		reviewUrl = existing.url.trim();
	}
	if (status === "merged" && (reviewUrl === undefined || reviewUrl.length === 0)) {
		throw new Error("A merged Pull Request requires a Pull Request URL.");
	}
	if (existing?.status === "merged" && status !== "merged") {
		throw new Error("A merged Pull Request cannot transition back to review or closure.");
	}
	if (existing?.status === "closed" && status !== "closed") {
		throw new Error("A closed Pull Request cannot transition back to an active review state.");
	}
	if (
		existing?.status === "merged" &&
		input.mergeCommit !== undefined &&
		existing.mergeCommit !== undefined &&
		input.mergeCommit.trim() !== existing.mergeCommit
	) {
		throw new Error("A merged Pull Request cannot change its merge commit.");
	}
	if (
		existing?.status === "merged" &&
		input.headCommit !== undefined &&
		existing.headCommit !== undefined &&
		input.headCommit.trim() !== existing.headCommit
	) {
		throw new Error("A merged Pull Request cannot change its final head commit.");
	}
	const record: PullRequestRecord = {
		pullRequestId: existing?.pullRequestId ?? nanoid(),
		workId: input.workId,
		missionId: input.missionId,
		executionId: input.executionId,
		status,
		...(input.url?.trim() ? { url: input.url.trim() } : existing?.url === undefined ? {} : { url: existing.url }),
		...(input.number === undefined
			? existing?.number === undefined
				? {}
				: { number: existing.number }
			: { number: input.number }),
		...(input.sourceBranch?.trim()
			? { sourceBranch: input.sourceBranch.trim() }
			: existing?.sourceBranch === undefined
				? {}
				: { sourceBranch: existing.sourceBranch }),
		...(input.targetBranch?.trim()
			? { targetBranch: input.targetBranch.trim() }
			: existing?.targetBranch === undefined
				? {}
				: { targetBranch: existing.targetBranch }),
		...(input.headCommit?.trim()
			? { headCommit: input.headCommit.trim() }
			: existing?.headCommit === undefined
				? {}
				: { headCommit: existing.headCommit }),
		...(existing?.planningCommit === undefined ? {} : { planningCommit: existing.planningCommit }),
		...(existing?.relatedPullRequestUrl === undefined ? {} : { relatedPullRequestUrl: existing.relatedPullRequestUrl }),
		...(existing?.remoteConfirmedAt === undefined ? {} : { remoteConfirmedAt: existing.remoteConfirmedAt }),
		...(input.mergeCommit?.trim()
			? { mergeCommit: input.mergeCommit.trim() }
			: existing?.mergeCommit === undefined
				? {}
				: { mergeCommit: existing.mergeCommit }),
		changedFiles: normalizeArray(input.changedFiles),
		diffSummary: input.diffSummary.trim(),
		validationResults,
		reviewFeedback,
		unresolvedGaps: normalizeArray(input.unresolvedGaps),
		...(input.reviewer?.trim() ? { reviewer: input.reviewer.trim() } : {}),
		recordedAt: new Date().toISOString(),
	};
	appendPullRequestRecord(context.cwd, record, projectTrusted);
	if (status === "changes-requested" || status === "merged" || status === "closed") {
		Promise.resolve(wake(context.cwd, input.workId, projectTrusted)).catch(() => undefined);
	}
	return Promise.resolve({
		content: [{ type: "text" as const, text: `Pull Request ${record.pullRequestId} recorded as ${record.status}.` }],
		details: record,
	});
}

function recordWorkOutcome(
	input: WorkOutcomeInput,
	context: ExtensionContext,
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean,
) {
	if (!isDedicatedConclaveSession(context)) {
		throw new Error("Only the dedicated project Conclave may record a Work Outcome.");
	}
	const acceptingActor = input.acceptingActor.trim();
	if (acceptingActor.length === 0) {
		throw new Error("A Work Outcome requires an accepting actor.");
	}
	const projectTrusted = isProjectTrusted(context);
	const pullRequest = latestPullRequestById(context.cwd, input.pullRequestId, projectTrusted);
	if (pullRequest === undefined || pullRequest.workId !== input.workId || pullRequest.status !== "merged") {
		throw new Error("A Work Outcome requires a merged Pull Request for the same Work.");
	}
	if (pullRequest.mergeCommit === undefined || pullRequest.headCommit === undefined) {
		throw new Error("The merged Pull Request is missing head or merge commit evidence.");
	}
	const execution = readExecutorRecord(context.cwd, pullRequest.executionId, projectTrusted);
	if (
		execution === undefined ||
		execution.workId !== input.workId ||
		execution.status !== "finished" ||
		execution.purpose?.kind !== "mission" ||
		execution.purpose.missionId !== pullRequest.missionId
	) {
		throw new Error("The merged Pull Request requires a finished matching Execution.");
	}
	const mission = readMission(context.cwd, pullRequest.missionId, projectTrusted);
	if (mission === undefined || mission.workId !== input.workId) {
		throw new Error("The merged Pull Request Mission is unavailable.");
	}
	const mandate = readMandate(context.cwd, mission.mandateId, projectTrusted);
	if (mandate === undefined || mandate.workId !== input.workId) {
		throw new Error("The merged Pull Request Mandate is unavailable.");
	}
	const existing = listWorkOutcomeRecords(context.cwd, projectTrusted).find(
		(outcome) => outcome.workId === input.workId,
	);
	if (existing !== undefined) {
		if (existing.pullRequestId !== input.pullRequestId) {
			throw new Error(`Work ${input.workId} already has an accepted Work Outcome.`);
		}
		return Promise.resolve({
			content: [{ type: "text" as const, text: `Work Outcome ${existing.outcomeId} already exists.` }],
			details: existing,
		});
	}
	const outcome: WorkOutcomeRecord = {
		outcomeId: nanoid(),
		workId: input.workId,
		mandateId: mandate.mandateId,
		missionId: pullRequest.missionId,
		executionId: pullRequest.executionId,
		pullRequestId: pullRequest.pullRequestId,
		...(pullRequest.url === undefined ? {} : { pullRequestUrl: pullRequest.url }),
		...(pullRequest.number === undefined ? {} : { pullRequestNumber: pullRequest.number }),
		...(pullRequest.sourceBranch === undefined ? {} : { sourceBranch: pullRequest.sourceBranch }),
		...(pullRequest.targetBranch === undefined ? {} : { targetBranch: pullRequest.targetBranch }),
		finalHeadCommit: pullRequest.headCommit,
		mergeCommit: pullRequest.mergeCommit,
		changedFiles: pullRequest.changedFiles,
		diffSummary: pullRequest.diffSummary,
		validationResults: pullRequest.validationResults,
		reviewFeedback: pullRequest.reviewFeedback,
		unresolvedGaps: pullRequest.unresolvedGaps,
		acceptingActor,
		acceptedAt: new Date().toISOString(),
	};
	const persistedOutcome = withArchiveLock(context.cwd, projectTrusted, () => {
		const existingOutcome = listWorkOutcomeRecords(context.cwd, projectTrusted).find(
			(candidate) => candidate.workId === input.workId,
		);
		if (existingOutcome !== undefined) {
			if (existingOutcome.pullRequestId !== input.pullRequestId) {
				throw new Error(`Work ${input.workId} already has an accepted Work Outcome.`);
			}
			return existingOutcome;
		}
		appendArchiveRecord(
			context.cwd,
			{
				schemaVersion: 2,
				type: "work-outcome",
				workId: outcome.workId,
				executionId: outcome.executionId,
				payload: outcome,
			},
			projectTrusted,
		);
		return outcome;
	});
	if (persistedOutcome.outcomeId !== outcome.outcomeId) {
		return Promise.resolve({
			content: [{ type: "text" as const, text: `Work Outcome ${persistedOutcome.outcomeId} already exists.` }],
			details: persistedOutcome,
		});
	}
	return Promise.resolve({
		content: [{ type: "text" as const, text: `Work Outcome ${outcome.outcomeId} recorded.` }],
		details: outcome,
	});
}

function appendPullRequestRecord(projectPath: string, record: PullRequestRecord, projectTrusted: boolean): void {
	withArchiveLock(projectPath, projectTrusted, () => {
		appendArchiveRecord(
			projectPath,
			{
				schemaVersion: 2,
				type: "pull-request",
				workId: record.workId,
				executionId: record.executionId,
				payload: record,
			},
			projectTrusted,
		);
	});
}

function latestPullRequestForMission(
	projectPath: string,
	missionId: string,
	projectTrusted: boolean,
): PullRequestRecord | undefined {
	let latest: PullRequestRecord | undefined;
	for (const record of listPullRequestRecords(projectPath, projectTrusted)) {
		if (record.missionId === missionId) {
			latest = record;
		}
	}
	return latest;
}

function latestPullRequest(
	projectPath: string,
	executionId: string,
	projectTrusted: boolean,
): PullRequestRecord | undefined {
	let latest: PullRequestRecord | undefined;
	for (const record of listPullRequestRecords(projectPath, projectTrusted)) {
		if (record.executionId === executionId) {
			latest = record;
		}
	}
	return latest;
}

function latestPullRequestById(
	projectPath: string,
	pullRequestId: string,
	projectTrusted: boolean,
): PullRequestRecord | undefined {
	let latest: PullRequestRecord | undefined;
	for (const record of listPullRequestRecords(projectPath, projectTrusted)) {
		if (record.pullRequestId === pullRequestId) {
			latest = record;
		}
	}
	return latest;
}

function normalizeArray(values: readonly string[]): string[] {
	return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

export type { PullRequestReviewInput, ReviewFinalizationInput, ReviewPreparationInput, WorkOutcomeInput };
export {
	appendPullRequestRecord,
	latestPullRequest,
	latestPullRequestForMission,
	markPullRequestReviewable,
	recordPullRequestReview,
	recordReviewFinalization,
	recordReviewPreparation,
	recordWorkOutcome,
	registerKhalaReview,
};
