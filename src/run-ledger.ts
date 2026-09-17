import { nanoid } from "nanoid";
import { type ArchivePort, RevisionConflict } from "./archive.js";
import type {
	ActiveInvocation,
	CommandMeta,
	JsonObject,
	JsonValue,
	TokenUsage,
	WorkBudget,
	WorkView,
} from "./model.js";

export type InvocationRole = "conclave" | "executor" | "observer" | "oracle";
export type InvocationState = "reserved" | "settled" | "uncertain";
export type InvocationFact = Readonly<{
	runId: string;
	workId: string;
	role: InvocationRole;
	missionId?: string | undefined;
	executionId?: string | undefined;
	allowance: number;
	usage?: TokenUsage | undefined;
	state: InvocationState;
}>;

export type RunLedgerPort = Pick<ArchivePort, "project" | "findCommand" | "findInvocation" | "append">;
export type ReserveInvocationInput = Readonly<{
	workId: string;
	role: InvocationRole;
	missionId?: string | undefined;
	executionId?: string | undefined;
	allowance: number;
	runId?: string | undefined;
	maxConcurrentRuns?: number | undefined;
}>;
export type SettleInvocationInput = Readonly<{ runId: string; usage?: TokenUsage | undefined; complete: boolean }>;
export type ReconcileInvocationInput = Readonly<{
	runId: string;
	workId: string;
	usage: TokenUsage;
	meta: CommandMeta;
	evidence: readonly string[];
}>;
export type ReservedInvocation = Readonly<{
	duplicate: boolean;
	runId: string;
	allowance: number;
	state: InvocationState;
	projection: WorkView;
}>;

export class RunLedger {
	private readonly archive: RunLedgerPort;
	constructor(archive: RunLedgerPort) {
		this.archive = archive;
	}

	reserve(input: ReserveInvocationInput): ReservedInvocation {
		const runId = input.runId ?? nanoid();
		const prior = this.find(runId);
		if (prior !== undefined) return this.reusedReservation(input, prior);
		const work = this.requireWork(input.workId);
		assertAllowance(input.allowance);
		const budget = reserveBudget(work.budget, input.allowance);
		const active: ActiveInvocation = { runId, role: input.role, allowance: input.allowance, state: "reserved" };
		const projection = {
			...work,
			revision: work.revision + 1,
			budget,
			activeInvocations: [...(work.activeInvocations ?? []), active],
		};
		const fact = reservationFact(input, runId);
		const result = this.archive.append({
			commandId: `invocation-reserve:${runId}`,
			expectedWorkRevision: work.revision,
			kind: "invocation",
			actor: "system",
			workId: input.workId,
			missionId: input.missionId,
			executionId: input.executionId,
			payloadVersion: 1,
			invocationLimit: input.maxConcurrentRuns,
			summary: `Reserved ${input.role} invocation ${runId}.`,
			payload: fact,
			projection,
		});
		return {
			duplicate: result.duplicate,
			runId,
			allowance: input.allowance,
			state: "reserved",
			projection: result.projection,
		};
	}

	settle(input: SettleInvocationInput): WorkView {
		const fact = this.find(input.runId);
		if (fact === undefined) throw new Error(`Invocation ${input.runId} was not reserved.`);
		const work = this.requireWork(fact.workId);
		assertSettlementUsage(fact, input);
		if (alreadySettled(fact, input.complete)) return work;
		const nextFact = settledFact(fact, input);
		const next = settlementProjection(work, fact, input);
		return this.archive.append({
			commandId: `${input.complete ? "invocation-settle" : "invocation-uncertain"}:${input.runId}`,
			expectedWorkRevision: work.revision,
			kind: "invocation",
			actor: "system",
			workId: fact.workId,
			missionId: fact.missionId,
			executionId: fact.executionId,
			payloadVersion: 1,
			summary: `Settled ${fact.role} invocation ${input.runId}.`,
			payload: nextFact,
			projection: next,
		}).projection;
	}

	reconcile(input: ReconcileInvocationInput): WorkView {
		assertReconciliationInput(input);
		const prior = this.archive.findCommand(input.meta.commandId, input.meta.commandFingerprint);
		if (prior !== undefined) return replayedReconciliation(prior, input);
		return this.reconcileNew(input);
	}

	private reconcileNew(input: ReconcileInvocationInput): WorkView {
		const fact = this.find(input.runId);
		if (fact === undefined) throw new Error(`Invocation ${input.runId} was not reserved.`);
		if (fact.workId !== input.workId) throw new Error(`Invocation ${input.runId} belongs to another Work.`);
		const work = this.requireWork(input.workId);
		assertReconciliationRevision(input, work);
		assertReportedUsage(fact, input.usage);
		assertHeldInvocation(fact);
		const settlement = { runId: input.runId, usage: input.usage, complete: true };
		return this.archive.append({
			commandId: input.meta.commandId,
			commandFingerprint: input.meta.commandFingerprint,
			expectedWorkRevision: work.revision,
			kind: "invocation",
			actor: "user",
			workId: input.workId,
			missionId: fact.missionId,
			executionId: fact.executionId,
			payloadVersion: 1,
			summary: `Reconciled ${fact.role} invocation ${input.runId}.`,
			evidenceRefs: input.evidence,
			payload: settledFact(fact, settlement),
			projection: settlementProjection(work, fact, settlement),
		}).projection;
	}

	find(runId: string): InvocationFact | undefined {
		const record = this.archive.findInvocation(runId)?.record;
		return record === undefined ? undefined : requireFact(record.payload, runId);
	}
	private requireWork(workId: string): WorkView {
		const work = this.archive.project(workId);
		if (work === undefined) throw new Error(`Work ${workId} was not found.`);
		return work;
	}
	private reusedReservation(input: ReserveInvocationInput, prior: InvocationFact): ReservedInvocation {
		const fields = ["workId", "role", "missionId", "executionId", "allowance"] as const;
		if (!fields.every((field) => prior[field] === input[field]))
			throw new Error(`Invocation ${prior.runId} is bound to different input.`);
		return {
			duplicate: true,
			runId: prior.runId,
			allowance: prior.allowance,
			state: prior.state,
			projection: this.requireWork(input.workId),
		};
	}
}

function assertReconciliationInput(input: ReconcileInvocationInput): void {
	assertReconciliationMeta(input.meta);
	assertReconciliationEvidence(input.evidence);
}

function assertReconciliationMeta(meta: CommandMeta): void {
	if (meta.actor !== "user") throw new Error("Invocation reconciliation requires the User actor.");
	if (meta.schemaVersion !== 1) throw new Error("Invocation reconciliation requires command schema version 1.");
	assertReconciliationCommand(meta);
}

function assertReconciliationCommand(meta: CommandMeta): void {
	if (meta.commandId.trim().length === 0) throw new Error("Invocation reconciliation requires a command ID.");
	const fingerprint = meta.commandFingerprint;
	if (fingerprint === undefined) throw new Error("Invocation reconciliation requires a command fingerprint.");
	if (fingerprint.trim().length === 0) throw new Error("Invocation reconciliation requires a command fingerprint.");
}

function assertReconciliationEvidence(evidence: readonly string[]): void {
	if (evidence.length === 0 || evidence.some((entry) => entry.trim().length === 0))
		throw new Error("Invocation reconciliation requires nonblank evidence.");
}

function assertReconciliationRevision(input: ReconcileInvocationInput, work: WorkView): void {
	const expected = input.meta.expectedWorkRevision;
	if (expected === undefined || !Number.isSafeInteger(expected))
		throw new Error("Invocation reconciliation requires an expected Work revision.");
	if (expected !== work.revision) throw new RevisionConflict(input.workId, expected, work.revision);
}

function assertHeldInvocation(fact: InvocationFact): void {
	if (fact.state === "settled") throw new Error(`Invocation ${fact.runId} is already settled.`);
}

function replayedReconciliation(
	prior: NonNullable<ReturnType<RunLedgerPort["findCommand"]>>,
	input: ReconcileInvocationInput,
): WorkView {
	if (prior.record.actor !== "user") throw new Error(`Command ${input.meta.commandId} belongs to another actor.`);
	if (prior.record.workId !== input.workId) throw new Error(`Command ${input.meta.commandId} belongs to another Work.`);
	const fact = requireFact(prior.record.payload, input.runId);
	assertUnchangedSettlement(fact, input.usage);
	return prior.projection;
}

function assertAllowance(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invocation allowance must be positive.");
}
function reserveBudget(budget: WorkBudget, allowance: number): WorkBudget {
	const reserved = budget.reservedTokens + allowance;
	if (budget.consumedTokens + reserved > budget.maxTokens)
		throw new Error("Work budget has no available invocation allowance.");
	return { ...budget, reservedTokens: reserved };
}
function reservationFact(input: ReserveInvocationInput, runId: string): InvocationFact {
	return {
		runId,
		workId: input.workId,
		role: input.role,
		missionId: input.missionId,
		executionId: input.executionId,
		allowance: input.allowance,
		state: "reserved",
	};
}
function alreadySettled(fact: InvocationFact, complete: boolean): boolean {
	return fact.state === "settled" || (fact.state === "uncertain" && !complete);
}
function settledFact(fact: InvocationFact, input: SettleInvocationInput): InvocationFact {
	return {
		...fact,
		usage: input.usage ?? fact.usage,
		state: input.complete ? "settled" : "uncertain",
	};
}
function settledBudget(budget: WorkBudget, fact: InvocationFact, input: SettleInvocationInput): WorkBudget {
	const observed = input.usage === undefined ? 0 : tokenTotal(input.usage);
	const previous = fact.usage === undefined ? 0 : tokenTotal(fact.usage);
	const consumed = Math.max(0, observed - previous);
	const remaining = Math.max(0, fact.allowance - previous);
	const released = input.complete ? remaining : Math.min(consumed, remaining);
	return {
		...budget,
		reservedTokens: budget.reservedTokens - released,
		consumedTokens: budget.consumedTokens + consumed,
	};
}
function settlementProjection(work: WorkView, fact: InvocationFact, input: SettleInvocationInput): WorkView {
	const next = {
		...work,
		revision: work.revision + 1,
		budget: settledBudget(work.budget, fact, input),
		activeInvocations: settleActiveInvocations(work, fact, input.complete),
	};
	if (work.execution === undefined || input.usage === undefined) return next;
	if (!matchesExecution(work.execution, fact)) return next;
	return {
		...next,
		execution: { ...work.execution, usage: accumulatedUsage(work.execution.usage, fact.usage, input.usage) },
	};
}

function settleActiveInvocations(work: WorkView, fact: InvocationFact, complete: boolean): readonly ActiveInvocation[] {
	const active = work.activeInvocations ?? [];
	if (!active.some((run) => run.runId === fact.runId))
		throw new Error(`Invocation ${fact.runId} has no owned reservation; explicit reconciliation is required.`);
	if (complete) return active.filter((run) => run.runId !== fact.runId);
	return active.map((run) => (run.runId === fact.runId ? { ...run, state: "uncertain" } : run));
}

function matchesExecution(execution: NonNullable<WorkView["execution"]>, fact: InvocationFact): boolean {
	return fact.role === "executor" && execution.executionId === fact.executionId;
}

function accumulatedUsage(
	current: TokenUsage | undefined,
	previous: TokenUsage | undefined,
	reported: TokenUsage,
): TokenUsage {
	const baseline = current ?? { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
	const observed = previous ?? { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
	const delta = (field: keyof TokenUsage): number => baseline[field] + reported[field] - observed[field];
	return {
		inputTokens: delta("inputTokens"),
		outputTokens: delta("outputTokens"),
		cacheHitTokens: delta("cacheHitTokens"),
		cacheMissTokens: delta("cacheMissTokens"),
	};
}

function requireFact(value: JsonValue, runId: string): InvocationFact {
	const fact = parseFact(value);
	if (fact?.runId !== runId) throw new Error(`Invocation ${runId} has invalid Archive evidence.`);
	return fact;
}

function assertSettlementUsage(fact: InvocationFact, input: SettleInvocationInput): void {
	if (input.usage === undefined) {
		if (input.complete) throw new Error("Complete settlement requires reported usage.");
		return;
	}
	assertReportedUsage(fact, input.usage);
	if (!input.complete) assertUnchangedSettlement(fact, input.usage);
}

function assertReportedUsage(fact: InvocationFact, usage: TokenUsage): void {
	const values = [usage.inputTokens, usage.outputTokens, usage.cacheHitTokens, usage.cacheMissTokens];
	if (!values.every(isNonNegativeInteger) || !Number.isSafeInteger(tokenTotal(usage)))
		throw new Error("Reported usage must contain non-negative safe integers.");
	assertMonotonicUsage(fact.usage, usage);
	if (fact.state === "settled") assertUnchangedSettlement(fact, usage);
}

function assertMonotonicUsage(previous: TokenUsage | undefined, usage: TokenUsage): void {
	const fields = ["inputTokens", "outputTokens", "cacheHitTokens", "cacheMissTokens"] as const;
	if (!fields.every((field) => usage[field] >= (previous?.[field] ?? 0)))
		throw new Error("Reported usage cannot erase previously observed consumption.");
}

function assertUnchangedSettlement(fact: InvocationFact, usage: TokenUsage): void {
	if (fact.state === "reserved") return;
	const fields = ["inputTokens", "outputTokens", "cacheHitTokens", "cacheMissTokens"] as const;
	if (!fields.every((field) => fact.usage?.[field] === usage[field]))
		throw new Error("An invocation observation cannot be replayed with different usage.");
}

function parseFact(value: JsonValue): InvocationFact | undefined {
	if (!isJsonObject(value)) return undefined;
	return parseFactObject(value);
}
function parseFactObject(value: JsonObject): InvocationFact | undefined {
	const identity = factIdentity(value);
	if (identity === undefined) return undefined;
	const allowance = value["allowance"];
	const state = value["state"];
	if (!isPositiveInteger(allowance) || !isState(state)) return undefined;
	return optionalFactFields({ ...identity, allowance, state }, value);
}
function factIdentity(value: JsonObject): Pick<InvocationFact, "runId" | "workId" | "role"> | undefined {
	const runId = value["runId"];
	const workId = value["workId"];
	const role = value["role"];
	if (!isText(runId) || !isText(workId) || !isRole(role)) return undefined;
	return { runId, workId, role };
}
function optionalFactFields(fact: InvocationFact, value: JsonObject): InvocationFact {
	const missionId = value["missionId"];
	const executionId = value["executionId"];
	const usage = storedUsage(value["usage"], fact.state);
	return {
		...fact,
		missionId: isText(missionId) ? missionId : undefined,
		executionId: isText(executionId) ? executionId : undefined,
		usage,
	};
}
function storedUsage(value: JsonValue | undefined, state: InvocationState): TokenUsage | undefined {
	if (value === undefined) {
		if (state === "settled") throw new Error("Settled invocation lacks usage evidence.");
		return undefined;
	}
	const usage = parseUsage(value);
	if (usage === undefined) throw new Error("Invocation usage evidence is malformed.");
	return usage;
}

function parseUsage(value: JsonValue | undefined): TokenUsage | undefined {
	if (!isJsonObject(value)) return undefined;
	const values = [value["inputTokens"], value["outputTokens"], value["cacheHitTokens"], value["cacheMissTokens"]];
	if (values.some((entry) => !isNonNegativeInteger(entry))) return undefined;
	// SAFETY: the guard above establishes that all four usage fields are non-negative integers.
	const [inputTokens, outputTokens, cacheHitTokens, cacheMissTokens] = values as [number, number, number, number];
	const usage = { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens };
	return Number.isSafeInteger(tokenTotal(usage)) ? usage : undefined;
}
function isNonNegativeInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && Object(value) === value && !Array.isArray(value);
}
function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}
function isPositiveInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}
function isRole(value: JsonValue | undefined): value is InvocationRole {
	return isText(value) && ["conclave", "executor", "observer", "oracle"].includes(value);
}
function isState(value: JsonValue | undefined): value is InvocationState {
	return isText(value) && ["reserved", "settled", "uncertain"].includes(value);
}
function tokenTotal(usage: TokenUsage): number {
	return usage.inputTokens + usage.outputTokens;
}
