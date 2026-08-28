import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type {
	Execution,
	JsonValue,
	Mission,
	ProviderCheck,
	ProviderObservation,
	ProviderReviewComment,
	ReviewRequest,
	ValidationResult,
} from "./model.js";
import type { CodeHostPort, ReviewRequestInput, WorkspacePort, WorkspacePreflight } from "./ports.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_BUFFER = 8_000_000;
const SENSITIVE_ENVIRONMENT_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i;
const MAX_PROVIDER_COMMENTS = 8;
const MAX_PROVIDER_CHECKS = 8;
const MAX_PROVIDER_COMMENT_BODY = 500;
const MAX_PROVIDER_FIELD = 200;

type CommandOptions = {
	cwd: string;
	timeout: number;
	killSignal: "SIGKILL";
	maxBuffer: number;
	env?: NodeJS.ProcessEnv;
};

function commandOptions(cwd: string, environment?: NodeJS.ProcessEnv) {
	const options: CommandOptions = {
		cwd,
		timeout: COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: MAX_COMMAND_BUFFER,
	};
	if (environment !== undefined) options.env = environment;
	return options;
}

function validationEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
	}
	return environment;
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
		await git(projectPath, ["fetch", "--no-tags", "origin", targetBranch]);
		const headCommit = await git(projectPath, ["rev-parse", `refs/remotes/origin/${targetBranch}`]);
		return { projectPath, origin, targetBranch, headCommit };
	}

	// oxlint-disable-next-line complexity
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
		const path = resolve(this.worktreeRoot, workKey, input.executionId);
		if (!isContainedPath(this.worktreeRoot, path)) throw new Error(`Sandbox ${path} is outside the worktree root.`);
		await mkdir(dirname(path), { recursive: true });
		if (!(await isRealContainedPath(this.worktreeRoot, dirname(path))))
			throw new Error(`Sandbox parent ${dirname(path)} is outside the worktree root.`);
		const existing = await lstat(path).catch(() => undefined);
		if (existing === undefined) {
			await execFileAsync(
				"git",
				["worktree", "add", "-b", branch, path, input.baseCommit],
				commandOptions(input.projectPath, sanitizedEnvironment()),
			);
		} else {
			if (existing.isSymbolicLink() || !existing.isDirectory())
				throw new Error(`Sandbox ${path} is not a directory owned by Khala.`);
			if (!(await isRealContainedPath(this.worktreeRoot, path)))
				throw new Error(`Sandbox ${path} is outside the worktree root.`);
			if (!(await isRegisteredWorktree(input.projectPath, path)))
				throw new Error(`Sandbox ${path} is not registered by the project repository.`);
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

	async inspectChanges(input: Readonly<{ path: string; baseCommit: string }>): Promise<readonly string[]> {
		const committed = await git(input.path, ["diff", "--name-only", `${input.baseCommit}...HEAD`]);
		const working = await git(input.path, ["diff", "--name-only", input.baseCommit]);
		const untracked = await git(input.path, ["ls-files", "--others", "--exclude-standard"]);
		return [
			...new Set(
				[committed, working, untracked].flatMap((value) =>
					value
						.split("\n")
						.map((path) => path.trim())
						.filter(Boolean),
				),
			),
		];
	}

	async commitSandbox(input: {
		sandbox: Execution["sandbox"];
		allowedPaths: readonly string[];
		message: string;
	}): Promise<string> {
		if (input.allowedPaths.length === 0)
			throw new Error("At least one permitted path is required to commit a sandbox.");
		await git(input.sandbox.path, ["add", "--all", "--", ...input.allowedPaths]);
		await git(input.sandbox.path, ["commit", "-m", input.message]);
		return this.inspectHead(input.sandbox.path);
	}

	async runValidation(input: { path: string; commands: readonly string[] }): Promise<readonly ValidationResult[]> {
		const results: ValidationResult[] = [];
		const environment = validationEnvironment();
		for (const command of input.commands) {
			try {
				const result = await execFileAsync(
					validationShell(),
					validationShellArguments(command),
					commandOptions(input.path, environment),
				);
				results.push({ command, passed: true, output: result.stdout.slice(-4_000) });
			} catch (error) {
				results.push({
					command,
					passed: false,
					output: error instanceof Error ? error.message.slice(-4_000) : String(error),
				});
			}
		}
		return results;
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
		if (!isContainedPath(this.worktreeRoot, sandbox.path))
			throw new Error(`Sandbox ${sandbox.path} is outside the worktree root.`);
		const existing = await lstat(sandbox.path).catch(() => undefined);
		if (existing !== undefined) {
			if (existing.isSymbolicLink() || !existing.isDirectory())
				throw new Error(`Sandbox ${sandbox.path} is not a directory owned by Khala.`);
			if (!(await isRealContainedPath(this.worktreeRoot, sandbox.path)))
				throw new Error(`Sandbox ${sandbox.path} is outside the worktree root.`);
			if (!(await isRegisteredWorktree(this.projectPath, sandbox.path)))
				throw new Error(`Sandbox ${sandbox.path} is not registered by the project repository.`);
			await execFileAsync(
				"git",
				["worktree", "remove", "--force", sandbox.path],
				commandOptions(this.projectPath, sanitizedEnvironment()),
			);
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
				...githubFeedback(row, reviewRequest, inlineComments),
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
			mergeCommit: readOptionalTextValue(row, "merge_commit_sha") ?? readTextValue(row, "sha"),
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

function validationShell(): string {
	return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "sh";
}

function validationShellArguments(command: string): readonly string[] {
	return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	return (await execFileAsync("git", [...args], commandOptions(cwd, sanitizedEnvironment()))).stdout.trim();
}

async function isRegisteredWorktree(projectPath: string, sandboxPath: string): Promise<boolean> {
	const listing = await git(projectPath, ["worktree", "list", "--porcelain"]);
	const expected = `worktree ${resolve(sandboxPath)}`;
	return listing.split("\n").some((line) => line.trim() === expected);
}

function isContainedPath(root: string, candidate: string): boolean {
	const rootRelative = relative(resolve(root), resolve(candidate));
	return rootRelative.length === 0 || (!rootRelative.startsWith("..") && !isAbsolute(rootRelative));
}

async function isRealContainedPath(root: string, candidate: string): Promise<boolean> {
	const [resolvedRoot, resolvedCandidate] = await Promise.all([
		realpath(root).catch(() => undefined),
		realpath(candidate).catch(() => undefined),
	]);
	return (
		resolvedRoot !== undefined && resolvedCandidate !== undefined && isContainedPath(resolvedRoot, resolvedCandidate)
	);
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
	}
	return environment;
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

function readOptionalTextValue(row: Record<string, JsonValue>, key: string): string | undefined {
	const value = row[key];
	const text = isTextValue(value) ? value.trim() : "";
	return text.length === 0 ? undefined : text;
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
	const comments = sources
		.flatMap(({ source, entries }) => {
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
						id: boundedText(String(id), MAX_PROVIDER_FIELD),
						author: boundedOptional(githubAuthor(entry), MAX_PROVIDER_FIELD),
						authorAssociation: boundedOptional(githubAssociation(entry), MAX_PROVIDER_FIELD),
						body: boundedText(body, MAX_PROVIDER_COMMENT_BODY),
						createdAt: boundedOptional(githubTimestamp(entry), MAX_PROVIDER_FIELD),
						url: boundedOptional(githubCommentUrl(entry), MAX_PROVIDER_FIELD),
						state: boundedOptional(
							isTextValue(entry["state"]) ? entry["state"].toUpperCase() : undefined,
							MAX_PROVIDER_FIELD,
						),
						source,
						location:
							path === undefined
								? undefined
								: boundedText(`${path}${line === undefined ? "" : `:${line}`}`, MAX_PROVIDER_FIELD),
						minimized: entry["isMinimized"] === true,
					},
				];
			});
		})
		.sort(compareProviderComments)
		.slice(0, MAX_PROVIDER_COMMENTS);
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
						name: boundedText(checkRunName, MAX_PROVIDER_FIELD),
						status: boundedText(checkRunStatus, MAX_PROVIDER_FIELD),
						conclusion: boundedOptional(
							isTextValue(entry["conclusion"]) ? entry["conclusion"] : undefined,
							MAX_PROVIDER_FIELD,
						),
						workflowName: boundedOptional(
							isTextValue(entry["workflowName"]) ? entry["workflowName"] : undefined,
							MAX_PROVIDER_FIELD,
						),
						detailsUrl: boundedOptional(
							isTextValue(entry["detailsUrl"]) ? entry["detailsUrl"] : undefined,
							MAX_PROVIDER_FIELD,
						),
						startedAt: boundedOptional(
							isTextValue(entry["startedAt"]) ? entry["startedAt"] : undefined,
							MAX_PROVIDER_FIELD,
						),
						completedAt: boundedOptional(
							isTextValue(entry["completedAt"]) ? entry["completedAt"] : undefined,
							MAX_PROVIDER_FIELD,
						),
					},
				];
			}
			const context = entry["context"];
			const state = entry["state"];
			if (!isTextValue(context) || !isTextValue(state)) return [];
			return [
				{
					kind: "status-context" as const,
					name: boundedText(context, MAX_PROVIDER_FIELD),
					status: boundedText(state, MAX_PROVIDER_FIELD),
					detailsUrl: boundedOptional(
						isTextValue(entry["targetUrl"]) ? entry["targetUrl"] : undefined,
						MAX_PROVIDER_FIELD,
					),
				},
			];
		})
		.slice(0, MAX_PROVIDER_CHECKS);
	return {
		pullRequest: {
			url: boundedText(reviewRequest.url, MAX_PROVIDER_FIELD),
			status: githubPollStatus(row, reviewRequest.status),
			state: boundedText(isTextValue(row["state"]) ? row["state"].toLowerCase() : "unknown", MAX_PROVIDER_FIELD),
			reviewDecision: boundedText(isTextValue(row["reviewDecision"]) ? row["reviewDecision"] : "", MAX_PROVIDER_FIELD),
			mergedAt:
				row["mergedAt"] === null
					? null
					: (boundedOptional(isTextValue(row["mergedAt"]) ? row["mergedAt"] : undefined, MAX_PROVIDER_FIELD) ?? null),
		},
		comments,
		checks,
	};
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

function githubFeedback(
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

// oxlint-disable-next-line complexity
function githubFeedbackEntry(
	prefix: string,
	entry: Record<string, JsonValue>,
	reviewRequest: ReviewRequest,
): readonly ProviderObservation[] {
	const body = entry["body"];
	const id = entry["id"];
	const state = isTextValue(entry["state"]) ? entry["state"].toUpperCase() : "";
	const author = githubAuthor(entry);
	const authorAssociation = githubAssociation(entry);
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
	const headCommit = githubCommentCommit(entry) ?? reviewRequest.headCommit;
	const feedback = `${body.trim()}${location}`.slice(0, 2_000);
	const observationId =
		prefix === "comment"
			? `review-comment:${reviewRequest.providerId}:${commentId}`
			: `review-comment:${reviewRequest.providerId}:${prefix}:${commentId}`;
	return [
		observation(
			"review-comment",
			reviewRequest.providerId,
			feedback,
			state === "CHANGES_REQUESTED" ? "changes-requested" : "commented",
			{
				observationId,
				feedback: [feedback],
				repository: reviewRequest.repository,
				sourceBranch: reviewRequest.sourceBranch,
				targetBranch: reviewRequest.targetBranch,
				headCommit,
				author,
				authorAssociation,
				reviewState: state || undefined,
				actionable: githubFeedbackIsActionable(prefix, state, authorAssociation),
			},
		),
	];
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

// oxlint-disable-next-line complexity
function githubFeedbackIsActionable(prefix: string, state: string, association: string | undefined): boolean {
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
