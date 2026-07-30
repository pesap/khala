// biome-ignore-all lint/style/noExcessiveLinesPerFile: Conclave runtime wiring keeps lifecycle coordination in one module.
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
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import type { ConclaveStorage } from "./khala-conclave-storage.js";
import { createFileConclaveStorage } from "./khala-conclave-storage-file.js";
import { loadKhalaConfig } from "./khala-config.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { formatError } from "./khala-error.js";
import { sendConfiguredExecutorMessage } from "./khala-executor.js";
import { readExecutorRecord } from "./khala-executor-registry.js";
import type { LearningRecord, SignalRecord, VerdictRecord, WorkSubmissionRequest } from "./khala-model.js";
import { resolvePackageRoot } from "./khala-package.js";
import { deliverVerdict as persistVerdictDelivery } from "./khala-verdict-delivery.js";
import { recoverTerminalExecutionStates } from "./khala-verdict-recovery.js";

type ConclaveCoordinator = Readonly<{
	submit: (request: WorkSubmissionRequest & { projectTrusted?: boolean }) => Promise<{ archivePath: string }>;
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
	getConclaveSessionPath: ConclaveStorage["getConclaveSessionPath"];
	getConclaveUserSessionPath: ConclaveStorage["getConclaveUserSessionPath"];
	ensureConclaveSession: (
		projectPath: string,
		userSessionPath?: string,
		projectTrusted?: boolean,
	) => string | undefined;
}>;
interface ConclaveRuntime {
	session: AgentSession;
	wakeChain: Promise<void>;
}
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Coordinator wiring keeps storage and wake lifecycle bindings together.
function createConclaveCoordinator(
	extensionPath: string,
	storage: ConclaveStorage = createFileConclaveStorage(),
): ConclaveCoordinator {
	const runtimes = new Map<string, Promise<ConclaveRuntime>>();
	const submit = (request: WorkSubmissionRequest & { projectTrusted?: boolean }): Promise<{ archivePath: string }> => {
		const projectPath = resolve(request.projectPath);
		const queued = storage.submit({ ...request, projectPath });
		wakeConclave({
			projectPath,
			projectTrusted: request.projectTrusted ?? false,
			workId: request.workId,
			archivePath: queued.archivePath,
			extensionPath,
			storage,
			runtimes,
		});
		return Promise.resolve(queued);
	};
	const wakeSignal = (projectPath: string, signal: SignalRecord, projectTrusted = false): Promise<void> =>
		wakeConclave({ projectPath: resolve(projectPath), projectTrusted, signal, extensionPath, storage, runtimes });
	const wakeReview = (projectPath: string, workId: string, projectTrusted = false): Promise<void> =>
		wakeConclave({
			projectPath: resolve(projectPath),
			projectTrusted,
			workId,
			review: true,
			extensionPath,
			storage,
			runtimes,
		});
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
		});
	};
	const resume = (projectPath: string, projectTrusted = false): void => {
		const resolvedProjectPath = resolve(projectPath);
		recoverTerminalExecutionStates(resolvedProjectPath, projectTrusted);
		for (const submission of storage.getPendingSubmissions(resolvedProjectPath, projectTrusted)) {
			wakeConclave({
				projectPath: resolvedProjectPath,
				projectTrusted,
				workId: submission.workId,
				archivePath: submission.archivePath,
				extensionPath,
				storage,
				runtimes,
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
		getConclaveSessionPath: storage.getConclaveSessionPath,
		getConclaveUserSessionPath: storage.getConclaveUserSessionPath,
		ensureConclaveSession,
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
}

async function wakeConclave(request: WakeRequest): Promise<void> {
	try {
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
					"A Maintainer Pull Request review event has arrived.",
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
					"If the Work is valid and has sufficient context or learning, call khala_admit_work, then call khala_launch_execution with the queued workId.",
					"If the authoritative submission is already admitted, skip admission and recover or launch its current Mission; if it is reviewing, wait for the current Observer attempt.",
					"If it is invalid or stale, do not launch an agent; record the reason in your response.",
				].join("\n");
			} else {
				prompt = [
					"A new Executor Signal has arrived.",
					`Read the authoritative Archive at ${join(getConclaveDirectory(request.projectPath, request.projectTrusted), "archive.jsonl")}.`,
					`The Signal concerns Work ${request.signal.workId}, execution ${request.signal.executionId}.`,
					"Evaluate the evidence and issue the appropriate durable Verdict through khala_verdict.",
					"If the Verdict is Retry, immediately call khala_launch_execution for the Work so the successor Mission is materialized and launched or returns an explicit recoverable error.",
				].join("\n");
			}
			await runtime.session.prompt(prompt);
		});
		await wake;
	} catch (error) {
		const runtime = await getExistingRuntime(request.projectPath, request.projectTrusted, request.runtimes);
		if (runtime !== undefined) {
			runtime.session.sessionManager.appendCustomEntry(KhalaEntryType.conclaveError, {
				workId: request.workId,
				error: formatError(error),
			});
		}
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
		tools: [
			"read",
			"grep",
			"find",
			"ls",
			"khala_read_archive",
			"khala_launch_observer",
			"khala_admit_work",
			"khala_launch_execution",
			"khala_verdict",
			"khala_record_work_outcome",
		],
	};
	if (model !== undefined) {
		sessionOptions.model = model;
	}
	if (model !== undefined && conclaveThinking !== "" && isSupportedThinkingLevel(model, conclaveThinking)) {
		sessionOptions.thinkingLevel = conclaveThinking;
	}
	const { session } = await createAgentSession(sessionOptions);
	return { session, wakeChain: Promise.resolve() };
}

function isSupportedThinkingLevel(
	model: { thinkingLevelMap?: Partial<Record<string, string | null>> },
	level: string,
): boolean {
	return level.length > 0 && model.thinkingLevelMap?.[level] !== undefined && model.thinkingLevelMap[level] !== null;
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
export { createConclaveCoordinator, enqueueConclaveWake, isSupportedThinkingLevel };
