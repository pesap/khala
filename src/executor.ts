// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Executor startup composes sandbox, review preparation, launcher, and cleanup fences in one transaction.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Executor startup composes sandbox, review preparation, launcher, and cleanup fences in one transaction.
import { join } from "node:path";
import type { LaunchedSession, Launcher, StartupRequest } from "./launcher.js";
import type { ReviewPreparation, VCSProvider as VcsProviderType } from "./vcs.js";

// The request stays provider-neutral so Git worktrees, branch sandboxes, and remote VCS implementations can share it.
interface SandboxRequest {
	projectPath: string;
	name: string;
	baseBranch?: string;
}

// The launcher uses only the working directory; the project root is retained for provider cleanup.
interface Sandbox {
	path: string;
	name: string;
	// VCS providers use the repository root to remove provider-owned branches after worktree removal.
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
	kind?: KhalaAgentKind;
	onSandboxCreated?: (sandbox: Sandbox, launcherName: string) => void;
	reviewWorkflow?: Readonly<{
		publish: boolean;
		targetBranch?: string;
		supersedesPullRequestUrl?: string;
		commitConvention?: string;
	}>;
	onReviewPrepared?: (preparation: ReviewPreparation, sandbox: Sandbox) => Promise<void> | void;
}

type ExecutorStarter = (request: ExecutorRequest) => Promise<LaunchedSession>;

// The starter composes the two providers without deciding how either repository isolation or terminal launching works.
// biome-ignore lint/complexity/useMaxParams: Configured starters pass launcher, model, and skill settings as separate integration parameters.
function createExecutorStarter(
	vcsProvider: VcsProviderType,
	launcher: Launcher,
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
		const sandbox = await vcsProvider.createSandbox(sandboxRequest);
		let launcherClosed = true;
		try {
			request.onSandboxCreated?.(sandbox, launcherName);
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
				if (request.reviewWorkflow.targetBranch !== undefined) {
					reviewRequest.targetBranch = request.reviewWorkflow.targetBranch;
				}
				const preparation = await vcsProvider.prepareReview(reviewRequest);
				if (preparation !== undefined) {
					await request.onReviewPrepared?.(preparation, sandbox);
				}
			}
			const [command, ...commandArgs] = piCommand;
			const startup: StartupRequest = { markerPath: join(sandbox.path, `.khala-startup-${request.executionId}`) };
			const modelArguments: string[] = [];
			if (model !== undefined) {
				modelArguments.push("--model", model);
			}
			const skillArguments: string[] = [];
			for (const skillPath of skillPaths) {
				skillArguments.push("--skill", skillPath);
			}
			const launched = await launcher.launch({
				sandbox,
				name: request.name,
				command,
				args: [...commandArgs, ...modelArguments, ...skillArguments, ...buildPiArguments(request, thinkingLevel)],
				startup,
			});
			launcherClosed = launched.target === undefined;
			if (launched.ready !== undefined) {
				try {
					await launched.ready;
				} catch (error) {
					if (launched.target !== undefined) {
						try {
							await launcher.close(launched.target);
							launcherClosed = true;
						} catch (cleanupError) {
							attachCleanupDiagnostic(error, cleanupError);
						}
					}
					throw error;
				}
			}
			let sandboxRemoved = false;
			const cleanup = async () => {
				const cleanupErrors: unknown[] = [];
				if (!launcherClosed && launched.target !== undefined) {
					try {
						await launcher.close(launched.target);
						launcherClosed = true;
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
			return { ...launched, cleanup };
		} catch (error) {
			if (launcherClosed) {
				try {
					await vcsProvider.removeSandbox(sandbox);
				} catch (cleanupError) {
					attachCleanupDiagnostic(error, cleanupError);
				}
			}
			throw error;
		}
	};
}

function attachCleanupDiagnostic(error: unknown, cleanupError: unknown): void {
	if (!(error instanceof Error)) {
		return;
	}
	// Keep the startup or launcher failure as the public error; this non-enumerable field is diagnostic only.
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

function buildPiArguments(request: ExecutorRequest, thinkingLevel?: string): string[] {
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
	if (request.mission.length > 0) {
		args.push(request.mission);
	}
	return args;
}

export type { VCSProvider } from "./vcs.js";
export type { ExecutorRequest, ExecutorStarter, KhalaAgentKind, PiCommand, Sandbox, SandboxRequest };
export { buildPiArguments, createExecutorStarter };
