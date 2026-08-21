// biome-ignore-all lint/style/noExcessiveLinesPerFile: Conclave runtime wiring keeps lifecycle coordination in one module.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Recovery ordering remains one auditable runtime transaction.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Recovery selection preserves exact Mission and model fences.
// biome-ignore-all lint/performance/noAwaitInLoops: Fail-safe shutdown and durable outage closure preserve identity order.
// biome-ignore-all lint/style/noTernary: Optional identity fields stay explicit at lifecycle boundaries.
// biome-ignore-all lint/complexity/useOptionalChain: Recovery availability is intentionally fail-closed.
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
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
import type { ExecutionRuntimeState } from "./executor-rpc.js";
import { listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	activeCoordinationHolds,
	isUserPriorityEnforced,
	listSignalRecords,
	pendingUserPriorities,
	pendingUserPriorityEnforcements,
	readCurrentMission,
	readUserPriority,
} from "./khala-archive-projections.js";
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import type { ConclaveStorage, SubmissionRecoveryClaim, SubmissionRecoveryOutcome } from "./khala-conclave-storage.js";
import { createFileConclaveStorage } from "./khala-conclave-storage-file.js";
import { KhalaConfigError, loadKhalaConfig } from "./khala-config.js";
import { formatBoundedDiagnostic, formatError } from "./khala-error.js";
import { createConfiguredExecutorStarter, sendConfiguredExecutorMessage } from "./khala-executor.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "./khala-executor-registry.js";
import {
	CONCLAVE_RECOVERY_CLAIM_LEASE_MS,
	type ConclaveWakeRecovery,
	type ExecutorRecord,
	ExecutorStatus,
	isMissionExecutorRecord,
	type KhalaWorkSubmission,
	type LearningRecord,
	type MissionRecord,
	type SignalRecord,
	type VerdictRecord,
	type WorkSubmissionRequest,
} from "./khala-model.js";
import {
	isModelUnavailableError,
	markUserExecutorModelRecoveryApplied,
	selectedUserExecutorModelRecovery,
} from "./khala-model-recovery.js";
import { randomProtossName } from "./khala-names.js";
import { resolvePackageRoot } from "./khala-package.js";
import { latestPullRequest, recordReviewPreparation } from "./khala-review.js";
import { readRolePrompt } from "./khala-role.js";
import {
	listEligibleFailedExecutorRecoveries,
	registerSupervisionController,
	SUPERVISION_ENTRY_TYPES,
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
import {
	executeUserWorkerAction,
	type SameMissionRecoveryResult,
	type UserWorkerActionRequestInput,
	type UserWorkerActionResult,
} from "./khala-user-worker-action.js";
import { deliverVerdict as persistVerdictDelivery } from "./khala-verdict-delivery.js";
import { recoverTerminalExecutionStates } from "./khala-verdict-recovery.js";

const CONCLAVE_PARTICIPANT_HASH_LENGTH = 16;
const USER_PRIORITY_WAKE_RETRY_FIRST_DELAY_MS = 50;
const USER_PRIORITY_WAKE_RETRY_SECOND_DELAY_MS = 100;
const USER_PRIORITY_WAKE_RETRY_THIRD_DELAY_MS = 250;
const USER_PRIORITY_WAKE_RETRY_DELAYS_MS = [
	USER_PRIORITY_WAKE_RETRY_FIRST_DELAY_MS,
	USER_PRIORITY_WAKE_RETRY_SECOND_DELAY_MS,
	USER_PRIORITY_WAKE_RETRY_THIRD_DELAY_MS,
] as const;
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
	"khala_apply_user_priority",
	"khala_dispose_user_priority",
] as const;
type ConclaveCoordinator = Readonly<{
	submit: (
		request: WorkSubmissionRequest & { projectTrusted?: boolean; signal?: AbortSignal | undefined },
	) => Promise<{ archivePath: string }>;
	resume: (projectPath: string, projectTrusted?: boolean) => void;
	wakeSignal: (projectPath: string, signal: SignalRecord, projectTrusted?: boolean) => Promise<void>;
	wakeLearning: (projectPath: string, learning: LearningRecord, projectTrusted?: boolean) => Promise<void>;
	wakeReview: (projectPath: string, workId: string, projectTrusted?: boolean) => Promise<void>;
	wakeUserPriority: (
		projectPath: string,
		priorityId: string,
		workId: string,
		projectTrusted?: boolean,
	) => Promise<void>;
	deliverVerdict: (projectPath: string, verdict: VerdictRecord, projectTrusted?: boolean) => Promise<void>;
	executeWorkerAction: (
		projectPath: string,
		request: UserWorkerActionRequestInput,
		projectTrusted?: boolean,
	) => Promise<UserWorkerActionResult>;
	probeExecutionRuntime: (
		projectPath: string,
		executionId: string,
		projectTrusted?: boolean,
	) => Promise<ExecutionRuntimeState>;
	getSubmission: ConclaveStorage["getSubmission"];
	getPendingSubmission: ConclaveStorage["getPendingSubmission"];
	claimSubmission: ConclaveStorage["claimSubmission"];
	markSubmissionReviewing: ConclaveStorage["markSubmissionReviewing"];
	markSubmissionQueued: ConclaveStorage["markSubmissionQueued"];
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
type PendingRecoveryIdentity = Readonly<{
	workId: string;
	missionId: string;
	executionId: string;
}>;
type FreshRecoveryLaunchFailure = Readonly<{
	kind: "fresh-executor-recovery-failed";
	workId: string;
	missionId: string;
	predecessorExecutionId: string;
	replacementExecutionId: string;
	error: string;
}>;

function isPendingRecoveryLaunchEligible(
	projectPath: string,
	projectTrusted: boolean,
	pending: PendingRecoveryIdentity,
): boolean {
	return listEligibleFailedExecutorRecoveries(projectPath, projectTrusted).some(
		(candidate) =>
			candidate.execution.workId === pending.workId &&
			candidate.execution.executionId === pending.executionId &&
			candidate.mission.missionId === pending.missionId,
	);
}
function isCurrentMissionAuthority(projectPath: string, projectTrusted: boolean, mission: MissionRecord): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const currentMission = readCurrentMission(projectPath, mission.workId, projectTrusted);
		return currentMission?.state === "current" && currentMission.mission.missionId === mission.missionId;
	});
}

function createConclaveCoordinator(
	extensionPath: string,
	storage: ConclaveStorage = createFileConclaveStorage(),
	processSubmissionWake: SubmissionWakeProcessor = wakeWorkSubmission,
	processUserPriorityWake?: UserPriorityWakeProcessor,
): ConclaveCoordinator {
	const runtimes = new Map<string, Promise<ConclaveRuntime>>();
	const backgroundTasks = new Set<Promise<void>>();
	const backgroundAbort = new AbortController();
	let disposed = false;
	const submit = (
		request: WorkSubmissionRequest & { projectTrusted?: boolean; signal?: AbortSignal | undefined },
	): Promise<{ archivePath: string }> => {
		if (disposed) {
			return Promise.reject(
				new Error("The Khala Conclave coordinator has been disposed; run /khala-recover to recover it."),
			);
		}
		request.signal?.throwIfAborted();
		const projectPath = resolve(request.projectPath);
		const projectTrusted = request.projectTrusted ?? false;
		const queued = storage.submit({
			workId: request.workId,
			projectPath,
			work: request.work,
			projectTrusted,
		});
		scheduleConclaveWake(
			backgroundTasks,
			{
				projectPath,
				projectTrusted,
				workId: request.workId,
				archivePath: queued.archivePath,
				extensionPath,
				storage,
				runtimes,
				abortSignal: backgroundAbort.signal,
				disposed: () => disposed,
			},
			processSubmissionWake,
		);
		return Promise.resolve(queued);
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
	const wakeUserPriority = (
		projectPath: string,
		priorityId: string,
		workId: string,
		projectTrusted = false,
	): Promise<void> => {
		const resolvedProjectPath = resolve(projectPath);
		return retryUserPriorityWake({
			projectPath: resolvedProjectPath,
			projectTrusted,
			priorityId,
			wake: () => {
				if (processUserPriorityWake !== undefined) {
					return processUserPriorityWake(resolvedProjectPath, priorityId, workId, projectTrusted);
				}
				return wakeConclave({
					projectPath: resolvedProjectPath,
					projectTrusted,
					workId,
					userPriorityId: priorityId,
					extensionPath,
					storage,
					runtimes,
					disposed: () => disposed,
				});
			},
			shouldStop: () => disposed,
		});
	};
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
	const executeWorkerAction = (
		projectPath: string,
		request: UserWorkerActionRequestInput,
		projectTrusted = false,
	): Promise<UserWorkerActionResult> => {
		const resolvedProjectPath = resolve(projectPath);
		return executeUserWorkerAction({
			...request,
			projectPath: resolvedProjectPath,
			projectTrusted,
			services: {
				getRuntime: async (executionId) => {
					let runtime: ReturnType<typeof getHeadlessRuntime>;
					try {
						await getRuntime(resolvedProjectPath, projectTrusted, extensionPath, storage, runtimes);
						runtime = getHeadlessRuntime(executionId);
					} catch {
						// The action boundary reports the missing runtime as unreachable.
					}
					return runtime;
				},
				continueMission: async (input) => {
					let runtime: ConclaveRuntime;
					try {
						runtime = await getRuntime(resolvedProjectPath, projectTrusted, extensionPath, storage, runtimes);
					} catch (error) {
						return {
							status: "held",
							missionId: input.mission.missionId,
							reason: formatError(error),
						};
					}
					const config = loadKhalaConfig(resolvedProjectPath, projectTrusted);
					const executorModel = input.model ?? config.executorModel;
					const selectedRecovery =
						input.model === undefined
							? undefined
							: selectedUserExecutorModelRecovery({
									projectPath: resolvedProjectPath,
									workId: input.failedExecution.workId,
									missionId: input.mission.missionId,
									predecessorExecutionId: input.failedExecution.executionId,
									projectTrusted,
								});
					return startFreshSameMissionExecution({
						projectPath: resolvedProjectPath,
						projectTrusted,
						failedExecution: input.failedExecution,
						mission: input.mission,
						executorModel,
						executorSystemPrompt: readRolePrompt(
							resolvePackageRoot(dirname(fileURLToPath(import.meta.url))),
							"executor",
						),
						supervision: runtime.supervision,
						isSupervisionAvailable: () => !runtime.isLaunchBlocked(input.mission.workId),
						onLaunchFailure: (failure) =>
							runtime.session.sessionManager.appendCustomEntry(SUPERVISION_ENTRY_TYPES.critical, failure),
						onLaunchSuccess: (replacementExecutionId) => {
							if (selectedRecovery !== undefined) {
								markUserExecutorModelRecoveryApplied(
									resolvedProjectPath,
									selectedRecovery,
									replacementExecutionId,
									projectTrusted,
								);
							}
						},
					});
				},
				failExecution: async (executionId) => {
					const runtime = getHeadlessRuntime(executionId);
					await failExecutionAndCloseInterventions(
						resolvedProjectPath,
						executionId,
						projectTrusted,
						runtime === undefined ? undefined : () => runtime.closeProcess(),
					);
				},
			},
		});
	};
	const probeExecutionRuntime = (
		_projectPath: string,
		executionId: string,
		_projectTrusted = false,
	): Promise<ExecutionRuntimeState> => {
		// Attention probing is read-only: never bootstrap a Conclave session just to inspect a Work.
		try {
			const runtime = getHeadlessRuntime(executionId);
			if (runtime === undefined) {
				return Promise.resolve({
					kind: "unreachable",
					executionId,
					reason: "The supervised runtime is not reachable.",
				});
			}
			return runtime.probeRuntime().catch((error: unknown) => ({
				kind: "unknown",
				executionId,
				reason: formatError(error),
			}));
		} catch (error) {
			return Promise.resolve({ kind: "unknown", executionId, reason: formatError(error) });
		}
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
		scheduleConclaveBackgroundTask(backgroundTasks, async () => {
			if (disposed) {
				return;
			}
			schedulePendingUserPriorityWakes(backgroundTasks, resolvedProjectPath, projectTrusted, (priorityId, workId) =>
				wakeUserPriority(resolvedProjectPath, priorityId, workId, projectTrusted),
			);
			recoverTerminalExecutionStates(resolvedProjectPath, projectTrusted);
			if (listEligibleFailedExecutorRecoveries(resolvedProjectPath, projectTrusted).length > 0) {
				await getRuntime(resolvedProjectPath, projectTrusted, extensionPath, storage, runtimes);
			}
			await recoverPendingSubmissions({
				projectPath: resolvedProjectPath,
				projectTrusted,
				storage,
				signal: backgroundAbort.signal,
				wake: (submission) =>
					wakeWorkSubmission({
						projectPath: resolvedProjectPath,
						projectTrusted,
						workId: submission.workId,
						archivePath: submission.archivePath,
						extensionPath,
						storage,
						runtimes,
						disposed: () => disposed,
					}),
				onOutcomePersistenceFailure: (claim, outcome, error) =>
					recordRecoveryOutcomePersistenceFailure(
						{
							projectPath: resolvedProjectPath,
							projectTrusted,
							workId: claim.submission.workId,
							archivePath: claim.submission.archivePath,
							storage,
						},
						outcome,
						error,
					),
			});
		});
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
		wakeUserPriority,
		deliverVerdict,
		executeWorkerAction,
		probeExecutionRuntime,
		getSubmission: storage.getSubmission,
		getPendingSubmission: storage.getPendingSubmission,
		claimSubmission: storage.claimSubmission,
		markSubmissionReviewing: storage.markSubmissionReviewing,
		markSubmissionQueued: storage.markSubmissionQueued,
		markSubmissionLaunched: storage.markSubmissionLaunched,
		pollBeforeDependentLaunch,
		getConclaveSessionPath: storage.getConclaveSessionPath,
		getConclaveUserSessionPath: storage.getConclaveUserSessionPath,
		ensureConclaveSession,
		dispose: async () => {
			disposed = true;
			backgroundAbort.abort();
			await Promise.all([...backgroundTasks]);
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
	userPriorityId?: string;
	extensionPath: string;
	storage: ConclaveStorage;
	runtimes: Map<string, Promise<ConclaveRuntime>>;
	abortSignal?: AbortSignal;
	disposed?: () => boolean;
}
type SubmissionWakeRequest = WakeRequest & Readonly<{ workId: string; archivePath: string }>;
type SubmissionWakeProcessor = (request: SubmissionWakeRequest) => Promise<void>;
type UserPriorityWakeProcessor = (
	projectPath: string,
	priorityId: string,
	workId: string,
	projectTrusted?: boolean,
) => Promise<void>;
type SubmissionWakeDiagnostic = Readonly<{ message: string; recovery: ConclaveWakeRecovery }>;
type SubmissionWakeDiagnosticRequest = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	workId: string;
	archivePath: string;
	storage: ConclaveStorage;
}>;

async function wakeWorkSubmission(request: SubmissionWakeRequest): Promise<void> {
	await wakeConclave(request);
}

function conclaveWakeRecovery(error: unknown): ConclaveWakeRecovery {
	if (error instanceof KhalaConfigError) {
		return "setup";
	}
	return "recreate";
}

function assertConclaveCoordinatorActive(request: WakeRequest): void {
	if (request.disposed?.() === true) {
		throw new Error("The Khala Conclave coordinator has been disposed; run /khala-recover to recover it.");
	}
}

async function wakeConclave(request: WakeRequest): Promise<void> {
	assertConclaveCoordinatorActive(request);
	const runtime = await getRuntime(
		request.projectPath,
		request.projectTrusted,
		request.extensionPath,
		request.storage,
		request.runtimes,
	);
	assertConclaveCoordinatorActive(request);
	const wake = enqueueConclaveWake(runtime, async () => {
		assertConclaveCoordinatorActive(request);
		let prompt: string;
		if (request.learning !== undefined) {
			prompt = [
				"A Khala Observer recorded new learning.",
				`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
				`The learning concerns Work ${request.learning.workId}, observation ${request.learning.executionId}.`,
				"Check whether this learning is relevant and whether equivalent learning already exists in the Archive.",
				"If it is sufficient, call khala_admit_work, then call khala_launch_execution; otherwise do not launch the Executor yet.",
			].join("\n");
		} else if (request.userPriorityId !== undefined) {
			prompt = [
				"A User Priority request has arrived.",
				`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
				`The priority record is ${request.userPriorityId} for Work ${request.workId}.`,
				"If it is still pending and matches its recorded active peer-conflict Coordination, call khala_apply_user_priority with the exact priorityId.",
				"If it is stale (no matching active peer-conflict Coordination remains), call khala_dispose_user_priority with the exact priorityId.",
				"Do not supply assessment, action, Work, Mission, Execution, or Coordination IDs from this prompt; read them from the Archive.",
				"Never modify the User Priority record and never let a priority change Mission authority.",
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
				"Read every current Mission and active Execution as structured Archive facts before launch. Compare objective, context, scope, acceptance, constraints, plan, validation, named modules, APIs, contracts, and generated artifacts. Use khala_coordinate_work for dependency or peer conflict; independent Work requires no coordination record. Dependency decisions require the selected upstream Execution; for peer conflicts, each Mission with an active starting or running Execution requires its exact Execution identity, while a Mission without one may omit its identity. Only then call khala_launch_execution with mode launch.",
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

const RECOVERY_OWNER_ID = `${process.pid}:${nanoid()}`;
const RECOVERY_COMPLETION_RETRY_DELAY_MS = 250;
const RECOVERY_LEASE_RENEWALS_PER_LEASE = 3;
const RECOVERY_LEASE_RENEWAL_INTERVAL_MS = Math.floor(
	CONCLAVE_RECOVERY_CLAIM_LEASE_MS / RECOVERY_LEASE_RENEWALS_PER_LEASE,
);

type PendingSubmissionRecoveryOptions = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	storage: ConclaveStorage;
	wake: (submission: KhalaWorkSubmission) => Promise<void>;
	workId?: string;
	ownerId?: string;
	leaseRenewalIntervalMs?: number;
	signal?: AbortSignal;
	onOutcomePersistenceFailure?: (
		claim: SubmissionRecoveryClaim,
		outcome: SubmissionRecoveryOutcome,
		error: unknown,
	) => void;
}>;

async function recoverPendingSubmissions(options: PendingSubmissionRecoveryOptions): Promise<void> {
	if (isRecoveryAborted(options)) {
		return;
	}
	// A scheduled wake carries the exact Work ID; claim it directly instead of scanning the
	// whole Archive. The global scan remains only for startup and resume without a known Work.
	const workIds =
		options.workId === undefined
			? options.storage
					.getRecoverableSubmissions(options.projectPath, options.projectTrusted)
					.map((submission) => submission.workId)
			: [options.workId];
	await Promise.all(
		workIds.map(async (workId) => {
			if (isRecoveryAborted(options)) {
				return;
			}
			const claim = options.storage.claimSubmissionRecovery(
				options.projectPath,
				workId,
				options.ownerId ?? RECOVERY_OWNER_ID,
				options.projectTrusted,
			);
			if (claim === undefined) {
				return;
			}
			const stopLeaseRenewal = maintainRecoveryLease(options, claim);
			try {
				const attemptedAt = new Date().toISOString();
				let outcome: SubmissionRecoveryOutcome;
				if (isRecoveryAborted(options)) {
					outcome = {
						status: "failed",
						attemptedAt,
						failure: "Conclave recovery was cancelled before its wake began.",
						recovery: "recreate",
					};
				} else {
					try {
						await options.wake(claim.submission);
						outcome = { status: "woken", attemptedAt };
					} catch (error) {
						outcome = {
							status: "failed",
							attemptedAt,
							failure: formatError(error),
							recovery: conclaveWakeRecovery(error),
						};
					}
				}
				await persistRecoveryOutcome(options, claim, outcome);
			} finally {
				await stopLeaseRenewal();
			}
		}),
	);
}

async function persistRecoveryOutcome(
	options: PendingSubmissionRecoveryOptions,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
): Promise<void> {
	let attemptedPersistence = false;
	let reportedPersistenceFailure = false;
	for (;;) {
		if (attemptedPersistence && isRecoveryAborted(options)) {
			return;
		}
		try {
			attemptedPersistence = true;
			options.storage.completeSubmissionRecovery(options.projectPath, claim, outcome, options.projectTrusted);
			// A false result is definitive claim loss, not a retryable storage failure.
			return;
		} catch (error) {
			if (!reportedPersistenceFailure) {
				reportedPersistenceFailure = true;
				reportRecoveryOutcomePersistenceFailure(options, claim, outcome, error);
			}
			if (isRecoveryAborted(options)) {
				return;
			}
			await waitForRecoveryRetry(options.signal);
		}
	}
}

function reportRecoveryOutcomePersistenceFailure(
	options: PendingSubmissionRecoveryOptions,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
	error: unknown,
): void {
	try {
		options.onOutcomePersistenceFailure?.(claim, outcome, error);
	} catch {
		// A session diagnostic cannot replace the authoritative retry path.
	}
}

function isRecoveryAborted(options: PendingSubmissionRecoveryOptions): boolean {
	return options.signal?.aborted === true;
}

function waitForRecoveryRetry(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolveRetry) => {
		const timer = setTimeout(finish, RECOVERY_COMPLETION_RETRY_DELAY_MS);
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolveRetry();
		}
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function maintainRecoveryLease(
	options: PendingSubmissionRecoveryOptions,
	claim: SubmissionRecoveryClaim,
): () => Promise<void> {
	let stopped = false;
	let cancelDelay: (() => void) | undefined;
	const wait = (milliseconds: number): Promise<void> =>
		new Promise((resolveWait) => {
			const timer = setTimeout(() => {
				cancelDelay = undefined;
				resolveWait();
			}, milliseconds);
			cancelDelay = () => {
				clearTimeout(timer);
				cancelDelay = undefined;
				resolveWait();
			};
		});
	const renewal = (async () => {
		let delay = options.leaseRenewalIntervalMs ?? RECOVERY_LEASE_RENEWAL_INTERVAL_MS;
		while (!(stopped || isRecoveryAborted(options))) {
			await wait(delay);
			if (stopped || isRecoveryAborted(options)) {
				return;
			}
			try {
				if (!options.storage.renewSubmissionRecovery(options.projectPath, claim, options.projectTrusted)) {
					return;
				}
				delay = options.leaseRenewalIntervalMs ?? RECOVERY_LEASE_RENEWAL_INTERVAL_MS;
			} catch {
				delay = RECOVERY_COMPLETION_RETRY_DELAY_MS;
			}
		}
	})();
	return async () => {
		stopped = true;
		cancelDelay?.();
		await renewal;
	};
}

function scheduleConclaveBackgroundTask(
	backgroundTasks: Set<Promise<void>>,
	operation: () => void | Promise<void>,
): void {
	let task: Promise<void>;
	task = new Promise<void>((resolveTask) => setImmediate(resolveTask))
		.then(operation)
		.catch(() => undefined)
		.finally(() => backgroundTasks.delete(task));
	backgroundTasks.add(task);
}

type PendingPriorityWake = (priorityId: string, workId: string, projectTrusted: boolean) => Promise<void>;

type UserPriorityWakeRetryOptions = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	priorityId: string;
	wake: () => Promise<void>;
	shouldStop: () => boolean;
}>;

async function retryUserPriorityWake(options: UserPriorityWakeRetryOptions): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= USER_PRIORITY_WAKE_RETRY_DELAYS_MS.length; attempt += 1) {
		const priority = readUserPriority(options.projectPath, options.priorityId, options.projectTrusted);
		if (
			priority === undefined ||
			priority.status !== "pending" ||
			isUserPriorityEnforced(options.projectPath, options.priorityId, options.projectTrusted)
		) {
			return;
		}
		try {
			await options.wake();
			return;
		} catch (error) {
			lastError = error;
		}
		if (options.shouldStop()) {
			throw lastError;
		}
		const delayMs = USER_PRIORITY_WAKE_RETRY_DELAYS_MS[attempt];
		if (delayMs === undefined) {
			throw lastError;
		}
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
	}
	throw lastError;
}

// A pending User Priority or an applied priority with incomplete enforcement is
// the durable at-least-once recovery queue item. Every remaining item is
// scheduled through the same serialized wake path on startup/resume; apply and
// dispose are Archive-locked and idempotent, so concurrent processes cannot
// apply or ignore it twice.
function schedulePendingUserPriorityWakes(
	backgroundTasks: Set<Promise<void>>,
	projectPath: string,
	projectTrusted: boolean,
	wake: PendingPriorityWake,
): void {
	const pending = new Map<string, string>();
	for (const priority of [
		...pendingUserPriorities(projectPath, projectTrusted),
		...pendingUserPriorityEnforcements(projectPath, projectTrusted),
	]) {
		pending.set(priority.priorityId, priority.workId);
	}
	for (const [priorityId, workId] of pending) {
		scheduleConclaveBackgroundTask(backgroundTasks, () => wake(priorityId, workId, projectTrusted));
	}
}

function scheduleConclaveWake(
	backgroundTasks: Set<Promise<void>>,
	request: SubmissionWakeRequest,
	processWake: SubmissionWakeProcessor,
): void {
	scheduleConclaveBackgroundTask(backgroundTasks, async () => {
		if (request.disposed?.() === true) {
			return;
		}
		try {
			await recoverPendingSubmissions({
				projectPath: request.projectPath,
				projectTrusted: request.projectTrusted,
				storage: request.storage,
				workId: request.workId,
				...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
				wake: (submission) =>
					processWake({ ...request, workId: submission.workId, archivePath: submission.archivePath }),
				onOutcomePersistenceFailure: (claim, outcome, error) =>
					recordRecoveryOutcomePersistenceFailure(
						{
							projectPath: request.projectPath,
							projectTrusted: request.projectTrusted,
							workId: claim.submission.workId,
							archivePath: claim.submission.archivePath,
							storage: request.storage,
						},
						outcome,
						error,
					),
			});
		} catch (error) {
			recordScheduledWakeDiagnostic(request, {
				message: `The scheduled Conclave wake failed unexpectedly: ${formatError(error)}`,
				recovery: conclaveWakeRecovery(error),
			});
		}
	});
}

function recordRecoveryOutcomePersistenceFailure(
	request: SubmissionWakeDiagnosticRequest,
	outcome: SubmissionRecoveryOutcome,
	error: unknown,
): void {
	if (outcome.status === "failed") {
		recordScheduledWakeDiagnostic(request, {
			message: `The Conclave wake failed: ${outcome.failure}, but its Archive evidence could not be persisted: ${formatError(error)}`,
			recovery: outcome.recovery,
		});
		return;
	}
	recordScheduledWakeDiagnostic(request, {
		message: `The Conclave wake completed, but its Archive evidence could not be persisted: ${formatError(error)}`,
		recovery: "recreate",
	});
}

function recordScheduledWakeDiagnostic(
	request: SubmissionWakeDiagnosticRequest,
	failure: SubmissionWakeDiagnostic,
): void {
	try {
		request.storage
			.loadConclaveSession(request.projectPath, undefined, request.projectTrusted)
			.appendCustomEntry("khala-conclave-wake-error", {
				workId: request.workId,
				archivePath: request.archivePath,
				message: failure.message,
				recovery: failure.recovery,
			});
	} catch {
		// The wake promise is always handled. If both Archive and Conclave-session
		// persistence are unavailable, recovery remains discoverable through setup.
	}
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
				isMissionExecutorRecord(execution) &&
				(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
		);
	let poller: UpstreamRefPoller | undefined;
	let supervision: SupervisionController | undefined;
	type PendingRecoveryLaunch = PendingRecoveryIdentity &
		Readonly<{
			upstreamBase?: ExecutorRecord["upstreamBase"];
			launch: () => Promise<SameMissionRecoveryResult>;
		}>;
	const pendingRecoveryLaunches: PendingRecoveryLaunch[] = [];
	const recoveryPendingEligible = (pending: PendingRecoveryLaunch): boolean =>
		isPendingRecoveryLaunchEligible(projectPath, projectTrusted, pending);
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
	const drainPendingRecovery = async (pending: PendingRecoveryLaunch): Promise<void> => {
		const index = pendingRecoveryLaunches.indexOf(pending);
		if (index < 0) {
			return;
		}
		if (!recoveryPendingEligible(pending)) {
			pendingRecoveryLaunches.splice(index, 1);
			return;
		}
		if (!recoveryLaunchAvailable(pending)) {
			return;
		}
		pendingRecoveryLaunches.splice(index, 1);
		const result = await pending.launch();
		if (result.status !== "started" && result.status !== "already-active" && recoveryPendingEligible(pending)) {
			pendingRecoveryLaunches.push(pending);
		}
	};
	const drainPendingRecoveries = async (): Promise<void> => {
		for (const pending of [...pendingRecoveryLaunches]) {
			await drainPendingRecovery(pending);
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
									isMissionExecutorRecord(execution) &&
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
			const recoveryModel = execution.model ?? config.executorModel;
			return recoverHeadlessExecutor({
				executionId: execution.executionId,
				sessionId: execution.piSessionId,
				sessionPath: execution.sessionPath,
				cwd: execution.sandboxPath,
				model: recoveryModel,
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
					updateExecutorRecord(
						projectPath,
						execution.executionId,
						{
							status: ExecutorStatus.failed,
							...(isModelUnavailableError(error)
								? { failureCategory: "model-unavailable", failureMessage: formatBoundedDiagnostic(error) }
								: {}),
						},
						projectTrusted,
					);
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
			let selectedModelRecovery: ReturnType<typeof selectedUserExecutorModelRecovery>;
			if (execution.failureCategory === "model-unavailable") {
				selectedModelRecovery = selectedUserExecutorModelRecovery({
					projectPath,
					workId: execution.workId,
					missionId: mission.missionId,
					predecessorExecutionId: execution.executionId,
					projectTrusted,
				});
				if (selectedModelRecovery === undefined) {
					return;
				}
			}
			const pending: PendingRecoveryLaunch = {
				workId: execution.workId,
				missionId: mission.missionId,
				executionId: execution.executionId,
				...(execution.upstreamBase === undefined ? {} : { upstreamBase: execution.upstreamBase }),
				launch: () =>
					startFreshSameMissionExecution({
						projectPath,
						projectTrusted,
						failedExecution: execution,
						mission,
						executorModel: selectedModelRecovery?.model ?? config.executorModel,
						executorSystemPrompt: readRolePrompt(
							resolvePackageRoot(dirname(fileURLToPath(import.meta.url))),
							"executor",
						),
						supervision,
						isSupervisionAvailable: () => recoveryLaunchAvailable(pending),
						onLaunchFailure: (failure) =>
							session.sessionManager.appendCustomEntry(SUPERVISION_ENTRY_TYPES.critical, failure),
						onLaunchSuccess: (replacementExecutionId) => {
							if (selectedModelRecovery !== undefined) {
								markUserExecutorModelRecoveryApplied(
									projectPath,
									selectedModelRecovery,
									replacementExecutionId,
									projectTrusted,
								);
							}
						},
					}),
			};
			if (recoveryLaunchAvailable(pending)) {
				const result = await pending.launch();
				if (result.status !== "started" && result.status !== "already-active" && recoveryPendingEligible(pending)) {
					pendingRecoveryLaunches.push(pending);
				}
			} else if (recoveryPendingEligible(pending)) {
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

async function cleanupFreshRecoveryResources(
	supervision: SupervisionController,
	executionId: string,
	launched: { cleanup?: () => Promise<void> } | undefined,
	runtimeOwnerRegistered: boolean,
): Promise<void> {
	try {
		if (runtimeOwnerRegistered) {
			await supervision.closeRuntimeOwner(executionId);
		} else {
			await launched?.cleanup?.();
		}
	} catch {
		// The failed Execution remains authoritative even when cleanup is unavailable.
	}
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
		onLaunchFailure?: (failure: FreshRecoveryLaunchFailure) => void;
		onLaunchSuccess?: (executionId: string) => void;
	}>,
): Promise<SameMissionRecoveryResult> {
	if (input.supervision === undefined) {
		return { status: "not-allowed", reason: "Supervision is unavailable for same-Mission recovery." };
	}
	if (input.executorModel.trim().length === 0) {
		return { status: "not-allowed", reason: "No Executor model is available for same-Mission recovery." };
	}
	if (input.isSupervisionAvailable?.() === false) {
		return { status: "held", missionId: input.mission.missionId, reason: "Supervision recovery is currently held." };
	}
	const { supervision } = input;
	const executionId = nanoid();
	const executorName = randomProtossName(
		new Set(listExecutorRecords(input.projectPath, input.projectTrusted).map((execution) => execution.executorName)),
	);
	const participantId = input.mission.assignedParticipantId;
	const promptIdentity = {
		packageVersion: packageMetadata.version,
		promptSha256: createHash("sha256").update(input.executorSystemPrompt).digest("hex"),
	};
	let registered = false;
	let preflightResult: SameMissionRecoveryResult | undefined;
	withArchiveLock(input.projectPath, input.projectTrusted, () => {
		const currentMission = readCurrentMission(input.projectPath, input.mission.workId, input.projectTrusted);
		if (currentMission?.state !== "current" || currentMission.mission.missionId !== input.mission.missionId) {
			preflightResult = { status: "stale", reason: "The Mission is no longer current." };
			return;
		}
		const hold = activeCoordinationHolds(input.projectPath, input.projectTrusted).find(
			(candidate) => candidate.workId === input.mission.workId && candidate.missionId === input.mission.missionId,
		);
		if (hold !== undefined) {
			preflightResult = {
				status: "held",
				missionId: input.mission.missionId,
				reason: hold.coordination.latest.reason,
			};
			return;
		}
		const eligibleRecovery = listEligibleFailedExecutorRecoveries(input.projectPath, input.projectTrusted).some(
			(candidate) =>
				candidate.mission.missionId === input.mission.missionId &&
				candidate.execution.executionId === input.failedExecution.executionId,
		);
		const competing = listExecutorRecords(input.projectPath, input.projectTrusted).find(
			(candidate) =>
				isMissionExecutorRecord(candidate) &&
				candidate.missionId === input.mission.missionId &&
				(candidate.status === ExecutorStatus.starting || candidate.status === ExecutorStatus.running),
		);
		if (competing !== undefined) {
			preflightResult = {
				status: "already-active",
				missionId: input.mission.missionId,
				executionId: competing.executionId,
			};
			return;
		}
		if (!eligibleRecovery) {
			preflightResult = { status: "stale", reason: "The predecessor Execution is no longer eligible for recovery." };
			return;
		}
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
					model: input.executorModel,
					recoveryOfExecutionId: input.failedExecution.executionId,
					promptIdentity,
					...(input.failedExecution.upstreamBase === undefined
						? {}
						: { upstreamBase: input.failedExecution.upstreamBase }),
				},
				ExecutorStatus.starting,
			),
			input.projectTrusted,
		);
		registered = true;
	});
	if (preflightResult !== undefined) {
		return preflightResult;
	}
	if (!registered) {
		return { status: "stale", reason: "The same-Mission recovery reservation was not created." };
	}
	let launched: { cleanup?: () => Promise<void> } | undefined;
	let runtimeOwnerRegistered = false;
	let staleAuthority = false;
	let failureReported = false;
	let rpcFailureObserved = false;
	let rpcFailureError: Error | undefined;
	let starterReturned = false;
	let runtimeFailureScheduled = false;
	const reportFreshRecoveryFailure = (error: unknown): void => {
		if (staleAuthority || failureReported) {
			return;
		}
		failureReported = true;
		try {
			input.onLaunchFailure?.({
				kind: "fresh-executor-recovery-failed",
				workId: input.mission.workId,
				missionId: input.mission.missionId,
				predecessorExecutionId: input.failedExecution.executionId,
				replacementExecutionId: executionId,
				error: formatBoundedDiagnostic(error),
			});
		} catch {
			// Session reporting cannot replace the authoritative failed Execution.
		}
	};
	const finishRuntimeFailure = (error: Error): Promise<void> =>
		supervision
			.closeRuntimeOwner(executionId)
			.catch(() => undefined)
			.then(() => {
				try {
					staleAuthority = !isCurrentMissionAuthority(input.projectPath, input.projectTrusted, input.mission);
				} catch {
					// Preserve the RPC failure diagnostic when authority cannot be re-read.
					staleAuthority = false;
				}
				if (!staleAuthority) {
					reportFreshRecoveryFailure(error);
				}
			});
	const scheduleRuntimeFailure = (error: Error): void => {
		if (runtimeFailureScheduled) {
			return;
		}
		runtimeFailureScheduled = true;
		setImmediate(() => {
			finishRuntimeFailure(error).catch(() => undefined);
		});
	};
	try {
		input.supervision.registerExecution(input.mission, executionId);
		const recoveryConfig = loadKhalaConfig(input.projectPath, input.projectTrusted);
		const previousReview = latestPullRequest(
			input.projectPath,
			input.failedExecution.executionId,
			input.projectTrusted,
		);
		const starter = createConfiguredExecutorStarter(
			{
				cwd: input.projectPath,
				isProjectTrusted: () => input.projectTrusted,
			},
			input.executorModel,
		);
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
			awaitInitialResponse: true,
			suppressRuntimeFailureSupervision: true,
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
			onRpcFailure: (error): Promise<void> | void => {
				rpcFailureObserved = true;
				rpcFailureError = error;
				updateExecutorRecord(
					input.projectPath,
					executionId,
					{
						status: ExecutorStatus.failed,
						...(isModelUnavailableError(error)
							? { failureCategory: "model-unavailable", failureMessage: formatBoundedDiagnostic(error) }
							: {}),
					},
					input.projectTrusted,
				);
				if (starterReturned) {
					scheduleRuntimeFailure(error);
				}
			},
		});
		starterReturned = true;
		if (launched.cleanup !== undefined) {
			input.supervision.registerRuntimeOwner(executionId, launched.cleanup);
			runtimeOwnerRegistered = true;
		}
		if (rpcFailureObserved && rpcFailureError !== undefined) {
			scheduleRuntimeFailure(rpcFailureError);
			return {
				status: "launch-failed",
				missionId: input.mission.missionId,
				executionId,
				predecessorExecutionId: input.failedExecution.executionId,
				reason: formatBoundedDiagnostic(rpcFailureError),
			};
		}
		if (input.isSupervisionAvailable?.() === false) {
			throw new Error("Supervision became unavailable after fresh recovery registration.");
		}
		if (!isCurrentMissionAuthority(input.projectPath, input.projectTrusted, input.mission)) {
			staleAuthority = true;
			throw new Error("Fresh recovery Mission was superseded during startup.");
		}
		updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.running }, input.projectTrusted);
		input.onLaunchSuccess?.(executionId);
		return {
			status: "started",
			missionId: input.mission.missionId,
			executionId,
			predecessorExecutionId: input.failedExecution.executionId,
		};
	} catch (error) {
		await cleanupFreshRecoveryResources(input.supervision, executionId, launched, runtimeOwnerRegistered);
		updateExecutorRecord(
			input.projectPath,
			executionId,
			{
				status: ExecutorStatus.failed,
				...(isModelUnavailableError(error)
					? { failureCategory: "model-unavailable", failureMessage: formatBoundedDiagnostic(error) }
					: {}),
			},
			input.projectTrusted,
		);
		if (!staleAuthority) {
			reportFreshRecoveryFailure(error);
		}
		if (staleAuthority) {
			return { status: "stale", reason: "The Mission changed during same-Mission recovery startup." };
		}
		return {
			status: "launch-failed",
			missionId: input.mission.missionId,
			executionId,
			predecessorExecutionId: input.failedExecution.executionId,
			reason: formatBoundedDiagnostic(error),
		};
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

export type { ConclaveCoordinator, FreshRecoveryLaunchFailure };
export {
	CONCLAVE_BASE_TOOL_ALLOWLIST,
	CONCLAVE_TOOL_ALLOWLIST,
	createConclaveCoordinator,
	enqueueConclaveWake,
	isPendingRecoveryLaunchEligible,
	recoverPendingSubmissions,
	schedulePendingUserPriorityWakes,
	startFreshSameMissionExecution,
};
