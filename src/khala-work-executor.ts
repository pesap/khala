// biome-ignore-all lint/style/noExcessiveLinesPerFile: Launch preparation and runtime cleanup share one transaction boundary.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Launch preparation validates durable Mission and Execution fences together.
// biome-ignore-all lint/style/noContinue: Peer override validation scans independent Coordination records.
// biome-ignore-all lint/style/useDestructuring: Runtime identity reads remain explicit at the launch fence.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { withArchiveLock } from "./khala-archive.js";
import {
	listSignalRecords,
	projectCoordinations,
	readCurrentMission,
	type readMandate,
} from "./khala-archive-projections.js";
import { formatAttachedCleanupDiagnostic, formatError } from "./khala-error.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "./khala-executor-registry.js";
import {
	type ExecutorRecord,
	ExecutorStatus,
	KhalaWorkLaunchStatus,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
	type UpstreamExecutionBase,
} from "./khala-model.js";
import { randomProtossName } from "./khala-names.js";
import type { KhalaWorkDependencies, KhalaWorkLaunchResult } from "./khala-work.js";
import { completeExecutorLaunch, startExecutor } from "./khala-work-executor-runtime.js";
import {
	ensureMission,
	launchedResult,
	launchHold,
	prepareExecutionLaunch,
	rejectedWorkLaunch,
} from "./khala-work-helpers.js";

async function launchFromConclave(
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
	await dependencies.pollBeforeDependentLaunch?.(context.cwd, projectTrusted, workId);
	const runtime = prepareExecutorRuntime(workId, context, dependencies, prepared);
	if ("content" in runtime) {
		return Promise.resolve(runtime);
	}
	if (runtime.held !== undefined) {
		return Promise.resolve({
			content: [
				{
					type: "text",
					text: `Mission ${runtime.mission.missionId} is held by Coordination ${runtime.held.coordinationId}.`,
				},
			],
			details: {
				status: KhalaWorkLaunchStatus.held,
				workId,
				missionId: runtime.mission.missionId,
				coordinationId: runtime.held.coordinationId,
				reason: runtime.held.reason,
			},
		});
	}
	const { executionId, mission, participantId, executorName, attemptNumber } = runtime;
	if (executionId === undefined || executorName === undefined || attemptNumber === undefined) {
		throw new Error("Executor launch preparation returned incomplete runtime identity.");
	}
	const launchInput = {
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
	};
	if (runtime.upstreamBase === undefined) {
		return runExecutorLaunch(launchInput);
	}
	return runExecutorLaunch({ ...launchInput, upstreamBase: runtime.upstreamBase });
}

type PreparedExecutionLaunch = Extract<ReturnType<typeof prepareExecutionLaunch>, { projectTrusted: boolean }>;

type PreparedExecutorRuntime = Readonly<{
	executionId?: string;
	mission: MissionRecord;
	participantId: string;
	executorName?: string;
	attemptNumber?: number;
	upstreamBase?: UpstreamExecutionBase;
	held?: { coordinationId: string; reason: string };
}>;

function prepareExecutorRuntime(
	workId: string,
	context: ExtensionContext,
	_dependencies: KhalaWorkDependencies,
	prepared: PreparedExecutionLaunch,
): PreparedExecutorRuntime | KhalaWorkLaunchResult {
	const { projectTrusted, currentProjection, mandate } = prepared;
	const mission = ensureMission({
		projectPath: context.cwd,
		projectTrusted,
		workId,
		mandate,
		existingMission: currentProjection?.mission,
	});
	const participantId = mission.assignedParticipantId;
	const executionId = nanoid();
	let upstreamBase = releasedUpstreamBase(context.cwd, workId, mission.missionId, projectTrusted);
	let held: { coordinationId: string; reason: string } | undefined;
	let existingResult: KhalaWorkLaunchResult | undefined;
	withArchiveLock(context.cwd, projectTrusted, () => {
		const initialHold = launchHold(context.cwd, workId, mission.missionId, projectTrusted);
		if (initialHold !== undefined) {
			held = {
				coordinationId: initialHold.coordination.coordinationId,
				reason: initialHold.coordination.latest.reason,
			};
			return;
		}
		assertPeerOverrideLaunchReady(context.cwd, workId, mission.missionId, projectTrusted);
		existingResult = existingMissionExecutionResult(workId, mission, context.cwd, projectTrusted);
	});
	if (held !== undefined) {
		return { mission, participantId, held };
	}
	if (existingResult !== undefined) {
		return existingResult;
	}

	const executorName = randomProtossName(
		new Set(listExecutorRecords(context.cwd, projectTrusted).map((execution) => execution.executorName)),
	);
	const attemptNumber =
		listExecutorRecords(context.cwd, projectTrusted).filter((execution) => execution.workId === workId).length + 1;
	const startingRecordBase: Omit<ExecutorRecord, "status" | "startedAt"> = {
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
	};
	let startingRecord: Omit<ExecutorRecord, "status" | "startedAt"> = startingRecordBase;
	withArchiveLock(context.cwd, projectTrusted, () => {
		const current = readCurrentMission(context.cwd, workId, projectTrusted);
		if (current?.state !== "current" || current.mission.missionId !== mission.missionId) {
			throw new Error("The Mission changed before its Executor could be materialized.");
		}
		const currentHold = launchHold(context.cwd, workId, mission.missionId, projectTrusted);
		if (currentHold !== undefined) {
			held = {
				coordinationId: currentHold.coordination.coordinationId,
				reason: currentHold.coordination.latest.reason,
			};
			return;
		}
		assertPeerOverrideLaunchReady(context.cwd, workId, mission.missionId, projectTrusted);
		upstreamBase = releasedUpstreamBase(context.cwd, workId, mission.missionId, projectTrusted);
		if (upstreamBase !== undefined) {
			startingRecord = { ...startingRecordBase, upstreamBase };
		}
		const starting = createExecutorRecord(startingRecord, ExecutorStatus.starting);
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

	if (held !== undefined) {
		return { mission, participantId, held };
	}
	if (upstreamBase === undefined) {
		return { executionId, mission, participantId, executorName, attemptNumber };
	}
	return { executionId, mission, participantId, executorName, attemptNumber, upstreamBase };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Peer override launch fencing keeps every stopped-state branch explicit.
function assertPeerOverrideLaunchReady(
	projectPath: string,
	workId: string,
	missionId: string,
	projectTrusted: boolean,
): void {
	for (const coordination of projectCoordinations(projectPath, projectTrusted)) {
		const latest = coordination.latest;
		if (
			!coordination.active ||
			latest.phase !== "override" ||
			latest.relation !== "peer-conflict" ||
			latest.selectedWorkId !== workId ||
			latest.selectedMissionId !== missionId
		) {
			continue;
		}
		const decision = coordination.records.find((record) => record.phase === "decision");
		let formerExecutionId = decision?.selectedExecutionId;
		if (formerExecutionId === undefined && decision !== undefined) {
			if (decision.selectedWorkId === decision.workId) {
				formerExecutionId = decision.executionId;
			} else {
				formerExecutionId = decision.relatedExecutionId;
			}
		}
		if (formerExecutionId === undefined) {
			continue;
		}
		const formerExecution = readExecutorRecord(projectPath, formerExecutionId, projectTrusted);
		if (formerExecution === undefined) {
			throw new Error("Peer override cannot launch until the former selected Execution is observable as stopped.");
		}
		if (formerExecution.status !== ExecutorStatus.starting && formerExecution.status !== ExecutorStatus.running) {
			continue;
		}
		const blocked = listSignalRecords(projectPath, projectTrusted)
			.filter(
				(signal) =>
					signal.executionId === formerExecution.executionId &&
					signal.missionId === formerExecution.missionId &&
					signal.kind === "blocked",
			)
			.at(-1);
		if (blocked === undefined) {
			throw new Error("Peer override cannot launch while the former selected Execution is starting or running.");
		}
	}
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
	const latestSignal = listSignalRecords(projectPath, projectTrusted)
		.filter(
			(signal) =>
				signal.executionId === existing.executionId &&
				signal.missionId === existing.missionId &&
				signal.participantId === existing.participantId,
		)
		.at(-1);
	if (latestSignal?.kind === "blocked") {
		throw new Error(
			`Execution ${existing.executionId} is blocked; issue the durable Verdict and launch its successor instead of reusing it.`,
		);
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
		destination: existing.sandboxPath,
		sandboxPath: existing.sandboxPath,
	});
}

function releasedUpstreamBase(
	projectPath: string,
	workId: string,
	missionId: string,
	projectTrusted: boolean,
): UpstreamExecutionBase | undefined {
	const coordination = projectCoordinations(projectPath, projectTrusted).find((candidate) => {
		const { latest } = candidate;
		return (
			latest.phase === "release" &&
			latest.workId === workId &&
			latest.missionId === missionId &&
			latest.relation === "dependency" &&
			latest.upstreamExecutionId !== undefined &&
			latest.upstreamHead !== undefined &&
			latest.remote !== undefined &&
			latest.branch !== undefined
		);
	});
	const latest = coordination?.latest;
	if (
		latest === undefined ||
		latest.upstreamExecutionId === undefined ||
		latest.upstreamHead === undefined ||
		latest.remote === undefined ||
		latest.branch === undefined ||
		latest.upstreamWorkId === undefined ||
		latest.upstreamMissionId === undefined
	) {
		return;
	}
	return {
		kind: "upstream-execution",
		workId: latest.upstreamWorkId,
		missionId: latest.upstreamMissionId,
		executionId: latest.upstreamExecutionId,
		remote: latest.remote,
		branch: latest.branch,
		headCommit: latest.upstreamHead,
	};
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
	upstreamBase?: UpstreamExecutionBase;
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
		upstreamBase,
	} = input;
	let launched: Awaited<ReturnType<typeof startExecutor>> | undefined;
	try {
		const startInput = {
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
		};
		if (upstreamBase === undefined) {
			launched = await startExecutor(startInput);
		} else {
			launched = await startExecutor({ ...startInput, upstreamBase });
		}
		return await completeExecutorLaunch({
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
		const current = readExecutorRecord(context.cwd, executionId, projectTrusted);
		let cleanupMessage = formatAttachedCleanupDiagnostic(error);
		if (current?.status === ExecutorStatus.starting || current?.status === ExecutorStatus.running) {
			try {
				await launched?.cleanup?.();
			} catch (cleanupFailure) {
				cleanupMessage += ` Cleanup also failed: ${formatError(cleanupFailure)}`;
			}
			updateExecutorRecord(context.cwd, executionId, { status: ExecutorStatus.failed }, projectTrusted);
		}
		return rejectedWorkLaunch(`Executor launch failed: ${formatError(error)}${cleanupMessage}`);
	}
}

export { launchFromConclave };
