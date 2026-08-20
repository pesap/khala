// biome-ignore-all lint/style/noExcessiveLinesPerFile: Launch preparation and review handoff share one runtime boundary.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Launch preparation carries durable Mission, review, and sandbox callbacks together.
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import packageMetadata from "../package.json" with { type: "json" };

const COMMIT_CONVENTION_PATTERN = /^commit convention:\s*(.+)$/i;

import type { readMandate } from "./khala-archive-projections.js";
import { listVerdictRecords, projectCoordinations } from "./khala-archive-projections.js";
import { loadKhalaConfig } from "./khala-config.js";
import { resolveCoordination } from "./khala-coordination.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { formatBoundedDiagnostic } from "./khala-error.js";
import { updateExecutorRecord } from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	KhalaWorkEntryStatus,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
	type RetryHandoff,
	type UpstreamExecutionBase,
} from "./khala-model.js";
import { isModelUnavailableError } from "./khala-model-recovery.js";
import {
	latestPullRequest,
	latestPullRequestForMission,
	type ReviewPreparationInput,
	recordReviewPreparation,
} from "./khala-review.js";
import { registerSupervisedExecution } from "./khala-supervision.js";
import type { KhalaWorkDependencies, KhalaWorkLaunchResult } from "./khala-work.js";
import { formatExecutorPlan } from "./khala-work-format.js";
import { launchedResult } from "./khala-work-helpers.js";
import type { ReviewPreparation } from "./vcs.js";

function completeExecutorLaunch(input: {
	pi: ExtensionAPI;
	workId: string;
	context: ExtensionContext;
	dependencies: KhalaWorkDependencies;
	projectTrusted: boolean;
	submission: KhalaWorkSubmission;
	mandate: NonNullable<ReturnType<typeof readMandate>>;
	executionId: string;
	mission: MissionRecord;
	executorName: string;
	launched: { sandbox: { path: string } };
}): KhalaWorkLaunchResult {
	const { pi, workId, context, dependencies, projectTrusted, mandate, executionId, mission, executorName, launched } =
		input;
	updateExecutorRecord(context.cwd, executionId, { status: ExecutorStatus.running }, projectTrusted);
	const releasedCoordination = projectCoordinations(context.cwd, projectTrusted).find(
		(candidate) =>
			candidate.latest.phase === "release" &&
			candidate.latest.workId === workId &&
			candidate.latest.missionId === mission.missionId,
	);
	if (releasedCoordination !== undefined) {
		resolveCoordination({
			projectPath: context.cwd,
			projectTrusted,
			coordinationId: releasedCoordination.coordinationId,
			actionId: `coordination-resolution-${executionId}`,
			releasedExecutionId: executionId,
		});
	}
	const destination = launched.sandbox.path;
	dependencies.markSubmissionLaunched(context.cwd, workId, { sandboxPath: launched.sandbox.path }, projectTrusted);
	pi.appendEntry(KhalaEntryType.work, {
		status: KhalaWorkEntryStatus.launched,
		workId,
		executionId,
		title: mission.assignment.title,
		executorName,
		sandboxPath: launched.sandbox.path,
		missionId: mission.missionId,
	});
	return launchedResult({
		workId,
		mission,
		executionId,
		executorName,
		destination,
		sandboxPath: launched.sandbox.path,
		mandateId: mandate.mandateId,
	});
}

function startExecutor(input: {
	context: ExtensionContext;
	dependencies: KhalaWorkDependencies;
	projectTrusted: boolean;
	workId: string;
	submission: KhalaWorkSubmission;
	mandate: NonNullable<ReturnType<typeof readMandate>>;
	learning: readonly LearningRecord[];
	executionId: string;
	mission: MissionRecord;
	participantId: string;
	executorName: string;
	attemptNumber: number;
	upstreamBase?: UpstreamExecutionBase;
}) {
	const {
		context,
		dependencies,
		projectTrusted,
		workId,
		mandate,
		learning,
		executionId,
		mission,
		participantId,
		executorName,
		attemptNumber,
		upstreamBase,
	} = input;
	const config = loadKhalaConfig(context.cwd, projectTrusted);
	const targetBranch = config.pullRequestTargetBranch.trim();
	const retryVerdict = findRetryVerdict(context.cwd, mission.causedByVerdictId, projectTrusted);
	let previousReview: ReturnType<typeof latestPullRequest>;
	if (retryVerdict !== undefined) {
		previousReview = latestPullRequest(context.cwd, retryVerdict.executionId, projectTrusted);
	} else if (mission.predecessorMissionId !== undefined) {
		previousReview = latestPullRequestForMission(context.cwd, mission.predecessorMissionId, projectTrusted);
	}
	if (retryVerdict !== undefined && retryVerdict.retryHandoff === undefined) {
		throw new Error(`Retry Verdict ${retryVerdict.verdictId} is missing its durable retry handoff.`);
	}
	const reviewWorkflow: {
		publish: true;
		targetBranch?: string;
		supersedesPullRequestUrl?: string;
		commitConvention?: string;
		baseCommit?: string;
	} = {
		publish: true,
		commitConvention: resolveCommitConvention(mission.assignment.constraints, config.commitConvention),
	};
	let missionMessage = formatExecutorPlan(mission.assignment, attemptNumber, learning, {
		workId,
		mandateId: mandate.mandateId,
		mandateRevision: mandate.revision,
		missionId: mission.missionId,
	});
	if (retryVerdict?.retryHandoff !== undefined) {
		missionMessage += formatRetryHandoff(retryVerdict.retryHandoff, previousReview);
	} else if (previousReview !== undefined) {
		missionMessage += [
			"",
			"Prior Pull Request review handoff:",
			`Pull Request: ${previousReview.url ?? "not published"}`,
			`Status: ${previousReview.status}`,
			`Review feedback: ${previousReview.reviewFeedback.join("; ") || "none recorded"}`,
			`Validation results: ${previousReview.validationResults.join("; ") || "none recorded"}`,
		].join("\n");
	}
	if (targetBranch.length > 0) {
		missionMessage += [
			"",
			"Khala Pull Request configuration:",
			`Target branch: ${targetBranch}`,
			"Use this branch as the Pull Request base when creating the draft.",
		].join("\n");
	}
	if (targetBranch.length > 0) {
		reviewWorkflow.targetBranch = targetBranch;
	}
	if (upstreamBase !== undefined) {
		reviewWorkflow.baseCommit = upstreamBase.headCommit;
		missionMessage += [
			"",
			"Immutable upstream Execution base:",
			`Work: ${upstreamBase.workId}`,
			`Mission: ${upstreamBase.missionId}`,
			`Execution: ${upstreamBase.executionId}`,
			`Remote: ${upstreamBase.remote}`,
			`Branch: ${upstreamBase.branch}`,
			`Exact head commit: ${upstreamBase.headCommit}`,
			"Do not rebase this Execution in place.",
		].join("\n");
	}
	if (previousReview?.url !== undefined) {
		reviewWorkflow.supersedesPullRequestUrl = previousReview.url;
	}
	updateExecutorRecord(
		context.cwd,
		executionId,
		{
			promptIdentity: {
				packageVersion: packageMetadata.version,
				promptSha256: createHash("sha256").update(dependencies.executorSystemPrompt).digest("hex"),
			},
		},
		projectTrusted,
	);
	registerSupervisedExecution(context.cwd, projectTrusted, mission, executionId);
	return dependencies.createExecutorStarter(context)({
		projectPath: context.cwd,
		workId,
		executionId,
		name: mission.assignment.title,
		executorName,
		mission: missionMessage,
		systemPrompt: dependencies.executorSystemPrompt,
		missionId: mission.missionId,
		mandateId: mandate.mandateId,
		participantId,
		projectTrusted,
		kind: "executor",
		onRpcReady: ({ sessionId, sessionPath }) => {
			updateExecutorRecord(context.cwd, executionId, { piSessionId: sessionId, sessionPath }, projectTrusted);
		},
		onRpcFailure: (error) => {
			const failure: {
				status: typeof ExecutorStatus.failed;
				failureCategory?: "model-unavailable";
				failureMessage?: string;
			} = { status: ExecutorStatus.failed };
			if (isModelUnavailableError(error)) {
				failure.failureCategory = "model-unavailable";
				failure.failureMessage = formatBoundedDiagnostic(error);
			}
			updateExecutorRecord(context.cwd, executionId, failure, projectTrusted);
		},
		reviewWorkflow,
		onReviewPrepared: (preparation: ReviewPreparation) => {
			const reviewInput: {
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
				supersedesPullRequestUrl?: string;
			} = {
				projectPath: context.cwd,
				projectTrusted,
				workId,
				missionId: mission.missionId,
				executionId,
				sourceBranch: preparation.sourceBranch,
				targetBranch: preparation.targetBranch,
				planningCommit: preparation.planningCommit,
			};
			if (preparation.url !== undefined) {
				reviewInput.url = preparation.url;
			}
			if (preparation.number !== undefined) {
				reviewInput.number = preparation.number;
			}
			if (reviewWorkflow.supersedesPullRequestUrl !== undefined) {
				reviewInput.supersedesPullRequestUrl = reviewWorkflow.supersedesPullRequestUrl;
			}
			recordReviewPreparation(reviewInput as ReviewPreparationInput);
		},
		onSandboxCreated: (sandbox, launcherName) =>
			updateExecutorRecord(
				context.cwd,
				executionId,
				{ sandboxPath: sandbox.path, launcher: launcherName },
				projectTrusted,
			),
	});
}

function findRetryVerdict(projectPath: string, causedByVerdictId: string | undefined, projectTrusted: boolean) {
	if (causedByVerdictId === undefined) {
		return;
	}
	return listVerdictRecords(projectPath, projectTrusted).find((record) => record.verdictId === causedByVerdictId);
}

function formatRetryHandoff(handoff: RetryHandoff, previousReview: ReturnType<typeof latestPullRequest>): string {
	const formatItems = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
	let predecessorInstruction =
		"No predecessor Pull Request was recorded; create a new Pull Request without a Supersedes link.";
	if (previousReview?.url !== undefined) {
		let predecessorReference = previousReview.url;
		if (previousReview.number !== undefined) {
			predecessorReference = `#${previousReview.number}`;
		}
		predecessorInstruction = `Create the successor Pull Request, include \`Supersedes ${predecessorReference}\`, and do not close the predecessor manually.`;
	} else if (previousReview !== undefined) {
		predecessorInstruction =
			"A predecessor Pull Request record exists without a published URL; create the successor without inventing a Supersedes link and report the missing URL.";
	}
	return [
		"",
		"Retry Contract:",
		"Failed acceptance criteria:",
		formatItems(handoff.failedCriteria),
		"Completed work to preserve:",
		formatItems(handoff.completedWork),
		"Required changes:",
		formatItems(handoff.requiredChanges),
		"Non-goals:",
		formatItems(handoff.nonGoals),
		"Validation:",
		formatItems(handoff.validation),
		"Predecessor Pull Request:",
		`URL: ${previousReview?.url ?? "not published"}`,
		`Number: ${previousReview?.number ?? "not recorded"}`,
		`Status: ${previousReview?.status ?? "not recorded"}`,
		predecessorInstruction,
	].join("\n");
}

function resolveCommitConvention(constraints: readonly string[], configured: string): string {
	for (const constraint of constraints) {
		const match = COMMIT_CONVENTION_PATTERN.exec(constraint.trim());
		if (match?.[1] !== undefined && match[1].trim().length > 0) {
			return match[1].trim();
		}
	}
	return configured;
}

export { completeExecutorLaunch, formatRetryHandoff, resolveCommitConvention, startExecutor };
