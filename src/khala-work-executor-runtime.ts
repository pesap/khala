// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Launch preparation carries durable Mission, review, and sandbox callbacks together.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMIT_CONVENTION_PATTERN = /^commit convention:\s*(.+)$/i;

import type { readMandate } from "./khala-archive-projections.js";
import { loadKhalaConfig } from "./khala-config.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { type ExecutorRuntimeUpdate, updateExecutorRecord } from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	KhalaWorkEntryStatus,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
} from "./khala-model.js";
import { latestPullRequestForMission, type ReviewPreparationInput, recordReviewPreparation } from "./khala-review.js";
import type { KhalaWorkDependencies, KhalaWorkLaunchResult } from "./khala-work.js";
import { formatExecutorPlan } from "./khala-work-format.js";
import { launchedResult } from "./khala-work-helpers.js";

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
	launched: { target?: string; sandbox: { path: string } };
}): KhalaWorkLaunchResult {
	const {
		pi,
		workId,
		context,
		dependencies,
		projectTrusted,
		submission,
		mandate,
		executionId,
		mission,
		executorName,
		launched,
	} = input;
	let runtimeUpdate: ExecutorRuntimeUpdate = { status: ExecutorStatus.running };
	if (launched.target !== undefined) {
		runtimeUpdate = { ...runtimeUpdate, target: launched.target };
	}
	updateExecutorRecord(context.cwd, executionId, runtimeUpdate, projectTrusted);
	const destination = launched.target ?? launched.sandbox.path;
	dependencies.markSubmissionLaunched(
		context.cwd,
		workId,
		{ target: launched.target, sandboxPath: launched.sandbox.path },
		projectTrusted,
	);
	pi.appendEntry(KhalaEntryType.work, {
		status: KhalaWorkEntryStatus.launched,
		workId,
		executionId,
		title: submission.work.title,
		executorName,
		sandboxPath: launched.sandbox.path,
		target: launched.target,
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
}) {
	const {
		context,
		dependencies,
		projectTrusted,
		workId,
		submission,
		mandate,
		learning,
		executionId,
		mission,
		participantId,
		executorName,
		attemptNumber,
	} = input;
	const config = loadKhalaConfig(context.cwd, projectTrusted);
	const targetBranch = config.pullRequestTargetBranch.trim();
	let previousReview: ReturnType<typeof latestPullRequestForMission>;
	if (mission.predecessorMissionId !== undefined) {
		previousReview = latestPullRequestForMission(context.cwd, mission.predecessorMissionId, projectTrusted);
	}
	const reviewWorkflow: {
		publish: boolean;
		targetBranch?: string;
		previousPullRequestUrl?: string;
		commitConvention?: string;
	} = {
		publish: config.publishExecutorBranches,
		commitConvention: resolveCommitConvention(submission.work.constraints, config.commitConvention),
	};
	let missionMessage = formatExecutorPlan(submission.work, attemptNumber, learning, {
		workId,
		mandateId: mandate.mandateId,
		mandateRevision: mandate.revision,
		missionId: mission.missionId,
	});
	if (previousReview !== undefined) {
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
	if (previousReview?.url !== undefined) {
		reviewWorkflow.previousPullRequestUrl = previousReview.url;
	}
	return dependencies.createExecutorStarter(context)({
		projectPath: context.cwd,
		workId,
		executionId,
		name: submission.work.title,
		executorName,
		mission: missionMessage,
		systemPrompt: dependencies.executorSystemPrompt,
		missionId: mission.missionId,
		mandateId: mandate.mandateId,
		participantId,
		projectTrusted,
		reviewWorkflow,
		onReviewPrepared: (preparation) => {
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
				previousPullRequestUrl?: string;
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
			if (reviewWorkflow.previousPullRequestUrl !== undefined) {
				reviewInput.previousPullRequestUrl = reviewWorkflow.previousPullRequestUrl;
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

function resolveCommitConvention(constraints: readonly string[], configured: string): string {
	for (const constraint of constraints) {
		const match = COMMIT_CONVENTION_PATTERN.exec(constraint.trim());
		if (match?.[1] !== undefined && match[1].trim().length > 0) {
			return match[1].trim();
		}
	}
	return configured;
}

export { completeExecutorLaunch, resolveCommitConvention, startExecutor };
