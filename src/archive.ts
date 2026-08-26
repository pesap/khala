import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type Actor,
	assertPositiveInteger,
	type ErrorEnvelope,
	type JsonObject,
	type JsonValue,
	type Page,
	type ProviderObservation,
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
	executionGuard?: Readonly<{ maxConcurrentExecutions: number; enforceFifo?: boolean }> | undefined;
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
	pendingEffects: (owner?: string) => readonly PendingArchiveEffect[];
	completeEffect: (effectId: string, owner?: string) => boolean;
	releaseEffect: (effectId: string, owner?: string) => void;
	renewEffect: (effectId: string, owner?: string) => boolean;
	query: (query?: RecordQuery, cursor?: string) => Page<RecordView>;
	project: (workId: string) => WorkView | undefined;
	findObservation: (workId: string, observationId: string) => ProviderObservation | undefined;
	findLatestObservation: (
		workId: string,
		kind: ProviderObservation["kind"],
		providerId: string,
		observationId?: string | undefined,
	) => ProviderObservation | undefined;
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
CREATE TABLE IF NOT EXISTS outbox_claim (
	effect_id TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	claimed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_records_work_sequence ON archive_records(work_id, sequence);
CREATE INDEX IF NOT EXISTS archive_records_kind_sequence ON archive_records(kind, sequence);
`;

const EFFECT_LEASE_MS = 120_000;

export class SQLiteArchive implements ArchivePort {
	private readonly database: SqlDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = openSqlite(path);
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
		this.database.exec(SCHEMA);
		this.migrateLegacyWorkStates();
	}

	private migrateLegacyWorkStates(): void {
		const rows = this.database.prepare("SELECT work_id, view_json FROM work_projection").all();
		const migrations: Array<Readonly<{ workId: string; view: JsonObject }>> = [];
		for (const row of rows) {
			const view = parseJson(readString(row, "view_json"));
			if (!isJsonObject(view)) throw new Error("Archive Work projection is invalid.");
			const stopReason = legacyWorkStopReason(view["state"]);
			if (stopReason === undefined) continue;
			const migrated = { ...view, state: "stopped", stopReason };
			if (!isWorkViewProjection(migrated)) throw new Error("Archive Work projection migration is invalid.");
			migrations.push({ workId: readString(row, "work_id"), view: migrated });
		}
		if (migrations.length === 0) return;

		this.database.exec("BEGIN IMMEDIATE");
		try {
			const updateProjection = this.database.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?");
			const updateRecords = this.database.prepare(
				"UPDATE archive_records SET state = 'stopped' WHERE work_id = ? AND state IN ('failed', 'cancelled')",
			);
			for (const migration of migrations) {
				updateProjection.run(JSON.stringify(migration.view), migration.workId);
				updateRecords.run(migration.workId);
			}
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
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

		validateProjection(input.projection, input.workId, input.expectedWorkRevision + 1);
		const serializedPayload = JSON.stringify(input.payload);
		if (serializedPayload.length > 64_000) {
			throw new Error("Archive payload exceeds the 64 KB limit.");
		}
		if (JSON.stringify(input.projection).length > 128_000) {
			throw new Error("Archive projection exceeds the 128 KB limit.");
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
			if (input.executionGuard !== undefined && input.projection.execution?.state === "queued") {
				this.assertExecutionAdmission(input.workId, input.executionGuard);
			}
			const now = new Date().toISOString();
			const recordId = randomUUID();
			const evidenceRefs = JSON.stringify(
				(input.evidenceRefs ?? []).slice(0, 20).map((entry) => boundText(entry, 500)),
			);
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
				const effectPayload = JSON.stringify(effect.payload);
				if (effectPayload.length > 16_000)
					throw new Error(`Archive effect ${effect.effectId} exceeds the 16 KB limit.`);
				const effectKind = boundText(effect.kind, 200);
				const existingEffect = this.database
					.prepare("SELECT kind, payload_json FROM outbox WHERE effect_id = ?")
					.get(effect.effectId);
				if (existingEffect !== undefined) {
					if (
						readString(existingEffect, "kind") !== effectKind ||
						readString(existingEffect, "payload_json") !== effectPayload
					)
						throw new Error(`Archive effect ${effect.effectId} conflicts with an existing effect.`);
					continue;
				}
				this.database
					.prepare("INSERT INTO outbox(effect_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
					.run(effect.effectId, effectKind, effectPayload, now);
			}
			this.database.exec("COMMIT");
			return { record: this.readRecord(sequence), projection, duplicate: false };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	pendingEffects(owner = "archive-reader"): readonly PendingArchiveEffect[] {
		const now = Date.now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare("DELETE FROM outbox_claim WHERE claimed_at < ?").run(now - EFFECT_LEASE_MS);
			const rows = this.database
				.prepare(
					"SELECT effect_id, kind, payload_json, created_at FROM outbox WHERE completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM outbox_claim WHERE outbox_claim.effect_id = outbox.effect_id) ORDER BY created_at, effect_id LIMIT 1",
				)
				.all();
			for (const row of rows) {
				this.database
					.prepare("INSERT INTO outbox_claim(effect_id, owner, claimed_at) VALUES (?, ?, ?)")
					.run(readString(row, "effect_id"), owner, now);
			}
			const effects = rows.map((row) => {
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
			this.database.exec("COMMIT");
			return effects;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeEffect(effectId: string, owner = "archive-reader"): boolean {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const claim = this.database
				.prepare("SELECT effect_id FROM outbox_claim WHERE effect_id = ? AND owner = ?")
				.get(effectId, owner);
			if (claim === undefined) {
				this.database.exec("COMMIT");
				return false;
			}
			this.database
				.prepare("UPDATE outbox SET completed_at = ? WHERE effect_id = ? AND completed_at IS NULL")
				.run(new Date().toISOString(), effectId);
			this.database.prepare("DELETE FROM outbox_claim WHERE effect_id = ? AND owner = ?").run(effectId, owner);
			this.database.exec("COMMIT");
			return true;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	releaseEffect(effectId: string, owner = "archive-reader"): void {
		this.database.prepare("DELETE FROM outbox_claim WHERE effect_id = ? AND owner = ?").run(effectId, owner);
	}

	renewEffect(effectId: string, owner = "archive-reader"): boolean {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const claim = this.database
				.prepare("SELECT effect_id FROM outbox_claim WHERE effect_id = ? AND owner = ?")
				.get(effectId, owner);
			if (claim === undefined) {
				this.database.exec("COMMIT");
				return false;
			}
			this.database
				.prepare("UPDATE outbox_claim SET claimed_at = ? WHERE effect_id = ? AND owner = ?")
				.run(Date.now(), effectId, owner);
			this.database.exec("COMMIT");
			return true;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
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

	findObservation(workId: string, observationId: string): ProviderObservation | undefined {
		const rows = this.database
			.prepare(
				"SELECT payload_json FROM archive_records WHERE work_id = ? AND kind = 'observation' ORDER BY sequence DESC",
			)
			.all(workId);
		for (const row of rows) {
			const payload = parseJson(readString(row, "payload_json"));
			if (isObservation(payload) && payload.observationId === observationId) return payload;
		}
		return;
	}

	findLatestObservation(
		workId: string,
		kind: ProviderObservation["kind"],
		providerId: string,
		observationId?: string | undefined,
	): ProviderObservation | undefined {
		const rows = this.database
			.prepare(
				"SELECT payload_json FROM archive_records WHERE work_id = ? AND kind = 'observation' ORDER BY sequence DESC",
			)
			.all(workId);
		for (const row of rows) {
			const payload = parseJson(readString(row, "payload_json"));
			if (
				isObservation(payload) &&
				payload.kind === kind &&
				payload.providerId === providerId &&
				(observationId === undefined || payload.observationId === observationId)
			)
				return payload;
		}
		return;
	}

	listProjects(): readonly WorkView[] {
		const rows = this.database.prepare("SELECT view_json FROM work_projection ORDER BY queued_sequence").all();
		return rows.map((row) => parseWorkView(readString(row, "view_json")));
	}

	close(): void {
		this.database.close();
	}

	private assertExecutionAdmission(
		workId: string,
		guard: Readonly<{ maxConcurrentExecutions: number; enforceFifo?: boolean }>,
	): void {
		assertPositiveInteger(guard.maxConcurrentExecutions, "maxConcurrentExecutions");
		const projects = this.database.prepare("SELECT work_id, view_json FROM work_projection").all();
		const views = projects.map((row) => parseWorkView(readString(row, "view_json")));
		const active = views.filter(
			(view) => view.execution?.state === "queued" || view.execution?.state === "running",
		).length;
		if (active >= guard.maxConcurrentExecutions) {
			throw new ExecutionAdmissionConflict(
				`Project execution limit ${guard.maxConcurrentExecutions} is already reserved.`,
			);
		}
		if (guard.enforceFifo === true) {
			const first = views
				.filter((view) => view.state === "queued")
				.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
			if (first !== undefined && first.workId !== workId) {
				throw new ExecutionAdmissionConflict(`Work ${first.workId} is ahead of Work ${workId} in the FIFO queue.`);
			}
		}
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

export class ExecutionAdmissionConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionAdmissionConflict";
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
	if (!isWorkViewProjection(parsed)) {
		throw new Error("Archive Work projection is invalid.");
	}
	return parsed;
}

function validateProjection(projection: WorkView, workId: string, revision: number): void {
	if (projection.workId !== workId || projection.revision !== revision || !isWorkViewProjection(projection)) {
		throw new Error("Archive projection does not match the expected Work revision.");
	}
	if (
		projection.terms.maxTokens <= 0 ||
		projection.budget.maxTokens <= 0 ||
		projection.budget.reservedTokens < 0 ||
		projection.budget.consumedTokens < 0 ||
		projection.budget.reservedTokens + projection.budget.consumedTokens > projection.budget.maxTokens ||
		projection.budget.maxTokens !== projection.terms.maxTokens ||
		projection.queuedSequence < 0 ||
		(projection.state === "stopped" && projection.stopReason === undefined) ||
		(projection.state !== "stopped" && projection.stopReason !== undefined) ||
		(projection.mission !== undefined && projection.mission.workId !== workId) ||
		(projection.execution !== undefined &&
			(projection.execution.workId !== workId || projection.mission?.missionId !== projection.execution.missionId))
	) {
		throw new Error("Archive Work projection contains invalid budget or queue values.");
	}
}

function isWorkViewProjection(value: JsonValue): value is WorkView {
	if (!isJsonObject(value)) return false;
	return (
		isText(value["workId"]) &&
		isInteger(value["revision"]) &&
		isWorkState(value["state"]) &&
		(value["stopReason"] === undefined || isWorkStopReason(value["stopReason"])) &&
		(value["missionState"] === undefined || isMissionState(value["missionState"])) &&
		isTerms(value["terms"]) &&
		isBudget(value["budget"]) &&
		isText(value["nextAction"]) &&
		isInteger(value["queuedSequence"]) &&
		(value["missionSpecificity"] === undefined || isMissionSpecificity(value["missionSpecificity"])) &&
		(value["mission"] === undefined || isMission(value["mission"])) &&
		(value["execution"] === undefined || isExecution(value["execution"])) &&
		(value["observer"] === undefined || isPiBinding(value["observer"])) &&
		(value["observerInFlight"] === undefined || isBoolean(value["observerInFlight"])) &&
		(value["reviewRequest"] === undefined || isReviewRequest(value["reviewRequest"])) &&
		(value["lastSignal"] === undefined || isSignal(value["lastSignal"])) &&
		(value["lastObservation"] === undefined || isObservation(value["lastObservation"])) &&
		(value["providerOutcome"] === undefined || isObservation(value["providerOutcome"])) &&
		(value["lastError"] === undefined || isErrorEnvelope(value["lastError"]))
	);
}

function isTerms(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isText(value["title"]) &&
		isText(value["objective"]) &&
		isText(value["context"]) &&
		isText(value["scope"]) &&
		isTextList(value["acceptanceCriteria"]) &&
		isTextList(value["constraints"]) &&
		isTextList(value["validation"]) &&
		isInteger(value["maxTokens"]) &&
		Number(value["maxTokens"]) > 0
	);
}

function isBudget(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isInteger(value["maxTokens"]) &&
		isInteger(value["reservedTokens"]) &&
		isInteger(value["consumedTokens"]) &&
		Number(value["maxTokens"]) > 0 &&
		Number(value["reservedTokens"]) >= 0 &&
		Number(value["consumedTokens"]) >= 0
	);
}

function isMission(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isText(value["missionId"]) &&
		isText(value["workId"]) &&
		isTerms(value["assignment"]) &&
		(value["specificity"] === undefined || isMissionSpecificity(value["specificity"])) &&
		isInteger(value["mandateRevision"]) &&
		isText(value["createdAt"])
	);
}

function isMissionSpecificity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["explicit", "defaults-used"].includes(String(value["status"])) && isTextList(value["missing"]);
}

function isExecution(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	const sandbox = value["sandbox"];
	const prompt = value["promptIdentity"];
	return (
		isText(value["executionId"]) &&
		isText(value["workId"]) &&
		isText(value["missionId"]) &&
		isExecutionState(value["state"]) &&
		isText(value["model"]) &&
		isText(value["thinking"]) &&
		isInteger(value["tokenAllowance"]) &&
		(value["runtimeState"] === undefined || isExecutionRuntimeState(value["runtimeState"])) &&
		(value["usage"] === undefined || isTokenUsage(value["usage"])) &&
		isJsonObject(prompt) &&
		isText(prompt["packageVersion"]) &&
		isText(prompt["promptSha256"]) &&
		isJsonObject(sandbox) &&
		isText(sandbox["path"]) &&
		isText(sandbox["baseCommit"]) &&
		isText(sandbox["branch"]) &&
		(value["pi"] === undefined || isPiBinding(value["pi"]))
	);
}

function isTokenUsage(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["inputTokens", "outputTokens", "cacheHitTokens", "cacheMissTokens"].every((key) => {
		const count = value[key];
		return isInteger(count) && Number(count) >= 0;
	});
}

function isExecutionRuntimeState(value: JsonValue | undefined): boolean {
	return ["working", "idle", "pending", "unreachable", "unknown"].includes(String(value));
}

function isPiBinding(value: JsonValue | undefined): boolean {
	return (
		isJsonObject(value) &&
		isText(value["sessionId"]) &&
		isText(value["sessionPath"]) &&
		(value["processGroupId"] === undefined || (isInteger(value["processGroupId"]) && value["processGroupId"] > 0)) &&
		(value["processStartTime"] === undefined || isText(value["processStartTime"])) &&
		(value["capabilityNonce"] === undefined || isText(value["capabilityNonce"])) &&
		(value["processMarker"] === undefined || isText(value["processMarker"]))
	);
}

function isReviewRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["github", "gitlab"].includes(String(value["provider"])) &&
		isText(value["principalId"]) &&
		isText(value["providerId"]) &&
		isText(value["url"]) &&
		isText(value["repository"]) &&
		["draft", "open", "merged", "closed"].includes(String(value["status"])) &&
		isText(value["sourceBranch"]) &&
		isText(value["targetBranch"]) &&
		isText(value["headCommit"]) &&
		isText(value["diffSummary"]) &&
		isTextList(value["validation"])
	);
}

function isSignal(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isText(value["signalId"]) &&
		isText(value["executionId"]) &&
		isText(value["kind"]) &&
		isText(value["summary"]) &&
		isTextList(value["evidence"]) &&
		isText(value["observedAt"])
	);
}

function isObservation(value: JsonValue | undefined): value is ProviderObservation {
	if (!isJsonObject(value)) return false;
	return (
		isText(value["observationId"]) &&
		isText(value["kind"]) &&
		isText(value["providerId"]) &&
		isText(value["status"]) &&
		isText(value["summary"]) &&
		isBoolean(value["changed"]) &&
		isText(value["observedAt"]) &&
		(value["feedback"] === undefined || isTextList(value["feedback"])) &&
		(value["author"] === undefined || isText(value["author"])) &&
		(value["authorAssociation"] === undefined || isText(value["authorAssociation"])) &&
		(value["reviewState"] === undefined || isText(value["reviewState"])) &&
		(value["actionable"] === undefined || isBoolean(value["actionable"])) &&
		(value["repository"] === undefined || isText(value["repository"])) &&
		(value["sourceBranch"] === undefined || isText(value["sourceBranch"])) &&
		(value["targetBranch"] === undefined || isText(value["targetBranch"])) &&
		(value["headCommit"] === undefined || isText(value["headCommit"])) &&
		(value["mergeCommit"] === undefined || isText(value["mergeCommit"])) &&
		(value["details"] === undefined || isProviderObservationDetails(value["details"]))
	);
}

function isProviderObservationDetails(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	const pullRequest = value["pullRequest"];
	return (
		isJsonObject(pullRequest) &&
		isText(pullRequest["url"]) &&
		["draft", "open", "merged", "closed"].includes(String(pullRequest["status"])) &&
		isText(pullRequest["state"]) &&
		isText(pullRequest["reviewDecision"]) &&
		(pullRequest["mergedAt"] === null || isText(pullRequest["mergedAt"])) &&
		isProviderReviewComments(value["comments"]) &&
		isProviderChecks(value["checks"])
	);
}

function isProviderReviewComments(value: JsonValue | undefined): boolean {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			if (!isJsonObject(entry) || !isText(entry["id"]) || !isText(entry["body"])) return false;
			return (
				(entry["author"] === undefined || isText(entry["author"])) &&
				(entry["authorAssociation"] === undefined || isText(entry["authorAssociation"])) &&
				(entry["createdAt"] === undefined || isText(entry["createdAt"])) &&
				(entry["url"] === undefined || isText(entry["url"])) &&
				(entry["state"] === undefined || isText(entry["state"])) &&
				(entry["source"] === undefined || ["issue-comment", "review", "inline"].includes(String(entry["source"]))) &&
				(entry["location"] === undefined || isText(entry["location"])) &&
				(entry["minimized"] === undefined || isBoolean(entry["minimized"]))
			);
		})
	);
}

function isProviderChecks(value: JsonValue | undefined): boolean {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			if (
				!isJsonObject(entry) ||
				!["check-run", "status-context"].includes(String(entry["kind"])) ||
				!isText(entry["name"]) ||
				!isText(entry["status"])
			)
				return false;
			return (
				(entry["conclusion"] === undefined || isText(entry["conclusion"])) &&
				(entry["workflowName"] === undefined || isText(entry["workflowName"])) &&
				(entry["detailsUrl"] === undefined || isText(entry["detailsUrl"])) &&
				(entry["startedAt"] === undefined || isText(entry["startedAt"])) &&
				(entry["completedAt"] === undefined || isText(entry["completedAt"]))
			);
		})
	);
}

function isErrorEnvelope(value: JsonValue | undefined): value is ErrorEnvelope {
	if (!isJsonObject(value)) return false;
	return (
		[
			"invalid-input",
			"not-found",
			"forbidden",
			"revision-conflict",
			"invalid-state",
			"budget-exhausted",
			"external-failure",
			"integrity-failure",
		].includes(String(value["code"])) &&
		isText(value["summary"]) &&
		isBoolean(value["retryable"]) &&
		isText(value["remediation"]) &&
		isTextList(value["evidenceRefs"]) &&
		(value["learning"] === undefined || isLearning(value["learning"]))
	);
}

function isLearning(value: JsonValue | undefined): boolean {
	return (
		isJsonObject(value) &&
		isText(value["failure"]) &&
		isText(value["missionSpecificity"]) &&
		isText(value["nextMissionGuidance"])
	);
}

function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function isInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

function isTextList(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every((entry) => isText(entry));
}

function isMissionState(value: JsonValue | undefined): boolean {
	return ["admitted", "active", "awaiting-review", "succeeded", "rejected", "superseded"].includes(String(value));
}

function legacyWorkStopReason(value: JsonValue | undefined): "failed" | "cancelled" | undefined {
	if (value === "failed" || value === "cancelled") return value;
	return undefined;
}

function isWorkState(value: JsonValue | undefined): boolean {
	return ["submitted", "needs-input", "queued", "active", "awaiting-review", "succeeded", "stopped"].includes(
		String(value),
	);
}

function isWorkStopReason(value: JsonValue | undefined): boolean {
	return ["failed", "cancelled"].includes(String(value));
}

function isExecutionState(value: JsonValue | undefined): boolean {
	return ["queued", "running", "awaiting-review", "completed", "blocked", "failed", "stopped"].includes(String(value));
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
