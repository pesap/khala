import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { JsonObject, JsonValue, PromptIdentity, TokenUsage } from "./model.js";
import type { AgentRuntimePort, OperationContext, RuntimeBinding, RuntimeState, RuntimeTurn } from "./ports.js";

export type PiRuntimeOptions = Readonly<{
	command: readonly string[];
	extensionPath?: string | undefined;
	baseEnvironment?: NodeJS.ProcessEnv | undefined;
	authorityPrivateKey?: KeyObject | undefined;
	rpcTimeoutMs?: number | undefined;
	agentTimeoutMs?: number | undefined;
}>;

type RpcData = Readonly<{
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	isStreaming?: boolean | undefined;
}>;

type RpcBlock = Readonly<{
	type?: string | undefined;
	text?: string | undefined;
}>;

type RpcUsage = Readonly<{
	input?: number | undefined;
	output?: number | undefined;
	cacheRead?: number | undefined;
	cacheWrite?: number | undefined;
}>;

type RpcMessage = Readonly<{
	role?: string | undefined;
	content?: readonly RpcBlock[] | undefined;
	usage?: RpcUsage | undefined;
}>;

type RpcEvent = Readonly<{
	type?: string | undefined;
	id?: string | undefined;
	command?: string | undefined;
	success?: boolean | undefined;
	data?: RpcData | undefined;
	error?: string | undefined;
	message?: RpcMessage | undefined;
}>;

type RpcResponse = Readonly<{
	type: "response";
	id?: string | undefined;
	command: string;
	success: boolean;
	data?: RpcData | undefined;
	error?: string | undefined;
}>;

type PendingResponse = Readonly<{
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}>;

type MutableChild = {
	process: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingResponse>;
	binding: RuntimeBinding;
	agentTimeoutMs: number | undefined;
	buffer: string;
	lastOutput: string;
	turnUsage: TokenUsage | undefined;
	lastError: string;
	closed: boolean;
	sending: boolean;
	lastAgentEnd: Promise<string> | undefined;
	resolveAgentEnd: ((output: string) => void) | undefined;
	rejectAgentEnd: ((error: Error) => void) | undefined;
	agentTimer: NodeJS.Timeout | undefined;
	ephemeralSession: boolean;
};

type RpcCommandData = Readonly<{ message?: string | undefined }>;
type SessionInput = Parameters<AgentRuntimePort["ensureSession"]>[0];
type CapabilityScopeInput = Readonly<{
	workId?: string | undefined;
	executionId?: string | undefined;
	nonce?: string | undefined;
}>;
type SessionLaunch = Readonly<{
	sessionPath: string;
	args: string[];
	capabilityNonce: string | undefined;
	capabilityToken: string | undefined;
	capabilityFile: string | undefined;
	environment: NodeJS.ProcessEnv;
	processMarker: string;
}>;
type RpcEventType = "response" | "message_end" | "agent_settled";
const RPC_EVENT_TYPES: ReadonlyMap<string, RpcEventType> = new Map([
	["response", "response"],
	["message_end", "message_end"],
	["agent_settled", "agent_settled"],
]);

export class PiRpcRuntime implements AgentRuntimePort {
	private readonly children = new Map<string, MutableChild>();
	private readonly sessionLaunches = new Map<string, Promise<RuntimeBinding>>();
	private readonly launches = new Set<Promise<RuntimeBinding>>();
	private readonly options: PiRuntimeOptions;
	private closing = false;

	constructor(options: PiRuntimeOptions) {
		this.options = options;
	}

	async ensureSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation?: OperationContext,
	): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		throwIfAborted(operation);
		return input.sessionPath === undefined
			? this.trackLaunch(this.startSessionWithRetry(input, operation))
			: this.ensurePersistentSession(input, operation);
	}

	private ensurePersistentSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const sessionPath = input.sessionPath ?? "";
		const active = this.sessionLaunches.get(sessionPath);
		return active === undefined
			? this.startPersistentSession(input, sessionPath, operation)
			: awaitOperation(active, operation);
	}

	private startPersistentSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		sessionPath: string,
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const launch = this.trackLaunch(this.startSessionWithRetry(input, operation));
		this.sessionLaunches.set(sessionPath, launch);
		return launch.finally(() => {
			if (this.sessionLaunches.get(sessionPath) === launch) this.sessionLaunches.delete(sessionPath);
		});
	}

	private async startSessionWithRetry(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		try {
			return await this.startSession(input, operation);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTransientStartupFailure(message)) throw error;
			return this.startSession(input, operation);
		}
	}
	private async startSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		throwIfAborted(operation);
		const launch = createSessionLaunch(input, this.options);
		await prepareSessionLaunch(input, launch);
		const childProcess = await spawnSessionSafely(this.options.command[0] ?? "pi", launch, input);
		const child = createStartingChild(childProcess, input, launch);
		await this.registerStartingChild(input, launch, child);
		return this.completeSessionStartup(input, launch, child, operation);
	}

	private async registerStartingChild(input: SessionInput, launch: SessionLaunch, child: MutableChild): Promise<void> {
		try {
			if (this.closing) throw new Error("Pi runtime is closed.");
			await writePersistentLaunchLease(input, launch, child);
		} catch (error) {
			await cleanupStartingChild(launch, child);
			throw error;
		}
	}

	private async completeSessionStartup(
		input: SessionInput,
		launch: SessionLaunch,
		child: MutableChild,
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const key = `child-${++childCounter}`;
		this.children.set(key, child);
		attachOutput(child, () => this.removeChild(child));
		try {
			const state = await request(child, "get_state", {}, rpcTimeout(this.options.rpcTimeoutMs), operation?.signal);
			const sessionId = startupSessionId(state, launch.sessionPath);
			await protectSessionFile(launch.sessionPath);
			assertChildRunning(child);
			await removeSessionCapability(launch);
			child.binding = { ...child.binding, sessionId, promptIdentity: input.promptIdentity };
			this.children.delete(key);
			this.children.set(sessionId, child);
			return child.binding;
		} catch (error) {
			this.children.delete(key);
			await removeSessionCapability(launch);
			killChild(child);
			removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
			removeEphemeralSession(child);
			throw error;
		}
	}
	async send(binding: RuntimeBinding, message: string, operation?: OperationContext): Promise<RuntimeTurn> {
		const child = this.requireChild(binding);
		if (child.sending) throw new Error(`Pi session ${binding.sessionId} is already processing a prompt.`);
		throwIfAborted(operation);
		return this.sendTurn(child, message, operation);
	}

	private async sendTurn(
		child: MutableChild,
		message: string,
		operation: OperationContext | undefined,
	): Promise<RuntimeTurn> {
		child.turnUsage = undefined;
		child.lastOutput = "";
		child.sending = true;
		const completion = waitForAgentSettled(child, agentTimeout(child, this.options.agentTimeoutMs));
		const abortHandler = createAbortHandler(child, operation, rpcTimeout(this.options.rpcTimeoutMs));
		registerAbortHandler(operation, abortHandler);
		void completion.catch(() => undefined);
		try {
			await sendPrompt(child, message, rpcTimeout(this.options.rpcTimeoutMs), operation?.signal);
			return await completedTurn(child, completion);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			await failTurn(child, completion, failure);
			throw failure;
		} finally {
			removeAbortHandler(operation, abortHandler);
			child.sending = false;
		}
	}
	async getState(binding: RuntimeBinding, operation?: OperationContext): Promise<RuntimeState> {
		throwIfAborted(operation);
		const child = this.children.get(binding.sessionId);
		if (child === undefined || !sameBindingIdentity(binding, child.binding)) return "unreachable";
		if (child.sending) return "working";
		return this.readChildState(child, operation);
	}

	private async readChildState(child: MutableChild, operation: OperationContext | undefined): Promise<RuntimeState> {
		try {
			const response = await request(child, "get_state", {}, this.options.rpcTimeoutMs ?? 10_000, operation?.signal);
			return childRuntimeState(response);
		} catch {
			throwIfAborted(operation);
			killChild(child);
			this.removeChild(child);
			return "unreachable";
		}
	}

	async requestStop(binding: RuntimeBinding): Promise<void> {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			await stopUnattachedBinding(binding);
			return;
		}
		if (!sameBindingIdentity(binding, child.binding)) return;
		try {
			await request(child, "abort", {}, this.options.rpcTimeoutMs ?? 10_000);
		} finally {
			killChild(child);
			this.removeChild(child);
		}
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		await Promise.allSettled(this.launches);
		for (const child of this.children.values()) {
			rejectAgentEnd(child, new Error("Pi runtime closed."));
			killChild(child);
			this.removeChild(child);
		}
		this.children.clear();
	}

	private trackLaunch(launch: Promise<RuntimeBinding>): Promise<RuntimeBinding> {
		this.launches.add(launch);
		void launch.finally(() => this.launches.delete(launch)).catch(() => undefined);
		return launch;
	}

	private removeChild(child: MutableChild): void {
		removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
		removeEphemeralSession(child);
		for (const [key, value] of this.children) {
			if (value === child) {
				this.children.delete(key);
			}
		}
	}

	private requireChild(binding: RuntimeBinding): MutableChild {
		const child = this.children.get(binding.sessionId);
		if (child === undefined || !sameBindingIdentity(binding, child.binding)) {
			throw new Error(`Pi session ${binding.sessionId} is not attached with the supplied binding.`);
		}
		return child;
	}
}

function removeEphemeralSession(child: MutableChild): void {
	if (!child.ephemeralSession || child.binding.sessionPath.length === 0) return;
	try {
		unlinkSync(child.binding.sessionPath);
	} catch {
		// The child may have removed its session file already.
	}
}

function attachOutput(child: MutableChild, onExit: () => void): void {
	const decoder = new StringDecoder("utf8");
	child.process.stdout.on("data", (chunk: Buffer) => {
		child.buffer += decoder.write(chunk);
		consumeLines(child);
	});
	child.process.stderr.on("data", (chunk: Buffer) => {
		child.lastError = `${child.lastError}${chunk.toString("utf8")}`.slice(-4000);
	});
	let exited = false;
	const cleanupAfterExit = (): void => {
		if (exited) return;
		exited = true;
		// A detached child can leave shells or tools behind after its own exit.
		// Kill its owned group before dropping the binding so recovery cannot race those descendants.
		killExitedProcessGroup(child);
		onExit();
	};
	child.process.stdin.on("error", (error) => {
		child.closed = true;
		child.lastError = `${child.lastError}${error.message}`.slice(-4000);
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		cleanupAfterExit();
	});
	child.process.on("error", (error) => {
		child.closed = true;
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		cleanupAfterExit();
	});
	child.process.on("exit", () => {
		child.closed = true;
		const detail = child.lastError.trim();
		const error = new Error(detail.length === 0 ? "Pi child exited before responding." : `Pi child exited: ${detail}`);
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		cleanupAfterExit();
	});
}
function consumeLines(child: MutableChild): void {
	let line = nextLine(child);
	while (line !== undefined) {
		consumeLine(child, line);
		line = nextLine(child);
	}
}

function nextLine(child: MutableChild): string | undefined {
	const newline = child.buffer.indexOf("\n");
	if (newline < 0) return undefined;
	const line = child.buffer.slice(0, newline).replace(/\r$/, "");
	child.buffer = child.buffer.slice(newline + 1);
	return line.trim().length === 0 ? nextLine(child) : line;
}

function consumeLine(child: MutableChild, line: string): void {
	const event = parseRpcEvent(line);
	if (event === undefined) return;
	const type = RPC_EVENT_TYPES.get(event.type ?? "");
	if (type === undefined) return;
	dispatchRpcEvent(child, event, type);
}

function dispatchRpcEvent(child: MutableChild, event: RpcEvent, type: RpcEventType): void {
	if (type === "response") consumeResponse(child, event);
	if (type === "message_end") consumeMessage(child, event);
	if (type === "agent_settled") resolveAgentEnd(child);
}

function parseRpcEvent(line: string): RpcEvent | undefined {
	try {
		// SAFETY: Pi RPC emits one JSON object per LF-delimited event; consumers validate required fields below.
		return JSON.parse(line) as RpcEvent;
	} catch {
		return undefined;
	}
}

function consumeResponse(child: MutableChild, event: RpcEvent): void {
	try {
		const response = readResponse(event);
		if (response.id !== undefined) resolvePendingResponse(child, response.id, response);
	} catch {
		// Ignore malformed responses and continue consuming the stream.
	}
}

function resolvePendingResponse(child: MutableChild, id: string, response: RpcResponse): void {
	const pending = child.pending.get(id);
	if (pending === undefined) return;
	child.pending.delete(id);
	clearTimeout(pending.timer);
	pending.resolve(response);
}

function consumeMessage(child: MutableChild, event: RpcEvent): void {
	if (!isAssistantMessage(event.message)) return;
	child.lastOutput = assistantText(event.message);
	const usage = readTokenUsage(event.message.usage);
	if (usage !== undefined) child.turnUsage = addTokenUsage(child.turnUsage, usage);
}

let requestCounter = 0;
let childCounter = 0;

type LaunchLease = Readonly<{
	processGroupId?: number | undefined;
	processStartTime?: string | undefined;
	capabilityFile?: string | undefined;
	processMarker?: string | undefined;
	ownerProcessId?: number | undefined;
	createdAt?: number | undefined;
}>;

const LAUNCH_INTENT_STALE_MS = 60_000;

function ephemeralSessionPath(): string {
	return join(tmpdir(), "khala-sessions", `khala-ephemeral-${randomUUID()}.jsonl`);
}

function capabilityFilePath(): string {
	return join(tmpdir(), `khala-capability-${randomUUID()}`);
}

function createSessionLaunch(input: SessionInput, options: PiRuntimeOptions): SessionLaunch {
	const sessionPath = input.sessionPath ?? ephemeralSessionPath();
	const capabilityNonce = sessionCapabilityNonce(input);
	const capabilityToken = createSessionCapability(input, options, capabilityNonce);
	const capabilityFile = sessionCapabilityFile(capabilityToken);
	const processMarker = randomUUID();
	return {
		sessionPath,
		args: sessionArguments(input, options, sessionPath),
		capabilityNonce,
		capabilityToken,
		capabilityFile,
		environment: sessionEnvironment(input, options, capabilityFile, capabilityNonce, processMarker),
		processMarker,
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
	return input.tools.length === 0 ? undefined : (input.bindingScope?.nonce ?? randomUUID());
}

function sessionCapabilityFile(token: string | undefined): string | undefined {
	return token === undefined ? undefined : capabilityFilePath();
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

async function prepareSessionLaunch(input: SessionInput, launch: SessionLaunch): Promise<void> {
	try {
		await prepareSessionPath(input, launch);
		await writeSessionCapability(launch);
	} catch (error) {
		await removeSessionCapability(launch);
		throw error;
	}
}

async function prepareSessionPath(input: SessionInput, launch: SessionLaunch): Promise<void> {
	if (input.sessionPath === undefined) await mkdir(dirname(launch.sessionPath), { recursive: true });
	if (input.sessionPath !== undefined)
		await reserveLaunch(launch.sessionPath, launch.capabilityFile, launch.processMarker);
}

async function writeSessionCapability(launch: SessionLaunch): Promise<void> {
	if (launch.capabilityFile !== undefined && launch.capabilityToken !== undefined)
		await writeCapabilityFile(launch.capabilityFile, launch.capabilityToken);
}

async function removeSessionCapability(launch: SessionLaunch): Promise<void> {
	if (launch.capabilityFile !== undefined) await unlink(launch.capabilityFile).catch(() => undefined);
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

async function spawnSessionSafely(
	command: string,
	launch: SessionLaunch,
	input: SessionInput,
): Promise<ChildProcessWithoutNullStreams> {
	try {
		return spawnSessionProcess(command, launch.args, input.cwd, launch.environment);
	} catch (error) {
		await removeSessionCapability(launch);
		if (input.sessionPath !== undefined) removeLaunchLeaseSync(launch.sessionPath, launch.processMarker);
		throw error;
	}
}

function startupSessionId(state: RpcResponse, sessionPath: string): string {
	if (!state.success) throw new Error(state.error ?? "Pi did not return its session state.");
	const sessionId = readSessionText(state.data, "sessionId");
	const reportedSessionPath = readSessionText(state.data, "sessionFile");
	if (resolve(reportedSessionPath) !== resolve(sessionPath))
		throw new Error("Pi returned a session file outside the runtime-owned session path.");
	return sessionId;
}

function assertChildRunning(child: MutableChild): void {
	if ([child.closed, child.process.exitCode !== null, child.process.signalCode !== null].some(Boolean))
		throw new Error("Pi child exited during session startup.");
}

async function writePersistentLaunchLease(
	input: SessionInput,
	launch: SessionLaunch,
	child: MutableChild,
): Promise<void> {
	if (input.sessionPath !== undefined) await writeLaunchLease(launch.sessionPath, child.binding, launch.capabilityFile);
}

async function cleanupStartingChild(launch: SessionLaunch, child: MutableChild): Promise<void> {
	await removeSessionCapability(launch);
	killChild(child);
	removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
}

function createStartingChild(
	process: ChildProcessWithoutNullStreams,
	input: SessionInput,
	launch: SessionLaunch,
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
		buffer: "",
		lastOutput: "",
		turnUsage: undefined,
		lastError: "",
		closed: false,
		sending: false,
		lastAgentEnd: undefined,
		resolveAgentEnd: undefined,
		rejectAgentEnd: undefined,
		agentTimer: undefined,
		ephemeralSession: input.sessionPath === undefined,
	};
}

async function writeCapabilityFile(path: string, token: string): Promise<void> {
	await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
async function reserveLaunch(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
): Promise<void> {
	await withLaunchLock(sessionPath, async () => {
		const path = launchLeasePath(sessionPath);
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text !== undefined) await replaceExistingLaunch(path, sessionPath, text);
		await writeLaunchIntentSafely(sessionPath, capabilityFile, processMarker);
	});
}

async function writeLaunchIntentSafely(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
): Promise<void> {
	try {
		await writeLaunchIntent(sessionPath, capabilityFile, processMarker);
	} catch (error) {
		if (error instanceof Error && isExistsError(error))
			throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
		throw error;
	}
}

async function replaceExistingLaunch(path: string, sessionPath: string, text: string): Promise<void> {
	const lease = parseLaunchLease(text);
	await assertLaunchAvailable(path, sessionPath, lease);
	const displacedPath = `${path}.stale-${randomUUID()}`;
	await renameStaleLaunch(path, displacedPath, sessionPath);
	if (lease?.capabilityFile !== undefined) await unlink(lease.capabilityFile).catch(() => undefined);
	await unlink(displacedPath).catch(() => undefined);
}

async function assertLaunchAvailable(path: string, sessionPath: string, lease: LaunchLease | undefined): Promise<void> {
	if (isProcessLease(lease)) {
		assertLiveProcessLease(sessionPath, lease);
		return;
	}
	await assertLaunchIntentAvailable(path, sessionPath, lease);
}

function isProcessLease(lease: LaunchLease | undefined): lease is ProcessLease {
	return lease?.processGroupId !== undefined;
}

type ProcessLease = LaunchLease & Readonly<{ processGroupId: number }>;

function assertLiveProcessLease(sessionPath: string, lease: ProcessLease): void {
	if (leaseIsOwnedByLiveProcess(lease))
		throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
}

function leaseIsOwnedByLiveProcess(lease: ProcessLease): boolean {
	const currentStartTime = readProcessStartTime(lease.processGroupId);
	if (lease.processStartTime === undefined) return processExists(lease.processGroupId);
	return (
		currentStartTime === lease.processStartTime ||
		(currentStartTime === undefined && processExists(lease.processGroupId))
	);
}

async function assertLaunchIntentAvailable(
	path: string,
	sessionPath: string,
	lease: LaunchLease | undefined,
): Promise<void> {
	if (liveLaunchIntent(lease)) throw new Error(`Runtime session ${sessionPath} is already launching.`);
	const createdAt = await launchIntentCreatedAt(path, lease);
	if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
		throw new Error(`Runtime session ${sessionPath} is already launching.`);
}

function liveLaunchIntent(lease: LaunchLease | undefined): boolean {
	return lease?.ownerProcessId !== undefined && processExists(lease.ownerProcessId);
}

async function launchIntentCreatedAt(path: string, lease: LaunchLease | undefined): Promise<number> {
	return lease?.createdAt ?? (await stat(path)).mtimeMs;
}

async function renameStaleLaunch(path: string, displacedPath: string, sessionPath: string): Promise<void> {
	try {
		await rename(path, displacedPath);
	} catch (error) {
		if (error instanceof Error && isMissingFileError(error))
			throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
		throw error;
	}
}

async function withLaunchLock<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${launchLeasePath(sessionPath)}.lock`;
	await mkdir(dirname(lockPath), { recursive: true });
	await acquireLaunchLock(lockPath, sessionPath);
	try {
		return await operation();
	} finally {
		await rmdir(lockPath).catch(() => undefined);
	}
}

async function acquireLaunchLock(lockPath: string, sessionPath: string): Promise<void> {
	try {
		await mkdir(lockPath);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		await replaceStaleLaunchLock(lockPath, sessionPath, error);
	}
}

async function replaceStaleLaunchLock(lockPath: string, sessionPath: string, error: Error): Promise<void> {
	if (!isExistsError(error)) throw error;
	const createdAt = await stat(lockPath)
		.then((entry) => entry.mtimeMs)
		.catch(() => Date.now());
	if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
		throw new Error(`Runtime session ${sessionPath} is already launching.`);
	await rmdir(lockPath).catch(() => undefined);
	await mkdir(lockPath);
}

async function protectSessionFile(sessionPath: string): Promise<void> {
	try {
		await chmod(sessionPath, 0o600);
	} catch (error) {
		if (!(error instanceof Error) || !isMissingFileError(error)) throw error;
	}
}

function isMissingFileError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

function isExistsError(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

function processExists(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

async function writeLaunchIntent(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
): Promise<void> {
	await mkdir(dirname(sessionPath), { recursive: true });
	await writeFile(
		launchLeasePath(sessionPath),
		JSON.stringify({ capabilityFile, processMarker, ownerProcessId: process.pid, createdAt: Date.now() }),
		{
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		},
	);
}
async function writeLaunchLease(
	sessionPath: string,
	binding: RuntimeBinding,
	capabilityFile: string | undefined,
): Promise<void> {
	if (binding.processGroupId === undefined) return;
	const existing = parseLaunchLease(readFileSync(launchLeasePath(sessionPath), "utf8"));
	if (existing?.processMarker !== binding.processMarker) throw new Error("Runtime launch ownership was lost.");
	const leasePath = launchLeasePath(sessionPath);
	const temporaryPath = `${leasePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, launchLeaseJson(binding, capabilityFile, existing), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporaryPath, leasePath);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function launchOwner(existing: LaunchLease | undefined): number {
	return existing?.ownerProcessId ?? process.pid;
}

function launchCreatedAt(existing: LaunchLease | undefined): number {
	return existing?.createdAt ?? Date.now();
}

function launchLeaseJson(
	binding: RuntimeBinding,
	capabilityFile: string | undefined,
	existing: LaunchLease | undefined,
): string {
	return JSON.stringify({
		processGroupId: binding.processGroupId,
		processStartTime: binding.processStartTime,
		capabilityFile,
		processMarker: binding.processMarker,
		ownerProcessId: launchOwner(existing),
		createdAt: launchCreatedAt(existing),
	});
}

function launchLeasePath(sessionPath: string): string {
	return `${sessionPath}.khala-process`;
}
function removeLaunchLeaseSync(sessionPath: string, processMarker?: string): void {
	if (sessionPath.length === 0) return;
	try {
		const existing = parseLaunchLease(readFileSync(launchLeasePath(sessionPath), "utf8"));
		if (leaseBelongsToAnotherProcess(existing, processMarker)) return;
		unlinkSync(launchLeasePath(sessionPath));
	} catch {
		// The lease may already have been removed by normal completion.
	}
}

function leaseBelongsToAnotherProcess(lease: LaunchLease | undefined, processMarker: string | undefined): boolean {
	return processMarker !== undefined && lease?.processMarker !== undefined && lease.processMarker !== processMarker;
}
function parseLaunchLease(text: string): LaunchLease | undefined {
	const parsed = readLaunchLeaseJson(text);
	if (parsed === undefined || !isJsonObject(parsed)) return undefined;
	return launchLeaseFromObject(parsed);
}

function readLaunchLeaseJson(text: string): JsonValue | undefined {
	try {
		// SAFETY: launch lease JSON is parsed and validated as a JsonValue before its fields are read.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

type LaunchLeaseFields = Readonly<{
	capabilityFile: string | undefined;
	processMarker: string | undefined;
	ownerProcessId: number | undefined;
	createdAt: number | undefined;
}>;

function launchLeaseFromObject(parsed: JsonObject): LaunchLease | undefined {
	const fields = readLaunchLeaseFields(parsed);
	if (fields === undefined) return undefined;
	if (isLaunchIntent(parsed)) return launchIntentLease(fields);
	const processGroupId = parsed["processGroupId"];
	const processStartTime = parsed["processStartTime"];
	const process = readLeaseProcess(processGroupId, processStartTime);
	if (process === undefined) return undefined;
	return { ...fields, ...process };
}

function isLaunchIntent(parsed: JsonObject): boolean {
	return parsed["processGroupId"] === undefined && parsed["processStartTime"] === undefined;
}

function readLeaseProcess(
	processGroupId: JsonValue | undefined,
	processStartTime: JsonValue | undefined,
): { processGroupId: number; processStartTime: string | undefined } | undefined {
	if (!validProcessGroup(processGroupId) || !validProcessStartTime(processStartTime)) return undefined;
	return { processGroupId, processStartTime };
}

function readLaunchLeaseFields(parsed: JsonObject): LaunchLeaseFields | undefined {
	const valid = validLaunchLeaseFields(parsed);
	if (!valid) return undefined;
	return {
		capabilityFile: optionalLeaseText(parsed["capabilityFile"]),
		processMarker: optionalLeaseText(parsed["processMarker"]),
		ownerProcessId: optionalLeaseInteger(parsed["ownerProcessId"]),
		createdAt: optionalLeaseInteger(parsed["createdAt"]),
	};
}

function validLaunchLeaseFields(parsed: JsonObject): boolean {
	return [
		validOptionalPositiveInteger(parsed["ownerProcessId"]),
		validOptionalPositiveInteger(parsed["createdAt"]),
		parsed["capabilityFile"] === undefined || isText(parsed["capabilityFile"]),
		parsed["processMarker"] === undefined || isText(parsed["processMarker"]),
	].every(Boolean);
}

function validOptionalPositiveInteger(value: JsonValue | undefined): boolean {
	return value === undefined || (isInteger(value) && value > 0);
}

function optionalLeaseText(value: JsonValue | undefined): string | undefined {
	if (value === undefined) return undefined;
	return isText(value) ? value : undefined;
}

function optionalLeaseInteger(value: JsonValue | undefined): number | undefined {
	if (value === undefined) return undefined;
	return isInteger(value) ? value : undefined;
}

function launchIntentLease(fields: LaunchLeaseFields): LaunchLease {
	return hasLeaseFields(fields) ? fields : {};
}

function hasLeaseFields(fields: LaunchLeaseFields): boolean {
	return [
		fields.capabilityFile !== undefined,
		fields.processMarker !== undefined,
		fields.ownerProcessId !== undefined,
		fields.createdAt !== undefined,
	].some(Boolean);
}

function validProcessGroup(value: JsonValue | undefined): value is number {
	return isInteger(value) && value > 0;
}

function validProcessStartTime(value: JsonValue | undefined): value is string | undefined {
	return value === undefined || (isText(value) && value.length > 0);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function isInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}

const SENSITIVE_ENVIRONMENT_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i;

function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const key of Object.keys(environment)) {
		if (SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
	}
	return environment;
}
function readProcessStartTime(processId: number | undefined): string | undefined {
	if (processId === undefined || process.platform === "win32") return undefined;
	return readUnixProcessStartTime(processId);
}

function readUnixProcessStartTime(processId: number): string | undefined {
	const linuxStartTime = readLinuxProcessStartTime(processId);
	return linuxStartTime ?? readPsProcessStartTime(processId);
}

function readLinuxProcessStartTime(processId: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
		const endOfCommand = stat.lastIndexOf(")");
		return stat
			.slice(endOfCommand + 2)
			.trim()
			.split(/\s+/)[19];
	} catch {
		return undefined;
	}
}

function readPsProcessStartTime(processId: number): string | undefined {
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(processId)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value.length === 0 ? undefined : value;
	} catch {
		return undefined;
	}
}
function killProcessGroup(processGroupId: number | undefined, processStartTime: string | undefined): boolean {
	if (!isKillableProcessGroup(processGroupId, processStartTime)) return false;
	if (process.platform === "win32") return killWindowsProcessGroup(processGroupId);
	return killPosixProcessGroupResult(processGroupId);
}

function isKillableProcessGroup(
	processGroupId: number | undefined,
	processStartTime: string | undefined,
): processGroupId is number {
	if (processGroupId === undefined) return false;
	if (process.platform === "win32") return true;
	return processStartTime !== undefined && readProcessStartTime(processGroupId) === processStartTime;
}

function killWindowsProcessGroup(processGroupId: number): boolean {
	killProcessTree(processGroupId);
	return !processExists(processGroupId);
}

function killPosixProcessGroupResult(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, "SIGKILL");
		return true;
	} catch {
		return !processExists(processGroupId);
	}
}

function isTransientStartupFailure(message: string): boolean {
	return message.includes("Pi child exited") || message.includes("Pi RPC get_state timed out");
}

async function stopUnattachedBinding(binding: RuntimeBinding): Promise<void> {
	if (binding.processGroupId === undefined || !processExists(binding.processGroupId)) {
		removeLaunchLeaseSync(binding.sessionPath, binding.processMarker);
		return;
	}
	if (killProcessGroup(binding.processGroupId, binding.processStartTime))
		removeLaunchLeaseSync(binding.sessionPath, binding.processMarker);
}
function sameBindingIdentity(left: RuntimeBinding, right: RuntimeBinding): boolean {
	return [
		left.sessionId === right.sessionId,
		left.sessionPath === right.sessionPath,
		left.processGroupId === right.processGroupId,
		left.processStartTime === right.processStartTime,
		left.capabilityNonce === right.capabilityNonce,
		left.processMarker === right.processMarker,
	].every(Boolean);
}

function killChild(child: MutableChild): void {
	if (child.binding.processStartTime !== undefined)
		killProcessGroup(child.binding.processGroupId ?? child.process.pid, child.binding.processStartTime);
	else killOwnedProcessGroup(child.process);
	child.process.kill();
	removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
}

function killExitedProcessGroup(child: MutableChild): void {
	const processId = child.binding.processGroupId ?? child.process.pid;
	if (process.platform === "win32") {
		killProcessTree(processId);
		return;
	}
	killPosixProcessGroup(processId);
}

function killPosixProcessGroup(processGroupId: number | undefined): void {
	if (processGroupId === undefined) return;
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch {
		// The process group may have exited with its parent.
	}
}

function killProcessTree(processId: number | undefined): void {
	if (processId === undefined) return;
	try {
		execFileSync("taskkill", ["/PID", String(processId), "/T", "/F"], { stdio: "ignore" });
	} catch {
		// The process tree may have exited before reconciliation.
	}
}

function killOwnedProcessGroup(childProcess: ChildProcessWithoutNullStreams): void {
	const processGroupId = ownedProcessGroupId(childProcess);
	if (processGroupId === undefined) return;
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch {
		// The process group may have exited before reconciliation.
	}
}

function ownedProcessGroupId(childProcess: ChildProcessWithoutNullStreams): number | undefined {
	if (process.platform === "win32" || childProcess.exitCode !== null) return;
	return childProcess.pid ?? undefined;
}
function request(
	child: MutableChild,
	command: string,
	data: RpcCommandData,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RpcResponse> {
	const id = `khala-${++requestCounter}`;
	const payload = JSON.stringify({ id, type: command, ...data });
	return new Promise((resolve, reject) =>
		initializeRequest(child, id, payload, command, timeoutMs, signal, resolve, reject),
	);
}

function initializeRequest(
	child: MutableChild,
	id: string,
	payload: string,
	command: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	resolve: (response: RpcResponse) => void,
	reject: (error: Error) => void,
): void {
	if (signal?.aborted === true) {
		reject(abortError());
		return;
	}
	let onAbort: () => void = () => undefined;
	const timer = setTimeout(() => timeoutRequest(child, id, command, timeoutMs, signal, onAbort, reject), timeoutMs);
	onAbort = () => abortRequest(child, id, timer, reject);
	signal?.addEventListener("abort", onAbort, { once: true });
	child.pending.set(id, pendingRequest(timer, signal, onAbort, resolve, reject));
	writeRequest(child, id, payload, timer, signal, onAbort, reject);
}

function timeoutRequest(
	child: MutableChild,
	id: string,
	command: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onAbort: () => void,
	reject: (error: Error) => void,
): void {
	child.pending.delete(id);
	signal?.removeEventListener("abort", onAbort);
	reject(new Error(`Pi RPC ${command} timed out after ${timeoutMs}ms.`));
}

function abortRequest(child: MutableChild, id: string, timer: NodeJS.Timeout, reject: (error: Error) => void): void {
	child.pending.delete(id);
	clearTimeout(timer);
	reject(abortError());
}

function pendingRequest(
	timer: NodeJS.Timeout,
	signal: AbortSignal | undefined,
	onAbort: () => void,
	resolve: (response: RpcResponse) => void,
	reject: (error: Error) => void,
): PendingResponse {
	return {
		resolve: (response) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(response);
		},
		reject: (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		},
		timer,
	};
}

function writeRequest(
	child: MutableChild,
	id: string,
	payload: string,
	timer: NodeJS.Timeout,
	signal: AbortSignal | undefined,
	onAbort: () => void,
	reject: (error: Error) => void,
): void {
	try {
		child.process.stdin.write(`${payload}\n`);
	} catch (error) {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		child.pending.delete(id);
		reject(error instanceof Error ? error : new Error(String(error)));
	}
}

function agentTimeout(child: MutableChild, fallback: number | undefined): number {
	return child.agentTimeoutMs ?? fallback ?? 1_800_000;
}

function rpcTimeout(value: number | undefined): number {
	return value ?? 10_000;
}

async function completedTurn(child: MutableChild, completion: Promise<string>): Promise<RuntimeTurn> {
	const output = await completion;
	return child.turnUsage === undefined ? { output } : { output, usage: child.turnUsage };
}

async function failTurn(child: MutableChild, completion: Promise<string>, failure: Error): Promise<void> {
	rejectAgentEnd(child, failure);
	killChild(child);
	await completion.catch(() => undefined);
}

async function sendPrompt(
	child: MutableChild,
	message: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const response = await sendPromptRequest(child, message, timeoutMs, signal);
	if (response?.success === false) throw new Error(response.error ?? "Pi rejected the prompt.");
}

async function sendPromptRequest(
	child: MutableChild,
	message: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<RpcResponse | undefined> {
	try {
		return await request(child, "prompt", { message }, timeoutMs, signal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Pi RPC prompt timed out after ")) return undefined;
		throw error;
	}
}

function createAbortHandler(
	child: MutableChild,
	operation: OperationContext | undefined,
	timeoutMs: number,
): (() => void) | undefined {
	if (operation?.signal === undefined) return undefined;
	return () => {
		void request(child, "abort", {}, timeoutMs).catch(() => undefined);
		rejectAgentEnd(child, abortError());
	};
}

function registerAbortHandler(operation: OperationContext | undefined, handler: (() => void) | undefined): void {
	if (operation?.signal !== undefined && handler !== undefined)
		operation.signal.addEventListener("abort", handler, { once: true });
}

function removeAbortHandler(operation: OperationContext | undefined, handler: (() => void) | undefined): void {
	if (operation?.signal !== undefined && handler !== undefined) operation.signal.removeEventListener("abort", handler);
}

function childRuntimeState(response: RpcResponse): RuntimeState {
	if (!response.success) return "unknown";
	return response.data?.isStreaming === true ? "working" : "idle";
}

function rejectPending(child: MutableChild, error: Error): void {
	for (const pending of child.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	child.pending.clear();
}

function waitForAgentSettled(child: MutableChild, timeoutMs: number): Promise<string> {
	child.lastAgentEnd = new Promise((resolve, reject) => {
		child.resolveAgentEnd = resolve;
		child.rejectAgentEnd = reject;
		child.agentTimer = setTimeout(
			() => rejectAgentEnd(child, new Error(`Pi agent turn timed out after ${timeoutMs}ms.`)),
			timeoutMs,
		);
	});
	return child.lastAgentEnd;
}

function resolveAgentEnd(child: MutableChild): void {
	if (child.agentTimer !== undefined) {
		clearTimeout(child.agentTimer);
		child.agentTimer = undefined;
	}
	if (child.resolveAgentEnd !== undefined) {
		child.resolveAgentEnd(child.lastOutput);
	}
	child.resolveAgentEnd = undefined;
	child.rejectAgentEnd = undefined;
	child.lastAgentEnd = undefined;
}

function rejectAgentEnd(child: MutableChild, error: Error): void {
	if (child.agentTimer !== undefined) {
		clearTimeout(child.agentTimer);
		child.agentTimer = undefined;
	}
	if (child.rejectAgentEnd !== undefined) {
		child.rejectAgentEnd(error);
	}
	child.resolveAgentEnd = undefined;
	child.rejectAgentEnd = undefined;
	child.lastAgentEnd = undefined;
}

function abortError(): Error {
	return new Error("Pi agent turn was cancelled.");
}

function awaitOperation<T>(promise: Promise<T>, operation: OperationContext | undefined): Promise<T> {
	const signal = operation?.signal;
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return abortableOperation(promise, signal);
}

function abortableOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const onAbort = (): void => {
			cleanup();
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				const message = error instanceof Error ? error.message : String(error);
				reject(new Error(message));
			},
		);
	});
}

function throwIfAborted(operation: OperationContext | undefined): void {
	if (operation?.signal?.aborted === true) throw abortError();
}
function readResponse(value: RpcEvent): RpcResponse {
	if (!isValidResponse(value)) throw new Error("Pi RPC response is invalid.");
	return {
		type: "response",
		id: value.id,
		command: value.command,
		success: value.success,
		data: value.data,
		error: value.error,
	};
}

function isValidResponse(value: RpcEvent): value is RpcEvent & RpcResponse {
	return [
		value.type === "response",
		value.command !== undefined,
		value.command === String(value.command),
		value.success === true || value.success === false,
	].every(Boolean);
}
function readSessionText(value: RpcData | undefined, key: "sessionId" | "sessionFile"): string {
	const entry = value?.[key];
	if (!isSessionText(entry)) throw new Error(`Pi RPC state is missing ${key}.`);
	return entry;
}

function isSessionText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value) && value.length > 0;
}

function isAssistantMessage(
	value: RpcMessage | undefined,
): value is RpcMessage & Readonly<{ role: "assistant"; content: readonly RpcBlock[] }> {
	return value !== undefined && value.role === "assistant" && value.content !== undefined;
}

function assistantText(message: Readonly<{ content: readonly RpcBlock[] }>): string {
	return message.content
		.filter((block) => block.type === "text" && block.text !== undefined)
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}
function readTokenUsage(value: RpcUsage | undefined): TokenUsage | undefined {
	if (value === undefined) return;
	const counts = [value.input, value.output, value.cacheRead, value.cacheWrite].map(readTokenCount);
	if (!allTokenCounts(counts)) return;
	const cacheMissTokens = counts[0] + counts[3];
	if (!Number.isSafeInteger(cacheMissTokens)) return;
	return { inputTokens: counts[0], outputTokens: counts[1], cacheHitTokens: counts[2], cacheMissTokens };
}

function allTokenCounts(value: readonly (number | undefined)[]): value is readonly [number, number, number, number] {
	return value.length === 4 && value.every((entry): entry is number => entry !== undefined);
}

function readTokenCount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	const totals = tokenTotals(previous, current);
	return { inputTokens: totals[0], outputTokens: totals[1], cacheHitTokens: totals[2], cacheMissTokens: totals[3] };
}

function tokenTotals(previous: TokenUsage | undefined, current: TokenUsage): readonly [number, number, number, number] {
	return [
		tokenTotal(previous, current, "inputTokens"),
		tokenTotal(previous, current, "outputTokens"),
		tokenTotal(previous, current, "cacheHitTokens"),
		tokenTotal(previous, current, "cacheMissTokens"),
	];
}

function tokenTotal(previous: TokenUsage | undefined, current: TokenUsage, key: keyof TokenUsage): number {
	return (previous?.[key] ?? 0) + current[key];
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

export function promptIdentity(prompt: string, packageVersion: string): PromptIdentity {
	return { packageVersion, promptSha256: createHash("sha256").update(prompt).digest("hex") };
}
