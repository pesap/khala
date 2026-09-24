import { MAX_PROVIDER_FIELD } from "./adapter-shared.js";
import { isFiniteNumber, isJsonObject, isText } from "./archive-codec.js";
import type { JsonObject, JsonValue, ProviderCheck } from "./model.js";

export type GitlabProviderChecks = Readonly<{
	checks: readonly ProviderCheck[];
	checksComplete: boolean;
}>;

export function gitlabProviderChecks(row: Record<string, JsonValue>): GitlabProviderChecks {
	const pipeline = row["head_pipeline"];
	if (!isJsonObject(pipeline)) return { checks: [], checksComplete: false };
	const check = gitlabPipelineCheck(pipeline);
	return {
		checks: check === undefined ? [] : [check],
		checksComplete: isCurrentPipelineEvidence(row, pipeline, check),
	};
}

function isCurrentPipelineEvidence(
	row: Record<string, JsonValue>,
	pipeline: JsonObject,
	check: ProviderCheck | undefined,
): boolean {
	if (check === undefined) return false;
	const currentHead = readProviderText(row["sha"]);
	return currentHead !== undefined && currentHead === readProviderText(pipeline["sha"]);
}

function gitlabPipelineCheck(pipeline: JsonObject): ProviderCheck | undefined {
	const status = readProviderText(pipeline["status"]);
	if (status === undefined) return undefined;
	return createGitlabPipelineCheck(pipeline, status);
}

function createGitlabPipelineCheck(pipeline: JsonObject, status: string): ProviderCheck {
	const pipelineId = readProviderIdentifier(pipeline["id"]);
	const name = pipelineId === undefined ? "GitLab pipeline" : `GitLab pipeline ${pipelineId}`;
	return {
		kind: "status-context",
		name: name.slice(0, MAX_PROVIDER_FIELD),
		status: status.slice(0, MAX_PROVIDER_FIELD),
		detailsUrl: readProviderText(pipeline["web_url"])?.slice(0, MAX_PROVIDER_FIELD),
		completedAt: readProviderText(pipeline["finished_at"])?.slice(0, MAX_PROVIDER_FIELD),
	};
}

function readProviderText(value: JsonValue | undefined): string | undefined {
	return isText(value) && value.trim().length > 0 ? value.trim() : undefined;
}

function readProviderIdentifier(value: JsonValue | undefined): string | undefined {
	if (value !== undefined && isFiniteNumber(value)) return String(value);
	return readProviderText(value);
}
