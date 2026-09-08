import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { type KeyObject, sign } from "node:crypto";
import { unlink } from "node:fs/promises";
import process from "node:process";
import { nanoid } from "nanoid";
import type { RuntimeBinding } from "./ports.js";
import { removeLaunchLeaseSync, reserveLaunch, writeCapabilityFile, writeLaunchLease } from "./runtime-lease.js";
import { childEnvironment, readProcessStartTime } from "./runtime-process.js";
import { readSessionText, removeEphemeralSession, terminateChild } from "./runtime-protocol.js";
import type { RuntimeStorage } from "./runtime-storage.js";
import type {
	CapabilityScopeInput,
	MutableChild,
	PiRuntimeOptions,
	RpcResponse,
	SessionInput,
	SessionLaunch,
} from "./runtime-types.js";

const DEFAULT_MAX_RPC_FRAME_BYTES = 8 * 1024 * 1024;
export const SUPPORTED_NATIVE_PI_VERSION = "0.85.0";
const VERSION_CHECK_TIMEOUT_MS = 10_000;
const nativeVersionChecks = new Map<string, Promise<void>>();

export function createSessionLaunch(
	input: SessionInput,
	options: PiRuntimeOptions,
	storage: RuntimeStorage,
): SessionLaunch {
	const sessionPath = storage.ownedPath(input.sessionPath ?? storage.ephemeralSessionPath());
	const capabilityNonce = sessionCapabilityNonce(input);
	const capabilityToken = createSessionCapability(input, options, capabilityNonce);
	const capabilityFile = sessionCapabilityFile(capabilityToken, storage);
	const processMarker = nanoid();
	return {
		sessionPath,
		args: sessionArguments(input, options, sessionPath),
		capabilityNonce,
		capabilityToken,
		capabilityFile,
		environment: sessionEnvironment(input, options, capabilityFile, capabilityNonce, processMarker),
		processMarker,
		storage,
	};
}

function sessionArguments(input: SessionInput, options: PiRuntimeOptions, sessionPath: string): string[] {
	return [
		...options.command.slice(1),
		"--mode",
		"rpc",
		"--model",
		input.model,
		"--thinking",
		input.thinking,
		"--session",
		sessionPath,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		// Keep native repository guidance: disabling context files also hides the assigned workspace's AGENTS.md.
		...toolArguments(input.tools),
		...extensionArguments(options.extensionPath),
		"--khala-role",
		input.role,
	];
}

function toolArguments(tools: readonly string[]): readonly string[] {
	return tools.length === 0 ? ["--no-tools"] : ["--tools", tools.join(",")];
}

function extensionArguments(extensionPath: string | undefined): readonly string[] {
	return extensionPath === undefined ? [] : ["--extension", extensionPath];
}

function sessionCapabilityNonce(input: SessionInput): string | undefined {
	return input.tools.length === 0 ? undefined : (input.bindingScope?.nonce ?? nanoid());
}

function sessionCapabilityFile(token: string | undefined, storage: RuntimeStorage): string | undefined {
	return token === undefined ? undefined : storage.capabilityFilePath();
}

function createSessionCapability(
	input: SessionInput,
	options: PiRuntimeOptions,
	capabilityNonce: string | undefined,
): string | undefined {
	if (input.tools.length === 0) return undefined;
	const token = createCapability(
		options.authorityPrivateKey,
		input.role,
		capabilityScopeForInput(input, capabilityNonce),
	);
	if (token === undefined) throw new Error("This runtime cannot launch a governed child without an authority key.");
	return token;
}

function capabilityScopeForInput(input: SessionInput, nonce: string | undefined): CapabilityScopeInput {
	return { workId: input.bindingScope?.workId, executionId: input.bindingScope?.executionId, nonce };
}

function sessionEnvironment(
	input: SessionInput,
	options: PiRuntimeOptions,
	capabilityFile: string | undefined,
	capabilityNonce: string | undefined,
	processMarker: string,
): NodeJS.ProcessEnv {
	const environment = childEnvironment({
		...process.env,
		...options.baseEnvironment,
		KHALA_ALLOWED_PATHS: input.allowedPaths === undefined ? undefined : JSON.stringify(input.allowedPaths),
		KHALA_SANDBOX_ROOT: input.sandboxRoot,
		KHALA_BOUND_WORK_ID: input.bindingScope?.workId,
		KHALA_BOUND_EXECUTION_ID: input.bindingScope?.executionId,
		KHALA_PROCESS_MARKER: processMarker,
	});
	delete environment["KHALA_ROLE_TOKEN"];
	delete environment["KHALA_ROLE_TOKEN_FILE"];
	delete environment["KHALA_ROLE_NONCE"];
	addCapabilityEnvironment(environment, capabilityFile, capabilityNonce);
	return environment;
}

function addCapabilityEnvironment(
	environment: NodeJS.ProcessEnv,
	capabilityFile: string | undefined,
	capabilityNonce: string | undefined,
): void {
	if (capabilityFile !== undefined) environment["KHALA_ROLE_TOKEN_FILE"] = capabilityFile;
	if (capabilityNonce !== undefined) environment["KHALA_ROLE_NONCE"] = capabilityNonce;
}

export async function prepareSessionLaunch(input: SessionInput, launch: SessionLaunch): Promise<void> {
	try {
		await prepareSessionPath(input, launch);
		await writeSessionCapability(launch);
	} catch (error) {
		await removeSessionCapability(launch);
		throw error;
	}
}

async function prepareSessionPath(input: SessionInput, launch: SessionLaunch): Promise<void> {
	await launch.storage.prepare();
	await launch.storage.prepareSessionFile(launch.sessionPath);
	if (input.sessionPath !== undefined)
		await reserveLaunch(launch.sessionPath, launch.capabilityFile, launch.processMarker, launch.storage);
}

async function writeSessionCapability(launch: SessionLaunch): Promise<void> {
	if (launch.capabilityFile !== undefined && launch.capabilityToken !== undefined)
		await writeCapabilityFile(launch.capabilityFile, launch.capabilityToken, launch.storage);
}

export async function removeSessionCapability(launch: SessionLaunch): Promise<void> {
	if (launch.capabilityFile !== undefined) await unlink(launch.capabilityFile).catch(() => undefined);
}

export function verifyNativePiVersion(command: readonly string[], cwd: string): Promise<void> {
	const executable = command[0];
	if (executable === undefined) return Promise.reject(new Error("Pi command is required."));
	const key = JSON.stringify({ command, cwd });
	const cached = nativeVersionChecks.get(key);
	if (cached !== undefined) return cached;
	const check = new Promise<void>((resolve, reject) => {
		execFile(
			executable,
			[...command.slice(1), "--version"],
			{ cwd, timeout: VERSION_CHECK_TIMEOUT_MS, killSignal: "SIGKILL", env: { ...process.env, PI_OFFLINE: "1" } },
			(error, stdout, stderr) => completeNativeVersionCheck(error, stdout, stderr, resolve, reject),
		);
	});
	nativeVersionChecks.set(key, check);
	return check;
}

function completeNativeVersionCheck(
	error: Error | null,
	stdout: string,
	stderr: string,
	resolve: () => void,
	reject: (error: Error) => void,
): void {
	if (error !== null) {
		reject(new Error(`Pi native version check failed: ${error.message}`));
		return;
	}
	const actual = stdout.trim();
	if (actual === SUPPORTED_NATIVE_PI_VERSION) {
		resolve();
		return;
	}
	reject(nativeVersionMismatch(actual, stderr));
}

function nativeVersionMismatch(actual: string, stderr: string): Error {
	const received = actual.length > 0 ? actual : stderr.trim().length > 0 ? stderr.trim() : "no version";
	return new Error(`Unsupported Pi native version: expected ${SUPPORTED_NATIVE_PI_VERSION}, received ${received}.`);
}

function spawnSessionProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
	return spawn(command, args, {
		cwd,
		detached: process.platform !== "win32",
		env: environment,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

export async function spawnSessionSafely(
	command: string | undefined,
	launch: SessionLaunch,
	input: SessionInput,
): Promise<ChildProcessWithoutNullStreams> {
	if (command === undefined) throw new Error("Pi command is required.");
	try {
		return spawnSessionProcess(command, launch.args, input.cwd, launch.environment);
	} catch (error) {
		await removeSessionCapability(launch);
		if (input.sessionPath !== undefined)
			removeLaunchLeaseSync(launch.sessionPath, launch.processMarker, launch.storage);
		throw error;
	}
}

export function startupSessionId(state: RpcResponse, sessionPath: string, storage: RuntimeStorage): string {
	if (!state.success) throw new Error(state.error ?? "Pi did not return its session state.");
	const sessionId = readSessionText(state.data, "sessionId");
	const reportedSessionPath = storage.ownedPath(readSessionText(state.data, "sessionFile"));
	if (reportedSessionPath !== sessionPath)
		throw new Error("Pi returned a session file outside the runtime-owned session path.");
	return sessionId;
}

export function assertChildRunning(child: MutableChild): void {
	if ([child.closed, child.process.exitCode !== null, child.process.signalCode !== null].some(Boolean))
		throw new Error("Pi child exited during session startup.");
}

export async function writePersistentLaunchLease(
	input: SessionInput,
	launch: SessionLaunch,
	child: MutableChild,
): Promise<void> {
	if (input.sessionPath !== undefined)
		await writeLaunchLease(launch.sessionPath, child.binding, launch.capabilityFile, launch.storage);
}

export async function cleanupStartingChild(launch: SessionLaunch, child: MutableChild): Promise<void> {
	await removeSessionCapability(launch);
	await terminateChild(child);
	removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker, launch.storage);
	removeEphemeralSession(child);
}

export function createStartingChild(
	process: ChildProcessWithoutNullStreams,
	input: SessionInput,
	launch: SessionLaunch,
	options: PiRuntimeOptions,
): MutableChild {
	const binding: RuntimeBinding = {
		sessionId: "starting",
		sessionPath: launch.sessionPath,
		processGroupId: process.pid,
		processStartTime: readProcessStartTime(process.pid),
		capabilityNonce: launch.capabilityNonce,
		processMarker: launch.processMarker,
		promptIdentity: input.promptIdentity,
	};
	return {
		process,
		pending: new Map(),
		binding,
		agentTimeoutMs: input.agentTimeoutMs,
		maxRpcFrameBytes: options.maxRpcFrameBytes ?? DEFAULT_MAX_RPC_FRAME_BYTES,
		buffer: Buffer.alloc(0),
		lastOutput: "",
		turnUsage: undefined,
		turnAllowance: undefined,
		allowanceStop: undefined,
		rpcTimeoutMs: options.rpcTimeoutMs ?? 10_000,
		lastError: "",
		closed: false,
		sending: false,
		lastAgentEnd: undefined,
		resolveAgentEnd: undefined,
		rejectAgentEnd: undefined,
		agentTimer: undefined,
		ephemeralSession: input.sessionPath === undefined,
		storage: launch.storage,
		remove: undefined,
		cleanupPromise: undefined,
		invocationWriter: undefined,
	};
}

type CapabilityScope = Readonly<{
	role: "conclave" | "observer" | "executor" | "oracle";
	workId: string | undefined;
	executionId: string | undefined;
	nonce: string | undefined;
}>;

function capabilityScope(
	role: CapabilityScope["role"],
	scope:
		| Readonly<{ workId?: string | undefined; executionId?: string | undefined; nonce?: string | undefined }>
		| undefined,
): CapabilityScope {
	return {
		role,
		workId: scope?.workId,
		executionId: scope?.executionId,
		nonce: scope?.nonce,
	} satisfies CapabilityScope;
}

function createCapability(
	privateKey: KeyObject | undefined,
	role: "conclave" | "observer" | "executor" | "oracle",
	scope:
		| Readonly<{ workId?: string | undefined; executionId?: string | undefined; nonce?: string | undefined }>
		| undefined,
): string | undefined {
	if (privateKey === undefined) return;
	const payload = Buffer.from(JSON.stringify(capabilityScope(role, scope)), "utf8").toString("base64url");
	const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
	return `${payload}.${signature}`;
}
