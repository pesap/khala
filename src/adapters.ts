import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Execution, JsonValue, Mission, ProviderCheck, ProviderObservation, ReviewRequest } from "./model.js";
import type { CodeHostPort, ReviewRequestInput, WorkspacePort, WorkspacePreflight } from "./ports.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;

function commandOptions(cwd: string) {
	return { cwd, timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" as const, maxBuffer: 1_000_000 };
}

export class GitWorkspace implements WorkspacePort {
	private readonly worktreeRoot: string;
	private readonly branchPrefix: string;
	private projectPath: string | undefined;

	constructor(worktreeRoot: string, branchPrefix: string, projectPath?: string) {
		this.worktreeRoot = worktreeRoot;
		this.branchPrefix = branchPrefix;
		this.projectPath = projectPath;
	}

	async preflight(projectPath: string, targetBranch: string): Promise<WorkspacePreflight> {
		this.projectPath = projectPath;
		const origin = await git(projectPath, ["remote", "get-url", "origin"]);
		await git(projectPath, ["rev-parse", "--verify", targetBranch]);
		const headCommit = await git(projectPath, ["rev-parse", targetBranch]);
		return { projectPath, origin, targetBranch, headCommit };
	}

	async ensureSandbox(
		input: Readonly<{
			workId: string;
			executionId: string;
			mission: Mission;
			projectPath: string;
			baseCommit: string;
		}>,
	): Promise<Execution["sandbox"]> {
		const workKey = createHash("sha256").update(input.workId).digest("hex").slice(0, 24);
		const branch = `${this.branchPrefix}${workKey}/${input.executionId.slice(0, 8)}`;
		const path = join(this.worktreeRoot, workKey, input.executionId);
		await mkdir(dirname(path), { recursive: true });
		const exists = await stat(path)
			.then(() => true)
			.catch(() => false);
		if (!exists) {
			await execFileAsync(
				"git",
				["worktree", "add", "-b", branch, path, input.baseCommit],
				commandOptions(input.projectPath),
			);
		} else {
			const existingBranch = await git(path, ["branch", "--show-current"]);
			if (existingBranch !== branch) {
				throw new Error(`Sandbox ${path} is attached to branch ${existingBranch}, not ${branch}.`);
			}
			const existingHead = await git(path, ["rev-parse", "HEAD"]);
			if (existingHead !== input.baseCommit) {
				throw new Error(`Sandbox ${path} has unexpected base ${existingHead}.`);
			}
		}
		return { path, baseCommit: input.baseCommit, branch };
	}

	async inspectHead(path: string): Promise<string> {
		return git(path, ["rev-parse", "HEAD"]);
	}

	async publishSandbox(sandbox: Execution["sandbox"]): Promise<string> {
		await git(sandbox.path, ["push", "--set-upstream", "origin", sandbox.branch]);
		return this.inspectHead(sandbox.path);
	}

	// oxlint-disable-next-line complexity
	async removeSandbox(sandbox: Execution["sandbox"]): Promise<void> {
		if (this.projectPath === undefined) {
			throw new Error("Workspace project path is not initialized.");
		}
		const exists = await stat(sandbox.path)
			.then(() => true)
			.catch(() => false);
		if (exists) {
			await execFileAsync("git", ["worktree", "remove", "--force", sandbox.path], commandOptions(this.projectPath));
		}
		try {
			await git(this.projectPath, ["branch", "-D", sandbox.branch]);
		} catch (error) {
			if (!(error instanceof Error) || !/branch .* not found/i.test(error.message)) throw error;
		}
	}
}

export class CommandCodeHost implements CodeHostPort {
	readonly provider: "github" | "gitlab";
	private readonly cwd: string;
	private repositoryName: string | undefined;

	constructor(provider: "github" | "gitlab", cwd: string) {
		this.provider = provider;
		this.cwd = cwd;
	}

	async capabilities(): Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>> {
		return { supportsDraft: true, supportsMergeObservation: true };
	}

	async identity(): Promise<Readonly<{ principalId: string; verified: boolean }>> {
		const command = this.provider === "github" ? "gh" : "glab";
		const args = this.provider === "github" ? ["api", "user", "--jq", ".login"] : ["api", "user", "--jq", ".id"];
		const principalId = (await run(command, args, this.cwd)).trim();
		return { principalId, verified: principalId.length > 0 };
	}

	// oxlint-disable-next-line complexity
	async ensureReviewRequest(input: ReviewRequestInput): Promise<ReviewRequest> {
		const title = `Khala: ${input.terms.title}`;
		const generatedBody = [
			input.draftMarker,
			`Mission: ${input.mission.missionId}`,
			`Execution: ${input.execution.executionId}`,
			"",
			input.terms.objective,
			"",
			"Acceptance criteria:",
			...input.terms.acceptanceCriteria.map((criterion) => `- ${criterion}`),
			"",
			"Validation:",
			...input.terms.validation.map((command) => `- ${command}`),
		].join("\n");
		const template = await readPullRequestTemplate(this.cwd);
		const body = template === undefined ? generatedBody : `${template.trim()}\n\n${generatedBody}`;
		const principal = await this.identity();
		if (!principal.verified) {
			throw new Error("The authenticated code-host identity is not verified.");
		}
		if (this.provider === "github") {
			const repository = await this.repository();
			const existing = await run(
				"gh",
				[
					"pr",
					"list",
					"--state",
					"all",
					"--search",
					input.draftMarker,
					"--json",
					"number,url,state,isDraft,headRefName,baseRefName,headRefOid",
				],
				this.cwd,
			);
			const rows = parseJsonArray(existing);
			const first = rows.find(
				(row) => row["headRefName"] === input.sandbox.branch && row["baseRefName"] === input.targetBranch,
			);
			if (first !== undefined) {
				const request = githubReview(first, input, principal.principalId, repository);
				return { ...request, diffSummary: await this.readDiff(request.providerId) };
			}
			const url = (
				await run(
					"gh",
					[
						"pr",
						"create",
						"--draft",
						"--title",
						title,
						"--body",
						body,
						"--base",
						input.targetBranch,
						"--head",
						input.sandbox.branch,
					],
					this.cwd,
				)
			).trim();
			const created = await run(
				"gh",
				["pr", "view", url, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid"],
				this.cwd,
			);
			const createdRow = parseJsonArray(`[${created}]`)[0];
			if (createdRow === undefined) {
				throw new Error("GitHub did not return review request metadata.");
			}
			const request = githubReview(createdRow, input, principal.principalId, repository);
			return { ...request, diffSummary: await this.readDiff(request.providerId) };
		}
		const existing = await run(
			"glab",
			["mr", "list", "--all", "--search", input.draftMarker, "--output", "json"],
			this.cwd,
		);
		const rows = parseJsonArray(existing);
		const first = rows.find(
			(row) => row["source_branch"] === input.sandbox.branch && row["target_branch"] === input.targetBranch,
		);
		if (first !== undefined) {
			const request = gitlabReview(first, input, principal.principalId);
			return { ...request, diffSummary: await this.readDiff(request.providerId) };
		}
		const created = await run(
			"glab",
			[
				"mr",
				"create",
				"--draft",
				"--title",
				title,
				"--description",
				body,
				"--source-branch",
				input.sandbox.branch,
				"--target-branch",
				input.targetBranch,
			],
			this.cwd,
		);
		const url = created.trim().split(/\s+/).at(-1);
		if (url === undefined || url.length === 0) {
			throw new Error("GitLab did not return a review request URL.");
		}
		const viewed = await run("glab", ["mr", "view", url, "--output", "json"], this.cwd);
		const createdRow = parseJsonArray(`[${viewed}]`)[0];
		if (createdRow === undefined) {
			throw new Error("GitLab did not return merge request metadata.");
		}
		const request = gitlabReview(createdRow, input, principal.principalId);
		return { ...request, diffSummary: await this.readDiff(request.providerId) };
	}

	private async repository(): Promise<string> {
		if (this.repositoryName !== undefined) return this.repositoryName;
		const repository = (
			await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], this.cwd)
		).trim();
		if (repository.length === 0) throw new Error("GitHub did not return repository identity.");
		this.repositoryName = repository;
		return repository;
	}

	private async readDiff(providerId: string): Promise<string> {
		const command = this.provider === "github" ? "gh" : "glab";
		const args = this.provider === "github" ? ["pr", "diff", providerId] : ["mr", "diff", providerId];
		return (await run(command, args, this.cwd)).slice(0, 16_000);
	}

	async poll(reviewRequest: ReviewRequest): Promise<readonly ProviderObservation[]> {
		if (this.provider === "github") {
			const data = await run(
				"gh",
				[
					"pr",
					"view",
					reviewRequest.providerId,
					"--json",
					"state,isDraft,mergedAt,reviewDecision,statusCheckRollup,comments,reviews",
				],
				this.cwd,
			);
			const row = parseJsonArray(`[${data}]`)[0];
			if (row === undefined) throw new Error("GitHub did not return review request polling data.");
			const repository = await this.repository();
			const inlineData = await run(
				"gh",
				["api", `repos/${repository}/pulls/${reviewRequest.providerId}/comments`, "--paginate", "--slurp"],
				this.cwd,
			);
			const inlineComments = parseJsonPages(inlineData);
			const details = githubProviderDetails(row, reviewRequest, inlineComments);
			return [
				{
					...observation("ci-status", reviewRequest.providerId, data),
					status: githubPollStatus(row, reviewRequest.status),
					details,
				},
				...githubFeedback(row, reviewRequest.providerId, reviewRequest.principalId, inlineComments, details),
			];
		}
		const data = await run("glab", ["mr", "view", reviewRequest.providerId, "--output", "json"], this.cwd);
		const row = parseJsonArray(`[${data}]`)[0];
		if (row === undefined) throw new Error("GitLab did not return review request polling data.");
		return [
			{
				...observation("ci-status", reviewRequest.providerId, data),
				status: gitlabStatus(readValue(row, "state"), readBoolean(row, "draft")),
			},
		];
	}

	// oxlint-disable-next-line complexity
	async inspectOutcome(reviewRequest: ReviewRequest): Promise<ProviderObservation | undefined> {
		if (this.provider === "github") {
			const data = await run(
				"gh",
				[
					"pr",
					"view",
					reviewRequest.providerId,
					"--json",
					"state,mergedAt,mergeCommit,headRefName,baseRefName,headRefOid",
				],
				this.cwd,
			);
			const row = parseJsonArray(`[${data}]`)[0];
			if (row === undefined || readValue(row, "state").toLowerCase() !== "merged" || row["mergedAt"] === null) return;
			return observation("provider-outcome", reviewRequest.providerId, JSON.stringify(row), "merged", {
				repository: reviewRequest.repository,
				sourceBranch: readTextValue(row, "headRefName"),
				targetBranch: readTextValue(row, "baseRefName"),
				headCommit: readTextValue(row, "headRefOid"),
				mergeCommit: readMergeCommit(row),
			});
		}
		const data = await run("glab", ["mr", "view", reviewRequest.providerId, "--output", "json"], this.cwd);
		const row = parseJsonArray(`[${data}]`)[0];
		if (row === undefined || readValue(row, "state").toLowerCase() !== "merged") return;
		return observation("provider-outcome", reviewRequest.providerId, JSON.stringify(row), "merged", {
			repository: readRepository(row),
			sourceBranch: readTextValue(row, "source_branch"),
			targetBranch: readTextValue(row, "target_branch"),
			headCommit: readTextValue(row, "sha"),
			mergeCommit: readTextValue(row, "merge_commit_sha"),
		});
	}
}

export function codeHostForOrigin(origin: string, cwd: string): CommandCodeHost {
	const host = originHost(origin);
	if (host === "github.com") {
		return new CommandCodeHost("github", cwd);
	}
	if (host === "gitlab.com") {
		return new CommandCodeHost("gitlab", cwd);
	}
	throw new Error("The repository origin must be hosted on GitHub or GitLab.");
}

function originHost(origin: string): string {
	const normalized = origin.trim().toLowerCase();
	const scp = normalized.match(/^[^@]+@([^:]+):/);
	if (scp?.[1] !== undefined) {
		return scp[1];
	}
	try {
		return new URL(normalized).hostname;
	} catch {
		return "";
	}
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	return (await execFileAsync("git", [...args], commandOptions(cwd))).stdout.trim();
}

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
	try {
		return (await execFileAsync(command, [...args], commandOptions(cwd))).stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${command} failed: ${message}`);
	}
}

function parseJsonArray(value: string): readonly Record<string, JsonValue>[] {
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

function githubReview(
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

// oxlint-disable-next-line complexity
function readRepository(row: Record<string, JsonValue>): string {
	const value = row["repository"];
	if (isJsonObject(value) && value["nameWithOwner"] !== undefined) return readTextValue(value, "nameWithOwner");
	const references = row["references"];
	if (isJsonObject(references) && references["full"] !== undefined)
		return readTextValue(references, "full").replace(/![^!]+$/, "");
	if (references !== undefined && references === String(references)) return String(references).replace(/![^!]+$/, "");
	const webUrl = row["web_url"];
	if (webUrl !== undefined && webUrl === String(webUrl)) {
		const parsed = new URL(String(webUrl));
		return parsed.pathname.replace(/\/-\/merge_requests\/[^/]+$/, "").replace(/^\//, "");
	}
	throw new Error("Code-host response is missing repository identity.");
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

function gitlabReview(row: Record<string, JsonValue>, input: ReviewRequestInput, principalId: string): ReviewRequest {
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

function readTextValue(row: Record<string, JsonValue>, key: string): string {
	const value = row[key];
	if (value === undefined || value !== String(value) || String(value).trim().length === 0) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	return String(value);
}

// oxlint-disable-next-line complexity
function readValue(row: Record<string, JsonValue>, key: string): string {
	const value = row[key];
	if (value === undefined || value === null) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	if (value === String(value)) {
		if (String(value).trim().length === 0) throw new Error(`Code-host response is missing ${key}.`);
		return String(value);
	}
	const number = Number(value);
	if (value !== number || !Number.isFinite(number)) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	return String(value);
}

function observation(
	kind: ProviderObservation["kind"],
	providerId: string,
	summary: string,
	status = "observed",
	evidence: Readonly<Partial<ProviderObservation>> = {},
): ProviderObservation {
	return {
		observationId: `${kind}:${providerId}`,
		kind,
		providerId,
		status,
		summary: summary.slice(0, 2000),
		changed: true,
		observedAt: new Date().toISOString(),
		...evidence,
	};
}

// oxlint-disable-next-line complexity
function githubProviderDetails(
	row: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
	inlineComments: readonly Record<string, JsonValue>[],
): NonNullable<ProviderObservation["details"]> {
	const sources = [
		{ source: "issue-comment" as const, entries: row["comments"] },
		{ source: "review" as const, entries: row["reviews"] },
		{ source: "inline" as const, entries: inlineComments },
	];
	const comments = sources.flatMap(({ source, entries }) => {
		if (!Array.isArray(entries)) return [];
		// oxlint-disable-next-line complexity
		return entries.filter(isJsonObject).flatMap((entry) => {
			const id = entry["id"];
			const body = isTextValue(entry["body"]) ? entry["body"].trim() : "";
			if ((id !== String(id) && id !== Number(id)) || body.length === 0) return [];
			const path = isTextValue(entry["path"]) ? entry["path"] : undefined;
			const line = entry["line"] === undefined ? undefined : String(entry["line"]);
			return [
				{
					id: String(id),
					author: githubAuthor(entry),
					authorAssociation: githubAssociation(entry),
					body,
					createdAt: githubTimestamp(entry),
					url: githubCommentUrl(entry),
					state: isTextValue(entry["state"]) ? entry["state"].toUpperCase() : undefined,
					source,
					location: path === undefined ? undefined : `${path}${line === undefined ? "" : `:${line}`}`,
					minimized: entry["isMinimized"] === true,
				},
			];
		});
	});
	const checks: ProviderCheck[] = (Array.isArray(row["statusCheckRollup"]) ? row["statusCheckRollup"] : [])
		.filter(isJsonObject)
		// oxlint-disable-next-line complexity
		.flatMap((entry): readonly ProviderCheck[] => {
			const checkRunName = entry["name"];
			const checkRunStatus = entry["status"];
			if (isTextValue(checkRunName) && isTextValue(checkRunStatus)) {
				return [
					{
						kind: "check-run" as const,
						name: checkRunName,
						status: checkRunStatus,
						conclusion: isTextValue(entry["conclusion"]) ? entry["conclusion"] : undefined,
						workflowName: isTextValue(entry["workflowName"]) ? entry["workflowName"] : undefined,
						detailsUrl: isTextValue(entry["detailsUrl"]) ? entry["detailsUrl"] : undefined,
						startedAt: isTextValue(entry["startedAt"]) ? entry["startedAt"] : undefined,
						completedAt: isTextValue(entry["completedAt"]) ? entry["completedAt"] : undefined,
					},
				];
			}
			const context = entry["context"];
			const state = entry["state"];
			if (!isTextValue(context) || !isTextValue(state)) return [];
			return [
				{
					kind: "status-context" as const,
					name: context,
					status: state,
					detailsUrl: isTextValue(entry["targetUrl"]) ? entry["targetUrl"] : undefined,
				},
			];
		});
	return {
		pullRequest: {
			url: reviewRequest.url,
			status: githubPollStatus(row, reviewRequest.status),
			state: isTextValue(row["state"]) ? row["state"].toLowerCase() : "unknown",
			reviewDecision: isTextValue(row["reviewDecision"]) ? row["reviewDecision"] : "",
			mergedAt: row["mergedAt"] === null ? null : isTextValue(row["mergedAt"]) ? row["mergedAt"] : null,
		},
		comments,
		checks,
	};
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

function githubFeedback(
	row: Record<string, JsonValue>,
	providerId: string,
	principalId: string,
	inlineComments: readonly Record<string, JsonValue>[] = [],
	details?: NonNullable<ProviderObservation["details"]>,
): readonly ProviderObservation[] {
	const sources = [
		{ prefix: "comment", entries: row["comments"] },
		{ prefix: "review", entries: row["reviews"] },
		{ prefix: "inline", entries: inlineComments },
	];
	return sources.flatMap(({ prefix, entries }) => {
		if (!Array.isArray(entries)) return [];
		// oxlint-disable-next-line complexity
		return entries.filter(isJsonObject).flatMap((entry) => {
			const body = entry["body"];
			const id = entry["id"];
			const state = isTextValue(entry["state"]) ? entry["state"].toUpperCase() : "";
			const author = githubAuthor(entry);
			const authorAssociation = githubAssociation(entry);
			const actionable = githubFeedbackIsActionable(prefix, state, authorAssociation, author, principalId);
			if (
				!isTextValue(body) ||
				body.trim().length === 0 ||
				(id !== String(id) && id !== Number(id)) ||
				(prefix === "review" && ["APPROVED", "DISMISSED"].includes(state))
			)
				return [];
			const commentId = String(id);
			const path = isTextValue(entry["path"]) ? entry["path"] : undefined;
			const line = entry["line"] === undefined ? undefined : String(entry["line"]);
			const location = path === undefined ? "" : ` (${path}${line === undefined ? "" : `:${line}`})`;
			const feedback = `${body.trim()}${location}`.slice(0, 2_000);
			const observationId =
				prefix === "comment"
					? `review-comment:${providerId}:${commentId}`
					: `review-comment:${providerId}:${prefix}:${commentId}`;
			return [
				observation(
					"review-comment",
					providerId,
					feedback,
					state === "CHANGES_REQUESTED" ? "changes-requested" : "commented",
					{
						observationId,
						feedback: [feedback],
						author,
						authorAssociation,
						reviewState: state || undefined,
						actionable,
						details,
					},
				),
			];
		});
	});
}

// oxlint-disable-next-line complexity
function githubPollStatus(row: Record<string, JsonValue>, current: ReviewRequest["status"]): ReviewRequest["status"] {
	if (isTextValue(row["mergedAt"])) return "merged";
	const state = isTextValue(row["state"]) ? row["state"].toUpperCase() : "";
	if (state === "CLOSED") return "closed";
	if (row["isDraft"] === true) return "draft";
	if (row["isDraft"] === false) return "open";
	return current === "draft" ? "draft" : "open";
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

// oxlint-disable-next-line complexity
function githubFeedbackIsActionable(
	prefix: string,
	state: string,
	association: string | undefined,
	author: string | undefined,
	principalId: string,
): boolean {
	if (author !== principalId) return false;
	if (!["COLLABORATOR", "CONTRIBUTOR", "MEMBER", "OWNER"].includes(association ?? "")) return false;
	return prefix !== "review" || ["CHANGES_REQUESTED", "COMMENTED"].includes(state);
}

function parseJsonPages(value: string): readonly Record<string, JsonValue>[] {
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

// oxlint-disable-next-line complexity
export async function readPullRequestTemplate(projectPath: string): Promise<string | undefined> {
	const paths = [
		"pull_request_template.md",
		"docs/pull_request_template.md",
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
	];
	for (const relativePath of paths) {
		const content = await readFile(join(projectPath, relativePath), "utf8").catch(() => "");
		if (content.trim().length > 0) {
			return content;
		}
	}
	const templateDirectory = join(projectPath, ".github", "PULL_REQUEST_TEMPLATE");
	const entries = await readdir(templateDirectory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries
		.filter((candidate) => candidate.isFile())
		.sort((left, right) => left.name.localeCompare(right.name))) {
		const content = await readFile(join(templateDirectory, entry.name), "utf8").catch(() => "");
		if (content.trim().length > 0) {
			return content;
		}
	}
	return undefined;
}
