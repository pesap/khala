import {
	isActiveInvocation,
	isJsonObject,
	isText,
	isTokenUsage,
	parseJson,
	readIntegerValue,
	readString,
} from "./archive-codec.js";
import type { ArchiveAppend } from "./archive-types.js";
import type { ActiveInvocation, JsonObject, JsonValue, WorkView } from "./model.js";
import type { SqlDatabase } from "./sqlite.js";

type DurableActiveInvocation = Readonly<{
	runId: string;
	workId: string;
	role: ActiveInvocation["role"];
	allowance: number;
	state: ActiveInvocation["state"];
	usage: number;
}>;

type ActiveInvocationObject = JsonObject &
	Readonly<{
		runId: string;
		workId: string;
		role: ActiveInvocation["role"];
		allowance: number;
		state: ActiveInvocation["state"];
	}>;

export function validateProjectionIntegrity(
	database: SqlDatabase,
	projections: readonly WorkView[],
	candidate?: ArchiveAppend,
): void {
	const activeRunIds = new Set<string>();
	for (const projection of projections) validateWorkProjection(database, projection, activeRunIds, candidate);
}

function validateWorkProjection(
	database: SqlDatabase,
	projection: WorkView,
	activeRunIds: Set<string>,
	candidate: ArchiveAppend | undefined,
): void {
	let reserved = 0;
	for (const active of projection.activeInvocations ?? []) {
		const fact = readActiveInvocation(database, active.runId, candidate);
		const validated = validateActiveInvocation(projection, active, fact, activeRunIds);
		reserved += Math.max(0, active.allowance - validated.usage);
		assertSafeReservedTokens(reserved);
	}
	if (projection.budget.reservedTokens !== reserved)
		throw new Error(`Archive Work ${projection.workId} has invalid invocation reservation accounting.`);
}

function validateActiveInvocation(
	projection: WorkView,
	active: ActiveInvocation,
	fact: DurableActiveInvocation | undefined,
	activeRunIds: Set<string>,
): DurableActiveInvocation {
	if (activeRunIds.has(active.runId))
		throw new Error(`Archive projections contain duplicate active invocation ${active.runId}.`);
	if (fact === undefined || !matchesActiveInvocation(projection, active, fact))
		throw new Error(`Archive active invocation ${active.runId} has no matching durable invocation fact.`);
	activeRunIds.add(active.runId);
	return fact;
}

function matchesActiveInvocation(
	projection: WorkView,
	active: ActiveInvocation,
	fact: DurableActiveInvocation,
): boolean {
	return [
		fact.runId === active.runId,
		fact.workId === projection.workId,
		fact.role === active.role,
		fact.allowance === active.allowance,
		fact.state === active.state,
	].every(Boolean);
}

function readActiveInvocation(
	database: SqlDatabase,
	runId: string,
	candidate: ArchiveAppend | undefined,
): DurableActiveInvocation | undefined {
	const payload = candidateInvocationPayload(candidate, runId) ?? persistedInvocationPayload(database, runId);
	return activeInvocationFact(payload);
}

function candidateInvocationPayload(candidate: ArchiveAppend | undefined, runId: string): JsonObject | undefined {
	if (candidate?.kind !== "invocation") return undefined;
	return matchingRunPayload(objectPayload(candidate.payload), runId);
}

function matchingRunPayload(payload: JsonObject | undefined, runId: string): JsonObject | undefined {
	if (payload === undefined) return undefined;
	return payload["runId"] === runId ? payload : undefined;
}

function persistedInvocationPayload(database: SqlDatabase, runId: string): JsonObject | undefined {
	const row = database
		.prepare(`SELECT payload_json FROM archive_records
			WHERE kind = 'invocation' AND json_extract(payload_json, '$.runId') = ?
			ORDER BY sequence DESC LIMIT 1`)
		.get(runId);
	if (row === undefined) return undefined;
	return objectPayload(parseJson(readString(row, "payload_json")));
}

function activeInvocationFact(value: JsonObject | undefined): DurableActiveInvocation | undefined {
	if (value === undefined || !isActiveInvocationObject(value)) return undefined;
	const usage = invocationUsage(value["usage"]);
	if (usage === undefined) return undefined;
	return {
		runId: value.runId,
		workId: value.workId,
		role: value.role,
		allowance: value.allowance,
		state: value.state,
		usage,
	};
}

function isActiveInvocationObject(value: JsonObject): value is ActiveInvocationObject {
	if (!isJsonObject(value)) return false;
	return [isActiveInvocation(value), isText(value["workId"])].every(Boolean);
}

function invocationUsage(value: JsonValue | undefined): number | undefined {
	if (value === undefined) return 0;
	const object = tokenUsageObject(value);
	if (object === undefined) return undefined;
	const total =
		readIntegerValue(object["inputTokens"], "Archive invocation inputTokens") +
		readIntegerValue(object["outputTokens"], "Archive invocation outputTokens");
	return Number.isSafeInteger(total) ? total : undefined;
}

function tokenUsageObject(value: JsonValue): JsonObject | undefined {
	if (!isJsonObject(value)) return undefined;
	return isTokenUsage(value) ? value : undefined;
}

function objectPayload(value: JsonValue): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

function assertSafeReservedTokens(reserved: number): void {
	if (!Number.isSafeInteger(reserved)) throw new Error("Archive invocation budget accounting is unsafe.");
}
