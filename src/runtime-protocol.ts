import { unlinkSync } from "node:fs";
import type { JsonObject, JsonValue, TokenUsage } from "./model.js";
import {
	type OperationContext,
	type RuntimeBinding,
	type RuntimeSendOptions,
	type RuntimeState,
	type RuntimeTurn,
	RuntimeTurnError,
} from "./ports.js";
import { completeInvocation, persistInvocationUsage, persistInvocationWriterStopped } from "./runtime-invocation.js";
import { isInteger, isJsonObject, isText, removeLaunchLeaseSync } from "./runtime-lease.js";
import { processGroupExists, terminateProcessGroup } from "./runtime-process.js";
import type { RuntimeStorage } from "./runtime-storage.js";
import type {
	MutableChild,
	PendingResponse,
	RpcBlock,
	RpcCommandData,
	RpcData,
	RpcEvent,
	RpcMessage,
	RpcResponse,
	RpcUsage,
} from "./runtime-types.js";

const MAX_ASSISTANT_TEXT_LENGTH = 16_000;
const ASSISTANT_TRUNCATION_INDICATOR = "[assistant output truncated]";
type RpcEventType = "response" | "message_end" | "agent_settled";
const RPC_EVENT_TYPES: ReadonlyMap<string, RpcEventType> = new Map([
	["response", "response"],
	["message_end", "message_end"],
	["agent_settled", "agent_settled"],
]);
export function removeEphemeralSession(child: MutableChild): void {
	if (!child.ephemeralSession || child.binding.sessionPath.length === 0) return;
	try {
		unlinkSync(child.binding.sessionPath);
	} catch {
		// The child may have removed its session file already.
	}
}

export function attachOutput(child: MutableChild, onExit: () => void, onProtocolFailure: (error: Error) => void): void {
	child.process.stdout.on("data", (chunk: Buffer) => {
		if (child.closed) return;
		try {
			consumeChunk(child, chunk);
		} catch (error) {
			onProtocolFailure(error instanceof Error ? error : new Error(String(error)));
		}
	});
	child.process.stderr.on("data", (chunk: Buffer) => {
		child.lastError = `${child.lastError}${chunk.toString("utf8")}`.slice(-4000);
	});
	let exited = false;
	const cleanupAfterExit = (): void => {
		if (exited) return;
		exited = true;
		// Do not release ownership until the entire owned group is confirmed stopped.
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
function consumeChunk(child: MutableChild, chunk: Buffer): void {
	while (chunk.length > 0) {
		const newline = chunk.indexOf(10);
		const end = newline < 0 ? chunk.length : newline + 1;
		appendFrameBytes(child, chunk.subarray(0, end));
		chunk = chunk.subarray(end);
		if (newline >= 0) consumeBufferedLine(child);
	}
}

function appendFrameBytes(child: MutableChild, bytes: Buffer): void {
	if (child.buffer.length + bytes.length > child.maxRpcFrameBytes)
		throw new Error(`Pi RPC frame exceeded the ${child.maxRpcFrameBytes}-byte limit.`);
	child.buffer = Buffer.concat([child.buffer, bytes]);
}

function consumeBufferedLine(child: MutableChild): void {
	const newline = child.buffer.indexOf(10);
	if (newline < 0) return;
	const line = child.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
	child.buffer = child.buffer.subarray(newline + 1);
	if (line.trim().length > 0) consumeLine(child, line);
}

function consumeLine(child: MutableChild, line: string): void {
	const event = parseRpcEvent(line);
	const type = RPC_EVENT_TYPES.get(event.type ?? "");
	if (type === undefined) return;
	dispatchRpcEvent(child, event, type);
}

function dispatchRpcEvent(child: MutableChild, event: RpcEvent, type: RpcEventType): void {
	if (type === "response") consumeResponse(child, event);
	if (type === "message_end") consumeMessage(child, event);
	if (type === "agent_settled") resolveAgentEnd(child);
}

function parseRpcEvent(line: string): RpcEvent {
	const parsed = parseRpcObject(line);
	const type = requiredRpcText(parsed, "type");
	if (type === "response") return readRpcResponseEvent(parsed);
	if (type === "message_end") return readRpcMessageEvent(parsed);
	return { type };
}

function parseRpcObject(line: string): JsonObject {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error("Pi RPC frame was not valid JSON.");
	}
	if (!isJsonObject(parsed)) throw new Error("Pi RPC frame was not a JSON object.");
	return parsed;
}

function readRpcResponseEvent(parsed: JsonObject): RpcEvent {
	return {
		type: "response",
		id: optionalRpcText(parsed, "id"),
		command: requiredRpcText(parsed, "command"),
		success: requiredRpcBoolean(parsed, "success"),
		data: optionalRpcData(parsed["data"]),
		error: optionalRpcText(parsed, "error"),
	};
}

function readRpcMessageEvent(parsed: JsonObject): RpcEvent {
	const message = parsed["message"];
	if (!isJsonObject(message)) throw new Error("Pi RPC message_end event is invalid.");
	return { type: "message_end", message: readRpcMessage(message) };
}

function readRpcMessage(parsed: JsonObject): RpcMessage {
	const role = requiredRpcText(parsed, "role");
	if (role !== "assistant") return { role };
	const content = parsed["content"];
	if (!Array.isArray(content)) throw new Error("Pi RPC message content is invalid.");
	return {
		role: requiredRpcText(parsed, "role"),
		content: content.map(readRpcBlock),
		usage: optionalRpcUsage(parsed["usage"]),
	};
}

function readRpcBlock(value: JsonValue): RpcBlock {
	if (!isJsonObject(value)) throw new Error("Pi RPC message block is invalid.");
	return { type: optionalRpcText(value, "type"), text: optionalRpcText(value, "text") };
}

function optionalRpcData(value: JsonValue | undefined): RpcData | undefined {
	return value === undefined
		? undefined
		: isJsonObject(value)
			? {
					sessionId: optionalRpcText(value, "sessionId"),
					sessionFile: optionalRpcText(value, "sessionFile"),
					isStreaming: optionalRpcBoolean(value, "isStreaming"),
				}
			: invalidRpcField("data");
}

function optionalRpcUsage(value: JsonValue | undefined): RpcUsage | undefined {
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) return invalidRpcField("usage");
	return {
		input: optionalRpcNumber(value, "input"),
		output: optionalRpcNumber(value, "output"),
		cacheRead: optionalRpcNumber(value, "cacheRead"),
		cacheWrite: optionalRpcNumber(value, "cacheWrite"),
	};
}

function requiredRpcText(value: JsonObject, key: string): string {
	const result = optionalRpcText(value, key);
	if (result === undefined) throw new Error(`Pi RPC event field ${key} is invalid.`);
	return result;
}

function optionalRpcText(value: JsonObject, key: string): string | undefined {
	const entry = value[key];
	return entry === undefined ? undefined : isText(entry) ? entry : invalidRpcField(key);
}

function requiredRpcBoolean(value: JsonObject, key: string): boolean {
	const result = optionalRpcBoolean(value, key);
	if (result === undefined) throw new Error(`Pi RPC event field ${key} is invalid.`);
	return result;
}

function optionalRpcBoolean(value: JsonObject, key: string): boolean | undefined {
	const entry = value[key];
	return entry === undefined ? undefined : entry === true || entry === false ? entry : invalidRpcField(key);
}

function optionalRpcNumber(value: JsonObject, key: string): number | undefined {
	const entry = value[key];
	return entry === undefined ? undefined : isInteger(entry) ? entry : invalidRpcField(key);
}

function invalidRpcField(key: string): never {
	throw new Error(`Pi RPC event field ${key} is invalid.`);
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
	if (child.allowanceStop === undefined) child.lastOutput = assistantText(event.message);
	consumeMessageUsage(child, event.message.usage);
}

function consumeMessageUsage(child: MutableChild, value: RpcUsage | undefined): void {
	const usage = readTokenUsage(value);
	if (usage === undefined) return;
	child.turnUsage = addTokenUsage(child.turnUsage, usage);
	persistInvocationUsage(child.invocationWriter, child.turnUsage);
	stopAtAllowance(child);
}

function stopAtAllowance(child: MutableChild): void {
	if (child.allowanceStop !== undefined || !allowanceReached(child)) return;
	requestAllowanceStop(child);
}

function allowanceReached(child: MutableChild): boolean {
	const allowance = child.turnAllowance;
	const usage = child.turnUsage;
	return allowance !== undefined && usage !== undefined && usageReachesAllowance(usage, allowance);
}

function usageReachesAllowance(usage: TokenUsage, allowance: number): boolean {
	return usage.inputTokens + usage.outputTokens >= allowance;
}

function requestAllowanceStop(child: MutableChild): void {
	// An acknowledgement is not proof of settlement. Replace the ordinary turn
	// deadline so even an acknowledged but ineffective abort cannot keep spending.
	clearTimeout(child.agentTimer);
	child.agentTimer = setTimeout(
		() => rejectAgentEnd(child, new Error("Pi did not settle after reaching its token allowance.")),
		child.rpcTimeoutMs,
	);
	child.allowanceStop = request(child, "abort", {}, child.rpcTimeoutMs)
		.then((response) => {
			if (!response.success) throw new Error(response.error ?? "Pi rejected the allowance stop request.");
		})
		.catch(() => {
			const failure = new Error("Pi did not acknowledge the allowance stop request.");
			rejectAgentEnd(child, failure);
			throw failure;
		});
	void child.allowanceStop.catch(() => undefined);
}

export function readRuntimeTokenAllowance(options: RuntimeSendOptions): number {
	const allowance = options.tokenAllowance;
	if (!Number.isSafeInteger(allowance) || allowance <= 0)
		throw new Error("Runtime token allowance must be a positive safe integer.");
	return allowance;
}

let requestCounter = 0;
export async function requestAbortBestEffort(child: MutableChild, timeoutMs: number): Promise<void> {
	try {
		await request(child, "abort", {}, timeoutMs);
	} catch {
		// Termination confirmation below is the authoritative stop result.
	}
}

export async function terminateChild(child: MutableChild): Promise<void> {
	const processGroupId = child.binding.processGroupId ?? child.process.pid;
	const leaderExited = child.process.exitCode !== null || child.process.signalCode !== null;
	await terminateProcessGroup(processGroupId, child.binding.processStartTime, leaderExited);
}

export function cleanupChild(child: MutableChild): Promise<void> {
	if (child.cleanupPromise !== undefined) return child.cleanupPromise;
	const cleanup = (async () => {
		await terminateChild(child);
		persistInvocationWriterStopped(child.invocationWriter);
		removeLaunchLeaseSync(child.binding.sessionPath, child.binding.processMarker, child.storage);
		removeEphemeralSession(child);
		child.remove?.();
	})();
	child.cleanupPromise = cleanup;
	void cleanup.catch(() => {
		if (child.cleanupPromise === cleanup) child.cleanupPromise = undefined;
	});
	return cleanup;
}

export function request(
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
export function agentTimeout(child: MutableChild, fallback: number | undefined): number {
	return child.agentTimeoutMs ?? fallback ?? 1_800_000;
}
export function rpcTimeout(value: number | undefined): number {
	return value ?? 10_000;
}
export function validateMaxRpcFrameBytes(value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
		throw new Error("Pi RPC frame limit must be a positive safe integer.");
}
export async function completedTurn(child: MutableChild, completion: Promise<string>): Promise<RuntimeTurn> {
	const output = await completion;
	// Do not let a delayed abort for this invocation interrupt the next prompt.
	await child.allowanceStop;
	return child.turnUsage === undefined ? { output } : { output, usage: child.turnUsage };
}
export function unattachedRuntimeState(binding: RuntimeBinding): RuntimeState {
	return processGroupExists(binding.processGroupId) ? "unknown" : "unreachable";
}

export async function stopUnattachedBinding(binding: RuntimeBinding, storage: RuntimeStorage): Promise<void> {
	await terminateProcessGroup(binding.processGroupId, binding.processStartTime);
	removeLaunchLeaseSync(binding.sessionPath, binding.processMarker, storage);
}

export async function failTurn(
	child: MutableChild,
	completion: Promise<string>,
	failure: RuntimeTurnError,
): Promise<RuntimeTurnError> {
	rejectAgentEnd(child, failure);
	try {
		await cleanupChild(child);
	} catch (error) {
		const cleanupFailure = error instanceof Error ? error.message : String(error);
		return new RuntimeTurnError(`${failure.message} Cleanup failed: ${cleanupFailure}`, failure.usage);
	}
	await completion.catch(() => undefined);
	return failure;
}

export async function sendPrompt(
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

export function createAbortHandler(
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

export function registerAbortHandler(operation: OperationContext | undefined, handler: (() => void) | undefined): void {
	if (operation?.signal !== undefined && handler !== undefined)
		operation.signal.addEventListener("abort", handler, { once: true });
}

export function removeAbortHandler(operation: OperationContext | undefined, handler: (() => void) | undefined): void {
	if (operation?.signal !== undefined && handler !== undefined) operation.signal.removeEventListener("abort", handler);
}

export function childRuntimeState(response: RpcResponse): RuntimeState {
	if (!response.success) return "unknown";
	return response.data?.isStreaming === true ? "working" : "idle";
}

export function rejectPending(child: MutableChild, error: Error): void {
	for (const pending of child.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	child.pending.clear();
}

export function waitForAgentSettled(child: MutableChild, timeoutMs: number): Promise<string> {
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
		completeInvocation(child.invocationWriter, child.turnUsage);
		child.resolveAgentEnd(child.lastOutput);
	}
	child.resolveAgentEnd = undefined;
	child.rejectAgentEnd = undefined;
	child.lastAgentEnd = undefined;
}

export function rejectAgentEnd(child: MutableChild, error: Error): void {
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

export function awaitOperation<T>(promise: Promise<T>, operation: OperationContext | undefined): Promise<T> {
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

export function throwIfAborted(operation: OperationContext | undefined): void {
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
export function readSessionText(value: RpcData | undefined, key: "sessionId" | "sessionFile"): string {
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
	let output = "";
	let textBlocks = 0;
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const next = appendAssistantText(output, block.text, textBlocks > 0);
		output = next.text;
		textBlocks += 1;
		if (next.truncated) return truncatedAssistantText(output);
	}
	return output.trim();
}

function appendAssistantText(output: string, text: string | undefined, separated: boolean) {
	if (text === undefined) return { text: output, truncated: false };
	const prefix = separated ? "\n" : "";
	const remaining = MAX_ASSISTANT_TEXT_LENGTH - output.length - prefix.length;
	if (remaining <= 0) return { text: output, truncated: true };
	return { text: output + prefix + text.slice(0, remaining), truncated: text.length > remaining };
}

function truncatedAssistantText(output: string): string {
	const available = MAX_ASSISTANT_TEXT_LENGTH - ASSISTANT_TRUNCATION_INDICATOR.length - 1;
	return `${output.slice(0, available).trimEnd()}\n${ASSISTANT_TRUNCATION_INDICATOR}`;
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
