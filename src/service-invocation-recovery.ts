import type { CommandMeta, TokenUsage, WorkView } from "./model.js";
import type { OperationContext, RuntimeInvocationEvidence } from "./ports.js";
import type { InvocationFact, RunLedger } from "./run-ledger.js";
import { ActionInputError } from "./service-contracts.js";

export type InvocationRecoveryRuntime = Readonly<{
	reconcileInvocation?: (runId: string, operation?: OperationContext) => Promise<RuntimeInvocationEvidence>;
}>;

export type InvocationReconciliationInput = Readonly<{
	runId?: string | undefined;
	usage?: TokenUsage | undefined;
	evidence?: readonly string[] | undefined;
}>;
type ManualSettlement = Readonly<{ usage: TokenUsage; evidence: readonly string[] }>;

export async function reconcileInvocation(
	work: WorkView,
	meta: CommandMeta,
	input: InvocationReconciliationInput | undefined,
	ledger: RunLedger,
	runtime: InvocationRecoveryRuntime,
	operation?: OperationContext,
): Promise<WorkView> {
	const runId = requiredText(input?.runId, "runId");
	const fact = requireHeldFact(ledger, runId, work.workId);
	const receipt = await requireRuntimeReconciliation(runtime)(runId, operation);
	const settlement = manualSettlement(input, receipt, fact, runId);
	return ledger.reconcile({ runId, workId: work.workId, ...settlement, meta });
}

function manualSettlement(
	input: InvocationReconciliationInput | undefined,
	receipt: RuntimeInvocationEvidence,
	fact: InvocationFact,
	runId: string,
): ManualSettlement {
	const values = input ?? {};
	const usage = reconciledUsage(values.usage, receipt, fact.usage);
	const evidence = settlementEvidence(values.evidence, receipt.complete, runId);
	return { usage, evidence };
}

function settlementEvidence(
	evidenceInput: readonly string[] | undefined,
	complete: boolean,
	runId: string,
): readonly string[] {
	const evidence = normalizedEvidence(evidenceInput);
	if (!complete && evidence.length === 0)
		throw new ActionInputError("Incomplete invocation receipts require nonblank recovery evidence.");
	return evidence.length === 0 ? [`runtime-receipt:${runId}`] : evidence;
}

export async function reconcileCompletedInvocations(
	work: WorkView,
	ledger: RunLedger,
	runtime: InvocationRecoveryRuntime,
	activeRunIds: Pick<ReadonlySet<string>, "has">,
	operation?: OperationContext,
): Promise<WorkView> {
	let current = work;
	const invocations = work.activeInvocations ?? [];
	for (const invocation of invocations) {
		if (activeRunIds.has(invocation.runId)) continue;
		current = await settleCompletedInvocation(invocation.runId, ledger, runtime, operation);
	}
	return current;
}

async function settleCompletedInvocation(
	runId: string,
	ledger: RunLedger,
	runtime: InvocationRecoveryRuntime,
	operation: OperationContext | undefined,
): Promise<WorkView> {
	const receipt = await requireRuntimeReconciliation(runtime)(runId, operation);
	if (!receipt.complete || receipt.usage === undefined)
		throw new ActionInputError(
			`Invocation ${runId} has no complete durable receipt; reconcile it manually with cumulative usage and evidence.`,
		);
	return ledger.settle({ runId, usage: receipt.usage, complete: true });
}

function reconciledUsage(
	provided: TokenUsage | undefined,
	receipt: RuntimeInvocationEvidence,
	recorded: TokenUsage | undefined,
): TokenUsage {
	if (receipt.complete) return completeReceiptUsage(provided, receipt.usage);
	if (provided === undefined) throw new ActionInputError("Incomplete runtime receipts require cumulative usage.");
	assertAtLeast(provided, receipt.usage, "runtime receipt");
	assertAtLeast(provided, recorded, "recorded ledger usage");
	return provided;
}

function completeReceiptUsage(provided: TokenUsage | undefined, receipt: TokenUsage | undefined): TokenUsage {
	if (receipt === undefined) throw new ActionInputError("A complete runtime receipt must include cumulative usage.");
	if (provided !== undefined && !sameUsage(provided, receipt))
		throw new ActionInputError("Provided usage differs from the complete runtime receipt.");
	return receipt;
}

function requireHeldFact(ledger: RunLedger, runId: string, workId: string): InvocationFact {
	const fact = ledger.find(runId);
	if (fact === undefined) throw new ActionInputError(`Invocation ${runId} was not reserved.`);
	if (fact.workId !== workId) throw new ActionInputError(`Invocation ${runId} belongs to another Work.`);
	if (fact.state === "settled") throw new ActionInputError(`Invocation ${runId} is already settled.`);
	return fact;
}

function requireRuntimeReconciliation(
	runtime: InvocationRecoveryRuntime,
): NonNullable<InvocationRecoveryRuntime["reconcileInvocation"]> {
	if (runtime.reconcileInvocation === undefined)
		throw new ActionInputError("The runtime cannot prove invocation settlement; reconcile the held run manually.");
	return runtime.reconcileInvocation.bind(runtime);
}

function assertAtLeast(usage: TokenUsage, minimum: TokenUsage | undefined, source: string): void {
	if (minimum === undefined) return;
	for (const field of usageFields)
		if (usage[field] < minimum[field])
			throw new ActionInputError(`Provided usage cannot be lower than ${source} ${field}.`);
}

const usageFields = ["inputTokens", "outputTokens", "cacheHitTokens", "cacheMissTokens"] as const;

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
	return usageFields.every((field) => left[field] === right[field]);
}

function requiredText(value: string | undefined, field: string): string {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) throw new ActionInputError(`${field} must not be blank.`);
	return normalized;
}

function normalizedEvidence(evidence: readonly string[] | undefined): readonly string[] {
	return (evidence ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
