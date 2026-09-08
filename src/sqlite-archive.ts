export class SQLiteArchive implements ArchivePort {
	private readonly database: SqlDatabase;
	private readonly supervision: SQLiteSupervisionLock | undefined;

	constructor(path: string, options: SQLiteArchiveOptions = {}) {
		this.database = openArchiveDatabase(path, options);
		if (options.readOnly === true) {
			this.supervision = undefined;
			this.initializeReadOnly();
			this.initializeReadViews();
			return;
		}
		this.initializeWritable(path);
		this.initializeReadViews();
		this.supervision = new SQLiteSupervisionLock(path);
	}

	private initializeReadOnly(): void {
		try {
			this.validateReadOnlySchema();
			this.validateIntegrity();
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	private initializeReadViews(): void {
		this.database.exec(ARCHIVE_READ_VIEWS);
	}

	private initializeWritable(path: string): void {
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
		this.database.exec(SCHEMA);
		this.migrateCommandColumns();
		this.migrateLegacyWorkTerms();
		this.migrateLegacyWorkStates();
		this.migrateRecordNumbers();
		this.validateIntegrity();
		ensureArchiveMarker(archiveMarkerPath(path));
	}

	private validateReadOnlySchema(): void {
		const tables = new Set(
			this.database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => readString(row, "name")),
		);
		const missing = REQUIRED_ARCHIVE_TABLES.filter((table) => !tables.has(table));
		if (missing.length > 0) throw new Error(`Archive schema is missing required tables: ${missing.join(", ")}.`);
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
		this.assertInvocationCapacity(input.invocationLimit);
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

	countPendingInvocations(): number {
		// Count in SQLite rather than materializing the complete model-run history in User memory.
		const row = this.database
			.prepare(`SELECT COUNT(*) AS pending FROM archive_records AS reservation
			WHERE reservation.command_id GLOB 'invocation-reserve:*'
			AND NOT EXISTS (SELECT 1 FROM archive_records AS settlement
				WHERE settlement.kind = 'invocation'
				AND json_extract(settlement.payload_json, '$.runId') = substr(reservation.command_id, 20)
				AND json_extract(settlement.payload_json, '$.state') = 'settled')`)
			.get();
		if (row === undefined) throw new Error("Archive invocation count is unavailable.");
		return readInteger(row, "pending");
	}

	private assertInvocationCapacity(limit: number | undefined): void {
		if (limit === undefined) return;
		assertPositiveInteger(limit, "invocationLimit");
		if (this.countPendingInvocations() >= limit) throw new InvocationCapacityExceeded();
	}

	private insertArchiveRecord(input: ArchiveAppend): InsertedArchiveRecord {
		const recordId = nanoid();
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

	pendingEffects(owner = "archive-reader", excludedEffectIds: readonly string[] = []): readonly PendingArchiveEffect[] {
		const now = Date.now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare("DELETE FROM outbox_claim WHERE claimed_at < ?").run(now - EFFECT_LEASE_MS);
			const rows = this.database.prepare(pendingEffectsQuery(excludedEffectIds)).all(...excludedEffectIds);
			rows.forEach((row) => {
				this.database
					.prepare("INSERT INTO outbox_claim(effect_id, owner, claimed_at) VALUES (?, ?, ?)")
					.run(readString(row, "effect_id"), owner, now);
			});
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

	findInvocation(runId: string): ArchiveAppendResult | undefined {
		const row = this.database
			.prepare(`SELECT sequence, work_id, command_fingerprint, projection_json FROM archive_records
				WHERE kind = 'invocation' AND json_extract(payload_json, '$.runId') = ?
				ORDER BY sequence DESC LIMIT 1`)
			.get(runId);
		return row === undefined ? undefined : this.duplicateResult(row);
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
		const filters = queryFilters(state.query, state.asOfSequence, state.lastSequence, "archive_records");
		const rows = this.database.prepare(archiveQuerySql(filters.clauses, state.query.order)).all(...filters.parameters);
		const items = rows.map((row) => this.recordFromRow(row));
		return archivePage(items, state);
	}

	querySummaries(query: RecordQuery = {}, visibleExecutionId?: string): Page<RecordSummaryView> {
		const normalized = normalizeQuery(query);
		const state = resolveQueryState({ ...normalized, order: "asc" }, undefined, () => this.latestSequence());
		const filters = queryFilters(
			state.query,
			state.asOfSequence,
			state.lastSequence,
			"khala_archive_record_summaries",
			visibleExecutionId,
		);
		const rows = this.database.prepare(archiveSummaryQuerySql(filters.clauses)).all(...filters.parameters);
		const items = rows.map((row) => this.recordSummaryFromRow(row));
		return archiveSummaryPage(items, state);
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

	acquireSupervision(): boolean {
		return this.supervision?.acquire() ?? false;
	}

	releaseSupervision(): void {
		this.supervision?.release();
	}

	close(): void {
		this.supervision?.release();
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

	private recordSummaryFromRow(row: SqlRow): RecordSummaryView {
		return {
			sequence: readInteger(row, "sequence"),
			recordNumber: readInteger(row, "record_number"),
			missionRecordNumber: readOptionalInteger(row, "mission_record_number"),
			id: readString(row, "record_id"),
			kind: readRecordKind(row, "kind"),
			actor: readActor(row, "actor"),
			workId: readString(row, "work_id"),
			missionId: readOptionalString(row, "mission_id"),
			executionId: readOptionalString(row, "execution_id"),
			summary: boundText(readString(row, "summary"), 500),
			recordedAt: readString(row, "recorded_at"),
		};
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

import { nanoid } from "nanoid";
import {
	isJsonObject,
	isObservation,
	parseJson,
	parseWorkView,
	readActor,
	readInteger,
	readOptionalInteger,
	readOptionalString,
	readRecordKind,
	readString,
	readStringValue,
	validateProjection,
} from "./archive-codec.js";
import {
	archivePage,
	archiveQuerySql,
	archiveSummaryPage,
	archiveSummaryQuerySql,
	normalizeQuery,
	queryFilters,
	resolveQueryState,
} from "./archive-query.js";
import {
	ARCHIVE_READ_VIEWS,
	activeClaim,
	archiveMarkerPath,
	assertCommandProjectionOwnership,
	assertCurrentRevision,
	assertDuplicateFingerprint,
	assertDuplicateWorkId,
	assertEffectCompatible,
	assertExecutionCapacity,
	assertFifoAdmission,
	boundText,
	commandFingerprint,
	deleteClaim,
	EFFECT_LEASE_MS,
	ensureArchiveMarker,
	evidenceReferences,
	executionId,
	isDefined,
	isLatestObservation,
	missingRecordNumbers,
	missionId,
	missionRecordNumbers,
	nextAvailableNumber,
	nextMissionNumber,
	openArchiveDatabase,
	pendingEffectsQuery,
	REQUIRED_ARCHIVE_TABLES,
	readLegacyWorkStateMigration,
	readLegacyWorkTermsMigration,
	SCHEMA,
	validateAppendSizes,
	validateArchiveAppendInput,
} from "./archive-storage.js";
import {
	type ArchiveAppend,
	type ArchiveAppendResult,
	type ArchiveEffect,
	type ArchivePort,
	InvocationCapacityExceeded,
	type PendingArchiveEffect,
	type SQLiteArchiveOptions,
} from "./archive-types.js";
import {
	assertPositiveInteger,
	type JsonObject,
	type Page,
	type ProviderObservation,
	type RecordQuery,
	type RecordSummaryView,
	type RecordView,
	type WorkView,
} from "./model.js";
import type { SqlDatabase, SqlRow } from "./sqlite.js";
import { SQLiteSupervisionLock } from "./supervision.js";

type InsertedArchiveRecord = Readonly<{ recordId: string; sequence: number; now: string }>;
