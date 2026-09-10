export function parseJson(value: string): JsonValue {
	// SAFETY: the archive only writes JSON values and this function validates the parsed tree at the boundary.
	const parsed: JsonValue = JSON.parse(value);
	if (!isJsonValue(parsed)) {
		throw new Error("Archive JSON value is invalid.");
	}
	return parsed;
}
export function isJsonValue(value: JsonValue): boolean {
	if (isJsonPrimitive(value)) return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isJsonObject(value)) return false;
	return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

export function isJsonPrimitive(value: JsonValue): boolean {
	return [value === null, value === true, value === false, value === String(value), isFiniteNumber(value)].some(
		Boolean,
	);
}

export function isFiniteNumber(value: JsonValue): boolean {
	return value === Number(value) && Number.isFinite(Number(value));
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function hasTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => isText(value[key]));
}

export function hasNonBlankTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => isNonBlankText(value[key]));
}

export function parseWorkView(value: string): WorkView {
	const parsed = parseJson(value);
	if (!isWorkViewProjection(parsed)) {
		throw new Error("Archive Work projection is invalid.");
	}
	return parsed;
}
export function validateProjection(projection: WorkView, workId: string, revision: number): void {
	assertProjectionIdentity(projection, workId, revision);
	assertProjectionValues(projection, workId);
}

export function assertProjectionIdentity(projection: WorkView, workId: string, revision: number): void {
	if (projection.workId !== workId || projection.revision !== revision || !isWorkViewProjection(projection))
		throw new Error("Archive projection does not match the expected Work revision.");
}

export function assertProjectionValues(projection: WorkView, workId: string): void {
	if (invalidProjectionBudget(projection) || invalidProjectionRelationships(projection, workId))
		throw new Error("Archive Work projection contains invalid budget or queue values.");
}

export function invalidProjectionBudget(projection: WorkView): boolean {
	return [
		projection.terms.maxTokens <= 0,
		projection.budget.maxTokens <= 0,
		projection.budget.reservedTokens < 0,
		projection.budget.consumedTokens < 0,
		projection.budget.maxTokens !== projection.terms.maxTokens,
		projection.queuedSequence < 0,
	].some(Boolean);
}

export function invalidProjectionRelationships(projection: WorkView, workId: string): boolean {
	return [
		invalidStopReasonRelationship(projection),
		invalidMissionRelationship(projection, workId),
		invalidExecutionRelationship(projection, workId),
	].some(Boolean);
}

export function invalidStopReasonRelationship(projection: WorkView): boolean {
	return (
		(projection.state === "stopped" && projection.stopReason === undefined) ||
		(projection.state !== "stopped" && projection.stopReason !== undefined)
	);
}

export function invalidMissionRelationship(projection: WorkView, workId: string): boolean {
	return projection.mission !== undefined && projection.mission.workId !== workId;
}

export function invalidExecutionRelationship(projection: WorkView, workId: string): boolean {
	if (projection.execution === undefined) return false;
	return projection.execution.workId !== workId || projection.mission?.missionId !== projection.execution.missionId;
}

export function isWorkViewProjection(value: JsonValue): value is WorkView {
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
		optional(value["providerOutcome"], isProviderOutcomeObservation),
		optional(value["lastValidation"], isValidationRun),
		optional(value["lastError"], isErrorEnvelope),
	].every(Boolean);
}

export function optional(value: JsonValue | undefined, check: (value: JsonValue | undefined) => boolean): boolean {
	return value === undefined || check(value);
}

export function isTerms(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["title", "objective", "context", "scope"].every((key) => isText(value[key])) &&
		["acceptanceCriteria", "constraints", "validation", "allowedPaths"].every((key) => isTextList(value[key])) &&
		isPositiveInteger(value["maxTokens"])
	);
}

export function isBudget(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isPositiveInteger(value["maxTokens"]) &&
		isNonNegativeInteger(value["reservedTokens"]) &&
		isNonNegativeInteger(value["consumedTokens"])
	);
}
export function isMission(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		hasTextFields(value, ["missionId", "workId", "createdAt"]),
		isTerms(value["assignment"]),
		optional(value["specificity"], isMissionSpecificity),
		isInteger(value["mandateRevision"]),
	].every(Boolean);
}

export function isMissionSpecificity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["explicit", "defaults-used"].includes(String(value["status"])) && isTextList(value["missing"]);
}
export function isExecution(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		hasTextFields(value, ["executionId", "workId", "missionId", "model", "thinking"]),
		isExecutionState(value["state"]),
		isInteger(value["tokenAllowance"]),
		optional(value["blockReason"], isBlockReason),
		optional(value["runtimeState"], isExecutionRuntimeState),
		optional(value["usage"], isTokenUsage),
		isPromptIdentity(value["promptIdentity"]),
		isSandbox(value["sandbox"]),
		optional(value["pi"], isPiBinding),
	].every(Boolean);
}

export function isBlockReason(value: JsonValue | undefined): boolean {
	return ["signal", "budget-exhausted"].includes(String(value));
}

export function isPromptIdentity(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return isText(value["packageVersion"]) && isText(value["promptSha256"]);
}

export function isSandbox(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["path", "baseCommit", "branch"].every((key) => isText(value[key]));
}

export function isPositiveInteger(value: JsonValue | undefined): boolean {
	return isInteger(value) && Number(value) > 0;
}

export function isNonNegativeInteger(value: JsonValue | undefined): boolean {
	return isInteger(value) && Number(value) >= 0;
}

export function isTokenUsage(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return ["inputTokens", "outputTokens", "cacheHitTokens", "cacheMissTokens"].every((key) => {
		const count = value[key];
		return isInteger(count) && Number(count) >= 0;
	});
}

export function isExecutionRuntimeState(value: JsonValue | undefined): boolean {
	return ["working", "idle", "pending", "unreachable", "unknown"].includes(String(value));
}
export function isPiBinding(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isText(value["sessionId"]),
		isText(value["sessionPath"]),
		optional(value["promptIdentity"], isPromptIdentity),
		optional(value["processGroupId"], isPositiveInteger),
		optional(value["processStartTime"], isText),
		optional(value["capabilityNonce"], isText),
		optional(value["processMarker"], isText),
	].every(Boolean);
}
export function isReviewRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isOneOf(value["provider"], ["github", "gitlab"]),
		hasTextFields(value, [
			"principalId",
			"providerId",
			"url",
			"repository",
			"sourceBranch",
			"targetBranch",
			"headCommit",
			"diffSummary",
		]),
		isOneOf(value["status"], REVIEW_REQUEST_STATUSES),
		optional(value["baseCommit"], isText),
		isTextList(value["validation"]),
	].every(Boolean);
}
export function isValidationRun(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isText(value["executionId"]),
		isText(value["headCommit"]),
		isValidationResults(value["results"]),
		optional(value["sourceVerified"], isBoolean),
		optional(value["sourceFailure"], isText),
	].every(Boolean);
}

export function isValidationResults(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isValidationResult);
}

export function isValidationResult(value: JsonValue): boolean {
	if (!isJsonObject(value)) return false;
	return hasTextFields(value, ["command", "output"]) && isBoolean(value["passed"]);
}
export function isSignal(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		["signalId", "executionId", "kind", "summary", "observedAt"].every((key) => isText(value[key])) &&
		isTextList(value["evidence"])
	);
}
export const PROVIDER_OBSERVATION_VALIDATORS: ReadonlyMap<string, (value: JsonObject) => boolean> = new Map([
	["ci-status", (value) => isOneOf(value["status"], PROVIDER_CI_STATUSES)],
	["review-comment", (value) => isOneOf(value["status"], PROVIDER_REVIEW_COMMENT_STATUSES)],
	["feedback-delivery", (value) => isOneOf(value["status"], PROVIDER_FEEDBACK_DELIVERY_STATUSES)],
	["monitor-failure", (value) => isOneOf(value["status"], PROVIDER_MONITOR_STATUSES)],
	[
		"provider-outcome",
		(value) =>
			value["status"] === "merged" &&
			hasNonBlankTextFields(value, ["repository", "sourceBranch", "targetBranch", "headCommit", "mergeCommit"]),
	],
]);

export function isObservation(value: JsonValue | undefined): value is ProviderObservation {
	if (!isJsonObject(value)) return false;
	const validator = PROVIDER_OBSERVATION_VALIDATORS.get(String(value["kind"]));
	return validator !== undefined && isObservationBase(value) && validator(value);
}

export function isObservationBase(value: JsonObject): boolean {
	return [
		hasNonBlankTextFields(value, ["observationId", "providerId", "summary", "observedAt"]),
		isBoolean(value["changed"]),
		optional(value["feedback"], isTextList),
		optionalTextFields(value, [
			"author",
			"authorAssociation",
			"reviewState",
			"repository",
			"sourceBranch",
			"targetBranch",
			"baseCommit",
			"headCommit",
			"mergeCommit",
		]),
		optional(value["actionable"], isBoolean),
		optional(value["details"], isProviderObservationDetails),
	].every(Boolean);
}

export function isProviderOutcomeObservation(value: JsonValue | undefined): value is ProviderOutcomeObservation {
	return isObservation(value) && value.kind === "provider-outcome";
}

export function optionalTextFields(value: JsonObject, keys: readonly string[]): boolean {
	return keys.every((key) => optional(value[key], isText));
}
export function isProviderObservationDetails(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isProviderPullRequest(value["pullRequest"]),
		isProviderReviewComments(value["comments"]),
		isProviderChecks(value["checks"]),
	].every(Boolean);
}

export function isProviderPullRequest(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return [
		isText(value["url"]),
		isOneOf(value["status"], REVIEW_REQUEST_STATUSES),
		isText(value["state"]),
		isText(value["reviewDecision"]),
		value["mergedAt"] === null || isText(value["mergedAt"]),
	].every(Boolean);
}

export function isOneOf(value: JsonValue | undefined, choices: readonly string[]): boolean {
	return choices.includes(String(value));
}

export function isProviderReviewComments(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderReviewComment);
}
export function isProviderReviewComment(entry: JsonValue): boolean {
	if (!isJsonObject(entry)) return false;
	return [
		isText(entry["id"]),
		isText(entry["body"]),
		optionalTextFields(entry, ["author", "authorAssociation", "createdAt", "url", "state", "location"]),
		optional(entry["source"], isProviderCommentSource),
		optional(entry["minimized"], isBoolean),
	].every(Boolean);
}

export function isProviderCommentSource(value: JsonValue | undefined): boolean {
	return isOneOf(value, ["issue-comment", "review", "inline"]);
}

export function isProviderChecks(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every(isProviderCheck);
}
export function isProviderCheck(entry: JsonValue): boolean {
	if (!isJsonObject(entry)) return false;
	return [
		isOneOf(entry["kind"], ["check-run", "status-context"]),
		isText(entry["name"]),
		isText(entry["status"]),
		optionalTextFields(entry, ["conclusion", "workflowName", "detailsUrl", "startedAt", "completedAt"]),
	].every(Boolean);
}
export function isErrorEnvelope(value: JsonValue | undefined): value is ErrorEnvelope {
	if (!isJsonObject(value)) return false;
	return [
		isOneOf(value["code"], [
			"invalid-input",
			"not-found",
			"forbidden",
			"revision-conflict",
			"invalid-state",
			"budget-exhausted",
			"external-failure",
			"integrity-failure",
		]),
		isText(value["summary"]),
		isBoolean(value["retryable"]),
		isText(value["remediation"]),
		isTextList(value["evidenceRefs"]),
		optional(value["learning"], isLearning),
	].every(Boolean);
}

export function isLearning(value: JsonValue | undefined): boolean {
	return (
		isJsonObject(value) &&
		isText(value["failure"]) &&
		isText(value["missionSpecificity"]) &&
		isText(value["nextMissionGuidance"])
	);
}

export function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

export function isNonBlankText(value: JsonValue | undefined): boolean {
	return isText(value) && value.trim().length > 0;
}

export function isInteger(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

export function isTextList(value: JsonValue | undefined): boolean {
	return Array.isArray(value) && value.every((entry) => isText(entry));
}

export function isMissionState(value: JsonValue | undefined): boolean {
	return ["admitted", "active", "awaiting-review", "succeeded", "rejected", "superseded"].includes(String(value));
}

export function legacyWorkStopReason(value: JsonValue | undefined): "failed" | "cancelled" | undefined {
	if (value === "failed" || value === "cancelled") return value;
	return undefined;
}

export function isWorkState(value: JsonValue | undefined): boolean {
	return ["submitted", "needs-input", "queued", "active", "awaiting-review", "succeeded", "stopped"].includes(
		String(value),
	);
}

export function isWorkStopReason(value: JsonValue | undefined): boolean {
	return ["failed", "cancelled"].includes(String(value));
}

export function isExecutionState(value: JsonValue | undefined): boolean {
	return ["queued", "running", "awaiting-review", "completed", "blocked", "failed", "stopped"].includes(String(value));
}

export function readString(row: SqlRow, key: string): string {
	return readStringValue(row[key], `Archive column ${key}`);
}

export function readOptionalString(row: SqlRow, key: string): string | undefined {
	const value = row[key];
	if (value === null || value === undefined) {
		return;
	}
	return readString(row, key);
}

export function readOptionalInteger(row: SqlRow, key: string): number | undefined {
	const value = row[key];
	if (value === null || value === undefined) {
		return;
	}
	return readInteger(row, key);
}
export function readJsonInteger(value: JsonValue | undefined, key: string): number {
	return readIntegerValue(value, `Archive cursor field ${key}`);
}

export function readInteger(row: SqlRow, key: string): number {
	return readIntegerValue(row[key], `Archive column ${key}`);
}

export function readIntegerValue(value: JsonValue | undefined | SqlOutputValue, field: string): number {
	const number = Number(value);
	if (!isIntegerValue(value, number)) throw new Error(`${field} is not an integer.`);
	return number;
}

export function isIntegerValue(value: JsonValue | undefined | SqlOutputValue, number: number): boolean {
	return [value !== null, value !== undefined, number === value, Number.isSafeInteger(number)].every(Boolean);
}

export function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	return values.map(parseRecordKind);
}

export function readRecordKind(row: SqlRow, key: string): RecordKind {
	return parseRecordKind(readString(row, key));
}

export function readActor(row: SqlRow, key: string): Actor {
	const value = readString(row, key);
	if (!isActor(value)) throw new Error(`Archive actor ${value} is invalid.`);
	return value;
}

export function readStringValue(value: JsonValue | undefined | SqlOutputValue, field: string): string {
	if (value === null || value === undefined || value !== String(value)) {
		throw new Error(`${field} is not text.`);
	}
	return String(value);
}

import {
	type Actor,
	type ErrorEnvelope,
	isActor,
	type JsonObject,
	type JsonValue,
	PROVIDER_CI_STATUSES,
	PROVIDER_FEEDBACK_DELIVERY_STATUSES,
	PROVIDER_MONITOR_STATUSES,
	PROVIDER_REVIEW_COMMENT_STATUSES,
	type ProviderObservation,
	type ProviderOutcomeObservation,
	parseRecordKind,
	REVIEW_REQUEST_STATUSES,
	type RecordKind,
	type WorkView,
} from "./model.js";
import type { SqlOutputValue, SqlRow } from "./sqlite.js";
