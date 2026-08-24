import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
		if (input.sessionPath === undefined) return this.startSession(input);
		const active = this.sessionLaunches.get(input.sessionPath);
		if (active !== undefined) return active;
		const launch = this.startSession(input);
		this.sessionLaunches.set(input.sessionPath, launch);
		try {
			return await launch;
		} finally {
			if (this.sessionLaunches.get(input.sessionPath) === launch) this.sessionLaunches.delete(input.sessionPath);
		}
	}

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
		if (input.sessionPath !== undefined) {
			await reconcileLaunch(input.sessionPath);
			args.push("--session", input.sessionPath);
		}
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
			KHALA_ROLE_NONCE: capabilityNonce,
			KHALA_PROCESS_MARKER: processMarker,
		};
		delete environment["KHALA_ROLE_TOKEN"];
		delete environment["KHALA_ROLE_TOKEN_FILE"];
		delete environment["KHALA_ROLE_NONCE"];
		if (capabilityFile !== undefined) environment["KHALA_ROLE_TOKEN_FILE"] = capabilityFile;
		if (capabilityNonce !== undefined) environment["KHALA_ROLE_NONCE"] = capabilityNonce;
		try {
			if (input.sessionPath !== undefined) await writeLaunchIntent(input.sessionPath, capabilityFile, processMarker);
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
			throw error;
		}
	}

	async send(binding: RuntimeBinding, message: string): Promise<RuntimeTurn> {
		const child = this.requireChild(binding);
		if (child.sending) {
			throw new Error(`Pi session ${binding.sessionId} is already processing a prompt.`);
		}
		child.turnUsage = undefined;
		child.lastOutput = "";
		child.sending = true;
		const completion = waitForAgentEnd(child, this.options.agentTimeoutMs ?? 1_800_000);
		try {
			const response = await request(child, "prompt", { message }, this.options.rpcTimeoutMs ?? 10_000);
			if (!response.success) {
				throw new Error(response.error ?? "Pi rejected the prompt.");
			}
			const output = await completion;
			const usage = child.turnUsage;
			return usage === undefined ? { output } : { output, usage };
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			rejectAgentEnd(child, failure);
			try {
				await request(child, "abort", {}, this.options.rpcTimeoutMs ?? 10_000);
			} catch {
				// A nonresponsive child is terminated below.
			}
			killChild(child);
			await completion.catch(() => undefined);
			throw failure;
		} finally {
			child.sending = false;
		}
	}

	async getState(binding: RuntimeBinding): Promise<RuntimeState> {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			return "unreachable";
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
			await terminateSessionProcesses(binding.sessionPath, binding.processMarker);
			killProcessGroup(binding.processGroupId, binding.processStartTime);
			removeLaunchLeaseSync(binding.sessionPath, binding.processMarker);
			return;
		}
		if (!sameBindingIdentity(binding, child.binding)) {
			await terminateSessionProcesses(binding.sessionPath, binding.processMarker);
			killProcessGroup(binding.processGroupId, binding.processStartTime);
			removeLaunchLeaseSync(binding.sessionPath, binding.processMarker);
			return;
		}
		try {
			await request(child, "abort", {}, this.options.rpcTimeoutMs ?? 10_000);
		} finally {
			killChild(child);
			this.removeChild(child);
			await terminateSessionProcesses(binding.sessionPath, binding.processMarker);
		}
	}

	async close(): Promise<void> {
		for (const child of this.children.values()) {
			rejectAgentEnd(child, new Error("Pi runtime closed."));
			killChild(child);
		}
		this.children.clear();
	}

	private removeChild(child: MutableChild): void {
		removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker);
		for (const [key, value] of this.children) {
			if (value === child) {
				this.children.delete(key);
			}
		}
	}

	private requireChild(binding: RuntimeBinding): MutableChild {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			throw new Error(`Pi session ${binding.sessionId} is not attached to this process.`);
		}
		return child;
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
}>;

function capabilityFilePath(): string {
	return join(tmpdir(), `khala-capability-${randomUUID()}`);
}

async function writeCapabilityFile(path: string, token: string): Promise<void> {
	await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function reconcileLaunch(sessionPath: string): Promise<void> {
	const path = launchLeasePath(sessionPath);
	const text = await readFile(path, "utf8").catch(() => undefined);
	const lease = text === undefined ? undefined : parseLaunchLease(text);
	if (
		lease?.processGroupId !== undefined &&
		lease.processStartTime !== undefined &&
		readProcessStartTime(lease.processGroupId) === lease.processStartTime
	)
		killProcessGroup(lease.processGroupId, lease.processStartTime);
	if (lease?.capabilityFile !== undefined) await unlink(lease.capabilityFile).catch(() => undefined);
	await terminateSessionProcesses(sessionPath, lease?.processMarker);
	await unlink(path).catch(() => undefined);
}

async function terminateSessionProcesses(sessionPath: string, processMarker?: string): Promise<void> {
	if (process.platform === "win32") return;
	const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
			.map(async (entry) => {
				const processId = Number(entry.name);
				const commandLine = await readFile(`/proc/${processId}/cmdline`, "utf8").catch(() => "");
				const args = commandLine.split("\0");
				const sessionIndex = args.indexOf("--session");
				const matchesSession = args[sessionIndex + 1] === sessionPath;
				const environment =
					processMarker === undefined ? "" : await readFile(`/proc/${processId}/environ`, "utf8").catch(() => "");
				const matchesMarker =
					processMarker !== undefined && environment.split("\0").includes(`KHALA_PROCESS_MARKER=${processMarker}`);
				if (processMarker !== undefined ? !matchesMarker : !matchesSession) return;
				const startTime = readProcessStartTime(processId);
				if (matchesSession) killProcessGroup(processId, startTime);
				else killProcess(processId, startTime);
			}),
	);
}

async function writeLaunchIntent(
	sessionPath: string,
	capabilityFile: string | undefined,
	processMarker: string,
): Promise<void> {
	await mkdir(dirname(sessionPath), { recursive: true });
	await writeFile(launchLeasePath(sessionPath), JSON.stringify({ capabilityFile, processMarker }), {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
}

async function writeLaunchLease(
	sessionPath: string,
	binding: RuntimeBinding,
	capabilityFile: string | undefined,
): Promise<void> {
	if (binding.processGroupId === undefined || binding.processStartTime === undefined) return;
	const existing = parseLaunchLease(readFileSync(launchLeasePath(sessionPath), "utf8"));
	if (existing?.processMarker !== binding.processMarker) throw new Error("Runtime launch ownership was lost.");
	await writeFile(
		launchLeasePath(sessionPath),
		JSON.stringify({
			processGroupId: binding.processGroupId,
			processStartTime: binding.processStartTime,
			capabilityFile,
			processMarker: binding.processMarker,
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
}

function launchLeasePath(sessionPath: string): string {
	return `${sessionPath}.khala-process`;
}

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
	if (
		(capabilityFile !== undefined && !isText(capabilityFile)) ||
		(processMarker !== undefined && !isText(processMarker))
	)
		return;
	if (processGroupId === undefined && processStartTime === undefined)
		return capabilityFile === undefined && processMarker === undefined ? {} : { capabilityFile, processMarker };
	if (!isInteger(processGroupId) || processGroupId <= 0 || !isText(processStartTime) || processStartTime.length === 0)
		return;
	return { processGroupId, processStartTime, capabilityFile, processMarker };
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

function killProcess(processId: number | undefined, processStartTime: string | undefined): void {
	if (
		processId === undefined ||
		processStartTime === undefined ||
		process.platform === "win32" ||
		readProcessStartTime(processId) !== processStartTime
	)
		return;
	try {
		process.kill(processId, "SIGKILL");
	} catch {
		// The process may have exited before reconciliation.
	}
}

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

function sameBindingIdentity(left: RuntimeBinding, right: RuntimeBinding): boolean {
	return (
		left.sessionPath === right.sessionPath &&
		(left.processGroupId === undefined ||
			right.processGroupId === undefined ||
			left.processGroupId === right.processGroupId) &&
		(left.processStartTime === undefined ||
			right.processStartTime === undefined ||
			left.processStartTime === right.processStartTime) &&
		(left.processMarker === undefined ||
			right.processMarker === undefined ||
			left.processMarker === right.processMarker)
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

function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	return {
		inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
		outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
		cacheHitTokens: (previous?.cacheHitTokens ?? 0) + current.cacheHitTokens,
		cacheMissTokens: (previous?.cacheMissTokens ?? 0) + current.cacheMissTokens,
	};
}

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
