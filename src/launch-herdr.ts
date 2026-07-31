import { execFile } from "node:child_process";
import { platform } from "node:os";
import process from "node:process";
import { promisify } from "node:util";
import {
	hasErrorCode,
	type LaunchedSession,
	Launcher,
	type LaunchRequest,
	prepareStartupRequest,
	waitForStartup,
} from "./launcher.js";

const execFileAsync = promisify(execFile);

type HerdrEnvironment = Readonly<{
	// biome-ignore lint/style/useNamingConvention: Match Herdr's exported environment variable.
	HERDR_ENV?: string;
}>;

type HerdrWorktreeOpenResponse = Readonly<{
	result?: Readonly<{
		// biome-ignore lint/style/useNamingConvention: Match Herdr's JSON response field.
		root_pane?: Readonly<{
			// biome-ignore lint/style/useNamingConvention: Match Herdr's JSON response field.
			pane_id?: unknown;
		}>;
	}>;
}>;

class HerdrLauncher extends Launcher {
	override async launch(request: LaunchRequest): Promise<LaunchedSession> {
		const paneId = await launchHerdr(prepareStartupRequest(request));
		let ready: Promise<void> | undefined;
		if (request.startup !== undefined) {
			ready = waitForStartup(request.startup.markerPath);
		}
		return { id: request.sandbox.name, sandbox: request.sandbox, target: paneId, ready };
	}

	override focus(target: string): Promise<void> {
		return focusHerdr(target);
	}

	override close(target: string): Promise<void> {
		return closeHerdr(target);
	}

	override async send(target: string, message: string): Promise<void> {
		await herdr(["agent", "prompt", target, message]);
	}
}

function createHerdrLauncher(): Launcher {
	return new HerdrLauncher();
}

async function launchHerdr(request: LaunchRequest): Promise<string> {
	if (!isHerdrEnvironment()) {
		throw new Error("The Herdr launcher requires an active Herdr-managed pane.");
	}
	// The VCS provider has already created the checkout. Open it through Herdr so the
	// resulting workspace retains Git worktree provenance instead of becoming a plain pane.
	const response = await herdr([
		"worktree",
		"open",
		"--cwd",
		request.sandbox.projectPath,
		"--path",
		request.sandbox.path,
		"--no-focus",
		"--json",
	]);
	const paneId = readRootPaneId(response);
	try {
		await herdr(["pane", "run", paneId, buildShellCommand(request)]);
	} catch (error) {
		try {
			await closeHerdr(paneId);
		} catch {
			// Preserve the command failure; the executor also removes the sandbox on launch failure.
		}
		throw error;
	}
	return paneId;
}

async function focusHerdr(target: string): Promise<void> {
	if (target.length === 0) {
		throw new Error("The Herdr Executor target is empty.");
	}
	// Herdr's agent focus accepts the pane ID hosting a recognized agent and focuses its tab and pane.
	await herdr(["agent", "focus", target]);
}

async function closeHerdr(target: string): Promise<void> {
	if (target.length === 0) {
		throw new Error("The Herdr Executor target is empty.");
	}
	await herdr(["pane", "close", target]);
}

function isHerdrEnvironment(): boolean {
	// biome-ignore lint/style/noProcessEnv: Herdr exposes active-session state through environment variables.
	const herdrEnvironment = process.env as HerdrEnvironment;
	return herdrEnvironment.HERDR_ENV?.trim() === "1";
}

function readRootPaneId(output: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		// biome-ignore lint/style/useErrorCause: Report a stable launcher diagnostic instead of parser internals.
		throw new Error("Herdr worktree open returned invalid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Herdr worktree open returned no root pane.");
	}
	const response = parsed as HerdrWorktreeOpenResponse;
	const paneId = response.result?.root_pane?.pane_id;
	if (typeof paneId !== "string" || paneId.length === 0) {
		throw new Error("Herdr worktree open returned no root pane ID.");
	}
	return paneId;
}

// Herdr's pane run API accepts one shell command rather than argv, so preserve the configured
// argument boundaries explicitly before submitting it to the pane's interactive shell.
function buildShellCommand(request: LaunchRequest): string {
	const arguments_ = [request.command, ...request.args];
	if (platform() === "win32") {
		return buildWindowsShellCommand(arguments_);
	}
	return arguments_.map(quotePosixArgument).join(" ");
}

function buildWindowsShellCommand(arguments_: readonly string[]): string {
	// Herdr submits custom command strings through cmd.exe on Windows. Encode a
	// PowerShell script so arbitrary configured arguments cannot be reparsed by cmd.
	const script = `& ${arguments_.map(quotePowerShellArgument).join(" ")}`;
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function quotePosixArgument(argument: string): string {
	return `'${argument.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellArgument(argument: string): string {
	return `'${argument.replace(/'/g, "''")}'`;
}

async function herdr(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("herdr", args, { encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			let message = errorMessage;
			if (hasErrorCode(error, "ENOENT")) {
				message = "herdr was not found on PATH";
			}
			// The package targets ES2020, whose TypeScript lib omits ErrorOptions.cause.
			// biome-ignore lint/style/useErrorCause: Preserve ES2020 compatibility.
			throw new Error(`herdr ${args.join(" ")} failed: ${message}`);
		}
		throw error;
	}
}

export { createHerdrLauncher };
