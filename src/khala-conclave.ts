// biome-ignore-all lint/style/noExcessiveLinesPerFile: Conclave runtime wiring keeps lifecycle coordination in one module.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Recovery ordering remains one auditable runtime transaction.
// biome-ignore-all lint/performance/noAwaitInLoops: Fail-safe shutdown and durable outage closure preserve identity order.
// biome-ignore-all lint/style/noTernary: Optional identity fields stay explicit at lifecycle boundaries.
// biome-ignore-all lint/complexity/useOptionalChain: Recovery availability is intentionally fail-closed.
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import packageMetadata from "../package.json" with { type: "json" };
import { buildPiArguments, disposeHeadlessRuntimes, getHeadlessRuntime, recoverHeadlessExecutor } from "./executor.js";
import { listArchiveRecords } from "./khala-archive.js";
import { listSignalRecords } from "./khala-archive-projections.js";
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import type { ConclaveStorage } from "./khala-conclave-storage.js";
import { createFileConclaveStorage } from "./khala-conclave-storage-file.js";
import { loadKhalaConfig } from "./khala-config.js";
import { formatError } from "./khala-error.js";
import { createConfiguredExecutorStarter, sendConfiguredExecutorMessage } from "./khala-executor.js";
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
	type LearningRecord,
	type MissionRecord,
	type SignalRecord,
	type VerdictRecord,
	type WorkSubmissionRequest,
} from "./khala-model.js";
import { randomProtossName } from "./khala-names.js";
import { resolvePackageRoot } from "./khala-package.js";
import { latestPullRequest, recordReviewPreparation } from "./khala-review.js";
import { readRolePrompt } from "./khala-role.js";
import {
	registerSupervisionController,
	SupervisionController,
	unregisterSupervisionController,
} from "./khala-supervision.js";
import {
	failExecutionAndCloseInterventions,
	mandatoryStopExecution,
	SupervisionOutageCoordinator,
	UpstreamRefPoller,
} from "./khala-supervision-recovery.js";
import { isSupportedThinkingLevel } from "./khala-thinking.js";
import { deliverVerdict as persistVerdictDelivery } from "./khala-verdict-delivery.js";
import { recoverTerminalExecutionStates } from "./khala-verdict-recovery.js";

type ConclaveWakeStatus = "woken" | "deferred" | "error";
const CONCLAVE_PARTICIPANT_HASH_LENGTH = 16;
const CONCLAVE_BASE_TOOL_ALLOWLIST = [
	"khala_read_archive",
	"khala_admit_work",
	"khala_launch_observer",
	"khala_launch_execution",
	"khala_verdict",
	"khala_record_work_outcome",
] as const;
const CONCLAVE_TOOL_ALLOWLIST = [
	"khala_read_archive",
	"khala_admit_work",
	"khala_launch_observer",
	"khala_launch_execution",
	"khala_verdict",
	"khala_record_work_outcome",
	"khala_steer_execution",
	"khala_coordinate_work",
	"khala_record_intervention_outcome",
] as const;
type ConclaveCoordinator = Readonly<{
	submit: (request: WorkSubmissionRequest & { projectTrusted?: boolean }) => Promise<{
		archivePath: string;
		wakeStatus: ConclaveWakeStatus;
		wakeError?: string;
	}>;
	resume: (projectPath: string, projectTrusted?: boolean) => void;
	wakeSignal: (projectPath: string, signal: SignalRecord, projectTrusted?: boolean) => Promise<void>;
	wakeLearning: (projectPath: string, learning: LearningRecord, projectTrusted?: boolean) => Promise<void>;
	wakeReview: (projectPath: string, workId: string, projectTrusted?: boolean) => Promise<void>;
	deliverVerdict: (projectPath: string, verdict: VerdictRecord, projectTrusted?: boolean) => Promise<void>;
	getSubmission: ConclaveStorage["getSubmission"];
	getPendingSubmission: ConclaveStorage["getPendingSubmission"];
	claimSubmission: ConclaveStorage["claimSubmission"];
	markSubmissionReviewing: ConclaveStorage["markSubmissionReviewing"];
	markSubmissionQueued: ConclaveStorage["markSubmissionQueued"];
	requeueSubmission: ConclaveStorage["requeueSubmission"];
	markSubmissionLaunched: ConclaveStorage["markSubmissionLaunched"];
	pollBeforeDependentLaunch: (projectPath: string, projectTrusted?: boolean, workId?: string) => Promise<void>;
	getConclaveSessionPath: ConclaveStorage["getConclaveSessionPath"];
	getConclaveUserSessionPath: ConclaveStorage["getConclaveUserSessionPath"];
	ensureConclaveSession: (
		projectPath: string,
		userSessionPath?: string,
		projectTrusted?: boolean,
	) => string | undefined;
	dispose: () => Promise<void>;
}>;
interface ConclaveRuntime {
	projectPath: string;
	projectTrusted: boolean;
	session: AgentSession;
	wakeChain: Promise<void>;
	supervision: SupervisionController;
	isLaunchBlocked: (workId?: string) => boolean;
}
function createConclaveCoordinator(
	extensionPath: string,
	storage: ConclaveStorage = createFileConclaveStorage(),
): ConclaveCoordinator {
	const runtimes = new Map<string, Promise<ConclaveRuntime>>();
	let disposed = false;
	const submit = async (
		request: WorkSubmissionRequest & { projectTrusted?: boolean },
	): Promise<{
		archivePath: string;
		wakeStatus: ConclaveWakeStatus;
		wakeError?: string;
	}> => {
		const projectPath = resolve(request.projectPath);
		const queued = storage.submit({ ...request, projectPath });
		try {
			await wakeConclave({
				projectPath,
				projectTrusted: request.projectTrusted ?? false,
				workId: request.workId,
				archivePath: queued.archivePath,
				extensionPath,
				storage,
				runtimes,
				disposed: () => disposed,
			});
			return { ...queued, wakeStatus: "woken" };
		} catch (error) {
			return {
				...queued,
				wakeStatus: "error",
				wakeError: formatError(error),
			};
		}
	};
	const wakeSignal = (projectPath: string, signal: SignalRecord, projectTrusted = false): Promise<void> =>
		wakeConclave({
			projectPath: resolve(projectPath),
			projectTrusted,
			signal,
			extensionPath,
			storage,
			runtimes,
			disposed: () => disposed,
		});
	const wakeReview = (projectPath: string, workId: string, projectTrusted = false): Promise<void> =>
		wakeConclave({
			projectPath: resolve(projectPath),
			projectTrusted,
			workId,
			review: true,
			extensionPath,
			storage,
			runtimes,
			disposed: () => disposed,
		});
	const pollBeforeDependentLaunch = async (
		projectPath: string,
		projectTrusted = false,
		workId?: string,
	): Promise<void> => {
		const runtime = await getRuntime(resolve(projectPath), projectTrusted, extensionPath, storage, runtimes);
		await runtime.supervision.pollBeforeDependentLaunch();
		if (runtime.isLaunchBlocked(workId)) {
			throw new Error("Executor launch is blocked while relevant supervision recovery is open.");
		}
	};
	const deliverVerdict = async (projectPath: string, verdict: VerdictRecord, projectTrusted = false): Promise<void> => {
		const resolvedProjectPath = resolve(projectPath);
		const execution = readExecutorRecord(resolvedProjectPath, verdict.executionId, projectTrusted);
		await persistVerdictDelivery(resolvedProjectPath, verdict, projectTrusted, execution, (executor, message) =>
			sendConfiguredExecutorMessage(executor, message),
		);
	};
	const wakeLearning = (projectPath: string, learning: LearningRecord, projectTrusted = false): Promise<void> => {
		storage.markSubmissionQueued(resolve(projectPath), learning.workId, learning.executionId, projectTrusted);
		return wakeConclave({
			projectPath: resolve(projectPath),
			projectTrusted,
			learning,
			extensionPath,
			storage,
			runtimes,
			disposed: () => disposed,
		});
	};
	const resume = (projectPath: string, projectTrusted = false): void => {
		const resolvedProjectPath = resolve(projectPath);
		recoverTerminalExecutionStates(resolvedProjectPath, projectTrusted);
		for (const submission of storage.getPendingSubmissions(resolvedProjectPath, projectTrusted)) {
			scheduleConclaveWake({
				projectPath: resolvedProjectPath,
				projectTrusted,
				workId: submission.workId,
				archivePath: submission.archivePath,
				extensionPath,
				storage,
				runtimes,
				disposed: () => disposed,
			});
		}
	};

	const ensureConclaveSession = (
		projectPath: string,
		userSessionPath?: string,
		projectTrusted = false,
	): string | undefined =>
		storage.loadConclaveSession(resolve(projectPath), userSessionPath, projectTrusted).getSessionFile();

	return {
		submit,
		resume,
		wakeSignal,
		wakeLearning,
		wakeReview,
		deliverVerdict,
		getSubmission: storage.getSubmission,
		getPendingSubmission: storage.getPendingSubmission,
		claimSubmission: storage.claimSubmission,
		markSubmissionReviewing: storage.markSubmissionReviewing,
		markSubmissionQueued: storage.markSubmissionQueued,
		requeueSubmission: storage.requeueSubmission,
		markSubmissionLaunched: storage.markSubmissionLaunched,
		pollBeforeDependentLaunch,
		getConclaveSessionPath: storage.getConclaveSessionPath,
		getConclaveUserSessionPath: storage.getConclaveUserSessionPath,
		ensureConclaveSession,
		dispose: async () => {
			disposed = true;
			const runtimesToDispose = [...runtimes.values()];
			runtimes.clear();
			await disposeHeadlessRuntimes();
			await Promise.all(
				runtimesToDispose.map((runtimePromise) =>
					runtimePromise.then(
						(runtime) => {
							runtime.supervision.dispose();
							unregisterSupervisionController(runtime.projectPath, runtime.projectTrusted);
							runtime.session.dispose();
						},
						() => undefined,
					),
				),
			);
		},
	};
}

interface WakeRequest {
	projectPath: string;
	projectTrusted: boolean;
	workId?: string;
	archivePath?: string;
	signal?: SignalRecord;
	learning?: LearningRecord;
	review?: boolean;
	extensionPath: string;
	storage: ConclaveStorage;
	runtimes: Map<string, Promise<ConclaveRuntime>>;
	disposed?: () => boolean;
}

async function wakeConclave(request: WakeRequest): Promise<void> {
	if (request.disposed?.() === true) {
		throw new Error("The Khala Conclave coordinator has been disposed; run /khala-recreate to recover it.");
	}
	const runtime = await getRuntime(
		request.projectPath,
		request.projectTrusted,
		request.extensionPath,
		request.storage,
		request.runtimes,
	);
	const wake = enqueueConclaveWake(runtime, async () => {
		let prompt: string;
		if (request.learning !== undefined) {
			prompt = [
				"A Khala Observer recorded new learning.",
				`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
				`The learning concerns Work ${request.learning.workId}, observation ${request.learning.executionId}.`,
				"Check whether this learning is relevant and whether equivalent learning already exists in the Archive.",
				"If it is sufficient, call khala_admit_work, then call khala_launch_execution; otherwise do not launch the Executor yet.",
			].join("\n");
		} else if (request.review === true) {
			prompt = [
				"A User Pull Request review event has arrived.",
				`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
				`The review concerns Work ${request.workId}.`,
				"If changes were requested, preserve the review evidence and launch the successor Mission. If the Pull Request was merged, verify the merge evidence and record the Work Outcome through khala_record_work_outcome.",
			].join("\n");
		} else if (request.signal === undefined) {
			prompt = [
				"A new Work Submission is waiting for this Project Conclave.",
				`Read the authoritative Archive at ${request.archivePath}.`,
				`Process exactly submission ${request.workId}.`,
				"Validate it against the current Work and Mission rules before acting.",
				"If the Work has no context, first check the Archive for relevant learning.",
				"If no sufficient learning exists, call khala_launch_observer with the queued workId.",
				"If the Work is valid and has sufficient context or learning, call khala_admit_work, then call khala_launch_execution with mode materialize before comparing concurrent Work.",
				"Read every current Mission and active Execution as structured Archive facts before launch. Compare objective, context, scope, acceptance, constraints, plan, validation, named modules, APIs, contracts, and generated artifacts. Use khala_coordinate_work for dependency or peer conflict; independent Work requires no coordination record. Only then call khala_launch_execution with mode launch.",
				"If the authoritative submission is already admitted, skip admission and recover or launch its current Mission; if it is reviewing, wait for the current Observer attempt.",
				"If it is invalid or stale, do not launch an agent; record the reason in your response.",
			].join("\n");
		} else {
			prompt = [
				"A new Executor Signal has arrived.",
				`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
				`The Signal concerns Work ${request.signal.workId}, execution ${request.signal.executionId}.`,
				"Evaluate the evidence and issue the appropriate durable Verdict through khala_verdict.",
				"Before any Retry launch, compare the successor Mission with all current Missions and active Coordinations; enforce any held dependency and never create an Executor until release conditions are verified.",
			].join("\n");
		}
		await runtime.session.prompt(prompt);
	});
	try {
		await wake;
	} catch (error) {
		const runtimeForError = await getExistingRuntime(request.projectPath, request.projectTrusted, request.runtimes);
		if (runtimeForError !== undefined) {
			runtimeForError.session.sessionManager.appendCustomEntry("khala-conclave-error", {
				workId: request.workId,
				error: formatError(error),
			});
		}
		throw error;
	}
}

// biome-ignore lint/complexity/useMaxParams: Runtime initialization receives the isolated project services explicitly.
function getRuntime(
	projectPath: string,
	projectTrusted: boolean,
	extensionPath: string,
	storage: ConclaveStorage,
	runtimes: Map<string, Promise<ConclaveRuntime>>,
): Promise<ConclaveRuntime> {
	const key = getRuntimeKey(projectPath, projectTrusted);
	const existing = runtimes.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const initialization = initializeRuntime(projectPath, projectTrusted, extensionPath, storage);
	let trackedInitialization: Promise<ConclaveRuntime>;
	trackedInitialization = initialization.catch((error: unknown) => {
		if (runtimes.get(key) === trackedInitialization) {
			runtimes.delete(key);
		}
		throw error;
	});
	runtimes.set(key, trackedInitialization);
	return trackedInitialization;
}

async function getExistingRuntime(
	projectPath: string,
	projectTrusted: boolean,
	runtimes: Map<string, Promise<ConclaveRuntime>>,
): Promise<ConclaveRuntime | undefined> {
	const existing = runtimes.get(getRuntimeKey(projectPath, projectTrusted));
	if (existing === undefined) {
		return;
	}
	try {
		return await existing;
	} catch {
		// A failed runtime is unavailable to the recovery recorder.
		// biome-ignore lint/complexity/noUselessUndefined: Make the unavailable result explicit for strict return analysis.
		return undefined;
	}
}

function scheduleConclaveWake(request: WakeRequest): undefined {
	wakeConclave(request).catch(() => undefined);
}

function enqueueConclaveWake(runtime: ConclaveRuntime, operation: () => Promise<void>): Promise<void> {
	const wake = runtime.wakeChain.catch(() => undefined).then(operation);
	runtime.wakeChain = wake.catch(() => undefined);
	return wake;
}

function getRuntimeKey(projectPath: string, projectTrusted: boolean): string {
	let trustKey = "global";
	if (projectTrusted) {
		trustKey = "trusted";
	}
	return `${projectPath}\u0000${trustKey}`;
}

async function initializeRuntime(
	projectPath: string,
	projectTrusted: boolean,
	extensionPath: string,
	storage: ConclaveStorage,
): Promise<ConclaveRuntime> {
	const sessionManager = storage.loadConclaveSession(projectPath, undefined, projectTrusted);
	const config = loadKhalaConfig(projectPath, projectTrusted);
	const { conclaveThinking } = config;
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
		allowModelNetwork: false,
	});
	const model = resolveConfiguredModel(modelRuntime, config.conclaveModel);
	if (config.conclaveModel.length > 0 && model === undefined) {
		throw new Error(`Configured Conclave model is unavailable: ${config.conclaveModel}`);
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd: projectPath,
		agentDir: getAgentDir(),
		additionalExtensionPaths: [extensionPath],
		additionalSkillPaths: [join(resolvePackageRoot(dirname(fileURLToPath(import.meta.url))), "skills", "khala")],
	});
	// createAgentSession does not reload a caller-provided resource loader. The
	// reload is required to register Khala's custom launch and verdict tools.
	await resourceLoader.reload();
	const sessionOptions: CreateAgentSessionOptions = {
		cwd: projectPath,
		agentDir: getAgentDir(),
		modelRuntime,
		resourceLoader,
		sessionManager,
		// Keep this allowlist authoritative so the Conclave cannot acquire implementation tools.
		tools: [...CONCLAVE_TOOL_ALLOWLIST],
	};
	if (model !== undefined) {
		sessionOptions.model = model;
	}
	if (model !== undefined && conclaveThinking !== "" && isSupportedThinkingLevel(model, conclaveThinking)) {
		sessionOptions.thinkingLevel = conclaveThinking;
	}
	const { session } = await createAgentSession(sessionOptions);
	session.setActiveToolsByName([...CONCLAVE_TOOL_ALLOWLIST]);
	const activeSupervisedExecutions = (): ExecutorRecord[] =>
		listExecutorRecords(projectPath, projectTrusted).filter(
			(execution) =>
				execution.kind === "executor" &&
				(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
		);
	let poller: UpstreamRefPoller | undefined;
	let supervision: SupervisionController | undefined;
	type PendingRecoveryLaunch = Readonly<{
		workId: string;
		executionId: string;
		upstreamBase?: ExecutorRecord["upstreamBase"];
		launch: () => Promise<boolean>;
	}>;
	const pendingRecoveryLaunches: PendingRecoveryLaunch[] = [];
	const recoveryOutageAffects = (
		pending: PendingRecoveryLaunch,
		outageRecord: ReturnType<typeof outage.getOpen>[number],
	): boolean =>
		outageRecord.kind === "poll" &&
		(outageRecord.workIds.includes(pending.workId) ||
			outageRecord.executionIds.includes(pending.executionId) ||
			(pending.upstreamBase !== undefined &&
				outageRecord.pollScope !== undefined &&
				outageRecord.pollScope.base.workId === pending.upstreamBase.workId &&
				outageRecord.pollScope.base.missionId === pending.upstreamBase.missionId &&
				outageRecord.pollScope.base.executionId === pending.upstreamBase.executionId &&
				outageRecord.pollScope.base.remote === pending.upstreamBase.remote &&
				outageRecord.pollScope.base.branch === pending.upstreamBase.branch &&
				outageRecord.pollScope.base.headCommit === pending.upstreamBase.headCommit));
	const recoveryLaunchAvailable = (pending: PendingRecoveryLaunch): boolean =>
		!outage
			.getOpen()
			.some((outageRecord) => outageRecord.kind === "conclave-model" || recoveryOutageAffects(pending, outageRecord));
	const drainPendingRecoveries = async (): Promise<void> => {
		for (const pending of [...pendingRecoveryLaunches]) {
			if (recoveryLaunchAvailable(pending)) {
				const index = pendingRecoveryLaunches.indexOf(pending);
				if (index >= 0) {
					pendingRecoveryLaunches.splice(index, 1);
					if (!(await pending.launch())) {
						pendingRecoveryLaunches.push(pending);
					}
				}
			}
		}
	};
	const stopWithoutIntervention = async (executionId: string, reason: string): Promise<void> => {
		const runtime = getHeadlessRuntime(executionId);
		if (runtime === undefined) {
			throw new Error(`Execution ${executionId} has no live runtime for mandatory stop.`);
		}
		const execution = readExecutorRecord(projectPath, executionId, projectTrusted);
		if (execution?.missionId === undefined || execution.participantId === undefined) {
			throw new Error(`Execution ${executionId} lacks the identity required for mandatory stop.`);
		}
		const marker = `\\u0000KHALA_MANDATORY_STOP:${executionId}:`;
		await mandatoryStopExecution(runtime, {
			marker,
			message: `${reason} Do not modify, create, delete, or stage files. Submit exactly one current blocked khala_signal with nonempty evidence.`,
			getBaselineSignalIds: () => listSignalRecords(projectPath, projectTrusted).map((signal) => signal.signalId),
			validatePostSettlement: (baselineSignalIds) => {
				const baseline = new Set(baselineSignalIds);
				const signals = listArchiveRecords(projectPath, projectTrusted).filter(
					(record) =>
						record.type === "signal" &&
						typeof record.payload === "object" &&
						record.payload !== null &&
						!baseline.has((record.payload as { signalId: string }).signalId) &&
						record.executionId === executionId &&
						typeof record.payload === "object" &&
						record.payload !== null &&
						(record.payload as { workId?: unknown }).workId === execution.workId &&
						(record.payload as { missionId?: unknown }).missionId === execution.missionId &&
						(record.payload as { participantId?: unknown }).participantId === execution.participantId &&
						(record.payload as { kind?: unknown }).kind === "blocked" &&
						Array.isArray((record.payload as { evidence?: unknown }).evidence) &&
						(record.payload as { evidence: unknown[] }).evidence.length > 0,
				);
				return Promise.resolve(signals.length === 1);
			},
		});
	};
	const outage = new SupervisionOutageCoordinator({
		projectPath,
		session: {
			getEntries: () => session.sessionManager.getEntries(),
			appendCustomEntry: (customType, data) => session.sessionManager.appendCustomEntry(customType, data),
		},
		onRetry: async (current) => {
			if (current.kind === "poll") {
				const outcomes = await poller?.pollNow(current.pollScope);
				return outcomes !== undefined && outcomes.length === 1 && outcomes[0]?.status !== "failed";
			}
			try {
				await session.prompt(
					"Retry the bounded Conclave supervision check from the authoritative Archive. Do not change Mission authority.",
				);
				supervision?.resumeAfterOutage();
				return true;
			} catch {
				return false;
			}
		},
		onFailSafe: async (current) => {
			const executionIds =
				current.kind === "conclave-model"
					? listExecutorRecords(projectPath, projectTrusted)
							.filter(
								(execution) =>
									execution.kind === "executor" &&
									(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
							)
							.map((execution) => execution.executionId)
					: current.executionIds;
			for (const executionId of executionIds) {
				try {
					await stopWithoutIntervention(executionId, `${current.kind} supervision outage fail-safe.`);
				} catch {
					const runtime = getHeadlessRuntime(executionId);
					await failExecutionAndCloseInterventions(
						projectPath,
						executionId,
						projectTrusted,
						runtime === undefined ? undefined : () => runtime.closeProcess(),
					);
				}
			}
		},
	});
	poller = new UpstreamRefPoller({
		projectPath,
		projectTrusted,
		closeRuntime: async (executionId) => {
			await getHeadlessRuntime(executionId)?.closeProcess();
		},
		stopDependent: async (dependent) => {
			if (dependent.executionId === undefined) {
				return;
			}
			try {
				const existingRuntime = getHeadlessRuntime(dependent.executionId);
				if (existingRuntime?.isStopPending === true) {
					return;
				}
				await stopWithoutIntervention(dependent.executionId, "The exact upstream ref changed or disappeared.");
			} catch {
				const runtime = getHeadlessRuntime(dependent.executionId);
				await failExecutionAndCloseInterventions(
					projectPath,
					dependent.executionId,
					projectTrusted,
					runtime === undefined ? undefined : () => runtime.closeProcess(),
				);
			}
		},
		onFailure: async (failure) => {
			await outage.fail({
				kind: "poll",
				workIds: failure.dependents.map((dependent) => dependent.workId),
				missionIds: failure.dependents.map((dependent) => dependent.missionId),
				executionIds: failure.dependents.flatMap((dependent) =>
					dependent.executionId === undefined ? [] : [dependent.executionId],
				),
				error: failure.error,
				scope: failure.scope,
			});
		},
		onSuccess: async (base) => {
			for (const open of outage
				.getOpen()
				.filter(
					(candidate) =>
						candidate.kind === "poll" &&
						candidate.pollScope !== undefined &&
						candidate.pollScope.base.workId === base.workId &&
						candidate.pollScope.base.missionId === base.missionId &&
						candidate.pollScope.base.executionId === base.executionId &&
						candidate.pollScope.remote === base.remote &&
						candidate.pollScope.branch === base.branch &&
						candidate.pollScope.base.headCommit === base.headCommit,
				)) {
				await outage.close(open.outageId);
			}
			await drainPendingRecoveries();
		},
	});
	supervision = new SupervisionController({
		projectPath,
		projectTrusted,
		session,
		conclaveParticipantId: `conclave:${createHash("sha256").update(projectPath).digest("hex").slice(0, CONCLAVE_PARTICIPANT_HASH_LENGTH)}`,
		conclaveMaxCostUsdPerTurn: config.conclaveMaxCostUsdPerTurn,
		executorMaxCostUsdPerTurn: config.executorMaxCostUsdPerTurn,
		upstreamPoller: poller,
		recoverExecutor: (execution, mission) => {
			if (execution.piSessionId === undefined || execution.sessionPath === undefined) {
				throw new Error("Executor recovery lacks its persisted Pi session binding.");
			}
			const [command, ...commandArgs] = config.piCommand;
			return recoverHeadlessExecutor({
				executionId: execution.executionId,
				sessionId: execution.piSessionId,
				sessionPath: execution.sessionPath,
				cwd: execution.sandboxPath,
				model: config.executorModel,
				mission: `Resume immutable Mission ${mission.missionId} for Work ${mission.workId}.`,
				command,
				args: [
					...commandArgs,
					...buildPiArguments(
						{
							projectPath,
							workId: mission.workId,
							executionId: execution.executionId,
							name: mission.assignment.title,
							executorName: execution.executorName,
							mission: "",
							systemPrompt: readRolePrompt(resolvePackageRoot(dirname(fileURLToPath(import.meta.url))), "executor"),
							missionId: mission.missionId,
							participantId: execution.participantId as string,
							projectTrusted,
							kind: "executor",
						},
						config.executorThinking,
						false,
					),
				],
				onReady: ({ sessionId, sessionPath }) => {
					updateExecutorRecord(
						projectPath,
						execution.executionId,
						{ piSessionId: sessionId, sessionPath },
						projectTrusted,
					);
				},
				onRestart: (runtime) =>
					supervision?.handleRuntimeRestart(
						{ workId: mission.workId, missionId: mission.missionId, executionId: execution.executionId },
						runtime,
					),
				onEvent: (event, runtime) =>
					supervision?.handleRuntimeEvent(
						{ workId: mission.workId, missionId: mission.missionId, executionId: execution.executionId },
						event,
						runtime,
					),
				onFailure: (error) => {
					updateExecutorRecord(projectPath, execution.executionId, { status: ExecutorStatus.failed }, projectTrusted);
					throw error;
				},
			});
		},
		onModelFailure: async (_identity, error) => {
			await outage.fail({
				kind: "conclave-model",
				workIds: activeSupervisedExecutions().map((execution) => execution.workId),
				missionIds: activeSupervisedExecutions().flatMap((execution) =>
					execution.missionId === undefined ? [] : [execution.missionId],
				),
				executionIds: activeSupervisedExecutions().map((execution) => execution.executionId),
				error: error.message,
			});
		},
		onModelSuccess: async () => {
			for (const open of outage.getOpen().filter((candidate) => candidate.kind === "conclave-model")) {
				await outage.close(open.outageId);
			}
			await drainPendingRecoveries();
			supervision?.resumeAfterOutage();
		},
		onExecutorRecoveryFailure: async (execution, mission) => {
			const pending: PendingRecoveryLaunch = {
				workId: execution.workId,
				executionId: execution.executionId,
				...(execution.upstreamBase === undefined ? {} : { upstreamBase: execution.upstreamBase }),
				launch: () =>
					startFreshSameMissionExecution({
						projectPath,
						projectTrusted,
						failedExecution: execution,
						mission,
						executorModel: config.executorModel,
						executorSystemPrompt: readRolePrompt(
							resolvePackageRoot(dirname(fileURLToPath(import.meta.url))),
							"executor",
						),
						supervision,
						isSupervisionAvailable: () => recoveryLaunchAvailable(pending),
					}),
			};
			if (recoveryLaunchAvailable(pending)) {
				if (!(await pending.launch())) {
					pendingRecoveryLaunches.push(pending);
				}
			} else {
				pendingRecoveryLaunches.push(pending);
			}
		},
	});
	await outage.recover();
	registerSupervisionController(projectPath, projectTrusted, supervision);
	await supervision.recover();
	return {
		projectPath,
		projectTrusted,
		session,
		wakeChain: Promise.resolve(),
		supervision,
		isLaunchBlocked: (workId) =>
			outage
				.getOpen()
				.some(
					(candidate) =>
						candidate.kind === "conclave-model" || (workId !== undefined && candidate.workIds.includes(workId)),
				),
	};
}

async function startFreshSameMissionExecution(
	input: Readonly<{
		projectPath: string;
		projectTrusted: boolean;
		failedExecution: ExecutorRecord;
		mission: MissionRecord;
		executorModel: string;
		executorSystemPrompt: string;
		supervision: SupervisionController | undefined;
		isSupervisionAvailable?: () => boolean;
	}>,
): Promise<boolean> {
	if (input.supervision === undefined || input.executorModel.trim().length === 0) {
		return false;
	}
	if (input.isSupervisionAvailable?.() === false) {
		return false;
	}
	const { supervision } = input;
	const executionId = nanoid();
	const executorName = randomProtossName(
		new Set(listExecutorRecords(input.projectPath, input.projectTrusted).map((execution) => execution.executorName)),
	);
	const participantId = input.mission.assignedParticipantId;
	const recoveryConfig = loadKhalaConfig(input.projectPath, input.projectTrusted);
	const previousReview = latestPullRequest(input.projectPath, input.failedExecution.executionId, input.projectTrusted);
	const promptIdentity = {
		packageVersion: packageMetadata.version,
		promptSha256: createHash("sha256").update(input.executorSystemPrompt).digest("hex"),
	};
	writeExecutorRecord(
		createExecutorRecord(
			{
				executionId,
				workId: input.mission.workId,
				executorName,
				kind: "executor",
				participantId,
				purpose: { kind: "mission", missionId: input.mission.missionId },
				missionId: input.mission.missionId,
				projectPath: input.projectPath,
				sandboxPath: "",
				launcher: "pending",
				promptIdentity,
				...(input.failedExecution.upstreamBase === undefined
					? {}
					: { upstreamBase: input.failedExecution.upstreamBase }),
			},
			ExecutorStatus.starting,
		),
		input.projectTrusted,
	);
	input.supervision.registerExecution(input.mission, executionId);
	const starter = createConfiguredExecutorStarter({
		cwd: input.projectPath,
		isProjectTrusted: () => input.projectTrusted,
	});
	let launched: Awaited<ReturnType<typeof starter>> | undefined;
	try {
		launched = await starter({
			projectPath: input.projectPath,
			workId: input.mission.workId,
			executionId,
			name: input.mission.assignment.title,
			executorName,
			mission: `Recover the same immutable Mission.\\n${JSON.stringify(input.mission)}`,
			systemPrompt: input.executorSystemPrompt,
			missionId: input.mission.missionId,
			participantId,
			projectTrusted: input.projectTrusted,
			kind: "executor",
			reviewWorkflow: {
				publish: true,
				...(recoveryConfig.pullRequestTargetBranch.trim().length === 0
					? {}
					: { targetBranch: recoveryConfig.pullRequestTargetBranch }),
				...(input.failedExecution.upstreamBase === undefined
					? {}
					: { baseCommit: input.failedExecution.upstreamBase.headCommit }),
				...(previousReview?.url === undefined ? {} : { supersedesPullRequestUrl: previousReview.url }),
			},
			onReviewPrepared: (preparation) => {
				recordReviewPreparation({
					projectPath: input.projectPath,
					projectTrusted: input.projectTrusted,
					workId: input.mission.workId,
					missionId: input.mission.missionId,
					executionId,
					sourceBranch: preparation.sourceBranch,
					targetBranch: preparation.targetBranch,
					planningCommit: preparation.planningCommit,
					...(preparation.url === undefined ? {} : { url: preparation.url }),
					...(preparation.number === undefined ? {} : { number: preparation.number }),
					...(previousReview?.url === undefined ? {} : { supersedesPullRequestUrl: previousReview.url }),
				});
			},
			onSandboxCreated: (sandbox, launcherName) =>
				updateExecutorRecord(
					input.projectPath,
					executionId,
					{ sandboxPath: sandbox.path, launcher: launcherName },
					input.projectTrusted,
				),
			onRpcReady: ({ sessionId, sessionPath }) => {
				updateExecutorRecord(
					input.projectPath,
					executionId,
					{ piSessionId: sessionId, sessionPath },
					input.projectTrusted,
				);
			},
			onRpcFailure: () => {
				updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.failed }, input.projectTrusted);
				supervision.closeRuntimeOwner(executionId).catch(() => undefined);
			},
		});
		if (launched.cleanup !== undefined) {
			input.supervision.registerRuntimeOwner(executionId, launched.cleanup);
		}
		if (input.isSupervisionAvailable?.() === false) {
			await input.supervision.closeRuntimeOwner(executionId);
			updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.failed }, input.projectTrusted);
			return false;
		}
		updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.running }, input.projectTrusted);
		return true;
	} catch {
		try {
			await launched?.cleanup?.();
		} catch {
			// The failed Execution remains authoritative even when cleanup is unavailable.
		}
		updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.failed }, input.projectTrusted);
		return false;
	}
}

function resolveConfiguredModel(modelRuntime: ModelRuntime, modelId: string) {
	if (modelId.length === 0) {
		return;
	}
	const separator = modelId.indexOf("/");
	if (separator <= 0 || separator === modelId.length - 1) {
		return;
	}
	return modelRuntime.getModel(modelId.slice(0, separator), modelId.slice(separator + 1));
}

export type { ConclaveCoordinator };
export { CONCLAVE_BASE_TOOL_ALLOWLIST, CONCLAVE_TOOL_ALLOWLIST, createConclaveCoordinator, enqueueConclaveWake };
