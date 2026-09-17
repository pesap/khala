export type QueryState = Readonly<{
	query: RecordQuery;
	asOfSequence: number;
	lastSequence: number;
}>;

export type QueryFilters = Readonly<{ clauses: readonly string[]; parameters: readonly (string | number)[] }>;

export function resolveQueryState(
	query: RecordQuery,
	cursor: string | undefined,
	latestSequence: () => number,
): QueryState {
	const normalized = normalizeQuery(query);
	if (cursor === undefined) {
		const asOfSequence = latestSequence();
		return { query: normalized, asOfSequence, lastSequence: normalized.order === "desc" ? asOfSequence + 1 : 0 };
	}
	const parsed = decodeCursor(cursor);
	if (JSON.stringify(normalized) !== JSON.stringify(parsed.query))
		throw new Error("Archive cursor does not match the requested filters.");
	return parsed;
}

export function queryFilters(
	query: RecordQuery,
	asOfSequence: number,
	lastSequence: number,
	source: "archive_records" | "khala_archive_record_summaries",
	visibleExecutionId?: string,
): QueryFilters {
	const clauses = [`${source}.sequence <= ?`, `${source}.sequence ${query.order === "desc" ? "<" : ">"} ?`];
	const parameters: Array<string | number> = [asOfSequence, lastSequence];
	addQueryTextFilters(clauses, parameters, query, source);
	if (visibleExecutionId !== undefined) {
		clauses.push(`(${source}.execution_id IS NULL OR ${source}.execution_id = ?)`);
		parameters.push(visibleExecutionId);
	}
	addQueryListFilter(clauses, parameters, `${source}.kind`, query.kinds);
	addQueryListFilter(clauses, parameters, `${source}.state`, query.states);
	addQueryDateFilter(clauses, parameters, `${source}.recorded_at >= ?`, query.from);
	addQueryDateFilter(clauses, parameters, `${source}.recorded_at <= ?`, query.to);
	return { clauses, parameters };
}

export function addQueryTextFilters(
	clauses: string[],
	parameters: Array<string | number>,
	query: RecordQuery,
	source: "archive_records" | "khala_archive_record_summaries",
): void {
	addQueryTextFilter(clauses, parameters, `${source}.work_id = ?`, query.workId);
	addQueryTextFilter(clauses, parameters, `${source}.mission_id = ?`, query.missionId);
	addQueryTextFilter(clauses, parameters, `${source}.execution_id = ?`, query.executionId);
}

export function addQueryTextFilter(
	clauses: string[],
	parameters: Array<string | number>,
	clause: string,
	value: string | undefined,
): void {
	if (value === undefined) return;
	clauses.push(clause);
	parameters.push(value);
}

export function addQueryListFilter(
	clauses: string[],
	parameters: Array<string | number>,
	column: string,
	values: readonly string[] | readonly RecordKind[] | undefined,
): void {
	if (values === undefined || values.length === 0) return;
	clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
	parameters.push(...values);
}

export function addQueryDateFilter(
	clauses: string[],
	parameters: Array<string | number>,
	clause: string,
	value: string | undefined,
): void {
	addQueryTextFilter(clauses, parameters, clause, value);
}

export function archiveQuerySql(clauses: readonly string[], order: "asc" | "desc" | undefined): string {
	return `SELECT archive_records.sequence, archive_records.record_id, archive_records.kind, archive_records.actor,
		archive_records.work_id, archive_records.mission_id, archive_records.execution_id,
		archive_records.payload_version, archive_records.summary, archive_records.evidence_refs_json,
		archive_records.payload_json, archive_records.recorded_at,
		archive_record_numbers.record_number, archive_record_numbers.mission_record_number
		FROM archive_records
		LEFT JOIN archive_record_numbers ON archive_record_numbers.record_id = archive_records.record_id
		WHERE ${clauses.join(" AND ")} ORDER BY archive_records.sequence ${order === "desc" ? "DESC" : "ASC"} LIMIT 100`;
}

export function archiveSummaryQuerySql(clauses: readonly string[]): string {
	return `SELECT sequence, record_id, kind, actor, work_id, mission_id, execution_id,
		summary, recorded_at, record_number, mission_record_number
		FROM khala_archive_record_summaries
		WHERE ${clauses.join(" AND ")}
		ORDER BY sequence DESC LIMIT ${SUMMARY_PAGE_LIMIT}`;
}

export function archivePage(items: readonly RecordView[], state: QueryState): Page<RecordView> {
	return archivePageWithLimit(items, state, 100);
}

export function archiveSummaryPage(items: readonly RecordSummaryView[], state: QueryState): Page<RecordSummaryView> {
	return { items, asOfSequence: state.asOfSequence };
}

export function archivePageWithLimit<T extends { sequence: number }>(
	items: readonly T[],
	state: QueryState,
	limit: number,
): Page<T> {
	const last = items.at(-1)?.sequence;
	return {
		items,
		asOfSequence: state.asOfSequence,
		nextCursor:
			last === undefined || items.length < limit
				? undefined
				: encodeCursor({ version: 1, query: state.query, asOfSequence: state.asOfSequence, lastSequence: last }),
	};
}
export function readRecordOrder(value: string | undefined): "asc" | "desc" {
	if (value === undefined) return "asc";
	if (value === "asc" || value === "desc") return value;
	throw new Error(`Archive query order ${value} is invalid.`);
}

export function normalizeQuery(query: RecordQuery): RecordQuery {
	return {
		order: readRecordOrder(query.order),
		workId: query.workId,
		missionId: query.missionId,
		executionId: query.executionId,
		kinds: query.kinds === undefined ? undefined : [...new Set(query.kinds)].sort(),
		states: query.states === undefined ? undefined : [...new Set(query.states)].sort(),
		from: query.from,
		to: query.to,
	};
}

export function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
export function decodeCursor(value: string): Cursor {
	const parsed = readCursorJson(value);
	if (!isJsonObject(parsed)) throw new Error("Invalid Archive cursor payload.");
	return cursorFromObject(parsed);
}

export function readCursorJson(value: string): JsonValue {
	try {
		return parseJson(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(`Invalid Archive cursor: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function cursorFromObject(object: JsonObject): Cursor {
	const query = object["query"];
	if (object["version"] !== 1 || !isJsonObject(query)) throw new Error("Invalid Archive cursor fields.");
	return {
		version: 1,
		query: queryFromJson(query),
		asOfSequence: readJsonInteger(object["asOfSequence"], "asOfSequence"),
		lastSequence: readJsonInteger(object["lastSequence"], "lastSequence"),
	};
}

export function queryFromJson(value: JsonObject): RecordQuery {
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
	const order = readRecordOrder(readOptional("order"));
	const workId = readOptional("workId");
	const missionId = readOptional("missionId");
	const executionId = readOptional("executionId");
	const kinds = readOptionalList("kinds");
	const states = readOptionalList("states");
	const from = readOptional("from");
	const to = readOptional("to");
	return {
		order,
		workId,
		missionId,
		executionId,
		kinds: kinds === undefined ? undefined : readRecordKinds(kinds),
		states,
		from,
		to,
	};
}

import { isJsonObject, parseJson, readJsonInteger, readRecordKinds, readStringValue } from "./archive-codec.js";
import type { JsonObject, JsonValue, Page, RecordKind, RecordQuery, RecordSummaryView, RecordView } from "./model.js";

type Cursor = Readonly<{
	version: 1;
	query: RecordQuery;
	asOfSequence: number;
	lastSequence: number;
}>;

const SUMMARY_PAGE_LIMIT = 10;
