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

export class SQLiteArchive implements ArchivePort {
	private readonly database: SqlDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = openSqlite(path);
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
		this.database.exec(SCHEMA);
		this.migrateLegacyWorkTerms();
		this.migrateLegacyWorkStates();
		this.migrateRecordNumbers();
	}

	// Existing Archives did not persist path scopes. Treat those historical Work terms as repository-wide.
	private migrateLegacyWorkTerms(): void {
		const rows = this.database.prepare("SELECT work_id, view_json FROM work_projection").all();
		const migrations = rows.map(readLegacyWorkTermsMigration).filter(isDefined);
		if (migrations.length > 0) applyWorkTermsMigrations(this.database, migrations);
	}

	// oxlint-disable-next-line complexity
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

	// oxlint-disable-next-line complexity
	private migrateRecordNumbers(): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const records = this.database
				.prepare("SELECT record_id, mission_id FROM archive_records ORDER BY sequence")
				.all();
			const numbered = this.database
				.prepare("SELECT record_id, record_number, mission_id, mission_record_number FROM archive_record_numbers")
				.all();
			if (numbered.length > records.length) {
				throw new Error("Archive record numbering has orphaned rows.");
			}
			const numberedRecordIds = new Set(numbered.map((row) => readString(row, "record_id")));
			const missing = records.filter((record) => !numberedRecordIds.has(readString(record, "record_id")));
			if (missing.length > 0) {
				const usedRecordNumbers = new Set(numbered.map((row) => readInteger(row, "record_number")));
				const usedMissionNumbers = new Map<string, Set<number>>();
				for (const row of numbered) {
					const missionId = readOptionalString(row, "mission_id");
					const missionRecordNumber = readOptionalInteger(row, "mission_record_number");
					if (missionId === undefined || missionRecordNumber === undefined) continue;
					const numbers = usedMissionNumbers.get(missionId) ?? new Set<number>();
					numbers.add(missionRecordNumber);
					usedMissionNumbers.set(missionId, numbers);
				}
				const insert = this.database.prepare(
					"INSERT INTO archive_record_numbers(record_id, record_number, mission_id, mission_record_number) VALUES (?, ?, ?, ?)",
				);
				for (const record of missing) {
					let recordNumber = 1;
					while (usedRecordNumbers.has(recordNumber)) recordNumber += 1;
					usedRecordNumbers.add(recordNumber);
					const missionId = readOptionalString(record, "mission_id");
					let missionRecordNumber: number | null = null;
					if (missionId !== undefined) {
						const numbers = usedMissionNumbers.get(missionId) ?? new Set<number>();
						missionRecordNumber = 1;
						while (numbers.has(missionRecordNumber)) missionRecordNumber += 1;
						numbers.add(missionRecordNumber);
						usedMissionNumbers.set(missionId, numbers);
					}
					insert.run(readString(record, "record_id"), recordNumber, missionId ?? null, missionRecordNumber);
				}
			}
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	// oxlint-disable-next-line complexity
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
			const recordNumberRow = this.database
				.prepare("SELECT COALESCE(MAX(record_number), 0) + 1 AS record_number FROM archive_record_numbers")
				.get();
			if (recordNumberRow === undefined) throw new Error("Archive record number could not be allocated.");
			const recordNumber = readInteger(recordNumberRow, "record_number");
			let missionRecordNumber: number | null = null;
			if (input.missionId !== undefined) {
				const missionRecordNumberRow = this.database
					.prepare(
						"SELECT COALESCE(MAX(mission_record_number), 0) + 1 AS mission_record_number FROM archive_record_numbers WHERE mission_id = ?",
					)
					.get(input.missionId);
				if (missionRecordNumberRow === undefined) throw new Error("Mission record number could not be allocated.");
				missionRecordNumber = readInteger(missionRecordNumberRow, "mission_record_number");
			}
			this.database
				.prepare(
					"INSERT INTO archive_record_numbers(record_id, record_number, mission_id, mission_record_number) VALUES (?, ?, ?, ?)",
				)
				.run(recordId, recordNumber, input.missionId ?? null, missionRecordNumber);
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

	// oxlint-disable-next-line complexity
	query(query: RecordQuery = {}, cursor?: string): Page<RecordView> {
		const parsedCursor = cursor === undefined ? undefined : decodeCursor(cursor);
		const effectiveQuery = parsedCursor?.query ?? normalizeQuery(query);
		const asOfSequence = parsedCursor?.asOfSequence ?? this.latestSequence();
		const lastSequence = parsedCursor?.lastSequence ?? 0;
		if (parsedCursor !== undefined && JSON.stringify(normalizeQuery(query)) !== JSON.stringify(effectiveQuery)) {
			throw new Error("Archive cursor does not match the requested filters.");
		}
		const clauses = ["archive_records.sequence <= ?", "archive_records.sequence > ?"];
		const parameters: Array<string | number> = [asOfSequence, lastSequence];
		if (effectiveQuery.workId !== undefined) {
			clauses.push("archive_records.work_id = ?");
			parameters.push(effectiveQuery.workId);
		}
		if (effectiveQuery.missionId !== undefined) {
			clauses.push("archive_records.mission_id = ?");
			parameters.push(effectiveQuery.missionId);
		}
		if (effectiveQuery.executionId !== undefined) {
			clauses.push("archive_records.execution_id = ?");
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
			clauses.push("archive_records.recorded_at >= ?");
			parameters.push(effectiveQuery.from);
		}
		if (effectiveQuery.to !== undefined) {
			clauses.push("archive_records.recorded_at <= ?");
			parameters.push(effectiveQuery.to);
		}
		const rows = this.database
			.prepare(
				`SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
				 archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
				 archive_records.payload_version, archive_records.summary, archive_records.evidence_refs_json,
				 archive_records.payload_json, archive_records.recorded_at,
				 archive_record_numbers.record_number, archive_record_numbers.mission_record_number
				 FROM archive_records
				 JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id
				 WHERE ${clauses.join(" AND ")} ORDER BY archive_records.sequence LIMIT 100`,
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

	// oxlint-disable-next-line complexity
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

	// oxlint-disable-next-line complexity
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
				`SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
				 archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
				 archive_records.payload_version, archive_records.summary, archive_records.evidence_refs_json,
				 archive_records.payload_json, archive_records.recorded_at,
				 archive_record_numbers.record_number, archive_record_numbers.mission_record_number
				 FROM archive_records
				 JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id
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
		const boundedPayload =
			payloadText.length > 16_000 ? { truncated: true, content: payloadText.slice(0, 16_000) } : parseJson(payloadText);
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

function applyWorkTermsMigrations(
	database: SqlDatabase,
	migrations: readonly Readonly<{ workId: string; view: JsonObject }>[],
): void {
	database.exec("BEGIN IMMEDIATE");
	try {
		const update = database.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?");
		for (const migration of migrations) update.run(JSON.stringify(migration.view), migration.workId);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
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

// oxlint-disable-next-line complexity
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

// oxlint-disable-next-line complexity
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

// oxlint-disable-next-line complexity
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
		optional(value["providerOutcome"], isObservation),
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

// oxlint-disable-next-line complexity
function isMission(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["missionId", "workId", "createdAt"].every((key) => isText(value[key])) &&
		isTerms(value["assignment"]) &&
		optional(value["specificity"], isMissionSpecificity) &&
		isInteger(value["mandateRevision"])
	);
}

function isMissionSpecificity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["explicit", "defaults-used"].includes(String(value["status"])) && isTextList(value["missing"]);
}

// oxlint-disable-next-line complexity
function isExecution(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	const sandbox = value["sandbox"];
	const prompt = value["promptIdentity"];
	return (
		["executionId", "workId", "missionId", "model", "thinking"].every((key) => isText(value[key])) &&
		isExecutionState(value["state"]) &&
		isInteger(value["tokenAllowance"]) &&
		optional(value["blockReason"], (entry) => entry === "signal" || entry === "budget-exhausted") &&
		optional(value["runtimeState"], isExecutionRuntimeState) &&
		optional(value["usage"], isTokenUsage) &&
		isPromptIdentity(prompt) &&
		isSandbox(sandbox) &&
		optional(value["pi"], isPiBinding)
	);
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

// oxlint-disable-next-line complexity
function isPiBinding(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value) || !isText(value["sessionId"]) || !isText(value["sessionPath"])) return false;
	return (
		optional(value["promptIdentity"], isPromptIdentity) &&
		optional(value["processGroupId"], (entry) => isPositiveInteger(entry)) &&
		optional(value["processStartTime"], isText) &&
		optional(value["capabilityNonce"], isText) &&
		optional(value["processMarker"], isText)
	);
}

// oxlint-disable-next-line complexity
function isReviewRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isOneOf(value["provider"], ["github", "gitlab"]) &&
		[
			"principalId",
			"providerId",
			"url",
			"repository",
			"sourceBranch",
			"targetBranch",
			"headCommit",
			"diffSummary",
		].every((key) => isText(value[key])) &&
		isOneOf(value["status"], ["draft", "open", "merged", "closed"]) &&
		isTextList(value["validation"])
	);
}

// oxlint-disable-next-line complexity
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

// oxlint-disable-next-line complexity
function isObservation(value: JsonValue | undefined): value is ProviderObservation {
	if (!isJsonObject(value)) return false;
	const required = ["observationId", "kind", "providerId", "status", "summary", "observedAt"].every((key) =>
		isText(value[key]),
	);
	const textFields = [
		"author",
		"authorAssociation",
		"reviewState",
		"repository",
		"sourceBranch",
		"targetBranch",
		"headCommit",
		"mergeCommit",
	];
	return (
		required &&
		isBoolean(value["changed"]) &&
		optional(value["feedback"], isTextList) &&
		textFields.every((key) => optional(value[key], isText)) &&
		optional(value["actionable"], isBoolean) &&
		optional(value["details"], isProviderObservationDetails)
	);
}

// oxlint-disable-next-line complexity
function isProviderObservationDetails(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	const pullRequest = value["pullRequest"];
	if (!isJsonObject(pullRequest)) return false;
	return (
		isText(pullRequest["url"]) &&
		isOneOf(pullRequest["status"], ["draft", "open", "merged", "closed"]) &&
		isText(pullRequest["state"]) &&
		isText(pullRequest["reviewDecision"]) &&
		(pullRequest["mergedAt"] === null || isText(pullRequest["mergedAt"])) &&
		isProviderReviewComments(value["comments"]) &&
		isProviderChecks(value["checks"])
	);
}

function isOneOf(value: JsonValue | undefined, choices: readonly string[]): boolean {
	return choices.includes(String(value));
}

function isProviderReviewComments(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderReviewComment);
}

// oxlint-disable-next-line complexity
function isProviderReviewComment(entry: JsonValue): boolean {
	if (!isJsonObject(entry) || !isText(entry["id"]) || !isText(entry["body"])) return false;
	const textFields = ["author", "authorAssociation", "createdAt", "url", "state", "location"];
	return (
		textFields.every((key) => optional(entry[key], isText)) &&
		optional(entry["source"], (source) => isOneOf(source, ["issue-comment", "review", "inline"])) &&
		optional(entry["minimized"], isBoolean)
	);
}

function isProviderChecks(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderCheck);
}

// oxlint-disable-next-line complexity
function isProviderCheck(entry: JsonValue): boolean {
	if (
		!isJsonObject(entry) ||
		!isOneOf(entry["kind"], ["check-run", "status-context"]) ||
		!isText(entry["name"]) ||
		!isText(entry["status"])
	)
		return false;
	return ["conclusion", "workflowName", "detailsUrl", "startedAt", "completedAt"].every((key) =>
		optional(entry[key], isText),
	);
}

// oxlint-disable-next-line complexity
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

function readOptionalInteger(row: SqlRow, key: string): number | undefined {
	const value = row[key];
	if (value === null || value === undefined) {
		return;
	}
	return readInteger(row, key);
}

// oxlint-disable-next-line complexity
function readJsonInteger(value: JsonValue | undefined, key: string): number {
	const number = Number(value);
	if (value === null || value === undefined || number !== value || !Number.isSafeInteger(number)) {
		throw new Error(`Archive cursor field ${key} is not an integer.`);
	}
	return number;
}

// oxlint-disable-next-line complexity
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
