import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { JsonObject, JsonValue, PromptIdentity, TokenUsage } from "./model.js";
import type { AgentRuntimePort, RuntimeBinding, RuntimeState, RuntimeTurn } from "./ports.js";

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

export class PiRpcRuntime implements AgentRuntimePort {
	private readonly children = new Map<string, MutableChild>();
	private readonly sessionLaunches = new Map<string, Promise<RuntimeBinding>>();
	private readonly launches = new Set<Promise<RuntimeBinding>>();
	private readonly options: PiRuntimeOptions;
	private closing = false;

	constructor(options: PiRuntimeOptions) {
		this.options = options;
	}

	async ensureSession(input: Parameters<AgentRuntimePort["ensureSession"]>[0]): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		return input.sessionPath === undefined
			? this.trackLaunch(this.startSessionWithRetry(input))
			: this.ensurePersistentSession(input);
	}

	private ensurePersistentSession(input: Parameters<AgentRuntimePort["ensureSession"]>[0]): Promise<RuntimeBinding> {
		const sessionPath = input.sessionPath ?? "";
		const active = this.sessionLaunches.get(sessionPath);
		return active ?? this.startPersistentSession(input, sessionPath);
	}

	private startPersistentSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		sessionPath: string,
	): Promise<RuntimeBinding> {
		const launch = this.trackLaunch(this.startSessionWithRetry(input));
		this.sessionLaunches.set(sessionPath, launch);
		return launch.finally(() => {
			if (this.sessionLaunches.get(sessionPath) === launch) this.sessionLaunches.delete(sessionPath);
		});
	}

	private async startSessionWithRetry(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
	): Promise<RuntimeBinding> {
		try {
			return await this.startSession(input);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTransientStartupFailure(message)) throw error;
			return this.startSession(input);
		}
	}

	// oxlint-disable-next-line complexity
	private async startSession(input: Parameters<AgentRuntimePort["ensureSession"]>[0]): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		const sessionPath = input.sessionPath ?? ephemeralSessionPath();
		const args = [
			...this.options.command.slice(1),
			"--mode",
			"rpc",
			"--model",
			input.model,
			"--thinking",
			input.thinking,
		];
		args.push("--session", sessionPath);
		if (input.tools.length === 0) {
			args.push("--no-tools");
		} else {
			args.push("--tools", input.tools.join(","));
		}
		if (this.options.extensionPath !== undefined) {
			args.push("--extension", this.options.extensionPath);
		}
		args.push("--khala-role", input.role);
		const capabilityNonce = input.tools.length === 0 ? undefined : (input.bindingScope?.nonce ?? randomUUID());
		const processMarker = randomUUID();
		const capabilityToken =
			input.tools.length === 0
				? undefined
				: createCapability(this.options.authorityPrivateKey, input.role, {
						workId: input.bindingScope?.workId,
						executionId: input.bindingScope?.executionId,
						nonce: capabilityNonce,
					});
		if (input.tools.length > 0 && capabilityToken === undefined)
			throw new Error("This runtime cannot launch a governed child without an authority key.");
		const capabilityFile = capabilityToken === undefined ? undefined : capabilityFilePath();
		const environment = childEnvironment({
			...process.env,
			...this.options.baseEnvironment,
			KHALA_ALLOWED_PATHS: input.allowedPaths === undefined ? undefined : JSON.stringify(input.allowedPaths),
			KHALA_SANDBOX_ROOT: input.sandboxRoot,
			KHALA_BOUND_WORK_ID: input.bindingScope?.workId,
			KHALA_BOUND_EXECUTION_ID: input.bindingScope?.executionId,
			KHALA_PROCESS_MARKER: processMarker,
		});
		delete environment["KHALA_ROLE_TOKEN"];
		delete environment["KHALA_ROLE_TOKEN_FILE"];
		delete environment["KHALA_ROLE_NONCE"];
		if (capabilityFile !== undefined) environment["KHALA_ROLE_TOKEN_FILE"] = capabilityFile;
		if (capabilityNonce !== undefined) environment["KHALA_ROLE_NONCE"] = capabilityNonce;
		try {
			if (input.sessionPath === undefined) await mkdir(dirname(sessionPath), { recursive: true });
			if (input.sessionPath !== undefined) await reserveLaunch(sessionPath, capabilityFile, processMarker);
			if (capabilityFile !== undefined && capabilityToken !== undefined)
				await writeCapabilityFile(capabilityFile, capabilityToken);
		} catch (error) {
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			throw error;
		}
		let childProcess: ChildProcessWithoutNullStreams;
		try {
			childProcess = spawn(this.options.command[0] ?? "pi", args, {
				cwd: input.cwd,
				detached: process.platform !== "win32",
				env: environment,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			if (input.sessionPath !== undefined) removeLaunchLeaseSync(sessionPath, processMarker);
			throw error;
		}
		const child: MutableChild = {
			process: childProcess,
			pending: new Map(),
			binding: {
				sessionId: "starting",
				sessionPath,
				capabilityNonce,
				processMarker,
				promptIdentity: input.promptIdentity,
			},
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
		child.binding = {
			...child.binding,
			processGroupId: child.process.pid,
			processStartTime: readProcessStartTime(child.process.pid),
			capabilityNonce,
			processMarker,
			promptIdentity: input.promptIdentity,
		};
		try {
			if (this.closing) throw new Error("Pi runtime is closed.");
			if (input.sessionPath !== undefined) await writeLaunchLease(sessionPath, child.binding, capabilityFile);
		} catch (error) {
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			killChild(child);
			removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
			throw error;
		}
		if (this.closing) {
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			killChild(child);
			removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
			throw new Error("Pi runtime is closed.");
		}
		const key = `child-${++childCounter}`;
		this.children.set(key, child);
		attachOutput(child, () => this.removeChild(child));
		try {
			const state = await request(child, "get_state", {}, this.options.rpcTimeoutMs ?? 10_000);
			if (!state.success) {
				throw new Error(state.error ?? "Pi did not return its session state.");
			}
			const sessionId = readSessionText(state.data, "sessionId");
			const reportedSessionPath = readSessionText(state.data, "sessionFile");
			if (resolve(reportedSessionPath) !== resolve(sessionPath))
				throw new Error("Pi returned a session file outside the runtime-owned session path.");
			await protectSessionFile(sessionPath);
			if (child.closed || child.process.exitCode !== null || child.process.signalCode !== null)
				throw new Error("Pi child exited during session startup.");
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			child.binding = {
				sessionId,
				sessionPath,
				processGroupId: child.process.pid,
				processStartTime: readProcessStartTime(child.process.pid),
				capabilityNonce,
				processMarker,
				promptIdentity: input.promptIdentity,
			};
			this.children.delete(key);
			this.children.set(sessionId, child);
			return child.binding;
		} catch (error) {
			this.children.delete(key);
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			killChild(child);
			removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
			removeEphemeralSession(child);
			throw error;
		}
	}

	// oxlint-disable-next-line complexity
	async send(binding: RuntimeBinding, message: string): Promise<RuntimeTurn> {
		const child = this.requireChild(binding);
		if (child.sending) {
			throw new Error(`Pi session ${binding.sessionId} is already processing a prompt.`);
		}
		child.turnUsage = undefined;
		child.lastOutput = "";
		child.sending = true;
		const completion = waitForAgentEnd(child, child.agentTimeoutMs ?? this.options.agentTimeoutMs ?? 1_800_000);
		void completion.catch(() => undefined);
		try {
			let response: RpcResponse | undefined;
			try {
				response = await request(child, "prompt", { message }, this.options.rpcTimeoutMs ?? 10_000);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("Pi RPC prompt timed out after ")) throw error;
				// Pi sends the prompt response as an acceptance acknowledgement. A late acknowledgement does not
				// invalidate the agent events already emitted for the turn, so let agent_end decide whether it completed.
			}
			if (response?.success === false) {
				throw new Error(response.error ?? "Pi rejected the prompt.");
			}
			const output = await completion;
			const usage = child.turnUsage;
			return usage === undefined ? { output } : { output, usage };
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			rejectAgentEnd(child, failure);
			// A failed turn has ambiguous event ownership. Kill the child instead of reusing it,
			// because a late agent_end or message event cannot be correlated to the next turn.
			killChild(child);
			this.removeChild(child);
			await completion.catch(() => undefined);
			throw failure;
		} finally {
			child.sending = false;
		}
	}

	// oxlint-disable-next-line complexity
	async getState(binding: RuntimeBinding): Promise<RuntimeState> {
		const child = this.children.get(binding.sessionId);
		if (child === undefined || !sameBindingIdentity(binding, child.binding)) {
			return "unreachable";
		}
		if (child.sending) {
			return "working";
		}
		try {
			const response = await request(child, "get_state", {}, this.options.rpcTimeoutMs ?? 10_000);
			if (!response.success) {
				return "unknown";
			}
			return response.data?.isStreaming === true ? "working" : "idle";
		} catch {
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

// oxlint-disable-next-line complexity
function consumeLines(child: MutableChild): void {
	for (;;) {
		const newline = child.buffer.indexOf("\n");
		if (newline < 0) {
			return;
		}
		let line = child.buffer.slice(0, newline);
		child.buffer = child.buffer.slice(newline + 1);
		if (line.endsWith("\r")) {
			line = line.slice(0, -1);
		}
		if (line.trim().length === 0) {
			continue;
		}
		let event: RpcEvent;
		try {
			// SAFETY: Pi RPC emits one JSON object per LF-delimited event; consumers validate required fields below.
			event = JSON.parse(line) as RpcEvent;
		} catch {
			continue;
		}
		if (event.type === "response") {
			let response: RpcResponse;
			try {
				response = readResponse(event);
			} catch {
				continue;
			}
			if (response.id !== undefined) {
				const pending = child.pending.get(response.id);
				if (pending !== undefined) {
					child.pending.delete(response.id);
					clearTimeout(pending.timer);
					pending.resolve(response);
				}
			}
			continue;
		}
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			child.lastOutput = assistantText(event.message);
			const usage = readTokenUsage(event.message.usage);
			if (usage !== undefined) child.turnUsage = addTokenUsage(child.turnUsage, usage);
		}
		if (event.type === "agent_end") {
			resolveAgentEnd(child);
		}
	}
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

async function writeCapabilityFile(path: string, token: string): Promise<void> {
	await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

// oxlint-disable-next-line complexity
async function reserveLaunch(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
): Promise<void> {
	// oxlint-disable-next-line complexity
	await withLaunchLock(sessionPath, async () => {
		const path = launchLeasePath(sessionPath);
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text !== undefined) {
			const lease = parseLaunchLease(text);
			if (lease?.processGroupId !== undefined) {
				const currentStartTime = readProcessStartTime(lease.processGroupId);
				if (
					(lease.processStartTime === undefined && processExists(lease.processGroupId)) ||
					(lease.processStartTime !== undefined &&
						(currentStartTime === lease.processStartTime ||
							(currentStartTime === undefined && processExists(lease.processGroupId))))
				)
					throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
			} else {
				if (lease?.ownerProcessId !== undefined && processExists(lease.ownerProcessId))
					throw new Error(`Runtime session ${sessionPath} is already launching.`);
				const createdAt = lease?.createdAt ?? (await stat(path)).mtimeMs;
				if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
					throw new Error(`Runtime session ${sessionPath} is already launching.`);
			}
			const displacedPath = `${path}.stale-${randomUUID()}`;
			try {
				await rename(path, displacedPath);
			} catch (error) {
				if (error instanceof Error && isMissingFileError(error))
					throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
				throw error;
			}
			if (lease?.capabilityFile !== undefined) await unlink(lease.capabilityFile).catch(() => undefined);
			await unlink(displacedPath).catch(() => undefined);
		}
		try {
			await writeLaunchIntent(sessionPath, capabilityFile, processMarker);
		} catch (error) {
			if (error instanceof Error && isExistsError(error))
				throw new Error(`Runtime session ${sessionPath} is already owned by another Khala process.`);
			throw error;
		}
	});
}

// oxlint-disable-next-line complexity
async function withLaunchLock<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${launchLeasePath(sessionPath)}.lock`;
	await mkdir(dirname(lockPath), { recursive: true });
	try {
		await mkdir(lockPath);
	} catch (error) {
		if (!(error instanceof Error) || !isExistsError(error)) throw error;
		const createdAt = await stat(lockPath)
			.then((entry) => entry.mtimeMs)
			.catch(() => Date.now());
		if (Date.now() - createdAt < LAUNCH_INTENT_STALE_MS)
			throw new Error(`Runtime session ${sessionPath} is already launching.`);
		await rmdir(lockPath).catch(() => undefined);
		await mkdir(lockPath);
	}
	try {
		return await operation();
	} finally {
		await rmdir(lockPath).catch(() => undefined);
	}
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

// oxlint-disable-next-line complexity
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
		await writeFile(
			temporaryPath,
			JSON.stringify({
				processGroupId: binding.processGroupId,
				processStartTime: binding.processStartTime,
				capabilityFile,
				processMarker: binding.processMarker,
				ownerProcessId: existing?.ownerProcessId ?? process.pid,
				createdAt: existing?.createdAt ?? Date.now(),
			}),
			{ encoding: "utf8", mode: 0o600, flag: "wx" },
		);
		await rename(temporaryPath, leasePath);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function launchLeasePath(sessionPath: string): string {
	return `${sessionPath}.khala-process`;
}

// oxlint-disable-next-line complexity
function removeLaunchLeaseSync(sessionPath: string, processMarker?: string): void {
	if (sessionPath.length === 0) return;
	try {
		const existing = parseLaunchLease(readFileSync(launchLeasePath(sessionPath), "utf8"));
		if (
			processMarker !== undefined &&
			existing?.processMarker !== undefined &&
			existing.processMarker !== processMarker
		)
			return;
		unlinkSync(launchLeasePath(sessionPath));
	} catch {
		// The lease may already have been removed by normal completion.
	}
}

// oxlint-disable-next-line complexity
function parseLaunchLease(text: string): LaunchLease | undefined {
	let parsed: JsonValue;
	try {
		// SAFETY: the parsed JSON is checked as a JsonObject before its fields are read below.
		parsed = JSON.parse(text) as JsonValue;
	} catch {
		return;
	}
	if (!isJsonObject(parsed)) return;
	const processGroupId = parsed["processGroupId"];
	const processStartTime = parsed["processStartTime"];
	const capabilityFile = parsed["capabilityFile"];
	const processMarker = parsed["processMarker"];
	const ownerProcessId = parsed["ownerProcessId"];
	const createdAt = parsed["createdAt"];
	if (
		(ownerProcessId !== undefined && (!isInteger(ownerProcessId) || ownerProcessId <= 0)) ||
		(createdAt !== undefined && (!isInteger(createdAt) || createdAt <= 0)) ||
		(capabilityFile !== undefined && !isText(capabilityFile)) ||
		(processMarker !== undefined && !isText(processMarker))
	)
		return;
	if (processGroupId === undefined && processStartTime === undefined)
		return capabilityFile === undefined &&
			processMarker === undefined &&
			ownerProcessId === undefined &&
			createdAt === undefined
			? {}
			: { capabilityFile, processMarker, ownerProcessId, createdAt };
	if (!isInteger(processGroupId) || processGroupId <= 0) return;
	if (processStartTime !== undefined && (!isText(processStartTime) || processStartTime.length === 0)) return;
	return { processGroupId, processStartTime, capabilityFile, processMarker, ownerProcessId, createdAt };
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

// oxlint-disable-next-line complexity
function readProcessStartTime(processId: number | undefined): string | undefined {
	if (processId === undefined) return;
	if (process.platform !== "win32") {
		try {
			const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
			const endOfCommand = stat.lastIndexOf(")");
			const linuxStartTime = stat
				.slice(endOfCommand + 2)
				.trim()
				.split(/\s+/)[19];
			if (linuxStartTime !== undefined) return linuxStartTime;
		} catch {
			// Darwin does not expose /proc; use ps below.
		}
		try {
			const darwinStartTime = execFileSync("ps", ["-o", "lstart=", "-p", String(processId)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return darwinStartTime.length === 0 ? undefined : darwinStartTime;
		} catch {
			return;
		}
	}
	return;
}

// oxlint-disable-next-line complexity
function killProcessGroup(processGroupId: number | undefined, processStartTime: string | undefined): boolean {
	if (
		processGroupId === undefined ||
		(process.platform !== "win32" &&
			(processStartTime === undefined || readProcessStartTime(processGroupId) !== processStartTime))
	)
		return false;
	if (process.platform === "win32") {
		killProcessTree(processGroupId);
		return !processExists(processGroupId);
	}
	try {
		process.kill(-processGroupId, "SIGKILL");
		return true;
	} catch {
		// The process group may have exited before reconciliation.
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

// oxlint-disable-next-line complexity
function sameBindingIdentity(left: RuntimeBinding, right: RuntimeBinding): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.sessionPath === right.sessionPath &&
		left.processGroupId === right.processGroupId &&
		left.processStartTime === right.processStartTime &&
		left.capabilityNonce === right.capabilityNonce &&
		left.processMarker === right.processMarker
	);
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

function request(child: MutableChild, command: string, data: RpcCommandData, timeoutMs: number): Promise<RpcResponse> {
	const id = `khala-${++requestCounter}`;
	const payload = JSON.stringify({ id, type: command, ...data });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.pending.delete(id);
			reject(new Error(`Pi RPC ${command} timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
		child.pending.set(id, { resolve, reject, timer });
		try {
			child.process.stdin.write(`${payload}\n`);
		} catch (error) {
			clearTimeout(timer);
			child.pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function rejectPending(child: MutableChild, error: Error): void {
	for (const pending of child.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	child.pending.clear();
}

function waitForAgentEnd(child: MutableChild, timeoutMs: number): Promise<string> {
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

// oxlint-disable-next-line complexity
function readResponse(value: RpcEvent): RpcResponse {
	if (
		value.type !== "response" ||
		value.command === undefined ||
		value.command !== String(value.command) ||
		(value.success !== true && value.success !== false)
	) {
		throw new Error("Pi RPC response is invalid.");
	}
	return {
		type: "response",
		id: value.id,
		command: value.command,
		success: value.success,
		data: value.data,
		error: value.error,
	};
}

// oxlint-disable-next-line complexity
function readSessionText(value: RpcData | undefined, key: "sessionId" | "sessionFile"): string {
	const entry = value?.[key];
	if (entry === undefined || entry !== String(entry) || entry.length === 0) {
		throw new Error(`Pi RPC state is missing ${key}.`);
	}
	return entry;
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

// oxlint-disable-next-line complexity
function readTokenUsage(value: RpcUsage | undefined): TokenUsage | undefined {
	if (value === undefined) return;
	const inputTokens = readTokenCount(value.input);
	const outputTokens = readTokenCount(value.output);
	const cacheHitTokens = readTokenCount(value.cacheRead);
	const cacheWriteTokens = readTokenCount(value.cacheWrite);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheHitTokens === undefined ||
		cacheWriteTokens === undefined
	)
		return;
	const cacheMissTokens = inputTokens + cacheWriteTokens;
	if (!Number.isSafeInteger(cacheMissTokens)) return;
	return { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens };
}

function readTokenCount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// oxlint-disable-next-line complexity
function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	return {
		inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
		outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
		cacheHitTokens: (previous?.cacheHitTokens ?? 0) + current.cacheHitTokens,
		cacheMissTokens: (previous?.cacheMissTokens ?? 0) + current.cacheMissTokens,
	};
}

// oxlint-disable-next-line complexity
function createCapability(
	privateKey: KeyObject | undefined,
	role: "conclave" | "observer" | "executor" | "oracle",
	scope:
		| Readonly<{ workId?: string | undefined; executionId?: string | undefined; nonce?: string | undefined }>
		| undefined,
): string | undefined {
	if (privateKey === undefined) return;
	const payload = Buffer.from(
		JSON.stringify({ role, workId: scope?.workId, executionId: scope?.executionId, nonce: scope?.nonce }),
		"utf8",
	).toString("base64url");
	const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
	return `${payload}.${signature}`;
}

export function promptIdentity(prompt: string, packageVersion: string): PromptIdentity {
	return { packageVersion, promptSha256: createHash("sha256").update(prompt).digest("hex") };
}
