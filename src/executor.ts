// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Executor startup composes sandbox, review preparation, RPC readiness, and cleanup fences in one transaction.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Executor startup composes sandbox, review preparation, RPC readiness, and cleanup fences in one transaction.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Executor launch keeps sandbox and launcher ownership in one transaction boundary.
import { join } from "node:path";
import type { HeadlessRuntimeOptions, RpcSessionBinding } from "./executor-rpc.js";
import {
	HeadlessExecutorRuntime,
	KHALA_HEADLESS_LAUNCHER,
	registerHeadlessRuntime,
	unregisterHeadlessRuntime,
} from "./executor-rpc.js";
import { getSupervisionController } from "./khala-supervision.js";
import { validatePersistedExecutorSession } from "./khala-supervision-recovery.js";
import type { LaunchedSession, Launcher, StartupRequest } from "./launcher.js";
import type { ReviewPreparation, VCSProvider as VcsProviderType } from "./vcs.js";

interface SandboxRequest {
	projectPath: string;
	name: string;
	baseBranch?: string;
	/** Exact published upstream commit used by a dependent Execution. */
	baseCommit?: string;
	baseRef?: string;
}

interface Sandbox {
	path: string;
	name: string;
	projectPath: string;
}

type PiCommand = readonly [command: string, ...args: string[]];
type KhalaAgentKind = "executor" | "observer";

interface ExecutorRequest {
	projectPath: string;
	workId: string;
	executionId: string;
	name: string;
	executorName: string;
	mission: string;
	systemPrompt: string;
	missionId?: string;
	mandateId?: string;
	participantId?: string;
	projectTrusted?: boolean;
	kind: KhalaAgentKind;
	onSandboxCreated?: (sandbox: Sandbox, launcherName: string) => void;
	onRpcReady?: (binding: RpcSessionBinding) => Promise<void> | void;
	onRpcEvent?: (event: unknown) => Promise<void> | void;
	onRpcFailure?: (error: Error) => Promise<void> | void;
	onRuntimeFailure?: (error: Error) => Promise<void> | void;
	onReviewPrepared?: (preparation: ReviewPreparation, sandbox: Sandbox) => Promise<void> | void;
	reviewWorkflow?: Readonly<{
		publish: boolean;
		targetBranch?: string;
		supersedesPullRequestUrl?: string;
		commitConvention?: string;
		baseCommit?: string;
		baseRef?: string;
	}>;
}

type ExecutorStarter = (request: ExecutorRequest) => Promise<LaunchedSession>;
type ExecutorRecoveryRequest = Readonly<{
	executionId: string;
	sessionId: string;
	sessionPath: string;
	cwd: string;
	model: string;
	mission: string;
	command: string;
	args: readonly string[];
	onReady?: HeadlessRuntimeOptions["onReady"];
	onRestart?: HeadlessRuntimeOptions["onRestart"];
	onEvent?: HeadlessRuntimeOptions["onEvent"];
	onFailure?: HeadlessRuntimeOptions["onFailure"];
	spawnProcess?: HeadlessRuntimeOptions["spawnProcess"];
}>;

async function recoverHeadlessExecutor(request: ExecutorRecoveryRequest): Promise<HeadlessExecutorRuntime> {
	validatePersistedExecutorSession(
		{ sessionId: request.sessionId, sessionPath: request.sessionPath },
		request.sessionPath,
	);
	let runtimeOptions: HeadlessRuntimeOptions = {
		command: request.command,
		args: request.args,
		cwd: request.cwd,
		model: request.model,
		mission: request.mission,
		executionId: request.executionId,
		sessionId: request.sessionId,
		sessionPath: request.sessionPath,
	};
	if (request.onReady !== undefined) {
		runtimeOptions = { ...runtimeOptions, onReady: request.onReady };
	}
	if (request.onRestart !== undefined) {
		runtimeOptions = { ...runtimeOptions, onRestart: request.onRestart };
	}
	if (request.onEvent !== undefined) {
		runtimeOptions = { ...runtimeOptions, onEvent: request.onEvent };
	}
	if (request.onFailure !== undefined) {
		runtimeOptions = { ...runtimeOptions, onFailure: request.onFailure };
	}
	if (request.spawnProcess !== undefined) {
		runtimeOptions = { ...runtimeOptions, spawnProcess: request.spawnProcess };
	}
	const runtime = new HeadlessExecutorRuntime(runtimeOptions);
	registerHeadlessRuntime(request.executionId, runtime);
	await runtime.start();
	return runtime;
}

// The starter composes the two providers without deciding how either repository isolation or terminal launching works.
// biome-ignore lint/complexity/useMaxParams: Configured starters pass launcher, model, and skill settings as separate integration parameters.
function createExecutorStarter(
	vcsProvider: VcsProviderType,
	launcher: Launcher | undefined,
	piCommand: PiCommand = ["pi"],
	launcherName = "configured",
	model?: string,
	skillPaths: readonly string[] = [],
	thinkingLevel?: string,
): ExecutorStarter {
	return async (request) => {
		const sandboxRequest: SandboxRequest = { projectPath: request.projectPath, name: request.name };
		if (request.reviewWorkflow?.targetBranch !== undefined) {
			sandboxRequest.baseBranch = request.reviewWorkflow.targetBranch;
		}
		if (request.reviewWorkflow?.baseCommit !== undefined) {
			sandboxRequest.baseCommit = request.reviewWorkflow.baseCommit;
		}
		if (request.reviewWorkflow?.baseRef !== undefined) {
			sandboxRequest.baseRef = request.reviewWorkflow.baseRef;
		}
		const sandbox = await vcsProvider.createSandbox(sandboxRequest);
		// This flag means all live child/pane resources are closed. It starts true
		// so failures before a runtime or Observer pane exists still remove the
		// sandbox; successful launch flips it false and owns explicit cleanup.
		let launcherClosed = true;
		let sandboxRemoved = false;
		let headlessRuntime: HeadlessExecutorRuntime | undefined;
		let launched: LaunchedSession | undefined;
		let cleanupAfterLaunch: (() => Promise<void>) | undefined;
		try {
			let activeLauncherName = launcherName;
			if (request.kind === "executor") {
				activeLauncherName = KHALA_HEADLESS_LAUNCHER;
			}
			request.onSandboxCreated?.(sandbox, activeLauncherName);
			if (request.reviewWorkflow !== undefined) {
				const reviewRequest: {
					sandbox: Sandbox;
					name: string;
					workId: string;
					executionId: string;
					mission: string;
					publish: boolean;
					targetBranch?: string;
					supersedesPullRequestUrl?: string;
					commitConvention?: string;
					baseCommit?: string;
				} = {
					sandbox,
					name: request.name,
					workId: request.workId,
					executionId: request.executionId,
					mission: request.mission,
					publish: request.reviewWorkflow.publish,
				};
				if (request.reviewWorkflow.supersedesPullRequestUrl !== undefined) {
					reviewRequest.supersedesPullRequestUrl = request.reviewWorkflow.supersedesPullRequestUrl;
				}
				if (request.reviewWorkflow.commitConvention !== undefined) {
					reviewRequest.commitConvention = request.reviewWorkflow.commitConvention;
				}
				if (request.reviewWorkflow.baseCommit !== undefined) {
					reviewRequest.baseCommit = request.reviewWorkflow.baseCommit;
				}
				if (request.reviewWorkflow.targetBranch !== undefined) {
					reviewRequest.targetBranch = request.reviewWorkflow.targetBranch;
				}
				const preparation = await vcsProvider.prepareReview(reviewRequest);
				if (preparation !== undefined) {
					await request.onReviewPrepared?.(preparation, sandbox);
				}
			}

			if (request.kind === "executor") {
				if (model === undefined || model.trim().length === 0) {
					throw new Error("A configured executorModel is required for headless Executor launch.");
				}
				const [command, ...commandArgs] = piCommand;
				const skillArguments: string[] = [];
				for (const skillPath of skillPaths) {
					skillArguments.push("--skill", skillPath);
				}
				const runtimeOptions: {
					command: string;
					args: string[];
					cwd: string;
					model: string;
					mission: string;
					executionId: string;
					onReady?: (binding: RpcSessionBinding) => Promise<void> | void;
					onEvent?: (event: unknown, runtime: HeadlessExecutorRuntime) => Promise<void> | void;
					onFailure?: (error: Error) => Promise<void> | void;
					onRestart?: (runtime: HeadlessExecutorRuntime) => Promise<void> | void;
				} = {
					command,
					args: [...commandArgs, ...buildPiArguments(request, thinkingLevel, false), ...skillArguments],
					cwd: sandbox.path,
					model,
					mission: request.mission,
					executionId: request.executionId,
				};
				const supervision = getSupervisionController(request.projectPath, request.projectTrusted ?? false);
				if (request.onRpcEvent !== undefined || supervision !== undefined) {
					runtimeOptions.onEvent = (event, runtime) => {
						const explicitResult = request.onRpcEvent?.(event);
						const supervisedResult = supervision?.handleRuntimeEvent(
							{
								workId: request.workId,
								missionId: request.missionId ?? "unknown-mission",
								executionId: request.executionId,
							},
							event,
							runtime,
						);
						return Promise.all([explicitResult, supervisedResult]).then(() => undefined);
					};
				}
				if (request.onRpcReady !== undefined) {
					runtimeOptions.onReady = request.onRpcReady;
				}
				if (supervision !== undefined) {
					runtimeOptions.onRestart = (runtime) =>
						supervision.handleRuntimeRestart(
							{
								workId: request.workId,
								missionId: request.missionId ?? "unknown-mission",
								executionId: request.executionId,
							},
							runtime,
						);
				}
				if (request.onRpcFailure !== undefined || request.onRuntimeFailure !== undefined || supervision !== undefined) {
					runtimeOptions.onFailure = async (error) => {
						if (cleanupAfterLaunch !== undefined) {
							try {
								await cleanupAfterLaunch();
							} catch (cleanupError) {
								attachCleanupDiagnostic(error, cleanupError);
							}
						}
						const explicitResult = (request.onRuntimeFailure ?? request.onRpcFailure)?.(error);
						const supervisedResult = supervision?.handleRuntimeFailure(
							{
								workId: request.workId,
								missionId: request.missionId ?? "unknown-mission",
								executionId: request.executionId,
							},
							error,
						);
						return Promise.all([explicitResult, supervisedResult]).then(() => undefined);
					};
				}
				headlessRuntime = new HeadlessExecutorRuntime(runtimeOptions);
				registerHeadlessRuntime(request.executionId, headlessRuntime);
				launched = await headlessRuntime.start();
				launched = { ...launched, sandbox };
				launcherClosed = false;
			} else {
				if (launcher === undefined) {
					throw new Error("Observer launch requires a configured pane launcher.");
				}
				const [command, ...commandArgs] = piCommand;
				const skillArguments: string[] = [];
				for (const skillPath of skillPaths) {
					skillArguments.push("--skill", skillPath);
				}
				const startup: StartupRequest = { markerPath: join(sandbox.path, `.khala-startup-${request.executionId}`) };
				launched = await launcher.launch({
					sandbox,
					name: request.name,
					command,
					args: [...commandArgs, ...skillArguments, ...buildPiArguments(request, thinkingLevel)],
					startup,
				});
				launcherClosed = launched.target === undefined;
				await launched.ready;
			}
			if (launched === undefined) {
				throw new Error("Executor launch did not return a session.");
			}
			const runningLaunch = launched;

			const cleanup = async (resourceAlreadyClosed = false) => {
				const cleanupErrors: unknown[] = [];
				if (launcher !== undefined && !launcherClosed && runningLaunch.target !== undefined) {
					try {
						await launcher.close(runningLaunch.target);
						launcherClosed = true;
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (resourceAlreadyClosed) {
					launcherClosed = true;
				}
				if (!launcherClosed && headlessRuntime !== undefined) {
					try {
						await headlessRuntime.closeProcess();
						launcherClosed = true;
						unregisterHeadlessRuntime(request.executionId);
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (launcherClosed && !sandboxRemoved) {
					try {
						await vcsProvider.removeSandbox(sandbox);
						sandboxRemoved = true;
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (cleanupErrors.length > 0) {
					const cleanupMessages: string[] = [];
					for (const cleanupError of cleanupErrors) {
						if (cleanupError instanceof Error) {
							cleanupMessages.push(cleanupError.message);
						} else {
							cleanupMessages.push(String(cleanupError));
						}
					}
					const cleanupFailure = new Error(`Executor launch cleanup failed: ${cleanupMessages.join("; ")}`);
					for (const cleanupError of cleanupErrors) {
						attachCleanupDiagnostic(cleanupFailure, cleanupError);
					}
					throw cleanupFailure;
				}
			};
			cleanupAfterLaunch = cleanup;
			if (runningLaunch.exited !== undefined) {
				runningLaunch.exited
					.then(async (exit) => {
						if (launcherClosed) {
							return;
						}
						const error = new Error(
							`Executor launcher child exited unexpectedly (code=${exit.code ?? "null"}, signal=${exit.signal ?? "none"}).`,
						);
						try {
							await cleanup(true);
						} catch (cleanupError) {
							attachCleanupDiagnostic(error, cleanupError);
						}
						await (request.onRuntimeFailure ?? request.onRpcFailure)?.(error);
					})
					.catch(() => undefined);
			}
			return { ...runningLaunch, cleanup };
		} catch (error) {
			if (headlessRuntime !== undefined) {
				try {
					await headlessRuntime.closeProcess();
					launcherClosed = true;
				} catch (cleanupError) {
					attachCleanupDiagnostic(error, cleanupError);
				}
				unregisterHeadlessRuntime(request.executionId);
			}
			if (launcher !== undefined && launched?.target !== undefined && !launcherClosed) {
				try {
					await launcher.close(launched.target);
					launcherClosed = true;
				} catch (cleanupError) {
					attachCleanupDiagnostic(error, cleanupError);
				}
			}
			try {
				if (launcherClosed && !sandboxRemoved) {
					await vcsProvider.removeSandbox(sandbox);
				}
			} catch (cleanupError) {
				attachCleanupDiagnostic(error, cleanupError);
			}
			throw error;
		}
	};
}

function attachCleanupDiagnostic(error: unknown, cleanupError: unknown): void {
	if (!(error instanceof Error)) {
		return;
	}
	// Keep the runtime or launcher failure as the public error; this non-enumerable field is diagnostic only.
	try {
		const existing = (error as Error & { cleanupErrors?: unknown[] }).cleanupErrors ?? [];
		Object.defineProperty(error, "cleanupErrors", {
			configurable: true,
			enumerable: false,
			value: [...existing, cleanupError],
			writable: false,
		});
		if (!("cleanupError" in error)) {
			Object.defineProperty(error, "cleanupError", {
				configurable: true,
				enumerable: false,
				value: cleanupError,
				writable: false,
			});
		}
	} catch {
		// A non-extensible primary error must still be rethrown unchanged.
	}
}

function buildPiArguments(request: ExecutorRequest, thinkingLevel?: string, includeMission = true): string[] {
	const args = [
		"--system-prompt",
		request.systemPrompt,
		"--khala-system-prompt-provided",
		"--name",
		request.executorName,
		"--khala-work-id",
		request.workId,
		"--khala-execution-id",
		request.executionId,
		"--khala-project-path",
		request.projectPath,
	];
	if (thinkingLevel !== undefined && thinkingLevel.length > 0) {
		args.push("--thinking", thinkingLevel);
	}
	if (request.projectTrusted !== undefined) {
		let trustedValue = "false";
		if (request.projectTrusted) {
			trustedValue = "true";
		}
		args.push("--khala-project-trusted", trustedValue);
	}
	if (request.kind === "observer") {
		args.push(
			"--tools",
			"read,grep,find,ls,khala_read_archive,khala_record_learning",
			"--khala-agent-kind",
			"observer",
		);
	}
	if (request.missionId !== undefined) {
		args.push("--khala-mission-id", request.missionId);
	}
	if (request.mandateId !== undefined) {
		args.push("--khala-mandate-id", request.mandateId);
	}
	if (request.participantId !== undefined) {
		args.push("--khala-participant-id", request.participantId);
	}
	if (includeMission && request.mission.length > 0) {
		args.push(request.mission);
	}
	return args;
}

// biome-ignore lint/performance/noBarrelFile: RPC launch helpers remain available beside the starter contract for focused transport tests.
export {
	buildHeadlessPiArguments,
	disposeHeadlessRuntimes,
	getHeadlessRuntime,
	HeadlessExecutorRuntime,
	KHALA_HEADLESS_LAUNCHER,
	readRpcSessionBinding,
	registerHeadlessRuntime,
	StrictJsonlReader,
	sendHeadlessExecutorMessage,
} from "./executor-rpc.js";
export type { VCSProvider } from "./vcs.js";
export type {
	ExecutorRecoveryRequest,
	ExecutorRequest,
	ExecutorStarter,
	KhalaAgentKind,
	PiCommand,
	Sandbox,
	SandboxRequest,
};
export { buildPiArguments, createExecutorStarter, recoverHeadlessExecutor };
