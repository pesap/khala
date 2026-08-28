import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	private readonly options: PiRuntimeOptions;

	constructor(options: PiRuntimeOptions) {
		this.options = options;
	}

	async ensureSession(input: Parameters<AgentRuntimePort["ensureSession"]>[0]): Promise<RuntimeBinding> {
		if (input.sessionPath === undefined) return this.startSessionWithRetry(input);
		const active = this.sessionLaunches.get(input.sessionPath);
		if (active !== undefined) return active;
		const launch = this.startSessionWithRetry(input);
		this.sessionLaunches.set(input.sessionPath, launch);
		try {
			return await launch;
		} finally {
			if (this.sessionLaunches.get(input.sessionPath) === launch) this.sessionLaunches.delete(input.sessionPath);
		}
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
		const args = [
			...this.options.command.slice(1),
			"--mode",
			"rpc",
			"--model",
			input.model,
			"--thinking",
			input.thinking,
		];
		if (input.sessionPath !== undefined) args.push("--session", input.sessionPath);
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
		const environment: NodeJS.ProcessEnv = {
			...process.env,
			...this.options.baseEnvironment,
			KHALA_BOUND_WORK_ID: input.bindingScope?.workId,
			KHALA_BOUND_EXECUTION_ID: input.bindingScope?.executionId,
			KHALA_PROCESS_MARKER: processMarker,
		};
		delete environment["KHALA_ROLE_TOKEN"];
		delete environment["KHALA_ROLE_TOKEN_FILE"];
		delete environment["KHALA_ROLE_NONCE"];
		if (capabilityFile !== undefined) environment["KHALA_ROLE_TOKEN_FILE"] = capabilityFile;
		if (capabilityNonce !== undefined) environment["KHALA_ROLE_NONCE"] = capabilityNonce;
		try {
			if (input.sessionPath !== undefined) await reserveLaunch(input.sessionPath, capabilityFile, processMarker);
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
			if (input.sessionPath !== undefined) removeLaunchLeaseSync(input.sessionPath, processMarker);
			throw error;
		}
		const child: MutableChild = {
			process: childProcess,
			pending: new Map(),
			binding: {
				sessionId: "starting",
				sessionPath: input.sessionPath ?? "",
				capabilityNonce,
				processMarker,
			},
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
		};
		try {
			if (input.sessionPath !== undefined) await writeLaunchLease(input.sessionPath, child.binding, capabilityFile);
		} catch (error) {
			if (capabilityFile !== undefined) await unlink(capabilityFile).catch(() => undefined);
			killChild(child);
			removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
			throw error;
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
			const sessionPath = readSessionText(state.data, "sessionFile");
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
		const completion = waitForAgentEnd(child, this.options.agentTimeoutMs ?? 1_800_000);
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
			const aborted = await tryAbort(child, this.options.rpcTimeoutMs ?? 10_000);
			if (!aborted) killChild(child);
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
		for (const child of this.children.values()) {
			rejectAgentEnd(child, new Error("Pi runtime closed."));
			killChild(child);
			this.removeChild(child);
		}
		this.children.clear();
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
	child.process.stdin.on("error", (error) => {
		child.closed = true;
		child.lastError = `${child.lastError}${error.message}`.slice(-4000);
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		onExit();
	});
	child.process.on("error", (error) => {
		child.closed = true;
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		onExit();
	});
	child.process.on("exit", () => {
		child.closed = true;
		const detail = child.lastError.trim();
		const error = new Error(detail.length === 0 ? "Pi child exited before responding." : `Pi child exited: ${detail}`);
		rejectPending(child, error);
		rejectAgentEnd(child, error);
		onExit();
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
	await writeFile(
		launchLeasePath(sessionPath),
		JSON.stringify({
			processGroupId: binding.processGroupId,
			processStartTime: binding.processStartTime,
			capabilityFile,
			processMarker: binding.processMarker,
			ownerProcessId: existing?.ownerProcessId ?? process.pid,
			createdAt: existing?.createdAt ?? Date.now(),
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
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

function readProcessStartTime(processId: number | undefined): string | undefined {
	if (processId === undefined || process.platform === "win32") return;
	try {
		const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
		const endOfCommand = stat.lastIndexOf(")");
		return stat
			.slice(endOfCommand + 2)
			.trim()
			.split(/\s+/)[19];
	} catch {
		return;
	}
}

// oxlint-disable-next-line complexity
function killProcessGroup(processGroupId: number | undefined, processStartTime: string | undefined): void {
	if (
		processGroupId === undefined ||
		processStartTime === undefined ||
		process.platform === "win32" ||
		readProcessStartTime(processGroupId) !== processStartTime
	)
		return;
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch {
		// The process group may have exited before reconciliation.
	}
}

function isTransientStartupFailure(message: string): boolean {
	return message.includes("Pi child exited") || message.includes("Pi RPC get_state timed out");
}

async function stopUnattachedBinding(binding: RuntimeBinding): Promise<void> {
	killProcessGroup(binding.processGroupId, binding.processStartTime);
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
	killProcessGroup(child.binding.processGroupId ?? child.process.pid, child.binding.processStartTime);
	// The direct handle is owned by this runtime; only persisted process IDs use the start-time check above.
	child.process.kill();
	removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
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

async function tryAbort(child: MutableChild, timeoutMs: number): Promise<boolean> {
	try {
		const response = await request(child, "abort", {}, timeoutMs);
		return response.success;
	} catch {
		return false;
	}
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
