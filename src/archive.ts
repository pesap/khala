import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type Actor,
	assertPositiveInteger,
	type JsonObject,
	type JsonValue,
	type Page,
	type RecordKind,
	type RecordQuery,
	type RecordView,
	type WorkView,
} from "./model.js";
import { openSqlite, type SqlDatabase, type SqlOutputValue, type SqlRow } from "./sqlite.js";

export type ArchiveEffect = Readonly<{
	effectId: string;
	kind: string;
	payload: JsonObject;
}>;

export type ArchiveAppend = Readonly<{
	commandId: string;
	expectedWorkRevision: number;
	kind: RecordKind;
	actor: Actor;
	workId: string;
	missionId?: string | undefined;
	executionId?: string | undefined;
	payloadVersion: number;
	summary: string;
	evidenceRefs?: readonly string[] | undefined;
	payload: JsonValue;
	projection: WorkView;
	effects?: readonly ArchiveEffect[] | undefined;
}>;

export type ArchiveAppendResult = Readonly<{
	record: RecordView;
	projection: WorkView;
	duplicate: boolean;
}>;

export type PendingArchiveEffect = Readonly<{
	effectId: string;
	kind: string;
	payload: JsonObject;
	createdAt: string;
}>;

export interface ArchivePort {
	append: (input: ArchiveAppend) => ArchiveAppendResult;
	findCommand: (commandId: string) => ArchiveAppendResult | undefined;
	pendingEffects: () => readonly PendingArchiveEffect[];
	completeEffect: (effectId: string) => void;
	query: (query?: RecordQuery, cursor?: string) => Page<RecordView>;
	project: (workId: string) => WorkView | undefined;
	listProjects: () => readonly WorkView[];
	close: () => void;
}

type Cursor = Readonly<{
	version: 1;
	query: RecordQuery;
	asOfSequence: number;
	lastSequence: number;
}>;

const SCHEMA = `
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
	kind TEXT NOT NULL,
	actor TEXT NOT NULL,
	work_id TEXT NOT NULL,
	mission_id TEXT,
	execution_id TEXT,
	payload_version INTEGER NOT NULL,
	state TEXT NOT NULL,
	summary TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL,
	payload_json TEXT NOT NULL,	recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
	effect_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,	payload_json TEXT NOT NULL,	created_at TEXT NOT NULL,	completed_at TEXT
);
CREATE INDEX IF NOT EXISTS archive_records_work_sequence ON archive_records(work_id, sequence);
CREATE INDEX IF NOT EXISTS archive_records_kind_sequence ON archive_records(kind, sequence);
`;

export class SQLiteArchive implements ArchivePort {
	private readonly database: SqlDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = openSqlite(path);
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
		this.database.exec(SCHEMA);
	}

	append(input: ArchiveAppend): ArchiveAppendResult {
		assertPositiveInteger(input.expectedWorkRevision + 1, "expectedWorkRevision");
		const duplicate = this.database
			.prepare("SELECT sequence, work_id FROM archive_records WHERE command_id = ?")
			.get(input.commandId);
		if (duplicate !== undefined) {
			const duplicateWorkId = readString(duplicate, "work_id");
			if (duplicateWorkId !== input.workId) {
				throw new Error(`Archive command ${input.commandId} was already used for Work ${duplicateWorkId}.`);
			}
			const record = this.readRecord(readInteger(duplicate, "sequence"));
			const projection = this.project(duplicateWorkId);
			if (projection === undefined) {
				throw new Error(`Archive command ${input.commandId} has no projection.`);
			}
			return { record, projection, duplicate: true };
		}

		this.database.exec("BEGIN IMMEDIATE");
		try {
			const concurrentDuplicate = this.database
				.prepare("SELECT sequence, work_id FROM archive_records WHERE command_id = ?")
				.get(input.commandId);
			if (concurrentDuplicate !== undefined) {
				const duplicateWorkId = readString(concurrentDuplicate, "work_id");
				if (duplicateWorkId !== input.workId) {
					throw new Error(`Archive command ${input.commandId} was already used for Work ${duplicateWorkId}.`);
				}
				const projection = this.project(duplicateWorkId);
				if (projection === undefined) {
					throw new Error(`Archive command ${input.commandId} has no projection.`);
				}
				this.database.exec("COMMIT");
				return {
					record: this.readRecord(readInteger(concurrentDuplicate, "sequence")),
					projection,
					duplicate: true,
				};
			}
			const current = this.database.prepare("SELECT revision FROM work_projection WHERE work_id = ?").get(input.workId);
			const currentRevision = current === undefined ? 0 : readInteger(current, "revision");
			if (currentRevision !== input.expectedWorkRevision) {
				throw new RevisionConflict(input.workId, input.expectedWorkRevision, currentRevision);
			}
			const now = new Date().toISOString();
			const recordId = randomUUID();
			const evidenceRefs = JSON.stringify((input.evidenceRefs ?? []).slice(0, 20));
			const payload = JSON.stringify(input.payload);
			const inserted = this.database
				.prepare(
					`INSERT INTO archive_records
					(record_id, command_id, kind, actor, work_id, mission_id, execution_id,
					 payload_version, state, summary, evidence_refs_json, payload_json, recorded_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					recordId,
					input.commandId,
					input.kind,
					input.actor,
					input.workId,
					input.missionId ?? null,
					input.executionId ?? null,
					input.payloadVersion,
					input.projection.state,
					boundText(input.summary, 500),
					evidenceRefs,
					payload,
					now,
				);
			const sequence = Number(inserted.lastInsertRowid);
			const projection =
				input.projection.queuedSequence === 0 ? { ...input.projection, queuedSequence: sequence } : input.projection;
			this.database
				.prepare(
					`INSERT INTO work_projection(work_id, revision, queued_sequence, view_json) VALUES (?, ?, ?, ?)
					 ON CONFLICT(work_id) DO UPDATE SET revision = excluded.revision,
					 queued_sequence = excluded.queued_sequence, view_json = excluded.view_json`,
				)
				.run(input.workId, projection.revision, projection.queuedSequence, JSON.stringify(projection));
			for (const effect of input.effects ?? []) {
				this.database
					.prepare("INSERT INTO outbox(effect_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
					.run(effect.effectId, effect.kind, JSON.stringify(effect.payload), now);
			}
			this.database.exec("COMMIT");
			return { record: this.readRecord(sequence), projection, duplicate: false };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	pendingEffects(): readonly PendingArchiveEffect[] {
		const rows = this.database
			.prepare(
				"SELECT effect_id, kind, payload_json, created_at FROM outbox WHERE completed_at IS NULL ORDER BY created_at, effect_id LIMIT 100",
			)
			.all();
		return rows.map((row) => {
			const payload = parseJson(readString(row, "payload_json"));
			if (!isJsonObject(payload)) {
				throw new Error(`Archive effect ${readString(row, "effect_id")} has an invalid payload.`);
			}
			return {
				effectId: readString(row, "effect_id"),
				kind: readString(row, "kind"),
				payload,
				createdAt: readString(row, "created_at"),
			};
		});
	}

	completeEffect(effectId: string): void {
		this.database
			.prepare("UPDATE outbox SET completed_at = ? WHERE effect_id = ? AND completed_at IS NULL")
			.run(new Date().toISOString(), effectId);
	}

	findCommand(commandId: string): ArchiveAppendResult | undefined {
		const row = this.database
			.prepare("SELECT sequence, work_id FROM archive_records WHERE command_id = ?")
			.get(commandId);
		if (row === undefined) {
			return undefined;
		}
		const sequence = readInteger(row, "sequence");
		const workId = readString(row, "work_id");
		const projection = this.project(workId);
		if (projection === undefined) {
			throw new Error(`Archive command ${commandId} has no projection.`);
		}
		return { record: this.readRecord(sequence), projection, duplicate: true };
	}

	query(query: RecordQuery = {}, cursor?: string): Page<RecordView> {
		const parsedCursor = cursor === undefined ? undefined : decodeCursor(cursor);
		const effectiveQuery = parsedCursor?.query ?? normalizeQuery(query);
		const asOfSequence = parsedCursor?.asOfSequence ?? this.latestSequence();
		const lastSequence = parsedCursor?.lastSequence ?? 0;
		if (parsedCursor !== undefined && JSON.stringify(normalizeQuery(query)) !== JSON.stringify(effectiveQuery)) {
			throw new Error("Archive cursor does not match the requested filters.");
		}
		const clauses = ["sequence <= ?", "sequence > ?"];
		const parameters: Array<string | number> = [asOfSequence, lastSequence];
		if (effectiveQuery.workId !== undefined) {
			clauses.push("work_id = ?");
			parameters.push(effectiveQuery.workId);
		}
		if (effectiveQuery.missionId !== undefined) {
			clauses.push("mission_id = ?");
			parameters.push(effectiveQuery.missionId);
		}
		if (effectiveQuery.executionId !== undefined) {
			clauses.push("execution_id = ?");
			parameters.push(effectiveQuery.executionId);
		}
		if (effectiveQuery.kinds !== undefined && effectiveQuery.kinds.length > 0) {
			clauses.push(`kind IN (${effectiveQuery.kinds.map(() => "?").join(",")})`);
			parameters.push(...effectiveQuery.kinds);
		}
		if (effectiveQuery.states !== undefined && effectiveQuery.states.length > 0) {
			clauses.push(`state IN (${effectiveQuery.states.map(() => "?").join(",")})`);
			parameters.push(...effectiveQuery.states);
		}
		if (effectiveQuery.from !== undefined) {
			clauses.push("recorded_at >= ?");
			parameters.push(effectiveQuery.from);
		}
		if (effectiveQuery.to !== undefined) {
			clauses.push("recorded_at <= ?");
			parameters.push(effectiveQuery.to);
		}
		const rows = this.database
			.prepare(
				`SELECT sequence, record_id, kind, actor, work_id, mission_id, execution_id,
				 payload_version, summary, evidence_refs_json, payload_json, recorded_at
				 FROM archive_records WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT 100`,
			)
			.all(...parameters);
		const items = rows.map((row) => this.recordFromRow(row));
		const last = items.at(-1)?.sequence;
		const nextCursor =
			last === undefined || items.length < 100
				? undefined
				: encodeCursor({ version: 1, query: effectiveQuery, asOfSequence, lastSequence: last });
		return { items, asOfSequence, nextCursor };
	}

	project(workId: string): WorkView | undefined {
		const row = this.database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get(workId);
		if (row === undefined) {
			return;
		}
		return parseWorkView(readString(row, "view_json"));
	}

	listProjects(): readonly WorkView[] {
		const rows = this.database.prepare("SELECT view_json FROM work_projection ORDER BY queued_sequence").all();
		return rows.map((row) => parseWorkView(readString(row, "view_json")));
	}

	close(): void {
		this.database.close();
	}

	private latestSequence(): number {
		const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM archive_records").get();
		return row === undefined ? 0 : readInteger(row, "sequence");
	}

	private readRecord(sequence: number): RecordView {
		const row = this.database
			.prepare(
				`SELECT sequence, record_id, kind, actor, work_id, mission_id, execution_id,
				 payload_version, summary, evidence_refs_json, payload_json, recorded_at
				 FROM archive_records WHERE sequence = ?`,
			)
			.get(sequence);
		if (row === undefined) {
			throw new Error(`Archive record at sequence ${sequence} was not found.`);
		}
		return this.recordFromRow(row);
	}

	private recordFromRow(row: SqlRow): RecordView {
		const payloadText = readString(row, "payload_json");
		const boundedPayload =
			payloadText.length > 16_000 ? { truncated: true, content: payloadText.slice(0, 16_000) } : parseJson(payloadText);
		const evidenceRefs = parseJson(readString(row, "evidence_refs_json"));
		if (!Array.isArray(evidenceRefs)) {
			throw new Error("Archive evidence references are invalid.");
		}
		const evidence = evidenceRefs.map((entry) => readStringValue(entry, "Archive evidence reference"));
		return {
			sequence: readInteger(row, "sequence"),
			id: readString(row, "record_id"),
			kind: readRecordKind(row, "kind"),
			actor: readActor(row, "actor"),
			workId: readString(row, "work_id"),
			missionId: readOptionalString(row, "mission_id"),
			executionId: readOptionalString(row, "execution_id"),
			payloadVersion: readInteger(row, "payload_version"),
			summary: boundText(readString(row, "summary"), 500),
			evidenceRefs: evidence.slice(0, 20),
			recordedAt: readString(row, "recorded_at"),
			payload: boundedPayload,
		};
	}
}

export class RevisionConflict extends Error {
	readonly workId: string;
	readonly expected: number;
	readonly actual: number;

	constructor(workId: string, expected: number, actual: number) {
		super(`Work ${workId} revision conflict: expected ${expected}, found ${actual}.`);
		this.name = "RevisionConflict";
		this.workId = workId;
		this.expected = expected;
		this.actual = actual;
	}
}

function normalizeQuery(query: RecordQuery): RecordQuery {
	return {
		workId: query.workId,
		missionId: query.missionId,
		executionId: query.executionId,
		kinds: query.kinds === undefined ? undefined : [...new Set(query.kinds)].sort(),
		states: query.states === undefined ? undefined : [...new Set(query.states)].sort(),
		from: query.from,
		to: query.to,
	};
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
	let parsed: JsonValue;
	try {
		parsed = parseJson(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid Archive cursor: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isJsonObject(parsed)) {
		throw new Error("Invalid Archive cursor payload.");
	}
	const object = parsed;
	const version = object["version"];
	const asOfSequence = object["asOfSequence"];
	const lastSequence = object["lastSequence"];
	const query = object["query"];
	if (version !== 1 || !isJsonObject(query)) {
		throw new Error("Invalid Archive cursor fields.");
	}
	return {
		version: 1,
		query: queryFromJson(query),
		asOfSequence: readJsonInteger(asOfSequence, "asOfSequence"),
		lastSequence: readJsonInteger(lastSequence, "lastSequence"),
	};
}

function queryFromJson(value: JsonObject): RecordQuery {
	const readOptionalList = (key: string): readonly string[] | undefined => {
		const entry = value[key];
		if (entry === undefined) {
			return;
		}
		if (!Array.isArray(entry)) {
			throw new Error(`Invalid Archive cursor query field ${key}.`);
		}
		return entry.map((item) => readStringValue(item, key));
	};
	const readOptional = (key: string): string | undefined => {
		const entry = value[key];
		if (entry === undefined) {
			return;
		}
		return readStringValue(entry, key);
	};
	const workId = readOptional("workId");
	const missionId = readOptional("missionId");
	const executionId = readOptional("executionId");
	const kinds = readOptionalList("kinds");
	const states = readOptionalList("states");
	const from = readOptional("from");
	const to = readOptional("to");
	return {
		workId,
		missionId,
		executionId,
		kinds: kinds === undefined ? undefined : readRecordKinds(kinds),
		states,
		from,
		to,
	};
}

function parseJson(value: string): JsonValue {
	// SAFETY: the archive only writes JSON values and this function validates the parsed tree at the boundary.
	const parsed: JsonValue = JSON.parse(value);
	if (!isJsonValue(parsed)) {
		throw new Error("Archive JSON value is invalid.");
	}
	return parsed;
}

function isJsonValue(value: JsonValue): boolean {
	if (value === null || value === true || value === false) {
		return true;
	}
	if (value === String(value) || (value === Number(value) && Number.isFinite(Number(value)))) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every((entry) => entry !== undefined && isJsonValue(entry));
	}
	return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function parseWorkView(value: string): WorkView {
	const parsed = parseJson(value);
	if (!isJsonObject(parsed)) {
		throw new Error("Archive Work projection is invalid.");
	}
	// SAFETY: the service is the sole writer of this projection and validates the domain shape before persistence.
	return Object.assign({} as WorkView, parsed);
}

function readString(row: SqlRow, key: string): string {
	return readStringValue(row[key], `Archive column ${key}`);
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
	const value = row[key];
	if (value === null || value === undefined) {
		return;
	}
	return readString(row, key);
}

function readJsonInteger(value: JsonValue | undefined, key: string): number {
	const number = Number(value);
	if (value === null || value === undefined || number !== value || !Number.isSafeInteger(number)) {
		throw new Error(`Archive cursor field ${key} is not an integer.`);
	}
	return number;
}

function readInteger(row: SqlRow, key: string): number {
	const value = row[key];
	const number = Number(value);
	if (value === null || value === undefined || number !== value || !Number.isSafeInteger(number)) {
		throw new Error(`Archive column ${key} is not an integer.`);
	}
	return number;
}

function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	return values.map((value) => {
		if (
			![
				"submission",
				"assessment",
				"learning",
				"mission",
				"mission-change",
				"execution",
				"signal",
				"review-request",
				"observation",
				"delivery",
				"verdict",
				"oracle-review",
				"outcome",
				"error",
				"work-amended",
			].includes(value)
		) {
			throw new Error(`Archive record kind ${value} is invalid.`);
		}
		// SAFETY: membership in the complete RecordKind list above proves the discriminant.
		return value as RecordKind;
	});
}

function readRecordKind(row: SqlRow, key: string): RecordKind {
	const value = readString(row, key);
	if (
		![
			"submission",
			"assessment",
			"learning",
			"mission",
			"mission-change",
			"execution",
			"signal",
			"review-request",
			"observation",
			"delivery",
			"verdict",
			"oracle-review",
			"outcome",
			"error",
			"work-amended",
		].includes(value)
	) {
		throw new Error(`Archive record kind ${value} is invalid.`);
	}
	// SAFETY: membership in the complete RecordKind list above proves the discriminant.
	return value as RecordKind;
}

function readActor(row: SqlRow, key: string): Actor {
	const value = readString(row, key);
	if (!["user", "conclave", "observer", "executor", "oracle", "monitor", "system"].includes(value)) {
		throw new Error(`Archive actor ${value} is invalid.`);
	}
	// SAFETY: membership in the complete Actor list above proves the discriminant.
	return value as Actor;
}

function readStringValue(value: JsonValue | undefined | SqlOutputValue, field: string): string {
	if (value === null || value === undefined || value !== String(value)) {
		throw new Error(`${field} is not text.`);
	}
	return String(value);
}

function boundText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
