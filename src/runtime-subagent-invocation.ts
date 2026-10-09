import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import type { JsonObject, JsonValue, TokenUsage } from "./model.js";
import type { RuntimeInvocationEvidence, RuntimeInvocationRecorder } from "./ports.js";
import { readProcessStartTime } from "./runtime-process.js";
import type { RuntimeStorage } from "./runtime-storage.js";

type NestedInvocationRecord = Readonly<{
	schemaVersion: 1;
	runId: string;
	writerProcessId: number;
	writerProcessStartTime?: string | undefined;
	sessionId: string;
	complete: boolean;
	writerStopped?: true | undefined;
	usage?: TokenUsage | undefined;
}>;

type NestedInvocationWriter = Readonly<{
	record: NestedInvocationRecord;
	storage: RuntimeStorage;
}>;

type NestedInvocationIdentity = Readonly<{
	runId: string;
	writerProcessId: number;
	sessionId: string;
	complete: boolean;
}>;

export async function beginNestedInvocation(
	runId: string,
	sessionId: string,
	storage: RuntimeStorage,
): Promise<RuntimeInvocationRecorder> {
	assertText(runId, "Runtime invocation run ID");
	assertText(sessionId, "Pi session ID");
	await storage.prepare();
	const record: NestedInvocationRecord = {
		schemaVersion: 1,
		runId,
		writerProcessId: process.pid,
		writerProcessStartTime: readProcessStartTime(process.pid),
		sessionId,
		complete: false,
	};
	const writer = { record, storage } satisfies NestedInvocationWriter;
	writeNewRecord(writer);
	return {
		reportUsage: (usage) => writeUpdatedRecord(writer, { ...writer.record, usage }),
		complete: (usage) => writeUpdatedRecord(writer, { ...writer.record, complete: true, usage }),
		stop: () => stopNestedInvocation(writer),
	};
}

export async function reconcileNestedInvocation(
	runId: string,
	storage: RuntimeStorage,
): Promise<RuntimeInvocationEvidence | undefined> {
	const initial = readNestedInvocation(runId, storage);
	if (initial === undefined) return;
	if (isSettledRecord(initial)) return invocationEvidence(initial);
	assertNestedWriterStopped(initial);
	writeUpdatedRecord({ record: initial, storage }, { ...initial, writerStopped: true });
	return invocationEvidence(readNestedInvocation(runId, storage) ?? initial);
}

function isSettledRecord(record: NestedInvocationRecord): boolean {
	return record.complete || record.writerStopped === true;
}

function stopNestedInvocation(writer: NestedInvocationWriter): void {
	const current = readNestedInvocation(writer.record.runId, writer.storage);
	if (current === undefined) throw new Error(`Runtime invocation ${writer.record.runId} has no durable receipt.`);
	if (isSettledRecord(current)) return;
	writeUpdatedRecord(writer, { ...current, writerStopped: true });
}

function assertNestedWriterStopped(record: NestedInvocationRecord): void {
	if (writerProcessIsMissing(record.writerProcessId)) return;
	assertWriterIsNotActive(record);
}

function writerProcessIsMissing(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		return error instanceof Error && hasErrorCode(error, "ESRCH");
	}
}

function assertWriterIsNotActive(record: NestedInvocationRecord): void {
	const currentStartTime = readProcessStartTime(record.writerProcessId);
	const [recordedStartTime, verifiedCurrentStartTime] = verifiedWriterStartTimes(record, currentStartTime);
	if (writerProcessInstanceChanged(recordedStartTime, verifiedCurrentStartTime)) return;
	throw activeNestedWriter(record);
}

function verifiedWriterStartTimes(
	record: NestedInvocationRecord,
	currentStartTime: string | undefined,
): readonly [string, string] {
	if (record.writerProcessStartTime === undefined || currentStartTime === undefined)
		throw new Error(`Runtime invocation ${record.runId} has an unverified in-session writer; refusing reconciliation.`);
	return [record.writerProcessStartTime, currentStartTime];
}

function writerProcessInstanceChanged(recordedStartTime: string, currentStartTime: string): boolean {
	return recordedStartTime !== currentStartTime;
}

function activeNestedWriter(record: NestedInvocationRecord): Error {
	return new Error(
		`Runtime invocation ${record.runId} is still owned by active Pi session ${record.sessionId}; Khala will not stop its parent session.`,
	);
}

function writeNewRecord(writer: NestedInvocationWriter): void {
	writeDurable(
		writer.storage.nestedInvocationPath(writer.record.runId),
		JSON.stringify(writer.record),
		"wx",
		undefined,
	);
}

function writeUpdatedRecord(writer: NestedInvocationWriter, record: NestedInvocationRecord): void {
	const current = readNestedInvocation(writer.record.runId, writer.storage);
	if (current === undefined) throw new Error(`Runtime invocation ${writer.record.runId} has no durable receipt.`);
	if (!canUpdateRecord(writer.record, current))
		throw new Error(`Runtime invocation ${writer.record.runId} is no longer owned by this Pi session.`);
	const temporaryPath = writer.storage.nestedInvocationTemporaryPath(writer.record.runId);
	try {
		writeDurable(temporaryPath, JSON.stringify(record), "wx", writer.storage.nestedInvocationPath(writer.record.runId));
	} finally {
		removeTemporaryRecord(temporaryPath);
	}
}

function canUpdateRecord(writer: NestedInvocationRecord, current: NestedInvocationRecord): boolean {
	return sameNestedInvocationWriter(writer, current) && !isSettledRecord(current);
}

function removeTemporaryRecord(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!(error instanceof Error) || !hasErrorCode(error, "ENOENT")) throw error;
	}
}

function readNestedInvocation(runId: string, storage: RuntimeStorage): NestedInvocationRecord | undefined {
	const text = readNestedText(runId, storage);
	if (text === undefined) return;
	const record = parseNestedInvocation(text);
	if (record === undefined || record.runId !== runId)
		throw new Error(`Runtime invocation ${runId} has a malformed in-session receipt.`);
	return record;
}

function readNestedText(runId: string, storage: RuntimeStorage): string | undefined {
	try {
		return readFileSync(storage.nestedInvocationPath(runId), "utf8");
	} catch (error) {
		if (error instanceof Error && hasErrorCode(error, "ENOENT")) return;
		throw error;
	}
}

function parseNestedInvocation(text: string): NestedInvocationRecord | undefined {
	const parsed = parseJson(text);
	if (!isJsonObject(parsed)) return;
	return parseNestedInvocationObject(parsed);
}

function parseNestedInvocationObject(value: JsonObject): NestedInvocationRecord | undefined {
	if (value["schemaVersion"] !== 1) return;
	const identity = nestedInvocationIdentity(value);
	if (identity === undefined) return;
	const optionalFields = readOptionalRecordFields(value);
	if (optionalFields === undefined) return;
	return { schemaVersion: 1, ...identity, ...optionalFields };
}

function readOptionalRecordFields(
	value: JsonObject,
): Pick<NestedInvocationRecord, "writerProcessStartTime" | "writerStopped" | "usage"> | undefined {
	const writerProcessStartTime = optionalText(value["writerProcessStartTime"]);
	const writerStopped = readWriterStopped(value["writerStopped"]);
	const usage = parseUsage(value["usage"]);
	if (writerProcessStartTime === null || writerStopped === null || usage === null) return;
	return { writerProcessStartTime, writerStopped, usage };
}

function nestedInvocationIdentity(value: JsonObject): NestedInvocationIdentity | undefined {
	if (!isNestedInvocationIdentity(value)) return;
	return {
		runId: value["runId"],
		writerProcessId: value["writerProcessId"],
		sessionId: value["sessionId"],
		complete: value["complete"],
	};
}

function isNestedInvocationIdentity(value: JsonObject): value is JsonObject & {
	runId: string;
	writerProcessId: number;
	sessionId: string;
	complete: boolean;
} {
	return [
		isText(value["runId"]),
		positiveInteger(value["writerProcessId"]),
		isText(value["sessionId"]),
		isBoolean(value["complete"]),
	].every(Boolean);
}

function parseUsage(value: JsonValue | undefined): TokenUsage | undefined | null {
	if (value === undefined) return;
	if (!isJsonObject(value)) return null;
	const counts = [value["inputTokens"], value["outputTokens"], value["cacheHitTokens"], value["cacheMissTokens"]];
	if (!isUsageCountTuple(counts)) return null;
	return {
		inputTokens: counts[0],
		outputTokens: counts[1],
		cacheHitTokens: counts[2],
		cacheMissTokens: counts[3],
	};
}

function isUsageCountTuple(
	value: readonly (JsonValue | undefined)[],
): value is readonly [number, number, number, number] {
	return value.length === 4 && value.every(nonnegativeInteger);
}

function readWriterStopped(value: JsonValue | undefined): true | undefined | null {
	if (value === undefined) return;
	return value === true ? true : null;
}

function optionalText(value: JsonValue | undefined): string | undefined | null {
	if (value === undefined) return;
	return isText(value) ? value : null;
}

function parseJson(text: string): JsonValue {
	try {
		// SAFETY: the parser validates every field before the value enters the runtime domain.
		return JSON.parse(text) as JsonValue;
	} catch {
		return null;
	}
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
	const directory = openSync(dirname(destination ?? path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function sameNestedInvocationWriter(left: NestedInvocationRecord, right: NestedInvocationRecord): boolean {
	return [
		left.runId === right.runId,
		left.writerProcessId === right.writerProcessId,
		left.writerProcessStartTime === right.writerProcessStartTime,
		left.sessionId === right.sessionId,
	].every(Boolean);
}

function invocationEvidence(record: NestedInvocationRecord): RuntimeInvocationEvidence {
	return record.usage === undefined
		? { complete: record.complete }
		: { complete: record.complete, usage: record.usage };
}

function assertText(value: string, label: string): void {
	if (value.length === 0 || value.length > 256) throw new Error(`${label} must contain 1 to 256 characters.`);
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

function positiveInteger(value: JsonValue | undefined): value is number {
	return isInteger(value) && value > 0;
}

function nonnegativeInteger(value: JsonValue | undefined): value is number {
	return isInteger(value) && value >= 0;
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

function hasErrorCode(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}
