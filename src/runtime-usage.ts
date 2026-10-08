import type { TokenUsage } from "./model.js";
import type { RpcUsage } from "./runtime-types.js";

export function readTokenUsage(value: RpcUsage | undefined): TokenUsage | undefined {
	if (value === undefined) return;
	const counts = [value.input, value.output, value.cacheRead, value.cacheWrite].map(readTokenCount);
	if (!allTokenCounts(counts)) return;
	const cacheMissTokens = counts[0] + counts[3];
	if (!Number.isSafeInteger(cacheMissTokens)) return;
	return { inputTokens: counts[0], outputTokens: counts[1], cacheHitTokens: counts[2], cacheMissTokens };
}

function allTokenCounts(value: readonly (number | undefined)[]): value is readonly [number, number, number, number] {
	return value.length === 4 && value.every((entry): entry is number => entry !== undefined);
}

function readTokenCount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	const totals = tokenTotals(previous, current);
	return { inputTokens: totals[0], outputTokens: totals[1], cacheHitTokens: totals[2], cacheMissTokens: totals[3] };
}

function tokenTotals(previous: TokenUsage | undefined, current: TokenUsage): readonly [number, number, number, number] {
	return [
		tokenTotal(previous, current, "inputTokens"),
		tokenTotal(previous, current, "outputTokens"),
		tokenTotal(previous, current, "cacheHitTokens"),
		tokenTotal(previous, current, "cacheMissTokens"),
	];
}

function tokenTotal(previous: TokenUsage | undefined, current: TokenUsage, key: keyof TokenUsage): number {
	return (previous?.[key] ?? 0) + current[key];
}
