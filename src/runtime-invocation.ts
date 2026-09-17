import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import type { JsonObject, JsonValue, TokenUsage } from "./model.js";
import type { RuntimeBinding, RuntimeInvocationEvidence } from "./ports.js";
import { isInteger, isJsonObject, isText, stopPersistedInvocation } from "./runtime-lease.js";
import type { RuntimeStorage } from "./runtime-storage.js";

type InvocationRecord = Readonly<{
	schemaVersion: 1;
	runId: string;
	writerProcessId: number;
	binding: RuntimeBinding;
	complete: boolean;
	writerStopped?: true | undefined;
	usage?: TokenUsage | undefined;
}>;

export type RuntimeInvocationWriter = Readonly<{
	record: InvocationRecord;
	storage: RuntimeStorage;
}>;

export function beginInvocation(
	runId: string | undefined,
	binding: RuntimeBinding,
	storage: RuntimeStorage,
): RuntimeInvocationWriter | undefined {
	if (runId === undefined) return undefined;
	assertRunId(runId);
	const writer = {
		record: {
			schemaVersion: 1,
			runId,
			writerProcessId: process.pid,
			binding: invocationBinding(binding),
			complete: false,
		},
		storage,
	} satisfies RuntimeInvocationWriter;
	writeNewRecord(writer);
	return writer;
}

export function persistInvocationUsage(
	writer: RuntimeInvocationWriter | undefined,
	usage: TokenUsage | undefined,
): void {
	if (writer === undefined) return;
	writeUpdatedRecord(writer, { ...writer.record, usage });
}

export function completeInvocation(writer: RuntimeInvocationWriter | undefined, usage: TokenUsage | undefined): void {
	if (writer === undefined) return;
	writeUpdatedRecord(writer, { ...writer.record, complete: true, usage });
}

export function readInvocation(runId: string, storage: RuntimeStorage): InvocationRecord {
	assertRunId(runId);
	let text: string;
	try {
		text = readFileSync(storage.invocationPath(runId), "utf8");
	} catch {
		throw new Error(`Runtime invocation ${runId} has no durable receipt.`);
	}
	const record = parseInvocationRecord(text);
	if (record === undefined || record.runId !== runId)
		throw new Error(`Runtime invocation ${runId} has a malformed durable receipt.`);
	return record;
}

export async function reconcilePersistedInvocation(
	runId: string,
	storage: RuntimeStorage,
): Promise<RuntimeInvocationEvidence> {
	const initial = readInvocation(runId, storage);
	if (initial.complete) return invocationEvidence(initial);
	if (initial.writerStopped === true) return invocationEvidence(initial);
	await stopPersistedInvocation(initial.binding, initial.writerProcessId, storage, () => {
		markInvocationWriterStopped(initial, storage);
	});
	const final = readInvocation(runId, storage);
	if (!sameInvocationWriter(initial, final))
		throw new Error(`Runtime invocation ${runId} changed ownership during reconciliation.`);
	return invocationEvidence(final);
}

function markInvocationWriterStopped(initial: InvocationRecord, storage: RuntimeStorage): void {
	const current = readInvocation(initial.runId, storage);
	if (!sameInvocationWriter(initial, current))
		throw new Error(`Runtime invocation ${initial.runId} changed ownership while its writer stopped.`);
	writeUpdatedRecord({ record: current, storage }, { ...current, writerStopped: true });
}

export function persistInvocationWriterStopped(writer: RuntimeInvocationWriter | undefined): void {
	if (writer === undefined) return;
	const current = readInvocation(writer.record.runId, writer.storage);
	if (current.complete) return;
	if (current.writerStopped === true) return;
	markInvocationWriterStopped(current, writer.storage);
}

export function invocationWriterIsSettled(writer: RuntimeInvocationWriter | undefined): boolean {
	if (writer === undefined) return true;
	try {
		const current = readInvocation(writer.record.runId, writer.storage);
		return current.complete || current.writerStopped === true;
	} catch {
		return false;
	}
}

function writeNewRecord(writer: RuntimeInvocationWriter): void {
	const path = writer.storage.invocationPath(writer.record.runId);
	writeDurable(path, JSON.stringify(writer.record), "wx", undefined);
}

function writeUpdatedRecord(writer: RuntimeInvocationWriter, record: InvocationRecord): void {
	const current = readInvocation(writer.record.runId, writer.storage);
	if (!sameInvocationWriter(writer.record, current) || current.complete)
		throw new Error(`Runtime invocation ${writer.record.runId} is no longer owned by this writer.`);
	const temporaryPath = writer.storage.invocationTemporaryPath(writer.record.runId);
	writeDurable(temporaryPath, JSON.stringify(record), "wx", writer.storage.invocationPath(writer.record.runId));
}

function writeDurable(path: string, contents: string, flag: "wx", destination: string | undefined): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, flag, 0o600);
		writeSync(descriptor, contents, undefined, "utf8");
		fsyncSync(descriptor);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	if (destination !== undefined) renameSync(path, destination);
	fsyncDirectory(dirname(destination ?? path));
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function parseInvocationRecord(text: string): InvocationRecord | undefined {
	let parsed: JsonValue;
	try {
		// SAFETY: every field is validated below before the parsed value enters the runtime domain.
		parsed = JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
	if (!isJsonObject(parsed) || parsed["schemaVersion"] !== 1) return undefined;
	return invocationRecordFromObject(parsed);
}

function invocationRecordFromObject(parsed: JsonObject): InvocationRecord | undefined {
	const identity = readInvocationIdentity(parsed);
	const fields = readInvocationFields(parsed);
	if (identity === undefined) return undefined;
	if (fields === undefined) return undefined;
	return { schemaVersion: 1, ...identity, ...fields };
}

function readInvocationFields(
	parsed: JsonObject,
): Pick<InvocationRecord, "binding" | "usage" | "writerStopped"> | undefined {
	const binding = readBinding(parsed["binding"]);
	const usage = readUsage(parsed["usage"]);
	const writerStopped = readWriterStopped(parsed["writerStopped"]);
	if (binding === undefined) return undefined;
	if (usage === null) return undefined;
	if (writerStopped === null) return undefined;
	return { binding, usage, writerStopped };
}

function readInvocationIdentity(
	value: JsonObject,
): Readonly<{ runId: string; writerProcessId: number; complete: boolean }> | undefined {
	const runId = value["runId"];
	const writerProcessId = value["writerProcessId"];
	const complete = value["complete"];
	if (!isText(runId)) return undefined;
	if (!positiveInteger(writerProcessId)) return undefined;
	if (!isBoolean(complete)) return undefined;
	return { runId, writerProcessId, complete };
}

function readBinding(value: JsonValue | undefined): RuntimeBinding | undefined {
	if (!isJsonObject(value)) return undefined;
	const session = readBindingSession(value);
	const processIdentity = readBindingProcess(value);
	if (session === undefined || processIdentity === undefined) return undefined;
	return { ...session, ...processIdentity };
}

function readBindingSession(value: JsonObject): Readonly<{ sessionId: string; sessionPath: string }> | undefined {
	const sessionId = value["sessionId"];
	const sessionPath = value["sessionPath"];
	if (!isText(sessionId)) return undefined;
	if (!isText(sessionPath)) return undefined;
	return { sessionId, sessionPath };
}

function readBindingProcess(
	value: JsonObject,
): Readonly<{ processGroupId: number; processStartTime: string; processMarker: string }> | undefined {
	const processGroupId = value["processGroupId"];
	const processStartTime = value["processStartTime"];
	const processMarker = value["processMarker"];
	if (!positiveInteger(processGroupId)) return undefined;
	if (!isText(processStartTime)) return undefined;
	if (!isText(processMarker)) return undefined;
	return { processGroupId, processStartTime, processMarker };
}

function invocationBinding(binding: RuntimeBinding): RuntimeBinding {
	return {
		sessionId: binding.sessionId,
		sessionPath: binding.sessionPath,
		processGroupId: binding.processGroupId,
		processStartTime: binding.processStartTime,
		processMarker: binding.processMarker,
	};
}

function readUsage(value: JsonValue | undefined): TokenUsage | undefined | null {
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) return null;
	return usageFromObject(value);
}

function usageFromObject(value: JsonObject): TokenUsage | null {
	const direct = readUsagePair(value["inputTokens"], value["outputTokens"]);
	const cached = readUsagePair(value["cacheHitTokens"], value["cacheMissTokens"]);
	if (direct === undefined) return null;
	if (cached === undefined) return null;
	const [inputTokens, outputTokens] = direct;
	const [cacheHitTokens, cacheMissTokens] = cached;
	return { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens };
}

function readUsagePair(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): readonly [number, number] | undefined {
	if (!nonnegativeInteger(left)) return undefined;
	if (!nonnegativeInteger(right)) return undefined;
	return [left, right];
}

function nonnegativeInteger(value: JsonValue | undefined): value is number {
	return isInteger(value) && value >= 0;
}

function positiveInteger(value: JsonValue | undefined): value is number {
	return isInteger(value) && value > 0;
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

function readWriterStopped(value: JsonValue | undefined): true | undefined | null {
	if (value === undefined) return undefined;
	return value === true ? true : null;
}

function sameInvocationWriter(left: InvocationRecord, right: InvocationRecord): boolean {
	return (
		left.runId === right.runId &&
		left.writerProcessId === right.writerProcessId &&
		JSON.stringify(left.binding) === JSON.stringify(right.binding)
	);
}

function invocationEvidence(record: InvocationRecord): RuntimeInvocationEvidence {
	return record.usage === undefined
		? { complete: record.complete }
		: { complete: record.complete, usage: record.usage };
}

function assertRunId(runId: string): void {
	if (runId.length === 0 || runId.length > 256)
		throw new Error("Runtime invocation run ID must contain 1 to 256 characters.");
}
