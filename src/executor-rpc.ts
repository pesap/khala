// biome-ignore-all lint/style/noExcessiveLinesPerFile: RPC transport and its owned process lifecycle form one bounded runtime boundary.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: The startup fence preserves exact child and session failure ordering.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: RPC startup intentionally keeps binding and event release atomic.
// biome-ignore-all lint/suspicious/noShadow: Promise resolver names are local transport callbacks.
// biome-ignore-all lint/style/noExcessiveClassesPerFile: The JSONL decoder and process owner share the same transport boundary.
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { sameFilesystemPath } from "./khala-path.js";
import type { LaunchedSession } from "./launcher.js";

type RpcSessionBinding = Readonly<{ sessionId: string; sessionPath: string }>;
type RpcCommand = Readonly<
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "prompt"; message: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "abort" }
>;
type RpcResponse = Readonly<{
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}>;
type RpcState = Readonly<{ sessionFile?: unknown; sessionId?: unknown }>;
type RpcSessionEntry = Readonly<{
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: unknown;
	[key: string]: unknown;
}>;
type RpcEntries = Readonly<{ entries: readonly RpcSessionEntry[]; leafId: string | null }>;
type StopHandoffSettlementObservation = Readonly<{ target?: number; observed: boolean }>;
type RpcChildFactory = (command: string, args: readonly string[], cwd: string) => ChildProcess;
type HeadlessRuntimeOptions = Readonly<{
	command: string;
	args: readonly string[];
	cwd: string;
	model: string;
	mission: string;
	executionId?: string;
	sessionPath?: string;
	sessionId?: string;
	onReady?: (binding: RpcSessionBinding) => Promise<void> | void;
	onRestart?: (runtime: HeadlessExecutorRuntime) => Promise<void> | void;
	onEvent?: (event: unknown, runtime: HeadlessExecutorRuntime) => Promise<void> | void;
	onFailure?: (error: Error) => Promise<void> | void;
	spawnProcess?: RpcChildFactory;
}>;

// biome-ignore lint/style/noMagicNumbers: The bounded capture is intentionally one 64 KiB pipe diagnostic window.
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;

const KHALA_HEADLESS_LAUNCHER = "headless-rpc";
const RPC_START_TIMEOUT_MS = 10_000;
const RPC_SHUTDOWN_TIMEOUT_MS = 1000;
const headlessRuntimes = new Map<string, HeadlessExecutorRuntime>();

/**
 * Decode Pi's RPC stream using LF only. U+2028 and U+2029 are valid JSON string
 * characters and must never become record delimiters.
 */
class StrictJsonlReader {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private readonly onRecord: (record: unknown) => void;

	constructor(onRecord: (record: unknown) => void) {
		this.onRecord = onRecord;
	}

	push(chunk: Buffer | string): void {
		if (typeof chunk === "string") {
			this.buffer += chunk;
		} else {
			this.buffer += this.decoder.write(chunk);
		}
		this.readCompleteLines();
	}

	end(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) {
			let finalLine = this.buffer;
			if (finalLine.endsWith("\r")) {
				finalLine = finalLine.slice(0, -1);
			}
			this.emit(finalLine);
			this.buffer = "";
		}
	}

	private readCompleteLines(): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) {
				return;
			}
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			this.emit(line);
		}
	}

	private emit(line: string): void {
		if (line.length === 0) {
			return;
		}
		this.onRecord(JSON.parse(line));
	}
}

class HeadlessExecutorRuntime {
	private child: ChildProcess | undefined;
	private reader: StrictJsonlReader | undefined;
	private readonly pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();
	private closed = false;
	private starting = false;
	private restartPromise: Promise<void> | undefined;
	private started = false;
	private stopping = false;
	private requestNumber = 0;
	private binding: RpcSessionBinding | undefined;
	private stopPromise: Promise<void> | undefined;
	private failurePromise: Promise<void> | undefined;
	private capturedStderr = Buffer.alloc(0);
	private eventReady: Promise<void> = Promise.resolve();
	private eventReadyResolve: (() => void) | undefined;
	private eventChain: Promise<void> = Promise.resolve();
	private eventFailure: Error | undefined;
	private eventReadyError: Error | undefined;
	private settledSequence = 0;
	private settledWaitTarget: number | undefined;
	private readonly settledWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
	private stopPending = false;
	private abortRequested = false;
	private stopHandoffUsed = false;
	private stopHandoffReady = false;
	private stopHandoffSettlementTarget: number | undefined;

	private readonly options: HeadlessRuntimeOptions;

	constructor(options: HeadlessRuntimeOptions) {
		this.options = options;
	}

	async start(): Promise<LaunchedSession> {
		await this.startProcess(this.options.sessionPath !== undefined);
		return {
			id: this.binding?.sessionId ?? "",
			sandbox: { path: this.options.cwd, name: "", projectPath: this.options.cwd },
			cleanup: () => this.closeProcess(),
		};
	}

	get sessionId(): string | undefined {
		return this.binding?.sessionId;
	}

	get sessionPath(): string | undefined {
		return this.binding?.sessionPath;
	}

	async sendPrompt(message: string): Promise<void> {
		if (this.stopPending) {
			throw new Error("Executor runtime is stop-pending; no new prompt may start.");
		}
		const response = await this.send({ type: "prompt", message });
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected prompt.");
		}
	}

	async sendStopHandoff(message: string): Promise<void> {
		if (!(this.stopPending && this.abortRequested && this.stopHandoffReady)) {
			throw new Error("Executor stop handoff is permitted only after a settled stop-pending abort.");
		}
		if (this.stopHandoffUsed) {
			throw new Error("Executor stop handoff is single-use.");
		}
		this.stopHandoffUsed = true;
		this.stopHandoffSettlementTarget = this.settledSequence + 1;
		const response = await this.send({ type: "prompt", message });
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected stop handoff.");
		}
	}

	async closeProcess(): Promise<void> {
		this.closed = true;
		const error = new Error("Executor RPC runtime closed.");
		rejectPending(error, this.pending);
		for (const waiter of this.settledWaiters.values()) {
			waiter.reject(error);
		}
		this.settledWaiters.clear();
		await this.stopChild();
		this.unregisterRuntime();
	}

	async sendSteer(message: string): Promise<void> {
		if (this.stopPending) {
			throw new Error("Executor runtime is stop-pending; no new steer may start.");
		}
		const response = await this.send({ type: "steer", message });
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected steer.");
		}
	}

	async sendAbort(): Promise<void> {
		if (!this.stopPending) {
			throw new Error("Executor abort requires a stop-pending barrier.");
		}
		this.settledWaitTarget = this.settledSequence + 1;
		const response = await this.send({ type: "abort" });
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected abort.");
		}
		this.abortRequested = true;
		this.stopHandoffReady = false;
	}

	setStopPending(): void {
		this.stopPending = true;
		this.abortRequested = false;
		this.stopHandoffReady = false;
		this.stopHandoffUsed = false;
		this.stopHandoffSettlementTarget = undefined;
	}

	getStopHandoffSettlementObservation(): StopHandoffSettlementObservation {
		const target = this.stopHandoffSettlementTarget;
		const observation: { observed: boolean; target?: number } = {
			observed: target !== undefined && this.settledSequence >= target,
		};
		if (target !== undefined) {
			observation.target = target;
		}
		return observation;
	}

	get isStopPending(): boolean {
		return this.stopPending;
	}

	async waitForSettled(timeoutMs = RPC_START_TIMEOUT_MS): Promise<void> {
		const target = this.settledWaitTarget ?? this.settledSequence + 1;
		if (this.settledSequence >= target) {
			this.settledWaitTarget = undefined;
			if (this.stopPending && this.abortRequested) {
				this.stopHandoffReady = true;
			}
			return;
		}
		try {
			await withTimeout(
				new Promise<void>((resolve, reject) => {
					this.settledWaiters.set(target, { resolve, reject });
				}),
				timeoutMs,
				"Pi RPC agent_settled timed out.",
			);
		} finally {
			this.settledWaitTarget = undefined;
		}
		if (this.stopPending && this.abortRequested) {
			this.stopHandoffReady = true;
		}
	}

	async stopForRecovery(): Promise<boolean> {
		if (this.closed) {
			throw new Error("Executor RPC runtime is closed.");
		}
		if (this.restartPromise !== undefined) {
			await this.restartPromise;
			return true;
		}
		this.started = false;
		await this.stopChild();
		return false;
	}

	async restartFromSession(): Promise<void> {
		if (this.closed) {
			throw new Error("Executor RPC runtime is closed.");
		}
		if (this.restartPromise !== undefined) {
			await this.restartPromise;
			return;
		}
		const restart = this.performRestart();
		this.restartPromise = restart;
		try {
			await restart;
		} finally {
			if (this.restartPromise === restart) {
				this.restartPromise = undefined;
			}
		}
	}

	private async performRestart(): Promise<void> {
		this.started = false;
		await this.stopChild();
		await this.startProcess(true);
	}

	async getEntries(since?: string): Promise<RpcEntries> {
		let command: RpcCommand = { type: "get_entries" };
		if (since !== undefined) {
			command = { type: "get_entries", since };
		}
		const response = await this.send(command);
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected get_entries.");
		}
		return readRpcEntries(response.data);
	}

	// The startup fence deliberately keeps binding, restart catch-up, and event release in one transaction.
	private async startProcess(resume: boolean): Promise<void> {
		if (this.starting) {
			throw new Error("Executor RPC startup is already in progress.");
		}
		if (this.closed) {
			throw new Error("Executor RPC runtime is closed.");
		}
		this.starting = true;
		this.eventReadyError = undefined;
		this.eventReady = new Promise((resolve) => {
			this.eventReadyResolve = resolve;
		});
		try {
			let sessionPath: string | undefined;
			if (resume) {
				sessionPath = this.binding?.sessionPath ?? this.options.sessionPath;
			}
			const child = (this.options.spawnProcess ?? defaultRpcChildFactory)(
				this.options.command,
				buildHeadlessPiArguments(this.options.args, this.options.model, sessionPath),
				this.options.cwd,
			);
			this.child = child;
			this.stopping = false;
			this.reader = new StrictJsonlReader((record) => this.handleRecord(record));
			this.attachChildHandlers(child);
			const state = await withTimeout(this.requestState(), RPC_START_TIMEOUT_MS, "Pi RPC get_state timed out.");
			const binding = readRpcSessionBinding(state);
			if (
				resume &&
				this.binding !== undefined &&
				(binding.sessionId !== this.binding.sessionId ||
					!sameFilesystemPath(binding.sessionPath, this.binding.sessionPath))
			) {
				throw new Error(`Executor RPC restart changed Pi session identity from ${this.binding.sessionId}.`);
			}
			if (this.options.sessionId !== undefined && binding.sessionId !== this.options.sessionId) {
				throw new Error(`Executor RPC session identity changed from ${this.options.sessionId}.`);
			}
			if (
				this.options.sessionPath !== undefined &&
				!sameFilesystemPath(binding.sessionPath, this.options.sessionPath)
			) {
				throw new Error(`Executor RPC session path changed from ${this.options.sessionPath}.`);
			}
			this.binding = binding;
			if (resume) {
				await this.options.onReady?.(binding);
				await this.options.onRestart?.(this);
			} else {
				await this.options.onReady?.(binding);
				await this.sendPrompt(this.options.mission);
			}
			this.started = true;
			this.eventReadyResolve?.();
			this.eventReadyResolve = undefined;
			await this.eventChain;
			if (this.eventFailure !== undefined) {
				throw this.eventFailure;
			}
		} catch (error) {
			const normalized = normalizeError(error, "Executor RPC startup failed");
			this.eventReadyError = normalized;
			if (this.closed) {
				await this.stopChild();
			} else {
				await this.fail(normalized);
			}
			throw normalized;
		} finally {
			this.eventReadyResolve?.();
			this.eventReadyResolve = undefined;
			this.starting = false;
		}
	}

	private attachChildHandlers(child: ChildProcess): void {
		child.stdout?.on("data", (chunk: Buffer | string) => {
			try {
				this.reader?.push(chunk);
			} catch (error) {
				this.reportFailure(error);
			}
		});
		child.stdout?.on("end", () => {
			try {
				this.reader?.end();
			} catch (error) {
				this.reportFailure(error);
			}
		});
		child.stdout?.on("error", (error) => {
			if (!this.stopping) {
				this.reportFailure(error);
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => this.captureStderr(chunk));
		child.stderr?.on("error", (error) => {
			if (!this.stopping) {
				this.reportFailure(error);
			}
		});
		child.stdin?.on("error", (error) => {
			if (!this.stopping) {
				this.reportFailure(error);
			}
		});
		child.once("error", (error) => this.reportFailure(error));
		child.once("exit", () => this.handleExit(child));
	}

	private async requestState(): Promise<RpcState> {
		const response = await this.send({ type: "get_state" });
		if (!response.success) {
			throw new Error(response.error ?? "Pi rejected get_state.");
		}
		return response.data as RpcState;
	}

	private send(command: RpcCommand): Promise<RpcResponse> {
		if (this.closed) {
			return Promise.reject(new Error("Executor RPC runtime is closed."));
		}
		const { child } = this;
		const stdin = child?.stdin;
		if (stdin === undefined || stdin === null || stdin.destroyed) {
			return Promise.reject(new Error("Executor RPC stdin is unavailable."));
		}
		this.requestNumber += 1;
		const id = `khala-rpc-${this.requestNumber}`;
		const commandWithId = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const settleWriteFailure = (error: Error): void => {
				if (!this.pending.delete(id)) {
					return;
				}
				reject(error);
				this.reportFailure(error);
			};
			try {
				stdin.write(`${JSON.stringify(commandWithId)}\n`, (error?: Error | null) => {
					if (error !== undefined && error !== null) {
						settleWriteFailure(normalizeError(error, "Executor RPC command failed"));
					}
				});
			} catch (error) {
				settleWriteFailure(normalizeError(error, "Executor RPC command failed"));
			}
		});
	}

	private handleRecord(record: unknown): void {
		if (typeof record !== "object" || record === null || !("type" in record)) {
			return;
		}
		const candidate = record as { type?: unknown; id?: unknown };
		if (candidate.type === "agent_settled") {
			this.settledSequence += 1;
			const waiter = this.settledWaiters.get(this.settledSequence);
			if (waiter !== undefined) {
				this.settledWaiters.delete(this.settledSequence);
				waiter.resolve();
			}
		}
		if (candidate.type === "response") {
			if (typeof candidate.id !== "string") {
				return;
			}
			const pending = this.pending.get(candidate.id);
			if (pending === undefined) {
				return;
			}
			this.pending.delete(candidate.id);
			pending.resolve(record as RpcResponse);
			return;
		}
		if (this.options.onEvent === undefined) {
			return;
		}
		this.eventChain = this.eventChain
			.catch(() => undefined)
			.then(() => this.eventReady)
			.then(() => {
				if (this.eventReadyError !== undefined) {
					throw this.eventReadyError;
				}
				return this.options.onEvent?.(record, this);
			})
			.catch((error: unknown) => {
				this.eventFailure = normalizeError(error, "Executor RPC event callback failed");
				this.reportFailure(this.eventFailure);
			});
	}

	private handleExit(child: ChildProcess): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		const error = new Error("Executor RPC child process exited unexpectedly.");
		rejectPending(error, this.pending);
		if (this.closed || !this.started) {
			return;
		}
		this.restartFromSession()
			.catch((restartError) => this.fail(restartError))
			.catch(() => undefined);
	}

	private fail(error: unknown): Promise<void> {
		if (this.failurePromise !== undefined) {
			return this.failurePromise;
		}
		const normalized = normalizeError(error, "Executor RPC process failed");
		this.closed = true;
		rejectPending(normalized, this.pending);
		this.failurePromise = (async () => {
			await this.stopChild();
			this.unregisterRuntime();
			try {
				await this.options.onFailure?.(normalized);
			} catch {
				// Failure reporting is advisory; it must never become an unhandled rejection.
			}
		})();
		return this.failurePromise;
	}

	private async stopChild(): Promise<void> {
		if (this.stopPromise !== undefined) {
			await this.stopPromise;
			return;
		}
		this.stopping = true;
		const { child } = this;
		this.stopPromise = (async () => {
			if (child === undefined) {
				return;
			}
			try {
				if (child.stdin !== null && !child.stdin.destroyed) {
					child.stdin.end();
				}
			} catch {
				// The exit/close race is settled by the bounded wait and kill below.
			}
			await waitForChildExit(child, RPC_SHUTDOWN_TIMEOUT_MS);
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {
					// A concurrent exit already owns termination.
				}
				await waitForChildExit(child, RPC_SHUTDOWN_TIMEOUT_MS);
			}
			if (this.child === child) {
				this.child = undefined;
			}
		})();
		try {
			await this.stopPromise;
		} finally {
			this.stopPromise = undefined;
		}
	}

	private unregisterRuntime(): void {
		if (this.options.executionId !== undefined) {
			unregisterHeadlessRuntime(this.options.executionId);
		}
	}

	private reportFailure(error: unknown): void {
		this.fail(error).catch(() => undefined);
	}

	private captureStderr(chunk: Buffer | string): void {
		let bytes: Buffer;
		if (typeof chunk === "string") {
			bytes = Buffer.from(chunk);
		} else {
			bytes = chunk;
		}
		this.capturedStderr = Buffer.concat([this.capturedStderr, bytes]);
		if (this.capturedStderr.length > MAX_CAPTURED_STDERR_BYTES) {
			this.capturedStderr = this.capturedStderr.subarray(-MAX_CAPTURED_STDERR_BYTES);
		}
	}
}

function defaultRpcChildFactory(command: string, args: readonly string[], cwd: string): ChildProcess {
	return spawn(command, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function readRpcSessionBinding(state: RpcState): RpcSessionBinding {
	if (typeof state.sessionId !== "string" || state.sessionId.trim().length === 0) {
		throw new Error("Pi RPC get_state did not return a stable sessionId.");
	}
	if (typeof state.sessionFile !== "string" || state.sessionFile.trim().length === 0) {
		throw new Error("Pi RPC get_state did not return a persistent sessionFile.");
	}
	return { sessionId: state.sessionId, sessionPath: state.sessionFile };
}

function buildHeadlessPiArguments(baseArguments: readonly string[], model: string, sessionPath?: string): string[] {
	const args = stripExecutorAuthorityOptions(baseArguments);
	const result = ["--mode", "rpc", "--model", model, ...args];
	if (sessionPath !== undefined) {
		return [...result, "--session", sessionPath];
	}
	return result;
}

function stripExecutorAuthorityOptions(command: readonly string[]): string[] {
	const valueOptions = new Set(["--provider", "--model", "--mode", "--session", "--session-id", "--fork"]);
	const flagOptions = new Set(["--resume", "--continue", "--no-session", "-r", "-c"]);
	const filtered: string[] = [];
	let skipNext = false;
	for (const argument of command) {
		let keep = true;
		if (skipNext) {
			skipNext = false;
			keep = false;
		} else if (valueOptions.has(argument)) {
			skipNext = true;
			keep = false;
		} else if (
			flagOptions.has(argument) ||
			[...valueOptions, ...flagOptions].some((option) => argument.startsWith(`${option}=`))
		) {
			keep = false;
		}
		if (keep) {
			filtered.push(argument);
		}
	}
	return filtered;
}

function rejectPending(
	error: Error,
	pending: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>,
): void {
	for (const request of pending.values()) {
		request.reject(error);
	}
	pending.clear();
}

function normalizeError(error: unknown, prefix: string): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(`${prefix}: ${String(error)}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

function registerHeadlessRuntime(executionId: string, runtime: HeadlessExecutorRuntime): void {
	headlessRuntimes.set(executionId, runtime);
}

function unregisterHeadlessRuntime(executionId: string): void {
	headlessRuntimes.delete(executionId);
}

function getHeadlessRuntime(executionId: string): HeadlessExecutorRuntime | undefined {
	return headlessRuntimes.get(executionId);
}

async function sendHeadlessExecutorMessage(executionId: string, message: string): Promise<void> {
	const runtime = headlessRuntimes.get(executionId);
	if (runtime === undefined) {
		throw new Error(`No live headless Executor runtime exists for Execution ${executionId}.`);
	}
	await runtime.sendPrompt(message);
}

async function disposeHeadlessRuntimes(): Promise<void> {
	const runtimes = [...headlessRuntimes.entries()];
	headlessRuntimes.clear();
	await Promise.all(runtimes.map(([, runtime]) => runtime.closeProcess()));
}

function readRpcEntries(value: unknown): RpcEntries {
	if (typeof value !== "object" || value === null) {
		throw new Error("Pi RPC get_entries returned invalid data.");
	}
	const candidate = value as { entries?: unknown; leafId?: unknown };
	if (!(Array.isArray(candidate.entries) && candidate.entries.every(isRpcSessionEntry))) {
		throw new Error("Pi RPC get_entries returned invalid entries.");
	}
	if (candidate.leafId !== null && candidate.leafId !== undefined && typeof candidate.leafId !== "string") {
		throw new Error("Pi RPC get_entries returned an invalid leafId.");
	}
	return { entries: candidate.entries, leafId: candidate.leafId ?? null };
}

function isRpcSessionEntry(value: unknown): value is RpcSessionEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return typeof candidate.type === "string" && typeof candidate.id === "string";
}

export type {
	HeadlessRuntimeOptions,
	RpcEntries,
	RpcSessionBinding,
	RpcSessionEntry,
	StopHandoffSettlementObservation,
};
export {
	buildHeadlessPiArguments,
	disposeHeadlessRuntimes,
	getHeadlessRuntime,
	HeadlessExecutorRuntime,
	KHALA_HEADLESS_LAUNCHER,
	readRpcSessionBinding,
	registerHeadlessRuntime,
	StrictJsonlReader,
	sendHeadlessExecutorMessage,
	unregisterHeadlessRuntime,
};
