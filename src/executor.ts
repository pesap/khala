import type { LaunchedSession, Launcher } from "./launcher.js";
import type { VCSProvider as VcsProviderType } from "./vcs.js";

// The request stays provider-neutral so Git worktrees, branch sandboxes, and remote VCS implementations can share it.
interface SandboxRequest {
	projectPath: string;
	name: string;
}

// The launcher only needs a working directory. VCS details remain owned by the provider that created it.
interface Sandbox {
	path: string;
	name: string;
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
	kind?: KhalaAgentKind;
	onSandboxCreated?: (sandbox: Sandbox, launcherName: string) => void;
}

type ExecutorStarter = (request: ExecutorRequest) => Promise<LaunchedSession>;

// The starter composes the two providers without deciding how either repository isolation or terminal launching works.
// biome-ignore lint/complexity/useMaxParams: The optional model is kept as a final compatibility parameter for configured starters.
function createExecutorStarter(
	vcsProvider: VcsProviderType,
	launcher: Launcher,
	piCommand: PiCommand = ["pi"],
	launcherName = "configured",
	model?: string,
): ExecutorStarter {
	return async (request) => {
		const sandbox = await vcsProvider.createSandbox({
			projectPath: request.projectPath,
			name: request.name,
		});
		try {
			request.onSandboxCreated?.(sandbox, launcherName);
			const [command, ...commandArgs] = piCommand;
			const modelArguments: string[] = [];
			if (model !== undefined) {
				modelArguments.push("--model", model);
			}
			return await launcher.launch({
				sandbox,
				name: request.name,
				command,
				args: [...commandArgs, ...modelArguments, ...buildPiArguments(request)],
			});
		} catch (error) {
			try {
				await vcsProvider.removeSandbox(sandbox);
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
	// Keep the startup or launcher failure as the public error; this non-enumerable field is diagnostic only.
	try {
		Object.defineProperty(error, "cleanupError", {
			configurable: true,
			enumerable: false,
			value: cleanupError,
			writable: false,
		});
	} catch {
		// A non-extensible primary error must still be rethrown unchanged.
	}
}

function buildPiArguments(request: ExecutorRequest): string[] {
	const args = [
		"--system-prompt",
		request.systemPrompt,
		"--name",
		request.executorName,
		"--khala-work-id",
		request.workId,
		"--khala-execution-id",
		request.executionId,
		"--khala-project-path",
		request.projectPath,
	];
	if (request.kind === "observer") {
		args.push("--khala-agent-kind", "observer");
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
export { createExecutorStarter };
