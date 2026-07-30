import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { hasErrorCode, type LaunchedSession, Launcher, type LaunchRequest } from "./launcher.js";

const execFileAsync = promisify(execFile);

type ZellijEnvironment = Readonly<{
	// biome-ignore lint/style/useNamingConvention: Match Zellij's exported environment variable.
	ZELLIJ?: string;
	// biome-ignore lint/style/useNamingConvention: Match Zellij's exported environment variable.
	ZELLIJ_SESSION_NAME?: string;
}>;

// Zellij can only add a tab to the session that owns the calling process. The
// command is passed as argv after `--`, so shell quoting never changes it.
class ZellijLauncher extends Launcher {
	override async launch(request: LaunchRequest): Promise<LaunchedSession> {
		const target = await launchZellij(request);
		return {
			id: request.sandbox.name,
			sandbox: request.sandbox,
			target,
		};
	}

	override focus(target: string): Promise<void> {
		return focusZellij(target);
	}

	override close(target: string): Promise<void> {
		return closeZellij(target);
	}

	override async send(target: string, message: string): Promise<void> {
		const tabId = getZellijTabId(target);
		await zellij(["action", "go-to-tab-by-id", tabId]);
		await zellij(["action", "write-chars", message]);
		await zellij(["action", "write", "13"]);
	}
}

function createZellijLauncher(): Launcher {
	return new ZellijLauncher();
}

async function launchZellij(request: LaunchRequest): Promise<string> {
	// biome-ignore lint/style/noProcessEnv: Zellij exposes active-session state through environment variables.
	const zellijEnvironment = process.env as ZellijEnvironment;
	const zellijMarker = zellijEnvironment.ZELLIJ?.trim();
	if (zellijMarker === undefined || zellijMarker.length === 0) {
		throw new Error("The zellij launcher requires an active zellij session to open a new tab.");
	}

	const tabId = await zellij([
		"action",
		"new-tab",
		"--name",
		request.sandbox.name,
		"--cwd",
		request.sandbox.path,
		"--",
		request.command,
		...request.args,
	]);
	const session = zellijEnvironment.ZELLIJ_SESSION_NAME?.trim();
	if (session === undefined || session.length === 0) {
		return tabId;
	}
	return `${session}:${tabId}`;
}

async function focusZellij(target: string): Promise<void> {
	const tabId = getZellijTabId(target);
	await zellij(["action", "go-to-tab-by-id", tabId]);
}

async function closeZellij(target: string): Promise<void> {
	const tabId = getZellijTabId(target);
	await zellij(["action", "close-tab", "--tab-id", tabId]);
}

function getZellijTabId(target: string): string {
	const separator = target.lastIndexOf(":");
	let tabId = target;
	if (separator >= 0) {
		tabId = target.slice(separator + 1);
	}
	if (tabId.length === 0) {
		throw new Error("The Zellij Executor target is empty.");
	}
	return tabId;
}

async function zellij(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("zellij", args, { encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			let message = errorMessage;
			if (hasErrorCode(error, "ENOENT")) {
				message = "zellij was not found on PATH";
			}
			// The package targets ES2020, whose TypeScript lib omits ErrorOptions.cause.
			// biome-ignore lint/style/useErrorCause: Preserve ES2020 compatibility.
			throw new Error(`zellij ${args.join(" ")} failed: ${message}`);
		}
		throw error;
	}
}

export { createZellijLauncher };
