import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type Actor,
	assertNonBlank,
	assertPositiveInteger,
	type ErrorEnvelope,
	isActor,
	type JsonObject,
	type JsonValue,
	type Page,
	PROVIDER_CI_STATUSES,
	PROVIDER_FEEDBACK_DELIVERY_STATUSES,
	PROVIDER_MONITOR_STATUSES,
	PROVIDER_REVIEW_COMMENT_STATUSES,
	type ProviderObservation,
	type ProviderOutcomeObservation,
	parseRecordKind,
	REVIEW_REQUEST_STATUSES,
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
	commandFingerprint?: string | undefined;
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

type InsertedArchiveRecord = Readonly<{ recordId: string; sequence: number; now: string }>;

export type PendingArchiveEffect = Readonly<{
	effectId: string;
	kind: string;
	payload: JsonObject;
	createdAt: string;
}>;

export interface ArchivePort {
	append: (input: ArchiveAppend) => ArchiveAppendResult;
	updateCommandProjection: (commandId: string, projection: WorkView) => void;
	findCommand: (commandId: string, commandFingerprint?: string) => ArchiveAppendResult | undefined;
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

function commandFingerprint(input: ArchiveAppend): string | null {
	return input.commandFingerprint ?? null;
}

function missionId(input: ArchiveAppend): string | null {
	return input.missionId ?? null;
}

function executionId(input: ArchiveAppend): string | null {
	return input.executionId ?? null;
}

function evidenceReferences(input: ArchiveAppend): string {
	return JSON.stringify((input.evidenceRefs ?? []).slice(0, 20).map((entry) => boundText(entry, 500)));
}

function assertEffectCompatible(
	existing: SqlRow,
	effect: ArchiveEffect,
	effectKind: string,
	effectPayload: string,
): void {
	if (readString(existing, "kind") !== effectKind || readString(existing, "payload_json") !== effectPayload)
		throw new Error(`Archive effect ${effect.effectId} conflicts with an existing effect.`);
}

function validateAppendSizes(input: ArchiveAppend): void {
	const payload = JSON.stringify(input.payload);
	if (payload === undefined) throw new Error("Archive payload must be a JSON value.");
	if (payload.length > 64_000) throw new Error("Archive payload exceeds the 64 KB limit.");
	if (JSON.stringify(input.projection).length > 128_000)
		throw new Error("Archive projection exceeds the 128 KB limit.");
}

function assertCurrentRevision(current: SqlRow | undefined, input: ArchiveAppend): void {
	const currentRevision = current === undefined ? 0 : readInteger(current, "revision");
	if (currentRevision !== input.expectedWorkRevision)
		throw new RevisionConflict(input.workId, input.expectedWorkRevision, currentRevision);
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
`;

const EFFECT_LEASE_MS = 120_000;
const ARCHIVE_MARKER_SUFFIX = ".initialized";

export class SQLiteArchive implements ArchivePort {
	private readonly database: SqlDatabase;

	constructor(path: string) {
		const existed = existsSync(path);
		const markerPath = archiveMarkerPath(path);
		if (!existed && existsSync(markerPath))
			throw new Error(`Archive database ${path} is missing; refusing to create a replacement Archive.`);
		mkdirSync(dirname(path), { recursive: true });
		this.database = openSqlite(path);
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
		this.database.exec(SCHEMA);
		this.migrateCommandColumns();
		this.migrateLegacyWorkTerms();
		this.migrateLegacyWorkStates();
		this.migrateRecordNumbers();
		this.validateIntegrity();
		ensureArchiveMarker(markerPath);
	}

	private validateIntegrity(): void {
		const check = this.database.prepare("PRAGMA quick_check").get();
		if (check === undefined || readString(check, "quick_check") !== "ok")
			throw new Error("Archive SQLite integrity check failed.");
		this.validateWorkProjections();
		this.validateRecordPayloads();
		this.validateOutboxPayloads();
	}

	private validateWorkProjections(): void {
		for (const row of this.database.prepare("SELECT view_json FROM work_projection").all())
			parseWorkView(readString(row, "view_json"));
	}

	private validateRecordPayloads(): void {
		for (const row of this.database.prepare("SELECT payload_json FROM archive_records").all())
			parseJson(readString(row, "payload_json"));
	}

	private validateOutboxPayloads(): void {
		for (const row of this.database.prepare("SELECT payload_json FROM outbox").all()) {
			const payload = parseJson(readString(row, "payload_json"));
			if (!isJsonObject(payload)) throw new Error("Archive outbox payload is invalid.");
		}
	}

	private migrateCommandColumns(): void {
		const columns = new Set(
			this.database
				.prepare("PRAGMA table_info(archive_records)")
				.all()
				.map((row) => readString(row, "name")),
		);
		if (!columns.has("command_fingerprint"))
			this.database.exec("ALTER TABLE archive_records ADD COLUMN command_fingerprint TEXT");
		if (!columns.has("projection_json"))
			this.database.exec("ALTER TABLE archive_records ADD COLUMN projection_json TEXT");
	}

	// Existing Archives did not persist path scopes. Treat those historical Work terms as repository-wide.
	private migrateLegacyWorkTerms(): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const rows = this.database.prepare("SELECT work_id, view_json FROM work_projection").all();
			const migrations = rows.map(readLegacyWorkTermsMigration).filter(isDefined);
			const update = this.database.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?");
			for (const migration of migrations) update.run(JSON.stringify(migration.view), migration.workId);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}
	private migrateLegacyWorkStates(): void {
		this.transaction(() => {
			const migrations = this.readLegacyWorkStateMigrations();
			const updateProjection = this.database.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?");
			const updateRecords = this.database.prepare(
				"UPDATE archive_records SET state = 'stopped' WHERE work_id = ? AND state IN ('failed', 'cancelled')",
			);
			for (const migration of migrations) {
				updateProjection.run(JSON.stringify(migration.view), migration.workId);
				updateRecords.run(migration.workId);
			}
		});
	}

	private readLegacyWorkStateMigrations(): Array<Readonly<{ workId: string; view: JsonObject }>> {
		return this.database
			.prepare("SELECT work_id, view_json FROM work_projection")
			.all()
			.map((row) => readLegacyWorkStateMigration(row))
			.filter(isDefined);
	}

	private migrateRecordNumbers(): void {
		this.transaction(() => {
			const records = this.database
				.prepare("SELECT record_id, mission_id FROM archive_records ORDER BY sequence")
				.all();
			const numbered = this.database
				.prepare("SELECT record_id, record_number, mission_id, mission_record_number FROM archive_record_numbers")
				.all();
			if (numbered.length > records.length) throw new Error("Archive record numbering has orphaned rows.");
			const missing = missingRecordNumbers(records, numbered);
			if (missing.length === 0) return;
			this.insertMissingRecordNumbers(numbered, missing);
		});
	}

	private insertMissingRecordNumbers(numbered: readonly SqlRow[], missing: readonly SqlRow[]): void {
		const usedRecordNumbers = new Set(numbered.map((row) => readInteger(row, "record_number")));
		const usedMissionNumbers = missionRecordNumbers(numbered);
		const insert = this.database.prepare(
			"INSERT INTO archive_record_numbers(record_id, record_number, mission_id, mission_record_number) VALUES (?, ?, ?, ?)",
		);
		for (const record of missing) {
			const recordNumber = nextAvailableNumber(usedRecordNumbers);
			const missionId = readOptionalString(record, "mission_id");
			const missionRecordNumber = nextMissionNumber(usedMissionNumbers, missionId);
			insert.run(readString(record, "record_id"), recordNumber, missionId ?? null, missionRecordNumber);
		}
	}

	private transaction<T>(action: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}
	append(input: ArchiveAppend): ArchiveAppendResult {
		validateArchiveAppendInput(input);
		assertPositiveInteger(input.expectedWorkRevision + 1, "expectedWorkRevision");
		const duplicate = this.findDuplicateRow(input.commandId);
		if (duplicate !== undefined) return this.duplicateResult(duplicate, input.workId, input.commandFingerprint);
		validateProjection(input.projection, input.workId, input.expectedWorkRevision + 1);
		validateAppendSizes(input);
		return this.transaction(() => this.appendNewRecord(input));
	}

	private findDuplicateRow(commandId: string): SqlRow | undefined {
		return this.database
			.prepare(
				"SELECT sequence, work_id, command_fingerprint, projection_json FROM archive_records WHERE command_id = ?",
			)
			.get(commandId);
	}

	private appendNewRecord(input: ArchiveAppend): ArchiveAppendResult {
		const concurrentDuplicate = this.findDuplicateRow(input.commandId);
		if (concurrentDuplicate !== undefined)
			return this.duplicateResult(concurrentDuplicate, input.workId, input.commandFingerprint);
		const current = this.database.prepare("SELECT revision FROM work_projection WHERE work_id = ?").get(input.workId);
		assertCurrentRevision(current, input);
		this.assertAppendAdmission(input);
		const inserted = this.insertArchiveRecord(input);
		this.allocateRecordNumbers(input, inserted.recordId);
		const projection = this.persistProjection(input, inserted.sequence);
		this.insertEffects(input.effects ?? [], inserted.now);
		return { record: this.readRecord(inserted.sequence), projection, duplicate: false };
	}

	private assertAppendAdmission(input: ArchiveAppend): void {
		if (input.executionGuard === undefined || input.projection.execution?.state !== "queued") return;
		this.assertExecutionAdmission(input.workId, input.executionGuard);
	}

	private insertArchiveRecord(input: ArchiveAppend): InsertedArchiveRecord {
		const recordId = randomUUID();
		const now = new Date().toISOString();
		const inserted = this.database
			.prepare(`INSERT INTO archive_records
			(record_id, command_id, command_fingerprint, kind, actor, work_id, mission_id, execution_id,
			 payload_version, projection_json, state, summary, evidence_refs_json, payload_json, recorded_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				recordId,
				input.commandId,
				commandFingerprint(input),
				input.kind,
				input.actor,
				input.workId,
				missionId(input),
				executionId(input),
				input.payloadVersion,
				null,
				input.projection.state,
				boundText(input.summary, 500),
				evidenceReferences(input),
				JSON.stringify(input.payload),
				now,
			);
		return { recordId, sequence: Number(inserted.lastInsertRowid), now } satisfies InsertedArchiveRecord;
	}

	private allocateRecordNumbers(input: ArchiveAppend, recordId: string): void {
		const recordNumberRow = this.database
			.prepare("SELECT COALESCE(MAX(record_number), 0) + 1 AS record_number FROM archive_record_numbers")
			.get();
		if (recordNumberRow === undefined) throw new Error("Archive record number could not be allocated.");
		const recordNumber = readInteger(recordNumberRow, "record_number");
		const missionRecordNumber = this.allocateMissionRecordNumber(input.missionId);
		this.database
			.prepare(
				"INSERT INTO archive_record_numbers(record_id, record_number, mission_id, mission_record_number) VALUES (?, ?, ?, ?)",
			)
			.run(recordId, recordNumber, input.missionId ?? null, missionRecordNumber);
	}

	private allocateMissionRecordNumber(missionId: string | undefined): number | null {
		if (missionId === undefined) return null;
		const row = this.database
			.prepare(
				"SELECT COALESCE(MAX(mission_record_number), 0) + 1 AS mission_record_number FROM archive_record_numbers WHERE mission_id = ?",
			)
			.get(missionId);
		if (row === undefined) throw new Error("Mission record number could not be allocated.");
		return readInteger(row, "mission_record_number");
	}

	private persistProjection(input: ArchiveAppend, sequence: number): WorkView {
		const projection =
			input.projection.queuedSequence === 0 ? { ...input.projection, queuedSequence: sequence } : input.projection;
		this.database
			.prepare("UPDATE archive_records SET projection_json = ? WHERE sequence = ?")
			.run(JSON.stringify(projection), sequence);
		this.database
			.prepare(`INSERT INTO work_projection(work_id, revision, queued_sequence, view_json) VALUES (?, ?, ?, ?)
			ON CONFLICT(work_id) DO UPDATE SET revision = excluded.revision, queued_sequence = excluded.queued_sequence, view_json = excluded.view_json`)
			.run(input.workId, projection.revision, projection.queuedSequence, JSON.stringify(projection));
		return projection;
	}

	private insertEffects(effects: readonly ArchiveEffect[], now: string): void {
		for (const effect of effects) this.insertEffect(effect, now);
	}

	private insertEffect(effect: ArchiveEffect, now: string): void {
		const effectPayload = JSON.stringify(effect.payload);
		if (effectPayload.length > 16_000) throw new Error(`Archive effect ${effect.effectId} exceeds the 16 KB limit.`);
		const effectKind = boundText(effect.kind, 200);
		const existing = this.database
			.prepare("SELECT kind, payload_json FROM outbox WHERE effect_id = ?")
			.get(effect.effectId);
		if (existing !== undefined) {
			assertEffectCompatible(existing, effect, effectKind, effectPayload);
			return;
		}
		this.database
			.prepare("INSERT INTO outbox(effect_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
			.run(effect.effectId, effectKind, effectPayload, now);
	}

	// The projection snapshot is replay metadata; updating it does not alter the append-only record.
	updateCommandProjection(commandId: string, projection: WorkView): void {
		validateProjection(projection, projection.workId, projection.revision);
		const serialized = JSON.stringify(projection);
		if (serialized.length > 128_000) throw new Error("Archive projection exceeds the 128 KB limit.");
		this.transaction(() => {
			const existing = this.database.prepare("SELECT work_id FROM archive_records WHERE command_id = ?").get(commandId);
			assertCommandProjectionOwnership(existing, commandId, projection.workId);
			this.database
				.prepare("UPDATE archive_records SET projection_json = ? WHERE command_id = ?")
				.run(serialized, commandId);
		});
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
				.prepare("SELECT effect_id, claimed_at FROM outbox_claim WHERE effect_id = ? AND owner = ?")
				.get(effectId, owner);
			if (!activeClaim(claim)) {
				deleteClaim(this.database, effectId, owner, claim);
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
				.prepare("SELECT effect_id, claimed_at FROM outbox_claim WHERE effect_id = ? AND owner = ?")
				.get(effectId, owner);
			if (!activeClaim(claim)) {
				deleteClaim(this.database, effectId, owner, claim);
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

	findCommand(commandId: string, commandFingerprint?: string): ArchiveAppendResult | undefined {
		const row = this.database
			.prepare(
				"SELECT sequence, work_id, command_fingerprint, projection_json FROM archive_records WHERE command_id = ?",
			)
			.get(commandId);
		return row === undefined ? undefined : this.duplicateResult(row, undefined, commandFingerprint, commandId);
	}

	private duplicateResult(
		row: SqlRow,
		expectedWorkId?: string,
		commandFingerprint?: string,
		commandId = `at sequence ${readInteger(row, "sequence")}`,
	): ArchiveAppendResult {
		const workId = readString(row, "work_id");
		assertDuplicateWorkId(workId, expectedWorkId, commandId);
		assertDuplicateFingerprint(readOptionalString(row, "command_fingerprint"), commandFingerprint, commandId);
		const projectionText = readOptionalString(row, "projection_json");
		const projection = projectionText === undefined ? this.project(workId) : parseWorkView(projectionText);
		if (projection === undefined) throw new Error(`Archive command ${commandId} has no projection.`);
		return { record: this.readRecord(readInteger(row, "sequence")), projection, duplicate: true };
	}
	query(query: RecordQuery = {}, cursor?: string): Page<RecordView> {
		const state = resolveQueryState(query, cursor, () => this.latestSequence());
		const filters = queryFilters(state.query, state.asOfSequence, state.lastSequence);
		const rows = this.database.prepare(archiveQuerySql(filters.clauses)).all(...filters.parameters);
		const items = rows.map((row) => this.recordFromRow(row));
		return archivePage(items, state);
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
			if (isLatestObservation(payload, kind, providerId, observationId)) return payload;
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
		const views = this.database
			.prepare("SELECT work_id, view_json FROM work_projection")
			.all()
			.map((row) => parseWorkView(readString(row, "view_json")));
		assertExecutionCapacity(views, guard.maxConcurrentExecutions);
		assertFifoAdmission(views, workId, guard.enforceFifo);
	}

	private latestSequence(): number {
		const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM archive_records").get();
		return row === undefined ? 0 : readInteger(row, "sequence");
	}

	private readRecord(sequence: number): RecordView {
		const row = this.database
			.prepare(
				`SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
				 archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
				 archive_records.payload_version, archive_records.summary, archive_records.evidence_refs_json,
				 archive_records.payload_json, archive_records.recorded_at,
				 archive_record_numbers.record_number, archive_record_numbers.mission_record_number
				 FROM archive_records
				 LEFT JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id
				 WHERE archive_records.sequence = ?`,
			)
			.get(sequence);
		if (row === undefined) {
			throw new Error(`Archive record at sequence ${sequence} was not found.`);
		}
		return this.recordFromRow(row);
	}

	private recordFromRow(row: SqlRow): RecordView {
		const payloadText = readString(row, "payload_json");
		const parsedPayload = parseJson(payloadText);
		const boundedPayload =
			payloadText.length > 16_000 ? { truncated: true, content: payloadText.slice(0, 16_000) } : parsedPayload;
		const evidenceRefs = parseJson(readString(row, "evidence_refs_json"));
		if (!Array.isArray(evidenceRefs)) {
			throw new Error("Archive evidence references are invalid.");
		}
		const evidence = evidenceRefs.map((entry) => readStringValue(entry, "Archive evidence reference"));
		const missionRecordNumber = readOptionalInteger(row, "mission_record_number");
		return {
			sequence: readInteger(row, "sequence"),
			recordNumber: readInteger(row, "record_number"),
			missionRecordNumber,
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

export class CommandReuseConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandReuseConflict";
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

function readLegacyWorkTermsMigration(row: SqlRow): Readonly<{ workId: string; view: JsonObject }> | undefined {
	const view = parseJson(readString(row, "view_json"));
	if (!isJsonObject(view)) throw new Error("Archive Work projection is invalid.");
	const viewMigration = migrateLegacyWorkTermsView(view);
	return viewMigration === undefined ? undefined : { workId: readString(row, "work_id"), view: viewMigration };
}

function migrateLegacyWorkTermsView(view: JsonObject): JsonObject | undefined {
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

function requiredJsonObject(value: JsonValue | undefined, field: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${field} are invalid.`);
	return value;
}

function needsPathScope(value: JsonObject): boolean {
	return value["allowedPaths"] === undefined;
}

function needsMissionPathScope(mission: JsonValue | undefined): boolean {
	return isJsonObject(mission) && isJsonObject(mission["assignment"]) && needsPathScope(mission["assignment"]);
}

function addDefaultPathScope(terms: JsonObject, needed: boolean): JsonObject {
	return needed ? { ...terms, allowedPaths: ["."] } : terms;
}

function addMissionPathScope(mission: JsonValue | undefined, needed: boolean): JsonValue | undefined {
	if (!needed || !isJsonObject(mission) || !isJsonObject(mission["assignment"])) return mission;
	return { ...mission, assignment: { ...mission["assignment"], allowedPaths: ["."] } };
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

function assertDuplicateWorkId(workId: string, expectedWorkId: string | undefined, commandId: string): void {
	if (expectedWorkId !== undefined && workId !== expectedWorkId)
		throw new Error(`Archive command ${commandId} was already used for Work ${workId}.`);
}

function assertDuplicateFingerprint(
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

function validateArchiveAppendInput(input: ArchiveAppend): void {
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

function validateOptionalText(value: string | undefined, field: string): void {
	if (value !== undefined) assertNonBlank(value, field);
}

function validateRecordKind(value: RecordKind): void {
	parseRecordKind(String(value));
}

function validateActor(value: Actor): void {
	if (!isActor(String(value))) throw new Error(`Archive actor ${String(value)} is invalid.`);
}

function activeClaim(claim: SqlRow | undefined): claim is SqlRow {
	return claim !== undefined && Date.now() - readInteger(claim, "claimed_at") < EFFECT_LEASE_MS;
}

function deleteClaim(database: SqlDatabase, effectId: string, owner: string, claim: SqlRow | undefined): void {
	if (claim === undefined) return;
	database.prepare("DELETE FROM outbox_claim WHERE effect_id = ? AND owner = ?").run(effectId, owner);
}

type QueryState = Readonly<{
	query: RecordQuery;
	asOfSequence: number;
	lastSequence: number;
}>;

type QueryFilters = Readonly<{ clauses: readonly string[]; parameters: readonly (string | number)[] }>;

function resolveQueryState(query: RecordQuery, cursor: string | undefined, latestSequence: () => number): QueryState {
	if (cursor === undefined) return { query: normalizeQuery(query), asOfSequence: latestSequence(), lastSequence: 0 };
	const parsed = decodeCursor(cursor);
	if (JSON.stringify(normalizeQuery(query)) !== JSON.stringify(parsed.query))
		throw new Error("Archive cursor does not match the requested filters.");
	return parsed;
}

function queryFilters(query: RecordQuery, asOfSequence: number, lastSequence: number): QueryFilters {
	const clauses = ["archive_records.sequence <= ?", "archive_records.sequence > ?"];
	const parameters: Array<string | number> = [asOfSequence, lastSequence];
	addQueryTextFilters(clauses, parameters, query);
	addQueryListFilter(clauses, parameters, "kind", query.kinds);
	addQueryListFilter(clauses, parameters, "state", query.states);
	addQueryDateFilter(clauses, parameters, "archive_records.recorded_at >= ?", query.from);
	addQueryDateFilter(clauses, parameters, "archive_records.recorded_at <= ?", query.to);
	return { clauses, parameters };
}

function addQueryTextFilters(clauses: string[], parameters: Array<string | number>, query: RecordQuery): void {
	addQueryTextFilter(clauses, parameters, "archive_records.work_id = ?", query.workId);
	addQueryTextFilter(clauses, parameters, "archive_records.mission_id = ?", query.missionId);
	addQueryTextFilter(clauses, parameters, "archive_records.execution_id = ?", query.executionId);
}

function addQueryTextFilter(
	clauses: string[],
	parameters: Array<string | number>,
	clause: string,
	value: string | undefined,
): void {
	if (value === undefined) return;
	clauses.push(clause);
	parameters.push(value);
}

function addQueryListFilter(
	clauses: string[],
	parameters: Array<string | number>,
	column: string,
	values: readonly string[] | readonly RecordKind[] | undefined,
): void {
	if (values === undefined || values.length === 0) return;
	clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
	parameters.push(...values);
}

function addQueryDateFilter(
	clauses: string[],
	parameters: Array<string | number>,
	clause: string,
	value: string | undefined,
): void {
	addQueryTextFilter(clauses, parameters, clause, value);
}

function archiveQuerySql(clauses: readonly string[]): string {
	return `SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
		archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
		archive_records.payload_version, archive_records.summary, archive_records.evidence_refs_json,
		archive_records.payload_json, archive_records.recorded_at,
		archive_record_numbers.record_number, archive_record_numbers.mission_record_number
		FROM archive_records
		LEFT JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id
		WHERE ${clauses.join(" AND ")} ORDER BY archive_records.sequence LIMIT 100`;
}

function archivePage(items: readonly RecordView[], state: QueryState): Page<RecordView> {
	const last = items.at(-1)?.sequence;
	return {
		items,
		asOfSequence: state.asOfSequence,
		nextCursor:
			last === undefined || items.length < 100
				? undefined
				: encodeCursor({ version: 1, query: state.query, asOfSequence: state.asOfSequence, lastSequence: last }),
	};
}

function assertCommandProjectionOwnership(existing: SqlRow | undefined, commandId: string, workId: string): void {
	if (existing === undefined) throw new Error(`Archive command ${commandId} was not found.`);
	if (readString(existing, "work_id") !== workId)
		throw new Error(`Archive command ${commandId} belongs to another Work.`);
}

function isLatestObservation(
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

function assertExecutionCapacity(views: readonly WorkView[], limit: number): void {
	const active = views.filter((view) =>
		["queued", "running", "awaiting-review"].includes(view.execution?.state ?? ""),
	).length;
	if (active >= limit) throw new ExecutionAdmissionConflict(`Project execution limit ${limit} is already reserved.`);
}

function assertFifoAdmission(views: readonly WorkView[], workId: string, enforceFifo: boolean | undefined): void {
	if (enforceFifo !== true) return;
	const first = views
		.filter((view) => view.state === "queued")
		.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
	if (first !== undefined && first.workId !== workId)
		throw new ExecutionAdmissionConflict(`Work ${first.workId} is ahead of Work ${workId} in the FIFO queue.`);
}

function readLegacyWorkStateMigration(row: SqlRow): Readonly<{ workId: string; view: JsonObject }> | undefined {
	const view = parseJson(readString(row, "view_json"));
	if (!isJsonObject(view)) throw new Error("Archive Work projection is invalid.");
	const stopReason = legacyWorkStopReason(view["state"]);
	if (stopReason === undefined) return undefined;
	const migrated = { ...view, state: "stopped", stopReason };
	if (!isWorkViewProjection(migrated)) throw new Error("Archive Work projection migration is invalid.");
	return { workId: readString(row, "work_id"), view: migrated };
}

function missingRecordNumbers(records: readonly SqlRow[], numbered: readonly SqlRow[]): readonly SqlRow[] {
	const numberedRecordIds = new Set(numbered.map((row) => readString(row, "record_id")));
	return records.filter((record) => !numberedRecordIds.has(readString(record, "record_id")));
}

function missionRecordNumbers(numbered: readonly SqlRow[]): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	for (const row of numbered) addMissionRecordNumber(result, row);
	return result;
}

function addMissionRecordNumber(numbers: Map<string, Set<number>>, row: SqlRow): void {
	const missionId = readOptionalString(row, "mission_id");
	const missionRecordNumber = readOptionalInteger(row, "mission_record_number");
	if (missionId === undefined || missionRecordNumber === undefined) return;
	const missionNumbers = numbers.get(missionId) ?? new Set<number>();
	missionNumbers.add(missionRecordNumber);
	numbers.set(missionId, missionNumbers);
}

function nextAvailableNumber(used: Set<number>): number {
	let next = 1;
	while (used.has(next)) next += 1;
	used.add(next);
	return next;
}

function nextMissionNumber(numbers: Map<string, Set<number>>, missionId: string | undefined): number | null {
	if (missionId === undefined) return null;
	const missionNumbers = numbers.get(missionId) ?? new Set<number>();
	const next = nextAvailableNumber(missionNumbers);
	numbers.set(missionId, missionNumbers);
	return next;
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
	const parsed = readCursorJson(value);
	if (!isJsonObject(parsed)) throw new Error("Invalid Archive cursor payload.");
	return cursorFromObject(parsed);
}

function readCursorJson(value: string): JsonValue {
	try {
		return parseJson(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid Archive cursor: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function cursorFromObject(object: JsonObject): Cursor {
	const query = object["query"];
	if (object["version"] !== 1 || !isJsonObject(query)) throw new Error("Invalid Archive cursor fields.");
	return {
		version: 1,
		query: queryFromJson(query),
		asOfSequence: readJsonInteger(object["asOfSequence"], "asOfSequence"),
		lastSequence: readJsonInteger(object["lastSequence"], "lastSequence"),
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
	if (isJsonPrimitive(value)) return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isJsonObject(value)) return false;
	return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

function isJsonPrimitive(value: JsonValue): boolean {
	return [value === null, value === true, value === false, value === String(value), isFiniteNumber(value)].some(
		Boolean,
	);
}

function isFiniteNumber(value: JsonValue): boolean {
	return value === Number(value) && Number.isFinite(Number(value));
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function hasTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => isText(value[key]));
}

function hasNonBlankTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => isNonBlankText(value[key]));
}

function parseWorkView(value: string): WorkView {
	const parsed = parseJson(value);
	if (!isWorkViewProjection(parsed)) {
		throw new Error("Archive Work projection is invalid.");
	}
	return parsed;
}
function validateProjection(projection: WorkView, workId: string, revision: number): void {
	assertProjectionIdentity(projection, workId, revision);
	assertProjectionValues(projection, workId);
}

function assertProjectionIdentity(projection: WorkView, workId: string, revision: number): void {
	if (projection.workId !== workId || projection.revision !== revision || !isWorkViewProjection(projection))
		throw new Error("Archive projection does not match the expected Work revision.");
}

function assertProjectionValues(projection: WorkView, workId: string): void {
	if (invalidProjectionBudget(projection) || invalidProjectionRelationships(projection, workId))
		throw new Error("Archive Work projection contains invalid budget or queue values.");
}

function invalidProjectionBudget(projection: WorkView): boolean {
	return [
		projection.terms.maxTokens <= 0,
		projection.budget.maxTokens <= 0,
		projection.budget.reservedTokens < 0,
		projection.budget.consumedTokens < 0,
		projection.budget.reservedTokens + projection.budget.consumedTokens > projection.budget.maxTokens,
		projection.budget.maxTokens !== projection.terms.maxTokens,
		projection.queuedSequence < 0,
	].some(Boolean);
}

function invalidProjectionRelationships(projection: WorkView, workId: string): boolean {
	return [
		invalidStopReasonRelationship(projection),
		invalidMissionRelationship(projection, workId),
		invalidExecutionRelationship(projection, workId),
	].some(Boolean);
}

function invalidStopReasonRelationship(projection: WorkView): boolean {
	return (
		(projection.state === "stopped" && projection.stopReason === undefined) ||
		(projection.state !== "stopped" && projection.stopReason !== undefined)
	);
}

function invalidMissionRelationship(projection: WorkView, workId: string): boolean {
	return projection.mission !== undefined && projection.mission.workId !== workId;
}

function invalidExecutionRelationship(projection: WorkView, workId: string): boolean {
	if (projection.execution === undefined) return false;
	return projection.execution.workId !== workId || projection.mission?.missionId !== projection.execution.missionId;
}

function isWorkViewProjection(value: JsonValue): value is WorkView {
	if (!isJsonObject(value)) return false;
	return [
		isText(value["workId"]),
		isInteger(value["revision"]),
		isWorkState(value["state"]),
		optional(value["stopReason"], isWorkStopReason),
		optional(value["missionState"], isMissionState),
		isTerms(value["terms"]),
		isBudget(value["budget"]),
		isText(value["nextAction"]),
		isInteger(value["queuedSequence"]),
		optional(value["missionSpecificity"], isMissionSpecificity),
		optional(value["mission"], isMission),
		optional(value["execution"], isExecution),
		optional(value["observer"], isPiBinding),
		optional(value["observerInFlight"], isBoolean),
		optional(value["reviewRequest"], isReviewRequest),
		optional(value["lastSignal"], isSignal),
		optional(value["lastObservation"], isObservation),
		optional(value["providerOutcome"], isProviderOutcomeObservation),
		optional(value["lastValidation"], isValidationRun),
		optional(value["lastError"], isErrorEnvelope),
	].every(Boolean);
}

function optional(value: JsonValue | undefined, check: (value: JsonValue | undefined) => boolean): boolean {
	return value === undefined || check(value);
}

function isTerms(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["title", "objective", "context", "scope"].every((key) => isText(value[key])) &&
		["acceptanceCriteria", "constraints", "validation", "allowedPaths"].every((key) => isTextList(value[key])) &&
		isPositiveInteger(value["maxTokens"])
	);
}

function isBudget(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isPositiveInteger(value["maxTokens"]) &&
		isNonNegativeInteger(value["reservedTokens"]) &&
		isNonNegativeInteger(value["consumedTokens"])
	);
}
function isMission(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		hasTextFields(value, ["missionId", "workId", "createdAt"]),
		isTerms(value["assignment"]),
		optional(value["specificity"], isMissionSpecificity),
		isInteger(value["mandateRevision"]),
	].every(Boolean);
}

function isMissionSpecificity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["explicit", "defaults-used"].includes(String(value["status"])) && isTextList(value["missing"]);
}
function isExecution(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		hasTextFields(value, ["executionId", "workId", "missionId", "model", "thinking"]),
		isExecutionState(value["state"]),
		isInteger(value["tokenAllowance"]),
		optional(value["blockReason"], isBlockReason),
		optional(value["runtimeState"], isExecutionRuntimeState),
		optional(value["usage"], isTokenUsage),
		isPromptIdentity(value["promptIdentity"]),
		isSandbox(value["sandbox"]),
		optional(value["pi"], isPiBinding),
	].every(Boolean);
}

function isBlockReason(value: JsonValue | undefined): boolean {
	return ["signal", "budget-exhausted"].includes(String(value));
}

function isPromptIdentity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return isText(value["packageVersion"]) && isText(value["promptSha256"]);
}

function isSandbox(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["path", "baseCommit", "branch"].every((key) => isText(value[key]));
}

function isPositiveInteger(value: JsonValue | undefined): boolean {
	return isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: JsonValue | undefined): boolean {
	return isInteger(value) && Number(value) >= 0;
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
	if (!isJsonObject(value)) return false;
	return [
		isText(value["sessionId"]),
		isText(value["sessionPath"]),
		optional(value["promptIdentity"], isPromptIdentity),
		optional(value["processGroupId"], isPositiveInteger),
		optional(value["processStartTime"], isText),
		optional(value["capabilityNonce"], isText),
		optional(value["processMarker"], isText),
	].every(Boolean);
}
function isReviewRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isOneOf(value["provider"], ["github", "gitlab"]),
		hasTextFields(value, [
			"principalId",
			"providerId",
			"url",
			"repository",
			"sourceBranch",
			"targetBranch",
			"headCommit",
			"diffSummary",
		]),
		isOneOf(value["status"], REVIEW_REQUEST_STATUSES),
		optional(value["baseCommit"], isText),
		isTextList(value["validation"]),
	].every(Boolean);
}
function isValidationRun(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [isText(value["executionId"]), isText(value["headCommit"]), isValidationResults(value["results"])].every(
		Boolean,
	);
}

function isValidationResults(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isValidationResult);
}

function isValidationResult(value: JsonValue): boolean {
	if (!isJsonObject(value)) return false;
	return hasTextFields(value, ["command", "output"]) && isBoolean(value["passed"]);
}
function isSignal(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["signalId", "executionId", "kind", "summary", "observedAt"].every((key) => isText(value[key])) &&
		isTextList(value["evidence"])
	);
}
const PROVIDER_OBSERVATION_VALIDATORS: ReadonlyMap<string, (value: JsonObject) => boolean> = new Map([
	["ci-status", (value) => isOneOf(value["status"], PROVIDER_CI_STATUSES)],
	["review-comment", (value) => isOneOf(value["status"], PROVIDER_REVIEW_COMMENT_STATUSES)],
	["feedback-delivery", (value) => isOneOf(value["status"], PROVIDER_FEEDBACK_DELIVERY_STATUSES)],
	["monitor-failure", (value) => isOneOf(value["status"], PROVIDER_MONITOR_STATUSES)],
	[
		"provider-outcome",
		(value) =>
			value["status"] === "merged" &&
			hasNonBlankTextFields(value, ["repository", "sourceBranch", "targetBranch", "headCommit", "mergeCommit"]),
	],
]);

function isObservation(value: JsonValue | undefined): value is ProviderObservation {
	if (!isJsonObject(value)) return false;
	const validator = PROVIDER_OBSERVATION_VALIDATORS.get(String(value["kind"]));
	return validator !== undefined && isObservationBase(value) && validator(value);
}

function isObservationBase(value: JsonObject): boolean {
	return [
		hasNonBlankTextFields(value, ["observationId", "providerId", "summary", "observedAt"]),
		isBoolean(value["changed"]),
		optional(value["feedback"], isTextList),
		optionalTextFields(value, [
			"author",
			"authorAssociation",
			"reviewState",
			"repository",
			"sourceBranch",
			"targetBranch",
			"baseCommit",
			"headCommit",
			"mergeCommit",
		]),
		optional(value["actionable"], isBoolean),
		optional(value["details"], isProviderObservationDetails),
	].every(Boolean);
}

function isProviderOutcomeObservation(value: JsonValue | undefined): value is ProviderOutcomeObservation {
	return isObservation(value) && value.kind === "provider-outcome";
}

function optionalTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => optional(value[key], isText));
}
function isProviderObservationDetails(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isProviderPullRequest(value["pullRequest"]),
		isProviderReviewComments(value["comments"]),
		isProviderChecks(value["checks"]),
	].every(Boolean);
}

function isProviderPullRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isText(value["url"]),
		isOneOf(value["status"], REVIEW_REQUEST_STATUSES),
		isText(value["state"]),
		isText(value["reviewDecision"]),
		value["mergedAt"] === null || isText(value["mergedAt"]),
	].every(Boolean);
}

function isOneOf(value: JsonValue | undefined, choices: readonly string[]): boolean {
	return choices.includes(String(value));
}

function isProviderReviewComments(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderReviewComment);
}
function isProviderReviewComment(entry: JsonValue): boolean {
	if (!isJsonObject(entry)) return false;
	return [
		isText(entry["id"]),
		isText(entry["body"]),
		optionalTextFields(entry, ["author", "authorAssociation", "createdAt", "url", "state", "location"]),
		optional(entry["source"], isProviderCommentSource),
		optional(entry["minimized"], isBoolean),
	].every(Boolean);
}

function isProviderCommentSource(value: JsonValue | undefined): boolean {
	return isOneOf(value, ["issue-comment", "review", "inline"]);
}

function isProviderChecks(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderCheck);
}
function isProviderCheck(entry: JsonValue): boolean {
	if (!isJsonObject(entry)) return false;
	return [
		isOneOf(entry["kind"], ["check-run", "status-context"]),
		isText(entry["name"]),
		isText(entry["status"]),
		optionalTextFields(entry, ["conclusion", "workflowName", "detailsUrl", "startedAt", "completedAt"]),
	].every(Boolean);
}
function isErrorEnvelope(value: JsonValue | undefined): value is ErrorEnvelope {
	if (!isJsonObject(value)) return false;
	return [
		isOneOf(value["code"], [
			"invalid-input",
			"not-found",
			"forbidden",
			"revision-conflict",
			"invalid-state",
			"budget-exhausted",
			"external-failure",
			"integrity-failure",
		]),
		isText(value["summary"]),
		isBoolean(value["retryable"]),
		isText(value["remediation"]),
		isTextList(value["evidenceRefs"]),
		optional(value["learning"], isLearning),
	].every(Boolean);
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

function isNonBlankText(value: JsonValue | undefined): boolean {
	return isText(value) && value.trim().length > 0;
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

function readOptionalInteger(row: SqlRow, key: string): number | undefined {
	const value = row[key];
	if (value === null || value === undefined) {
		return;
	}
	return readInteger(row, key);
}
function readJsonInteger(value: JsonValue | undefined, key: string): number {
	return readIntegerValue(value, `Archive cursor field ${key}`);
}

function readInteger(row: SqlRow, key: string): number {
	return readIntegerValue(row[key], `Archive column ${key}`);
}

function readIntegerValue(value: JsonValue | undefined | SqlOutputValue, field: string): number {
	const number = Number(value);
	if (!isIntegerValue(value, number)) throw new Error(`${field} is not an integer.`);
	return number;
}

function isIntegerValue(value: JsonValue | undefined | SqlOutputValue, number: number): boolean {
	return [value !== null, value !== undefined, number === value, Number.isSafeInteger(number)].every(Boolean);
}

function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	return values.map(parseRecordKind);
}

function readRecordKind(row: SqlRow, key: string): RecordKind {
	return parseRecordKind(readString(row, key));
}

function readActor(row: SqlRow, key: string): Actor {
	const value = readString(row, key);
	if (!isActor(value)) throw new Error(`Archive actor ${value} is invalid.`);
	return value;
}

function readStringValue(value: JsonValue | undefined | SqlOutputValue, field: string): string {
	if (value === null || value === undefined || value !== String(value)) {
		throw new Error(`${field} is not text.`);
	}
	return String(value);
}

function archiveMarkerPath(path: string): string {
	return `${path}${ARCHIVE_MARKER_SUFFIX}`;
}

function ensureArchiveMarker(path: string): void {
	try {
		writeFileSync(path, "Khala Archive initialized.\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if (error instanceof Error && isExistsError(error)) return;
		throw error;
	}
}

function isExistsError(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

function boundText(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
