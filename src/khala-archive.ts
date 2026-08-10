// biome-ignore-all lint/style/noExcessiveLinesPerFile: Archive append and replay locking are one durability boundary.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { nanoid } from "nanoid";
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import type { ArchiveSchemaVersion, KhalaArchiveAppend, KhalaArchiveRecord } from "./khala-model.js";
import { EXECUTION_SCHEMA_VERSION, isArchiveRecord, validateArchiveReplay } from "./khala-model.js";

class KhalaArchiveReadError extends Error {
	readonly path: string;
	readonly lineNumber: number | undefined;
	readonly cause: unknown;

	constructor(message: string, path: string, lineNumber?: number, cause?: unknown) {
		super(message);
		this.cause = cause;
		this.name = "KhalaArchiveReadError";
		this.path = path;
		this.lineNumber = lineNumber;
	}
}

function getArchivePath(projectPath: string, projectTrusted = false): string {
	return join(getConclaveDirectory(projectPath, projectTrusted), "archive.jsonl");
}

function createArchiveReadError(
	message: string,
	path: string,
	lineNumber?: number,
	cause?: unknown,
): KhalaArchiveReadError {
	return new KhalaArchiveReadError(message, path, lineNumber, cause);
}

const ARCHIVE_LOCK_RETRY_MS = 10;
const ARCHIVE_LOCK_TIMEOUT_MS = 5000;
const ARCHIVE_LOCK_BUFFER_SIZE = 4;
const ARCHIVE_OWNER_PATTERN = /^\d+$/;
const localArchiveLockDepth = new Map<string, number>();
type ArchivePayloadRecord = Record<string, unknown> &
	Readonly<{
		status?: unknown;
		kind?: unknown;
		purpose?: unknown;
		participantId?: unknown;
		missionId?: unknown;
		governingMandateId?: unknown;
		issuedByParticipantId?: unknown;
	}>;

function appendArchiveRecord(
	projectPath: string,
	input: KhalaArchiveAppend,
	projectTrusted = false,
): KhalaArchiveRecord {
	return appendArchiveRecords(projectPath, [input], projectTrusted)[0] as KhalaArchiveRecord;
}

function appendArchiveRecords(
	projectPath: string,
	inputs: readonly KhalaArchiveAppend[],
	projectTrusted = false,
): readonly KhalaArchiveRecord[] {
	if (inputs.length === 0) {
		return [];
	}
	return withArchiveLock(projectPath, projectTrusted, () =>
		appendArchiveRecordsUnlocked(projectPath, inputs, projectTrusted),
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Replay deduplication is kept beside the append boundary.
function appendArchiveRecordsUnlocked(
	projectPath: string,
	inputs: readonly KhalaArchiveAppend[],
	projectTrusted = false,
): readonly KhalaArchiveRecord[] {
	if (inputs.length === 0) {
		return [];
	}
	const resolvedProjectPath = resolve(projectPath);
	const records = inputs.map((input) => createArchiveRecord(resolvedProjectPath, input));
	const path = getArchivePath(resolvedProjectPath, projectTrusted);
	const existing = listArchiveRecords(resolvedProjectPath, projectTrusted);
	for (const record of records) {
		if (!isArchiveRecord(record)) {
			throw new Error("Cannot append an invalid Khala Archive record.");
		}
	}
	const knownActions = new Map<string, KhalaArchiveRecord>();
	for (const record of existing) {
		const actionId = readSupervisionActionId(record);
		if (actionId !== undefined) {
			knownActions.set(actionId, record);
		}
	}
	const pending: KhalaArchiveRecord[] = [];
	const returned: KhalaArchiveRecord[] = [];
	for (const record of records) {
		const actionId = readSupervisionActionId(record);
		if (actionId === undefined) {
			pending.push(record);
			returned.push(record);
		} else {
			const previous = knownActions.get(actionId);
			if (previous === undefined) {
				knownActions.set(actionId, record);
				pending.push(record);
				returned.push(record);
			} else if (sameReplayEvidence(previous, record)) {
				returned.push(previous);
			} else {
				throw new Error(`Supervision action ${actionId} was replayed with different evidence.`);
			}
		}
	}
	validateArchiveReplay([...existing, ...pending]);
	if (pending.length > 0) {
		mkdirSync(getConclaveDirectory(resolvedProjectPath, projectTrusted), { recursive: true });
		appendFileSync(path, `${pending.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	}
	return returned;
}

function sameReplayEvidence(previous: KhalaArchiveRecord, next: KhalaArchiveRecord): boolean {
	return (
		previous.type === next.type &&
		JSON.stringify(replayEnvelopeIdentity(previous)) === JSON.stringify(replayEnvelopeIdentity(next)) &&
		JSON.stringify(previous.payload) === JSON.stringify(next.payload)
	);
}

function replayEnvelopeIdentity(record: KhalaArchiveRecord): unknown {
	return {
		schemaVersion: record.schemaVersion,
		type: record.type,
		projectPath: record.projectPath,
		workId: record.workId,
		executionId: record.executionId,
	};
}

function readSupervisionActionId(record: KhalaArchiveRecord): string | undefined {
	if (record.type !== "coordination" && record.type !== "intervention") {
		return;
	}
	if (typeof record.payload !== "object" || record.payload === null || !("actionId" in record.payload)) {
		return;
	}
	const { actionId } = record.payload as { actionId?: unknown };
	if (typeof actionId === "string") {
		return actionId;
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy strict return analysis for an absent action.
	return undefined;
}

function createArchiveRecord(projectPath: string, input: KhalaArchiveAppend): KhalaArchiveRecord {
	const schemaVersion = resolveArchiveSchemaVersion(input);
	let record: KhalaArchiveRecord = {
		recordId: nanoid(),
		type: input.type,
		projectPath,
		workId: input.workId,
		recordedAt: new Date().toISOString(),
		payload: input.payload,
	};
	if (schemaVersion !== 1) {
		record = { ...record, schemaVersion };
	}
	if (input.executionId !== undefined) {
		return { ...record, executionId: input.executionId };
	}
	return record;
}

// Schema v2 describes the historic mission Execution contract. New mission
// Executions and active Executor writes always use v3, even when an internal
// caller supplies a legacy schema version.
function resolveArchiveSchemaVersion(input: KhalaArchiveAppend): ArchiveSchemaVersion {
	const inferredSchemaVersion = inferSchemaVersion(input);
	if (input.type === "execution" && typeof input.payload === "object" && input.payload !== null) {
		const payload = input.payload as ArchivePayloadRecord;
		if (
			inferredSchemaVersion === EXECUTION_SCHEMA_VERSION ||
			(payload.kind === "executor" && payload.status === "running")
		) {
			return EXECUTION_SCHEMA_VERSION;
		}
	}
	return input.schemaVersion ?? inferredSchemaVersion;
}

function inferSchemaVersion(input: KhalaArchiveAppend): ArchiveSchemaVersion {
	if (input.type === "mandate" || input.type === "mission") {
		return 2;
	}
	if (typeof input.payload !== "object" || input.payload === null) {
		return 1;
	}
	return inferPayloadSchemaVersion(input.type, input.payload as ArchivePayloadRecord);
}

function inferPayloadSchemaVersion(
	type: KhalaArchiveAppend["type"],
	payload: ArchivePayloadRecord,
): ArchiveSchemaVersion {
	if (type === "submission") {
		if (payload.status === "reviewing" || payload.status === "admitted" || payload.status === "rejected") {
			return 2;
		}
		return 1;
	}
	if (type === "execution") {
		if (hasV2Fields(payload, ["purpose", "participantId"])) {
			return EXECUTION_SCHEMA_VERSION;
		}
		return 1;
	}
	if (type === "signal") {
		if (hasV2Fields(payload, ["missionId", "participantId"])) {
			return 2;
		}
		return 1;
	}
	if (type === "verdict") {
		if (hasV2Fields(payload, ["missionId", "governingMandateId", "issuedByParticipantId"])) {
			return 2;
		}
		return 1;
	}
	return 2;
}

function hasV2Fields(payload: ArchivePayloadRecord, fields: readonly string[]): boolean {
	return fields.every((field) => payload[field] !== undefined);
}

function listArchiveRecords(projectPath: string, projectTrusted = false): readonly KhalaArchiveRecord[] {
	return withArchiveLock(projectPath, projectTrusted, () => listArchiveRecordsUnlocked(projectPath, projectTrusted));
}

function listArchiveRecordsUnlocked(projectPath: string, projectTrusted = false): readonly KhalaArchiveRecord[] {
	const path = getArchivePath(projectPath, projectTrusted);
	const contents = readArchiveContents(path);
	if (contents.length === 0) {
		return [];
	}
	const records = contents.split("\n").flatMap((line, index, lines) => {
		if (index === lines.length - 1 && line.length === 0) {
			return [];
		}
		return [parseArchiveLine(line, path, index + 1)];
	});
	try {
		validateArchiveReplay(records);
	} catch (error) {
		throw createArchiveReadError("Invalid Khala Archive replay state.", path, undefined, error);
	}
	return records;
}

function readArchiveContents(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (readErrorCode(error) === "ENOENT") {
			return "";
		}
		throw createArchiveReadError(`Unable to read the Khala Archive (${readErrorCode(error)}).`, path, undefined, error);
	}
}

function parseArchiveLine(line: string, path: string, lineNumber: number): KhalaArchiveRecord {
	if (line.trim().length === 0) {
		throw createArchiveReadError(`Malformed Khala Archive JSON at line ${lineNumber}.`, path, lineNumber);
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw createArchiveReadError(`Malformed Khala Archive JSON at line ${lineNumber}.`, path, lineNumber, error);
	}
	if (!isArchiveRecord(value)) {
		throw createArchiveReadError(`Invalid Khala Archive record at line ${lineNumber}.`, path, lineNumber);
	}
	return value;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Lock acquisition distinguishes active, stale, and crash-recovery states atomically.
function withArchiveLock<T>(projectPath: string, projectTrusted: boolean, operation: () => T): T {
	const directory = getConclaveDirectory(projectPath, projectTrusted);
	const lockKey = resolve(directory);
	const heldDepth = localArchiveLockDepth.get(lockKey);
	if (heldDepth !== undefined) {
		localArchiveLockDepth.set(lockKey, heldDepth + 1);
		try {
			return operation();
		} finally {
			localArchiveLockDepth.set(lockKey, heldDepth);
		}
	}
	mkdirSync(directory, { recursive: true });
	const lockPath = join(directory, "archive.lock");
	const deadline = Date.now() + ARCHIVE_LOCK_TIMEOUT_MS;
	let acquired = false;
	while (!acquired) {
		let created = false;
		try {
			mkdirSync(lockPath);
			created = true;
		} catch (error) {
			if (readErrorCode(error) !== "EEXIST") {
				throw error;
			}
			if (isStaleArchiveLock(lockPath)) {
				// Rename first so a concurrent acquirer cannot recreate the lock while
				// this process is recursively deleting the stale directory.
				const quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
				try {
					renameSync(lockPath, quarantinePath);
					rmSync(quarantinePath, { recursive: true, force: true });
				} catch (recoveryError) {
					if (readErrorCode(recoveryError) !== "EEXIST" && readErrorCode(recoveryError) !== "ENOENT") {
						throw recoveryError;
					}
				}
			} else if (Date.now() >= deadline) {
				throw createArchiveReadError(
					"The Khala Archive is busy; retry the operation.",
					join(directory, "archive.jsonl"),
					undefined,
					error,
				);
			} else {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(ARCHIVE_LOCK_BUFFER_SIZE)), 0, 0, ARCHIVE_LOCK_RETRY_MS);
			}
		}
		if (created) {
			try {
				writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, "utf8");
				acquired = true;
			} catch (error) {
				rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
		}
	}
	localArchiveLockDepth.set(lockKey, 1);
	try {
		return operation();
	} finally {
		localArchiveLockDepth.delete(lockKey);
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function isStaleArchiveLock(lockPath: string): boolean {
	try {
		const owner = readFileSync(join(lockPath, "owner"), "utf8").trim();
		if (!ARCHIVE_OWNER_PATTERN.test(owner)) {
			return isLockDirectoryStale(lockPath);
		}
		try {
			process.kill(Number(owner), 0);
			return false;
		} catch (error) {
			return readErrorCode(error) === "ESRCH";
		}
	} catch (error) {
		if (readErrorCode(error) !== "ENOENT") {
			return false;
		}
		return isLockDirectoryStale(lockPath);
	}
}

function isLockDirectoryStale(lockPath: string): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs >= ARCHIVE_LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

function readErrorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return "unknown read error";
}

export {
	appendArchiveRecord,
	appendArchiveRecords,
	getArchivePath,
	KhalaArchiveReadError,
	listArchiveRecords,
	withArchiveLock,
};
