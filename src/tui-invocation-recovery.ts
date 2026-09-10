import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, TokenUsage, WorkView } from "./model.js";

const USAGE_FIELDS = [
	["inputTokens", "Cumulative input tokens"],
	["outputTokens", "Cumulative output tokens"],
	["cacheHitTokens", "Cumulative cache hit tokens"],
	["cacheMissTokens", "Cumulative cache miss tokens"],
	["evidence", "Usage evidence reference (one per line)"],
] as const;

export async function editInvocationRecovery(
	context: ExtensionContext,
	work: WorkView,
	values: Map<string, string>,
): Promise<void> {
	const runs = new Map(
		(work.activeInvocations ?? []).map((run) => [`${run.role} ${run.runId} (${run.state})`, run.runId]),
	);
	const selected = await context.ui.select("Held invocation to reconcile:", [...runs.keys()]);
	const runId = selected === undefined ? undefined : runs.get(selected);
	if (runId === undefined) return;
	values.set("runId", runId);
	await editUsageFields(context, runId, values);
}

async function editUsageFields(context: ExtensionContext, runId: string, values: Map<string, string>): Promise<void> {
	for (const [field, label] of USAGE_FIELDS) {
		const key = `${runId}:${field}`;
		const value = await context.ui.editor(`${label} — use final usage evidence; do not estimate`, values.get(key));
		if (value === undefined) return;
		values.set(key, value);
	}
}

export function invocationRecoveryInput(values: ReadonlyMap<string, string>): JsonObject & {
	runId: string;
	usage: TokenUsage;
	evidence: readonly string[];
} {
	const runId = values.get("runId");
	if (runId === undefined) throw new Error("Choose a held invocation with Edit before submitting.");
	const usage = {
		inputTokens: usageCount(values, runId, "inputTokens"),
		outputTokens: usageCount(values, runId, "outputTokens"),
		cacheHitTokens: usageCount(values, runId, "cacheHitTokens"),
		cacheMissTokens: usageCount(values, runId, "cacheMissTokens"),
	};
	const evidence = (values.get(`${runId}:evidence`) ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (evidence.length === 0) throw new Error("Provide an evidence reference for the cumulative usage counts.");
	return { runId, usage, evidence };
}

function usageCount(values: ReadonlyMap<string, string>, runId: string, field: string): number {
	const text = (values.get(`${runId}:${field}`) ?? "").trim();
	if (!/^\d+$/.test(text)) throw new Error(`${field} requires a non-negative whole number from usage evidence.`);
	const value = Number(text);
	if (!Number.isSafeInteger(value)) throw new Error(`${field} exceeds the supported token count.`);
	return value;
}
