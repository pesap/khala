import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { nanoid } from "nanoid";
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import type { ArchiveSchemaVersion, KhalaArchiveAppend, KhalaArchiveRecord } from "./khala-model.js";
import { isArchiveRecord } from "./khala-model.js";

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
type ArchivePayloadRecord = Record<string, unknown> &
	Readonly<{
		status?: unknown;
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
	const resolvedProjectPath = resolve(projectPath);
	const records = inputs.map((input) => createArchiveRecord(resolvedProjectPath, input));
	const path = getArchivePath(resolvedProjectPath, projectTrusted);
	mkdirSync(getConclaveDirectory(resolvedProjectPath, projectTrusted), { recursive: true });
	appendFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	return records;
}

function createArchiveRecord(projectPath: string, input: KhalaArchiveAppend): KhalaArchiveRecord {
	const schemaVersion = input.schemaVersion ?? inferSchemaVersion(input);
	let record: KhalaArchiveRecord = {
		recordId: nanoid(),
		type: input.type,
		projectPath,
		workId: input.workId,
		recordedAt: new Date().toISOString(),
		payload: input.payload,
	};
	if (schemaVersion === 2) {
		record = { ...record, schemaVersion: 2 };
	}
	if (input.executionId !== undefined) {
		return { ...record, executionId: input.executionId };
	}
	return record;
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
			return 2;
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
	const path = getArchivePath(projectPath, projectTrusted);
	const contents = readArchiveContents(path);
	if (contents.length === 0) {
		return [];
	}
	return contents.split("\n").flatMap((line, index, lines) => {
		if (index === lines.length - 1 && line.length === 0) {
			return [];
		}
		return [parseArchiveLine(line, path, index + 1)];
	});
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

function withArchiveLock<T>(projectPath: string, projectTrusted: boolean, operation: () => T): T {
	const directory = getConclaveDirectory(projectPath, projectTrusted);
	mkdirSync(directory, { recursive: true });
	const lockPath = join(directory, "archive.lock");
	const deadline = Date.now() + ARCHIVE_LOCK_TIMEOUT_MS;
	let acquired = false;
	while (!acquired) {
		try {
			mkdirSync(lockPath);
			writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, "utf8");
			acquired = true;
		} catch (error) {
			if (readErrorCode(error) !== "EEXIST") {
				rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			if (isStaleArchiveLock(lockPath)) {
				rmSync(lockPath, { recursive: true, force: true });
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
	}
	try {
		return operation();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function isStaleArchiveLock(lockPath: string): boolean {
	try {
		const owner = readFileSync(join(lockPath, "owner"), "utf8").trim();
		if (!ARCHIVE_OWNER_PATTERN.test(owner)) {
			return false;
		}
		try {
			process.kill(Number(owner), 0);
			return false;
		} catch (error) {
			return readErrorCode(error) === "ESRCH";
		}
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
