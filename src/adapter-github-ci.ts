import { isJsonObject, isTextValue, MAX_PROVIDER_CHECKS, MAX_PROVIDER_FIELD } from "./adapter-shared.js";
import type { JsonValue, ProviderCheck } from "./model.js";

export type GithubProviderChecks = Readonly<{
	checks: readonly ProviderCheck[];
	checksComplete: boolean;
}>;

export function githubProviderChecks(row: Record<string, JsonValue>): GithubProviderChecks {
	const rollup = row["statusCheckRollup"];
	const checks = Array.isArray(rollup) ? rollup.filter(isJsonObject).map(githubProviderCheck).filter(isDefined) : [];
	return {
		checks: checks.slice(0, MAX_PROVIDER_CHECKS),
		checksComplete: Array.isArray(rollup) && rollup.length <= MAX_PROVIDER_CHECKS && checks.length === rollup.length,
	};
}

function githubProviderCheck(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	switch (entry["__typename"]) {
		case "CheckRun":
			return githubCheckRun(entry);
		case "StatusContext":
			return githubStatusContext(entry);
		default:
			return undefined;
	}
}

function githubCheckRun(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	const name = entry["name"];
	const status = entry["status"];
	if (!isNonBlankProviderText(name) || !isNonBlankProviderText(status)) return undefined;
	return {
		kind: "check-run",
		name: boundedText(name.trim()),
		status: boundedText(status.trim()),
		conclusion: boundedOptional(textField(entry, "conclusion")),
		workflowName: boundedOptional(textField(entry, "workflowName")),
		detailsUrl: boundedOptional(textField(entry, "detailsUrl")),
		startedAt: boundedOptional(textField(entry, "startedAt")),
		completedAt: boundedOptional(textField(entry, "completedAt")),
	};
}

function githubStatusContext(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	const context = entry["context"];
	const state = entry["state"];
	if (!isNonBlankProviderText(context) || !isNonBlankProviderText(state)) return undefined;
	return {
		kind: "status-context",
		name: boundedText(context.trim()),
		status: boundedText(state.trim()),
		detailsUrl: boundedOptional(textField(entry, "targetUrl")),
	};
}

function isNonBlankProviderText(value: JsonValue | undefined): value is string {
	return isTextValue(value) && value.trim().length > 0;
}

function textField(entry: Record<string, JsonValue>, key: string): string | undefined {
	return isTextValue(entry[key]) ? entry[key] : undefined;
}

function boundedText(value: string): string {
	return value.slice(0, MAX_PROVIDER_FIELD);
}

function boundedOptional(value: string | undefined): string | undefined {
	return value === undefined ? undefined : boundedText(value);
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
