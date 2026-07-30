import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { withArchiveLock } from "./khala-archive.js";
import { readCurrentMission, type readMandate } from "./khala-archive-projections.js";
import { formatError } from "./khala-error.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	updateExecutorRecord,
	writeExecutorRecord,
} from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	KhalaWorkLaunchStatus,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
} from "./khala-model.js";
import { randomProtossName } from "./khala-names.js";
import type { KhalaWorkDependencies, KhalaWorkLaunchResult } from "./khala-work.js";
import { completeExecutorLaunch, startExecutor } from "./khala-work-executor-runtime.js";
import {
	ensureMission,
	executorParticipantId,
	launchedResult,
	prepareExecutionLaunch,
	rejectedWorkLaunch,
} from "./khala-work-helpers.js";

function launchFromConclave(
	pi: ExtensionAPI,
	workId: string,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): Promise<KhalaWorkLaunchResult> {
	const prepared = prepareExecutionLaunch(workId, context, dependencies);
	if (!("projectTrusted" in prepared)) {
		return Promise.resolve(prepared);
	}
	const { projectTrusted, submission, mandate, learning } = prepared;
	const runtime = prepareExecutorRuntime(workId, context, dependencies, prepared);
	if (!("executionId" in runtime)) {
		return Promise.resolve(runtime);
	}
	const { executionId, mission, participantId, executorName, attemptNumber } = runtime;
	return runExecutorLaunch({
		pi,
		workId,
		context,
		dependencies,
		projectTrusted,
		submission,
		mandate,
		learning,
		executionId,
		mission,
		participantId,
		executorName,
		attemptNumber,
	});
}

type PreparedExecutionLaunch = Extract<ReturnType<typeof prepareExecutionLaunch>, { projectTrusted: boolean }>;

type PreparedExecutorRuntime = Readonly<{
	executionId: string;
	mission: MissionRecord;
	participantId: string;
	executorName: string;
	attemptNumber: number;
}>;

function prepareExecutorRuntime(
	workId: string,
	context: ExtensionContext,
	_dependencies: KhalaWorkDependencies,
	prepared: PreparedExecutionLaunch,
): PreparedExecutorRuntime | KhalaWorkLaunchResult {
	const { projectTrusted, currentProjection, mandate } = prepared;
	const executionId = nanoid();
	const proposedParticipantId = executorParticipantId(executionId);
	const mission = ensureMission({
		projectPath: context.cwd,
		projectTrusted,
		workId,
		mandate,
		existingMission: currentProjection?.mission,
		assignedParticipantId: proposedParticipantId,
	});
	const participantId = mission.assignedParticipantId;
	const existingResult = existingMissionExecutionResult(workId, mission, context.cwd, projectTrusted);
	if (existingResult !== undefined) {
		return existingResult;
	}

	const executorName = randomProtossName(
		new Set(listExecutorRecords(context.cwd, projectTrusted).map((execution) => execution.executorName)),
	);
	const attemptNumber =
		listExecutorRecords(context.cwd, projectTrusted).filter((execution) => execution.workId === workId).length + 1;
	const starting = createExecutorRecord(
		{
			executionId,
			workId,
			executorName,
			kind: "executor",
			participantId,
			purpose: { kind: "mission", missionId: mission.missionId },
			missionId: mission.missionId,
			projectPath: context.cwd,
			sandboxPath: "",
			launcher: "pending",
		},
		ExecutorStatus.starting,
	);
	withArchiveLock(context.cwd, projectTrusted, () => {
		const current = readCurrentMission(context.cwd, workId, projectTrusted);
		if (current?.state !== "current" || current.mission.missionId !== mission.missionId) {
			throw new Error("The Mission changed before its Executor could be materialized.");
		}
		const competing = listExecutorRecords(context.cwd, projectTrusted).find(
			(execution) =>
				execution.purpose?.kind === "mission" &&
				execution.purpose.missionId === mission.missionId &&
				(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
		);
		if (competing !== undefined) {
			throw new Error(`Mission ${mission.missionId} is already being processed by Execution ${competing.executionId}.`);
		}
		writeExecutorRecord(starting, projectTrusted);
	});

	return { executionId, mission, participantId, executorName, attemptNumber };
}

function existingMissionExecutionResult(
	workId: string,
	mission: MissionRecord,
	projectPath: string,
	projectTrusted: boolean,
): KhalaWorkLaunchResult | undefined {
	const existing = listExecutorRecords(projectPath, projectTrusted).find(
		(execution) =>
			execution.purpose?.kind === "mission" &&
			execution.purpose.missionId === mission.missionId &&
			(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
	);
	if (existing === undefined) {
		return;
	}
	if (existing.status === ExecutorStatus.starting) {
		return {
			content: [
				{
					type: "text",
					text: [
						`Work ID: ${workId}`,
						`Mission ID: ${mission.missionId}`,
						`Execution ID: ${existing.executionId}`,
						"Status: launch already starting",
						`Executor: ${existing.executorName}`,
					].join("\n"),
				},
			],
			details: {
				status: KhalaWorkLaunchStatus.starting,
				workId,
				executionId: existing.executionId,
				missionId: mission.missionId,
				executorName: existing.executorName,
			},
		};
	}
	return launchedResult({
		workId,
		mission,
		executionId: existing.executionId,
		executorName: existing.executorName,
		destination: existing.target ?? existing.sandboxPath,
		sandboxPath: existing.sandboxPath,
	});
}

async function runExecutorLaunch(input: {
	pi: ExtensionAPI;
	workId: string;
	context: ExtensionContext;
	dependencies: KhalaWorkDependencies;
	projectTrusted: boolean;
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
		pi,
		workId,
		context,
		dependencies,
		projectTrusted,
		submission,
		mandate,
		learning,
		executionId,
		mission,
		participantId,
		executorName,
		attemptNumber,
	} = input;
	let launcherSucceeded = false;
	try {
		const launched = await startExecutor({
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
		});
		launcherSucceeded = true;
		return completeExecutorLaunch({
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
		});
	} catch (error) {
		if (!launcherSucceeded) {
			updateExecutorRecord(context.cwd, executionId, { status: ExecutorStatus.failed }, projectTrusted);
		}
		return rejectedWorkLaunch(`Executor launch failed: ${formatError(error)}`);
	}
}

export { launchFromConclave };
