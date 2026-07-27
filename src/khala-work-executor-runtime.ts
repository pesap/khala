import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { readMandate } from "./khala-archive-projections.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { type ExecutorRuntimeUpdate, updateExecutorRecord } from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	KhalaWorkEntryStatus,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
} from "./khala-model.js";
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
	return dependencies.createExecutorStarter(context)({
		projectPath: context.cwd,
		workId,
		executionId,
		name: submission.work.title,
		executorName,
		mission: formatExecutorPlan(submission.work, attemptNumber, learning, {
			workId,
			mandateId: mandate.mandateId,
			mandateRevision: mandate.revision,
			missionId: mission.missionId,
		}),
		systemPrompt: dependencies.executorSystemPrompt,
		missionId: mission.missionId,
		mandateId: mandate.mandateId,
		participantId,
		onSandboxCreated: (sandbox, launcherName) =>
			updateExecutorRecord(
				context.cwd,
				executionId,
				{ sandboxPath: sandbox.path, launcher: launcherName },
				projectTrusted,
			),
	});
}

export { completeExecutorLaunch, startExecutor };
