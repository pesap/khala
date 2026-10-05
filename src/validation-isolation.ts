import { type ChildProcess, fork } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import Value from "typebox/value";
import type { JsonValue } from "./model.js";
import { readProcessStartTime, terminateProcessGroup } from "./runtime-process.js";

const VALIDATION_TIMEOUT_MS = 120_000;
const VALIDATION_MAX_BUFFER = 8_000_000;
const outputSchema = Type.Object({ stdout: Type.String(), stderr: Type.String(), error: Type.Optional(Type.String()) });
const messageSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("output"),
		stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
		text: Type.String({ maxLength: 4_000 }),
	}),
	Type.Object({ kind: Type.Literal("result"), ...outputSchema.properties }),
]);

export type IsolatedCommandInput = Readonly<{
	command: string;
	args: readonly string[];
	cwd: string;
	path: string;
	lang: string;
	home: string;
	temporary: string;
	readonlyPaths: readonly string[];
	maxBuffer: number;
	npmCache?: string | undefined;
}>;
export type IsolatedCommandOutput = Readonly<Static<typeof outputSchema>>;
export type IsolatedCommandMessage = Readonly<Static<typeof messageSchema>>;
type IsolatedCommandOptions = Readonly<{
	command: string;
	args: readonly string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
	resolverEnvironment: NodeJS.ProcessEnv;
	npmPackageRoot: string | undefined;
	npmCache: string | undefined;
}>;

export class CommandExecutionError extends Error {
	readonly stdout: string;
	readonly stderr: string;

	constructor(message: string, stdout: string, stderr: string) {
		super(message);
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export async function executeIsolatedCommand(
	input: IsolatedCommandOptions,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	requireSupportedPlatform();
	signal?.throwIfAborted();
	const privateRoot = await createPrivateRoot();
	try {
		const home = join(privateRoot, "home");
		const temporary = join(privateRoot, "tmp");
		await Promise.all([mkdir(home), mkdir(temporary)]);
		const npmBin = await createNpmAliases(input.npmPackageRoot, privateRoot);
		const request = await validationRequest(input, home, temporary, npmBin);
		requireLiteralPaths(request);
		return await invokeWorker(request, input.resolverEnvironment, signal);
	} finally {
		await rm(privateRoot, { recursive: true, force: true });
	}
}

function requireSupportedPlatform(): void {
	if (process.platform !== "linux" && process.platform !== "darwin")
		throw new Error("Validation isolation supports Linux and macOS; Windows validation is unsupported.");
}

async function createPrivateRoot(): Promise<string> {
	// macOS's per-user temp path leaves too little room for the SDK's Unix socket names.
	const parent = process.platform === "darwin" ? "/tmp" : tmpdir();
	return realpath(await mkdtemp(join(parent, "khala-validation-")));
}

async function createNpmAliases(npmPackageRoot: string | undefined, privateRoot: string): Promise<string | undefined> {
	if (npmPackageRoot === undefined) return undefined;
	// Resolving the host npm symlink loses its command name. Expose only the selected package's CLI aliases.
	const bin = join(privateRoot, "bin");
	await mkdir(bin);
	await Promise.all(
		["npm", "npx"].map((name) => symlink(join(npmPackageRoot, "bin", `${name}-cli.js`), join(bin, name))),
	);
	return bin;
}

function validationExecutablePath(input: IsolatedCommandOptions, npmBin: string | undefined): string {
	const path = input.environment["PATH"] ?? "/usr/bin:/bin";
	if (npmBin === undefined) return path;
	const workspaceBin = join(input.cwd, "node_modules", ".bin");
	return [workspaceBin, npmBin, ...path.split(delimiter).filter((entry) => entry !== workspaceBin)].join(delimiter);
}

async function validationRequest(
	input: IsolatedCommandOptions,
	home: string,
	temporary: string,
	npmBin: string | undefined,
): Promise<IsolatedCommandInput> {
	return {
		command: input.command,
		args: input.args,
		cwd: input.cwd,
		path: validationExecutablePath(input, npmBin),
		lang: input.environment["LANG"] ?? "C",
		home,
		temporary,
		readonlyPaths: [
			...(await readonlyRuntimePaths()),
			...(input.npmPackageRoot === undefined ? [] : [input.npmPackageRoot]),
			...(npmBin === undefined ? [] : [npmBin]),
		],
		maxBuffer: VALIDATION_MAX_BUFFER,
		npmCache: input.npmCache,
	};
}

async function readonlyRuntimePaths(): Promise<readonly string[]> {
	const paths =
		process.platform === "darwin"
			? ["/usr", "/bin", "/sbin", "/System/Library", "/private/var/select/sh"]
			: ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
	if (process.platform === "linux") {
		// The SDK executes its bundled seccomp helper inside the denied host filesystem.
		const manifest = findPackageJSON("@anthropic-ai/sandbox-runtime", import.meta.url);
		if (manifest === undefined) throw new Error("Validation isolation runtime package was not found.");
		paths.push(await realpath(dirname(manifest)));
	}
	return [...paths, process.execPath];
}

function requireLiteralPaths(input: IsolatedCommandInput): void {
	const paths = [input.cwd, input.home, input.temporary, ...input.readonlyPaths];
	if (input.npmCache !== undefined) paths.push(input.npmCache);
	for (const path of paths)
		if (/[?*[\]\\]/u.test(path)) throw new Error("Validation isolation requires paths without glob characters.");
}

async function invokeWorker(
	input: IsolatedCommandInput,
	resolverEnvironment: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
	const child = createWorker(input, resolverEnvironment, signal);
	const startTime = readProcessStartTime(child.pid);
	const completed = workerResult(child);
	try {
		sendRequest(child, input, startTime);
		const output = await completed;
		if (output.error !== undefined) throw new CommandExecutionError(output.error, output.stdout, output.stderr);
		return { stdout: output.stdout, stderr: output.stderr };
	} finally {
		await stopWorker(child, startTime);
	}
}

function createWorker(
	input: IsolatedCommandInput,
	resolverEnvironment: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): ChildProcess {
	// The SDK has global state. A fresh helper keeps concurrent Works' policies and cleanup independent.
	const worker = new URL("./validation-worker.js", import.meta.url);
	return fork(fileURLToPath(worker), [], {
		cwd: input.cwd,
		execPath: process.execPath,
		execArgv: [],
		detached: true,
		silent: true,
		timeout: VALIDATION_TIMEOUT_MS,
		killSignal: "SIGKILL",
		signal,
		env: {
			PATH: resolverEnvironment["PATH"] ?? "/usr/bin:/bin",
			LANG: input.lang,
			HOME: input.home,
			TMPDIR: input.temporary,
			TMP: input.temporary,
			TEMP: input.temporary,
		},
	});
}

function workerResult(child: ChildProcess): Promise<IsolatedCommandOutput> {
	return new Promise((resolvePromise, reject) => {
		let response: IsolatedCommandOutput | undefined;
		const output = { stdout: "", stderr: "" };
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
		});
		child.stdout?.resume();
		child.on("message", (message: JsonValue) => {
			try {
				const event = Value.Parse(messageSchema, message);
				if (event.kind === "output") output[event.stream] = `${output[event.stream]}${event.text}`.slice(-4_000);
				else response = event;
			} catch (error) {
				reject(error);
			}
		});
		child.once("error", (error: Error) => {
			reject(new CommandExecutionError(error.message, output.stdout, `${output.stderr}${stderr}`.slice(-4_000)));
		});
		child.once("close", (code, terminationSignal) => {
			if (response !== undefined && code === 0) resolvePromise(response);
			else
				reject(
					new CommandExecutionError(
						`Validation isolation helper failed (${String(terminationSignal ?? code)}).`,
						output.stdout,
						`${output.stderr}${stderr}`.slice(-4_000),
					),
				);
		});
	});
}

function sendRequest(child: ChildProcess, input: IsolatedCommandInput, startTime: string | undefined): void {
	if (startTime !== undefined) child.send(input);
	else if (child.connected) child.disconnect();
}

async function stopWorker(child: ChildProcess, startTime: string | undefined): Promise<void> {
	if (child.pid !== undefined && startTime !== undefined)
		await terminateProcessGroup(child.pid, startTime, child.exitCode !== null || child.signalCode !== null);
}
