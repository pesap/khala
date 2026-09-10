import { createHash } from "node:crypto";
import {
	MAX_PROVIDER_CHECKS,
	MAX_PROVIDER_COMMENT_BODY,
	MAX_PROVIDER_COMMENTS,
	MAX_PROVIDER_FIELD,
} from "./adapter-shared.js";
import type {
	JsonValue,
	ProviderCheck,
	ProviderCiObservation,
	ProviderCiStatus,
	ProviderObservation,
	ProviderObservationBase,
	ProviderOutcomeObservation,
	ProviderReviewComment,
	ProviderReviewCommentObservation,
	ProviderReviewCommentStatus,
	ReviewRequest,
} from "./model.js";
import type { ReviewRequestInput } from "./ports.js";

export function parseJsonArray(value: string): readonly Record<string, JsonValue>[] {
	const parsed: JsonValue = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Code-host response was not a JSON object list.");
	}
	return parsed.map((entry) => {
		if (!isJsonObject(entry)) {
			throw new Error("Code-host response was not a JSON object list.");
		}
		return entry;
	});
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function requireProviderRow(data: string, message: string): Record<string, JsonValue> {
	const row = parseJsonArray(`[${data}]`)[0];
	if (row === undefined) throw new Error(message);
	return row;
}

export function githubCiObservation(
	data: string,
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
	repository: string,
	details: GithubProviderDetails,
): ProviderCiObservation {
	return {
		...providerObservationBase("ci-status", reviewRequest.providerId, data),
		kind: "ci-status",
		status: githubCheckStatus(githubPollStatus(row, reviewRequest.status), details),
		repository,
		sourceBranch: readOptionalTextValue(row, "headRefName"),
		targetBranch: readOptionalTextValue(row, "baseRefName"),
		baseCommit: readOptionalTextValue(row, "baseRefOid"),
		headCommit: readOptionalTextValue(row, "headRefOid"),
		details,
	};
}

export function gitlabCiObservation(
	data: string,
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): ProviderCiObservation {
	return {
		...providerObservationBase("ci-status", reviewRequest.providerId, data),
		kind: "ci-status",
		status: gitlabStatus(readValue(row, "state"), readBoolean(row, "draft")),
		repository: readRepository(row),
		sourceBranch: readOptionalTextValue(row, "source_branch"),
		targetBranch: readOptionalTextValue(row, "target_branch"),
		baseCommit: readNestedTextValue(row, "diff_refs", "base_sha"),
		headCommit: readOptionalTextValue(row, "sha"),
	};
}

export function isMergedGithubOutcome(row: Record<string, JsonValue>): boolean {
	if (readValue(row, "state").toLowerCase() !== "merged") return false;
	return row["mergedAt"] !== null;
}

export function githubOutcomeObservation(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): ProviderOutcomeObservation {
	return {
		...providerObservationBase("provider-outcome", reviewRequest.providerId, JSON.stringify(row)),
		kind: "provider-outcome",
		status: "merged",
		repository: reviewRequest.repository,
		sourceBranch: readTextValue(row, "headRefName"),
		targetBranch: readTextValue(row, "baseRefName"),
		baseCommit: readOptionalTextValue(row, "baseRefOid"),
		headCommit: readTextValue(row, "headRefOid"),
		mergeCommit: readMergeCommit(row),
	};
}

export function gitlabOutcomeObservation(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): ProviderOutcomeObservation | undefined {
	const mergeCommit = readOptionalTextValue(row, "merge_commit_sha") ?? readOptionalTextValue(row, "squash_commit_sha");
	if (mergeCommit === undefined) return undefined;
	return {
		...providerObservationBase("provider-outcome", reviewRequest.providerId, JSON.stringify(row)),
		kind: "provider-outcome",
		status: "merged",
		repository: readRepository(row),
		sourceBranch: readTextValue(row, "source_branch"),
		targetBranch: readTextValue(row, "target_branch"),
		baseCommit: readNestedTextValue(row, "diff_refs", "base_sha"),
		headCommit: readTextValue(row, "sha"),
		mergeCommit,
	};
}

export function githubReview(
	row: Record<string, JsonValue>,
	input: ReviewRequestInput,
	principalId: string,
	repository: string,
): ReviewRequest {
	return {
		provider: "github",
		principalId,
		providerId: readValue(row, "number"),
		url: readValue(row, "url"),
		repository,
		status: githubStatus(readValue(row, "state"), readBoolean(row, "isDraft")),
		sourceBranch: readTextValue(row, "headRefName"),
		targetBranch: readTextValue(row, "baseRefName"),
		baseCommit: input.sandbox.baseCommit,
		headCommit: readTextValue(row, "headRefOid"),
		diffSummary: `Review request ${readValue(row, "number")} for ${input.terms.title}.`,
		validation: input.terms.validation,
	};
}

function githubStatus(state: string, isDraft: boolean): ReviewRequest["status"] {
	const normalized = state.toLowerCase();
	if (normalized === "merged") {
		return "merged";
	}
	if (normalized === "open") {
		return isDraft ? "draft" : "open";
	}
	return "closed";
}
function readRepository(row: Record<string, JsonValue>): string {
	const repository = [readRepositoryName(row), readRepositoryReference(row), readRepositoryUrl(row)].find(isTextValue);
	if (repository === undefined) throw new Error("Code-host response is missing repository identity.");
	return repository;
}

function readRepositoryName(row: Record<string, JsonValue>): string | undefined {
	const value = row["repository"];
	if (!isJsonObject(value) || value["nameWithOwner"] === undefined) return undefined;
	return readTextValue(value, "nameWithOwner");
}

function readRepositoryReference(row: Record<string, JsonValue>): string | undefined {
	const references = row["references"];
	if (isJsonObject(references) && references["full"] !== undefined)
		return readTextValue(references, "full").replace(/![^!]+$/, "");
	if (isTextValue(references)) return references.replace(/![^!]+$/, "");
	return undefined;
}

function readRepositoryUrl(row: Record<string, JsonValue>): string | undefined {
	const webUrl = row["web_url"];
	if (!isTextValue(webUrl)) return undefined;
	const parsed = new URL(webUrl);
	return parsed.pathname.replace(/\/-\/merge_requests\/[^/]+$/, "").replace(/^\//, "");
}

function readMergeCommit(row: Record<string, JsonValue>): string {
	const value = row["mergeCommit"];
	if (isJsonObject(value) && value["oid"] !== undefined) return readTextValue(value, "oid");
	return readTextValue(row, "merge_commit_sha");
}

function readBoolean(row: Record<string, JsonValue>, key: string): boolean {
	const value = row[key];
	if (value !== true && value !== false) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	return value;
}

export function gitlabReview(
	row: Record<string, JsonValue>,
	input: ReviewRequestInput,
	principalId: string,
): ReviewRequest {
	const id = readValue(row, "iid");
	const url = readValue(row, "web_url");
	return {
		provider: "gitlab",
		principalId,
		providerId: id,
		url,
		repository: readRepository(row),
		status: gitlabStatus(readValue(row, "state"), readBoolean(row, "draft")),
		sourceBranch: readTextValue(row, "source_branch"),
		targetBranch: readTextValue(row, "target_branch"),
		baseCommit: readNestedTextValue(row, "diff_refs", "base_sha") ?? input.sandbox.baseCommit,
		headCommit: readTextValue(row, "sha"),
		diffSummary: `Review request ${id} for ${input.terms.title}.`,
		validation: input.terms.validation,
	};
}

function gitlabStatus(state: string, draft: boolean): ReviewRequest["status"] {
	if (state.toLowerCase() === "merged") return "merged";
	if (state.toLowerCase() !== "opened") return "closed";
	return draft ? "draft" : "open";
}

function readOptionalTextValue(row: Record<string, JsonValue>, key: string): string | undefined {
	const value = row[key];
	const text = isTextValue(value) ? value.trim() : "";
	return text.length === 0 ? undefined : text;
}

function readNestedTextValue(row: Record<string, JsonValue>, objectKey: string, valueKey: string): string | undefined {
	const nested = row[objectKey];
	return isJsonObject(nested) ? readOptionalTextValue(nested, valueKey) : undefined;
}

function readTextValue(row: Record<string, JsonValue>, key: string): string {
	const value = row[key];
	if (value === undefined || value !== String(value) || String(value).trim().length === 0) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	return String(value);
}
export function readValue(row: Record<string, JsonValue>, key: string): string {
	const value = row[key];
	if (value === undefined || value === null) throw new Error(`Code-host response is missing ${key}.`);
	return value === String(value) ? readStringValue(String(value), key) : readNumberValue(value, key);
}

function readStringValue(value: string, key: string): string {
	if (value.trim().length === 0) throw new Error(`Code-host response is missing ${key}.`);
	return value;
}

function readNumberValue(value: JsonValue, key: string): string {
	const number = Number(value);
	if (value !== number || !Number.isFinite(number)) throw new Error(`Code-host response is missing ${key}.`);
	return String(value);
}

function providerObservationBase(
	kind: ProviderObservation["kind"],
	providerId: string,
	summary: string,
): ProviderObservationBase {
	return {
		observationId: `${kind}:${providerId}`,
		providerId,
		summary: summary.slice(0, 2000),
		changed: true,
		observedAt: new Date().toISOString(),
	};
}
type GithubProviderDetails = NonNullable<ProviderObservation["details"]>;

type GithubCommentSource = Readonly<{
	source: "issue-comment" | "review" | "inline";
	entries: JsonValue | readonly Record<string, JsonValue>[] | undefined;
}>;

export function githubProviderDetails(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
	inlineComments: readonly Record<string, JsonValue>[],
): GithubProviderDetails {
	return {
		pullRequest: githubPullRequestDetails(row, reviewRequest),
		comments: githubProviderComments(row, inlineComments),
		checks: githubProviderChecks(row),
	};
}

function githubProviderComments(
	row: Record<string, JsonValue>,
	inlineComments: readonly Record<string, JsonValue>[],
): readonly ProviderReviewComment[] {
	const sources: readonly GithubCommentSource[] = [
		{ source: "issue-comment", entries: row["comments"] },
		{ source: "review", entries: row["reviews"] },
		{ source: "inline", entries: inlineComments },
	];
	return sources.flatMap(githubSourceComments).sort(compareProviderComments).slice(0, MAX_PROVIDER_COMMENTS);
}

function githubSourceComments(source: GithubCommentSource): readonly ProviderReviewComment[] {
	if (!Array.isArray(source.entries)) return [];
	return source.entries
		.filter(isJsonObject)
		.map((entry) => githubProviderComment(source.source, entry))
		.filter(isDefined);
}

function githubProviderComment(
	source: GithubCommentSource["source"],
	entry: Record<string, JsonValue>,
): ProviderReviewComment | undefined {
	const identity = githubCommentIdentity(entry);
	if (identity === undefined) return undefined;
	const path = isTextValue(entry["path"]) ? entry["path"] : undefined;
	const line = entry["line"] === undefined ? undefined : String(entry["line"]);
	return {
		id: boundedText(identity.id, MAX_PROVIDER_FIELD),
		author: boundedOptional(githubAuthor(entry), MAX_PROVIDER_FIELD),
		authorAssociation: boundedOptional(githubAssociation(entry), MAX_PROVIDER_FIELD),
		body: boundedText(identity.body, MAX_PROVIDER_COMMENT_BODY),
		createdAt: boundedOptional(githubTimestamp(entry), MAX_PROVIDER_FIELD),
		url: boundedOptional(githubCommentUrl(entry), MAX_PROVIDER_FIELD),
		state: boundedOptional(githubCommentState(entry), MAX_PROVIDER_FIELD),
		source,
		location: githubCommentLocation(path, line),
		minimized: entry["isMinimized"] === true,
	};
}

function githubCommentIdentity(entry: Record<string, JsonValue>): { id: string; body: string } | undefined {
	const id = entry["id"];
	if (!isProviderId(id)) return undefined;
	const body = isTextValue(entry["body"]) ? entry["body"].trim() : "";
	if (body.length === 0) return undefined;
	return { id: String(id), body };
}

function isProviderId(value: JsonValue | undefined): boolean {
	return isTextValue(value) || (value === Number(value) && Number.isFinite(Number(value)));
}

function githubCommentState(entry: Record<string, JsonValue>): string | undefined {
	return isTextValue(entry["state"]) ? entry["state"].toUpperCase() : undefined;
}

function githubCommentLocation(path: string | undefined, line: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	return boundedText(`${path}${line === undefined ? "" : `:${line}`}`, MAX_PROVIDER_FIELD);
}

function githubProviderChecks(row: Record<string, JsonValue>): readonly ProviderCheck[] {
	const entries = Array.isArray(row["statusCheckRollup"]) ? row["statusCheckRollup"].filter(isJsonObject) : [];
	return entries.map(githubProviderCheck).filter(isDefined).slice(0, MAX_PROVIDER_CHECKS);
}

function githubProviderCheck(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	const checkRun = githubCheckRun(entry);
	return checkRun ?? githubStatusContext(entry);
}

function githubCheckRun(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	const name = entry["name"];
	const status = entry["status"];
	if (!isTextValue(name) || !isTextValue(status)) return undefined;
	return {
		kind: "check-run",
		name: boundedText(name, MAX_PROVIDER_FIELD),
		status: boundedText(status, MAX_PROVIDER_FIELD),
		conclusion: boundedOptional(textField(entry, "conclusion"), MAX_PROVIDER_FIELD),
		workflowName: boundedOptional(textField(entry, "workflowName"), MAX_PROVIDER_FIELD),
		detailsUrl: boundedOptional(textField(entry, "detailsUrl"), MAX_PROVIDER_FIELD),
		startedAt: boundedOptional(textField(entry, "startedAt"), MAX_PROVIDER_FIELD),
		completedAt: boundedOptional(textField(entry, "completedAt"), MAX_PROVIDER_FIELD),
	};
}

function githubStatusContext(entry: Record<string, JsonValue>): ProviderCheck | undefined {
	const context = entry["context"];
	const state = entry["state"];
	if (!isTextValue(context) || !isTextValue(state)) return undefined;
	return {
		kind: "status-context",
		name: boundedText(context, MAX_PROVIDER_FIELD),
		status: boundedText(state, MAX_PROVIDER_FIELD),
		detailsUrl: boundedOptional(textField(entry, "targetUrl"), MAX_PROVIDER_FIELD),
	};
}

function textField(entry: Record<string, JsonValue>, key: string): string | undefined {
	return isTextValue(entry[key]) ? entry[key] : undefined;
}

function githubPullRequestDetails(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): GithubProviderDetails["pullRequest"] {
	return {
		url: boundedText(reviewRequest.url, MAX_PROVIDER_FIELD),
		status: githubPollStatus(row, reviewRequest.status),
		state: boundedText(githubState(row), MAX_PROVIDER_FIELD),
		reviewDecision: boundedText(textField(row, "reviewDecision") ?? "", MAX_PROVIDER_FIELD),
		mergedAt: githubMergedAt(row),
	};
}

function githubState(row: Record<string, JsonValue>): string {
	return textField(row, "state")?.toLowerCase() ?? "unknown";
}

function githubMergedAt(row: Record<string, JsonValue>): string | null {
	return boundedOptional(textField(row, "mergedAt"), MAX_PROVIDER_FIELD) ?? null;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

function compareProviderComments(left: ProviderReviewComment, right: ProviderReviewComment): number {
	return compareProviderDates(left.createdAt, right.createdAt);
}

function compareProviderDates(left: string | undefined, right: string | undefined): number {
	const leftValue = left ?? "";
	const rightValue = right ?? "";
	return rightValue.localeCompare(leftValue);
}

function boundedText(value: string, limit: number): string {
	return value.slice(0, limit);
}

function boundedOptional(value: string | undefined, limit: number): string | undefined {
	return value === undefined ? undefined : boundedText(value, limit);
}

function githubTimestamp(entry: Record<string, JsonValue>): string | undefined {
	for (const key of ["createdAt", "created_at", "submittedAt", "submitted_at"]) {
		if (isTextValue(entry[key])) return entry[key];
	}
	return undefined;
}

function githubCommentUrl(entry: Record<string, JsonValue>): string | undefined {
	for (const key of ["url", "html_url"]) {
		if (isTextValue(entry[key])) return entry[key];
	}
	return undefined;
}

export function githubFeedback(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
	inlineComments: readonly Record<string, JsonValue>[] = [],
): readonly ProviderObservation[] {
	const sources = [
		{ prefix: "comment", entries: row["comments"] },
		{ prefix: "review", entries: row["reviews"] },
		{ prefix: "inline", entries: inlineComments },
	];
	const entries = sources.flatMap(({ prefix, entries: sourceEntries }) =>
		Array.isArray(sourceEntries) ? sourceEntries.filter(isJsonObject).map((entry) => ({ prefix, entry })) : [],
	);
	entries.sort((left, right) => compareProviderDates(githubTimestamp(left.entry), githubTimestamp(right.entry)));
	return entries
		.flatMap(({ prefix, entry }) => githubFeedbackEntry(prefix, entry, reviewRequest))
		.slice(0, MAX_PROVIDER_COMMENTS);
}
type GithubFeedback = Readonly<{
	body: string;
	id: string;
	state: string;
	author: string | undefined;
	authorAssociation: string | undefined;
}>;

function githubFeedbackEntry(
	prefix: string,
	entry: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): readonly ProviderObservation[] {
	const feedback = readGithubFeedback(prefix, entry);
	if (feedback === undefined) return [];
	return [createGithubFeedbackObservation(prefix, feedback, entry, reviewRequest)];
}

function readGithubFeedback(prefix: string, entry: Record<string, JsonValue>): GithubFeedback | undefined {
	const body = readFeedbackBody(entry);
	if (body === undefined) return undefined;
	const id = readFeedbackId(entry);
	if (id === undefined) return undefined;
	const state = readFeedbackState(entry);
	if (isIgnoredGithubReview(prefix, state)) return undefined;
	return { body, id, state, author: githubAuthor(entry), authorAssociation: githubAssociation(entry) };
}

function readFeedbackBody(entry: Record<string, JsonValue>): string | undefined {
	const body = textField(entry, "body")?.trim();
	return body === undefined || body.length === 0 ? undefined : body;
}

function readFeedbackId(entry: Record<string, JsonValue>): string | undefined {
	const id = entry["id"];
	return isProviderId(id) ? String(id) : undefined;
}

function readFeedbackState(entry: Record<string, JsonValue>): string {
	return githubCommentState(entry) ?? "";
}

function isIgnoredGithubReview(prefix: string, state: string): boolean {
	return prefix === "review" && ["APPROVED", "DISMISSED"].includes(state);
}

function createGithubFeedbackObservation(
	prefix: string,
	feedback: GithubFeedback,
	entry: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): ProviderReviewCommentObservation {
	const location = githubFeedbackLocation(entry);
	const headCommit = githubCommentCommit(entry) ?? reviewRequest.headCommit;
	const output = `${feedback.body}${location}`.slice(0, 2_000);
	const version = createHash("sha256")
		.update(`${feedback.body}\u0000${headCommit}\u0000${feedback.state}`)
		.digest("hex")
		.slice(0, 16);
	return {
		...providerObservationBase("review-comment", reviewRequest.providerId, output),
		observationId: githubFeedbackId(prefix, reviewRequest.providerId, feedback.id, version),
		kind: "review-comment",
		status: githubFeedbackStatus(feedback.state),
		feedback: [output],
		repository: reviewRequest.repository,
		sourceBranch: reviewRequest.sourceBranch,
		targetBranch: reviewRequest.targetBranch,
		headCommit,
		author: feedback.author,
		authorAssociation: feedback.authorAssociation,
		reviewState: feedback.state || undefined,
		actionable: githubFeedbackIsActionable(prefix, feedback.state, feedback.authorAssociation),
	};
}

function githubFeedbackLocation(entry: Record<string, JsonValue>): string {
	const path = textField(entry, "path");
	if (path === undefined) return "";
	const line = entry["line"] === undefined ? undefined : String(entry["line"]);
	return ` (${path}${line === undefined ? "" : `:${line}`})`;
}

function githubFeedbackStatus(state: string): ProviderReviewCommentStatus {
	return state === "CHANGES_REQUESTED" ? "changes-requested" : "commented";
}

function githubFeedbackId(prefix: string, providerId: string, commentId: string, version: string): string {
	return prefix === "comment"
		? `review-comment:${providerId}:${commentId}:${version}`
		: `review-comment:${providerId}:${prefix}:${commentId}:${version}`;
}
function githubPollStatus(row: Record<string, JsonValue>, current: ReviewRequest["status"]): ReviewRequest["status"] {
	if (isTextValue(row["mergedAt"])) return "merged";
	return githubOpenStatus(row, current);
}

function githubOpenStatus(row: Record<string, JsonValue>, current: ReviewRequest["status"]): ReviewRequest["status"] {
	const state = githubStateValue(row);
	if (state === "CLOSED") return "closed";
	if (row["isDraft"] === true) return "draft";
	if (row["isDraft"] === false) return "open";
	return githubDefaultStatus(current);
}

function githubStateValue(row: Record<string, JsonValue>): string {
	return textField(row, "state")?.toUpperCase() ?? "";
}

function githubDefaultStatus(current: ReviewRequest["status"]): ReviewRequest["status"] {
	return current === "draft" ? "draft" : "open";
}

function githubCheckStatus(
	reviewStatus: ReviewRequest["status"],
	details: NonNullable<ProviderObservation["details"]>,
): ProviderCiStatus {
	if (reviewStatus === "merged" || reviewStatus === "closed") return reviewStatus;
	return details.checks.some(providerCheckFailed) ? "checks-failed" : reviewStatus;
}

function providerCheckFailed(check: ProviderCheck): boolean {
	const value = `${check.status} ${check.conclusion ?? ""}`.toLowerCase();
	return ["failure", "failed", "error", "cancelled", "timed_out", "action_required"].some((term) =>
		value.includes(term),
	);
}

function githubCommentCommit(entry: Record<string, JsonValue>): string | undefined {
	return readOptionalTextValue(entry, "commit_id") ?? readOptionalTextValue(entry, "commitId");
}

function githubAuthor(entry: Record<string, JsonValue>): string | undefined {
	for (const key of ["author", "user"]) {
		const value = entry[key];
		if (isJsonObject(value) && isTextValue(value["login"])) return value["login"];
	}
	return undefined;
}

function githubAssociation(entry: Record<string, JsonValue>): string | undefined {
	const value = entry["authorAssociation"] ?? entry["author_association"];
	return isTextValue(value) ? value.toUpperCase() : undefined;
}
function githubFeedbackIsActionable(prefix: string, state: string, association: string | undefined): boolean {
	if (!["COLLABORATOR", "MEMBER", "OWNER"].includes(association ?? "")) return false;
	return prefix !== "review" || ["CHANGES_REQUESTED", "COMMENTED"].includes(state);
}

export function parseJsonPages(value: string): readonly Record<string, JsonValue>[] {
	const parsed: JsonValue = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("Code-host response was not a JSON page list.");
	const entries: JsonValue[] = [];
	for (const page of parsed) {
		if (Array.isArray(page)) entries.push(...page);
		else entries.push(page);
	}
	return entries.filter(isJsonObject);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}
