import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import {
	hasErrorCode,
	type LaunchedSession,
	Launcher,
	type LaunchRequest,
	prepareStartupRequest,
	waitForExit,
	waitForStartup,
} from "./launcher.js";

const execFileAsync = promisify(execFile);

// Tmux owns terminal placement only. The launched command is already prepared by the shared executor layer.
class TmuxLauncher extends Launcher {
	override async launch(request: LaunchRequest): Promise<LaunchedSession> {
		const target = await launchTmux(prepareStartupRequest(request));
		const { startup } = request;
		if (startup === undefined) {
			return { id: request.sandbox.name, sandbox: request.sandbox, target };
		}
		const ready = waitForStartup(startup.markerPath);
		return {
			id: request.sandbox.name,
			sandbox: request.sandbox,
			target,
			ready,
			exited: waitForExit(startup.markerPath),
		};
	}

	override focus(target: string): Promise<void> {
		return focusTmux(target);
	}

	override close(target: string): Promise<void> {
		return closeTmux(target);
	}
}

function createTmuxLauncher(): Launcher {
	return new TmuxLauncher();
}

async function launchTmux(request: LaunchRequest): Promise<string> {
	if (platform() === "win32") {
		throw new Error("The tmux launcher is unavailable on native Windows; configure a Windows launcher instead.");
	}
	const session = await currentTmuxSession();
	if (session !== undefined) {
		await tmux([
			"new-window",
			"-d",
			"-n",
			request.sandbox.name,
			"-c",
			request.sandbox.path,
			request.command,
			...request.args,
		]);
		return `${session}:${request.sandbox.name}`;
	}

	const newSession = `khala-${request.sandbox.name}`;
	await tmux(["new-session", "-d", "-s", newSession, "-c", request.sandbox.path, request.command, ...request.args]);
	return newSession;
}

async function focusTmux(target: string): Promise<void> {
	if (target.length === 0) {
		throw new Error("The tmux Executor target is empty.");
	}
	if ((await currentTmuxSession()) !== undefined) {
		await tmux(["switch-client", "-t", target]);
		return;
	}
	await tmuxInteractive(["attach-session", "-t", target]);
}

async function closeTmux(target: string): Promise<void> {
	if (target.length === 0) {
		throw new Error("The tmux Executor target is empty.");
	}
	await tmux(["kill-window", "-t", target]);
}

async function currentTmuxSession(): Promise<string | undefined> {
	let session: string | undefined;
	try {
		const currentSession = await tmux(["display-message", "-p", "#{session_name}"]);
		if (currentSession.length > 0) {
			session = currentSession;
		}
	} catch {
		// Failing here means Pi is not inside a tmux session, so create a detached session instead.
	}
	return session;
}

async function tmuxInteractive(args: string[]): Promise<void> {
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("tmux", args, { stdio: "inherit" });
			child.once("error", reject);
			child.once("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`tmux exited with status ${code ?? 1}`));
			});
		});
	} catch (error) {
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			let message = errorMessage;
			if (hasErrorCode(error, "ENOENT")) {
				message = "tmux was not found on PATH";
			}
			// The package targets ES2020, whose TypeScript lib omits ErrorOptions.cause.
			// biome-ignore lint/style/useErrorCause: Preserve ES2020 compatibility.
			throw new Error(`tmux ${args.join(" ")} failed: ${message}`);
		}
		throw error;
	}
}

async function tmux(args: string[]): Promise<string> {
	try {
		// execFile passes argv directly; no Bash, shell quoting, or platform shell syntax is involved.
		const result = await execFileAsync("tmux", args, { encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			let message = errorMessage;
			if (hasErrorCode(error, "ENOENT")) {
				message = "tmux was not found on PATH";
			}
			// The package targets ES2020, whose TypeScript lib omits ErrorOptions.cause.
			// biome-ignore lint/style/useErrorCause: Preserve ES2020 compatibility.
			throw new Error(`tmux ${args.join(" ")} failed: ${message}`);
		}
		throw error;
	}
}

export { createTmuxLauncher };
