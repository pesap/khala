export function pendingEffectsQuery(excludedEffectIds: readonly string[]): string {
	const exclusion =
		excludedEffectIds.length === 0 ? "" : `AND effect_id NOT IN (${excludedEffectIds.map(() => "?").join(",")})`;
	return `SELECT effect_id, kind, payload_json, created_at FROM outbox WHERE completed_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM outbox_claim WHERE outbox_claim.effect_id = outbox.effect_id)
		${exclusion} ORDER BY created_at, effect_id LIMIT 1`;
}

export function commandFingerprint(input: ArchiveAppend): string | null {
	return input.commandFingerprint ?? null;
}

export function missionId(input: ArchiveAppend): string | null {
	return input.missionId ?? null;
}

export function executionId(input: ArchiveAppend): string | null {
	return input.executionId ?? null;
}

export function evidenceReferences(input: ArchiveAppend): string {
	return JSON.stringify((input.evidenceRefs ?? []).slice(0, 20).map((entry) => boundText(entry, 500)));
}

export function assertEffectCompatible(
	existing: SqlRow,
	effect: ArchiveEffect,
	effectKind: string,
	effectPayload: string,
): void {
	if (readString(existing, "kind") !== effectKind || readString(existing, "payload_json") !== effectPayload)
		throw new Error(`Archive effect ${effect.effectId} conflicts with an existing effect.`);
}

export function validateAppendSizes(input: ArchiveAppend): void {
	const payload = JSON.stringify(input.payload);
	if (payload === undefined) throw new Error("Archive payload must be a JSON value.");
	if (payload.length > 64_000) throw new Error("Archive payload exceeds the 64 KB limit.");
	if (JSON.stringify(input.projection).length > 128_000)
		throw new Error("Archive projection exceeds the 128 KB limit.");
}

export function assertCurrentRevision(current: SqlRow | undefined, input: ArchiveAppend): void {
	const currentRevision = current === undefined ? 0 : readInteger(current, "revision");
	if (currentRevision !== input.expectedWorkRevision)
		throw new RevisionConflict(input.workId, input.expectedWorkRevision, currentRevision);
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_projection (
	work_id TEXT PRIMARY KEY,
	revision INTEGER NOT NULL,
	queued_sequence INTEGER NOT NULL,
	view_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_records (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	record_id TEXT NOT NULL UNIQUE,
	command_id TEXT NOT NULL UNIQUE,
	command_fingerprint TEXT,
	kind TEXT NOT NULL,
	actor TEXT NOT NULL,
	work_id TEXT NOT NULL,
	mission_id TEXT,
	execution_id TEXT,
	payload_version INTEGER NOT NULL,
	projection_json TEXT,
	state TEXT NOT NULL,
	summary TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL,
	payload_json TEXT NOT NULL,	recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_record_numbers (
	record_id TEXT PRIMARY KEY REFERENCES archive_records(record_id),
	record_number INTEGER NOT NULL UNIQUE CHECK (record_number > 0),
	mission_id TEXT,
	mission_record_number INTEGER,
	CHECK (
		(mission_id IS NULL AND mission_record_number IS NULL) OR
		(mission_id IS NOT NULL AND mission_record_number IS NOT NULL AND mission_record_number > 0)
	),
	UNIQUE(mission_id, mission_record_number)
);
CREATE INDEX IF NOT EXISTS archive_record_numbers_mission
	ON archive_record_numbers(mission_id, mission_record_number);
CREATE TABLE IF NOT EXISTS outbox (
	effect_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,	payload_json TEXT NOT NULL,	created_at TEXT NOT NULL,	completed_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox_claim (
	effect_id TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	claimed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_records_work_sequence ON archive_records(work_id, sequence);
CREATE INDEX IF NOT EXISTS archive_records_kind_sequence ON archive_records(kind, sequence);
CREATE INDEX IF NOT EXISTS archive_records_invocation_run_sequence
	ON archive_records(json_extract(payload_json, '$.runId'), sequence DESC)
	WHERE kind = 'invocation';
`;

export const EFFECT_LEASE_MS = 120_000;
export const ARCHIVE_MARKER_SUFFIX = ".initialized";
export const REQUIRED_ARCHIVE_TABLES = [
	"work_projection",
	"archive_records",
	"archive_record_numbers",
	"outbox",
	"outbox_claim",
] as const;

export const ARCHIVE_READ_VIEWS = `
CREATE TEMP VIEW IF NOT EXISTS khala_archive_record_summaries AS
SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
	archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
	archive_records.state, archive_records.summary, archive_records.recorded_at,
	archive_record_numbers.record_number, archive_record_numbers.mission_record_number
	FROM archive_records
	LEFT JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id;
`;

export function openArchiveDatabase(path: string, options: SQLiteArchiveOptions): SqlDatabase {
	if (options.readOnly === true) return openReadOnlyDatabase(path);
	assertWritableArchivePath(path);
	mkdirSync(dirname(path), { recursive: true });
	return openSqlite(path, { readOnly: false });
}

export function openReadOnlyDatabase(path: string): SqlDatabase {
	if (!existsSync(path)) throw new Error(`Archive database ${path} does not exist.`);
	return openSqlite(path, { readOnly: true });
}

export function assertWritableArchivePath(path: string): void {
	const existed = existsSync(path);
	if (!existed && existsSync(archiveMarkerPath(path)))
		throw new Error(`Archive database ${path} is missing; refusing to create a replacement Archive.`);
}

export function readLegacyWorkTermsMigration(row: SqlRow): Readonly<{ workId: string; view: JsonObject }> | undefined {
	const view = parseJson(readString(row, "view_json"));
	if (!isJsonObject(view)) throw new Error("Archive Work projection is invalid.");
	const viewMigration = migrateLegacyWorkTermsView(view);
	return viewMigration === undefined ? undefined : { workId: readString(row, "work_id"), view: viewMigration };
}

export function migrateLegacyWorkTermsView(view: JsonObject): JsonObject | undefined {
	const terms = requiredJsonObject(view["terms"], "Archive Work terms");
	const mission = view["mission"];
	const needsTerms = needsPathScope(terms);
	const needsMission = needsMissionPathScope(mission);
	if (!needsTerms && !needsMission) return undefined;
	const migrated = {
		...view,
		terms: addDefaultPathScope(terms, needsTerms),
		mission: addMissionPathScope(mission, needsMission),
	};
	if (!isWorkViewProjection(migrated)) throw new Error("Archive Work terms migration is invalid.");
	return migrated;
}

export function requiredJsonObject(value: JsonValue | undefined, field: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${field} are invalid.`);
	return value;
}

export function needsPathScope(value: JsonObject): boolean {
	return value["allowedPaths"] === undefined;
}

export function needsMissionPathScope(mission: JsonValue | undefined): boolean {
	return isJsonObject(mission) && isJsonObject(mission["assignment"]) && needsPathScope(mission["assignment"]);
}

export function addDefaultPathScope(terms: JsonObject, needed: boolean): JsonObject {
	return needed ? { ...terms, allowedPaths: ["."] } : terms;
}

export function addMissionPathScope(mission: JsonValue | undefined, needed: boolean): JsonValue | undefined {
	if (!needed || !isJsonObject(mission) || !isJsonObject(mission["assignment"])) return mission;
	return { ...mission, assignment: { ...mission["assignment"], allowedPaths: ["."] } };
}

export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

export function assertDuplicateWorkId(workId: string, expectedWorkId: string | undefined, commandId: string): void {
	if (expectedWorkId !== undefined && workId !== expectedWorkId)
		throw new Error(`Archive command ${commandId} was already used for Work ${workId}.`);
}

export function assertDuplicateFingerprint(
	storedFingerprint: string | undefined,
	commandFingerprint: string | undefined,
	commandId: string,
): void {
	if (commandFingerprint === undefined) return;
	if (storedFingerprint === undefined)
		throw new CommandReuseConflict(
			`Archive command ${commandId} has no input fingerprint and cannot be replayed safely.`,
		);
	if (storedFingerprint !== commandFingerprint)
		throw new CommandReuseConflict(`Archive command ${commandId} was already used with different input.`);
}

export function validateArchiveAppendInput(input: ArchiveAppend): void {
	const textFields: readonly [string, string | undefined][] = [
		["commandId", input.commandId],
		["commandFingerprint", input.commandFingerprint],
		["workId", input.workId],
		["missionId", input.missionId],
		["executionId", input.executionId],
	];
	for (const [field, value] of textFields) validateOptionalText(value, field);
	validateRecordKind(input.kind);
	validateActor(input.actor);
	assertPositiveInteger(input.payloadVersion, "payloadVersion");
	if (!isJsonValue(input.payload)) throw new Error("Archive payload must be a JSON value.");
}

export function validateOptionalText(value: string | undefined, field: string): void {
	if (value !== undefined) assertNonBlank(value, field);
}

export function validateRecordKind(value: RecordKind): void {
	parseRecordKind(String(value));
}

export function validateActor(value: Actor): void {
	if (!isActor(String(value))) throw new Error(`Archive actor ${String(value)} is invalid.`);
}

export function activeClaim(claim: SqlRow | undefined): claim is SqlRow {
	return claim !== undefined && Date.now() - readInteger(claim, "claimed_at") < EFFECT_LEASE_MS;
}

export function deleteClaim(database: SqlDatabase, effectId: string, owner: string, claim: SqlRow | undefined): void {
	if (claim === undefined) return;
	database.prepare("DELETE FROM outbox_claim WHERE effect_id = ? AND owner = ?").run(effectId, owner);
}

export function assertCommandProjectionOwnership(
	existing: SqlRow | undefined,
	commandId: string,
	workId: string,
): void {
	if (existing === undefined) throw new Error(`Archive command ${commandId} was not found.`);
	if (readString(existing, "work_id") !== workId)
		throw new Error(`Archive command ${commandId} belongs to another Work.`);
}

export function isLatestObservation(
	value: JsonValue,
	kind: ProviderObservation["kind"],
	providerId: string,
	observationId: string | undefined,
): value is ProviderObservation {
	if (!isObservation(value)) return false;
	return [
		value.kind === kind,
		value.providerId === providerId,
		observationId === undefined || value.observationId === observationId,
	].every(Boolean);
}

export function assertExecutionCapacity(views: readonly WorkView[], limit: number): void {
	const active = views.filter((view) =>
		["queued", "running", "awaiting-review"].includes(view.execution?.state ?? ""),
	).length;
	if (active >= limit) throw new ExecutionAdmissionConflict(`Project execution limit ${limit} is already reserved.`);
}

export function assertFifoAdmission(
	views: readonly WorkView[],
	workId: string,
	enforceFifo: boolean | undefined,
): void {
	if (enforceFifo !== true) return;
	const first = views
		.filter((view) => view.state === "queued")
		.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
	if (first !== undefined && first.workId !== workId)
		throw new ExecutionAdmissionConflict(`Work ${first.workId} is ahead of Work ${workId} in the FIFO queue.`);
}

export function readLegacyWorkStateMigration(row: SqlRow): Readonly<{ workId: string; view: JsonObject }> | undefined {
	const view = parseJson(readString(row, "view_json"));
	if (!isJsonObject(view)) throw new Error("Archive Work projection is invalid.");
	const stopReason = legacyWorkStopReason(view["state"]);
	if (stopReason === undefined) return undefined;
	const migrated = { ...view, state: "stopped", stopReason };
	if (!isWorkViewProjection(migrated)) throw new Error("Archive Work projection migration is invalid.");
	return { workId: readString(row, "work_id"), view: migrated };
}

export function missingRecordNumbers(records: readonly SqlRow[], numbered: readonly SqlRow[]): readonly SqlRow[] {
	const numberedRecordIds = new Set(numbered.map((row) => readString(row, "record_id")));
	return records.filter((record) => !numberedRecordIds.has(readString(record, "record_id")));
}

export function missionRecordNumbers(numbered: readonly SqlRow[]): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	for (const row of numbered) addMissionRecordNumber(result, row);
	return result;
}

export function addMissionRecordNumber(numbers: Map<string, Set<number>>, row: SqlRow): void {
	const missionId = readOptionalString(row, "mission_id");
	const missionRecordNumber = readOptionalInteger(row, "mission_record_number");
	if (missionId === undefined || missionRecordNumber === undefined) return;
	const missionNumbers = numbers.get(missionId) ?? new Set<number>();
	missionNumbers.add(missionRecordNumber);
	numbers.set(missionId, missionNumbers);
}

export function nextAvailableNumber(used: Set<number>): number {
	let next = 1;
	while (used.has(next)) next += 1;
	used.add(next);
	return next;
}

export function nextMissionNumber(numbers: Map<string, Set<number>>, missionId: string | undefined): number | null {
	if (missionId === undefined) return null;
	const missionNumbers = numbers.get(missionId) ?? new Set<number>();
	const next = nextAvailableNumber(missionNumbers);
	numbers.set(missionId, missionNumbers);
	return next;
}

export function archiveMarkerPath(path: string): string {
	return `${path}${ARCHIVE_MARKER_SUFFIX}`;
}

export function ensureArchiveMarker(path: string): void {
	try {
		writeFileSync(path, "Khala Archive initialized.\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (error instanceof Error && isExistsError(error)) return;
		throw error;
	}
}

export function isExistsError(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

export function boundText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	isJsonObject,
	isJsonValue,
	isObservation,
	isWorkViewProjection,
	legacyWorkStopReason,
	parseJson,
	readInteger,
	readOptionalInteger,
	readOptionalString,
	readString,
} from "./archive-codec.js";
import {
	type ArchiveAppend,
	type ArchiveEffect,
	CommandReuseConflict,
	ExecutionAdmissionConflict,
	RevisionConflict,
	type SQLiteArchiveOptions,
} from "./archive-types.js";
import {
	type Actor,
	assertNonBlank,
	assertPositiveInteger,
	isActor,
	type JsonObject,
	type JsonValue,
	type ProviderObservation,
	parseRecordKind,
	type RecordKind,
	type WorkView,
} from "./model.js";
import { openSqlite, type SqlDatabase, type SqlRow } from "./sqlite.js";
