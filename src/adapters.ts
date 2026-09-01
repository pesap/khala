import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type {
	Execution,
	JsonValue,
	Mission,
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
	ValidationResult,
} from "./model.js";
import type { CodeHostPort, OperationContext, ReviewRequestInput, WorkspacePort, WorkspacePreflight } from "./ports.js";

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
	signal?: AbortSignal;
};

function commandOptions(cwd: string, environment?: NodeJS.ProcessEnv, signal?: AbortSignal) {
	const options: CommandOptions = {
		cwd,
		timeout: COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: MAX_COMMAND_BUFFER,
	};
	if (environment !== undefined) options.env = environment;
	if (signal !== undefined) options.signal = signal;
	return options;
}

function projectEnvironment(projectPath: string | undefined): NodeJS.ProcessEnv {
	const environment = sanitizedEnvironment();
	const inheritedPath = Object.entries(environment)
		.filter(([key]) => key.toLowerCase() === "path")
		.map(([, value]) => value)
		.filter((value): value is string => value !== undefined)
		.join(delimiter);
	for (const key of Object.keys(environment)) {
		if (key.toLowerCase() === "path") delete environment[key];
	}
	const parentNodeBin = projectPath === undefined ? undefined : join(projectPath, "node_modules", ".bin");
	// Keep inherited commands ahead of repository-owned tools.
	environment["PATH"] = [inheritedPath, parentNodeBin]
		.filter((value): value is string => value !== undefined && value !== "")
		.join(delimiter);
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

	async preflight(
		projectPath: string,
		targetBranch: string,
		operation?: OperationContext,
	): Promise<WorkspacePreflight> {
		this.projectPath = projectPath;
		const origin = await git(projectPath, ["remote", "get-url", "origin"], operation?.signal);
		await git(projectPath, ["fetch", "--no-tags", "origin", targetBranch], operation?.signal);
		const headCommit = await git(projectPath, ["rev-parse", `refs/remotes/origin/${targetBranch}`], operation?.signal);
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
		operation?: OperationContext,
	): Promise<Execution["sandbox"]> {
		const workKey = createHash("sha256").update(input.workId).digest("hex").slice(0, 24);
		const branch = `${this.branchPrefix}${workKey}/${input.executionId.slice(0, 8)}`;
		const path = resolve(this.worktreeRoot, workKey, input.executionId);
		await prepareSandboxParent(this.worktreeRoot, path);
		const existing = await lstat(path).catch(() => undefined);
		if (existing === undefined) await createSandbox(input, branch, path, operation);
		else await validateExistingSandbox(this.worktreeRoot, input, branch, path, existing, operation);
		return { path, baseCommit: input.baseCommit, branch };
	}

	async inspectHead(path: string, operation?: OperationContext): Promise<string> {
		return git(path, ["rev-parse", "HEAD"], operation?.signal);
	}

	async inspectChanges(
		input: Readonly<{ path: string; baseCommit: string }>,
		operation?: OperationContext,
	): Promise<readonly string[]> {
		const committed = await git(input.path, ["diff", "--name-only", `${input.baseCommit}...HEAD`], operation?.signal);
		const working = await git(input.path, ["diff", "--name-only", input.baseCommit], operation?.signal);
		const untracked = await git(input.path, ["ls-files", "--others", "--exclude-standard"], operation?.signal);
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

	async commitSandbox(
		input: {
			sandbox: Execution["sandbox"];
			allowedPaths: readonly string[];
			message: string;
		},
		operation?: OperationContext,
	): Promise<string> {
		if (input.allowedPaths.length === 0)
			throw new Error("At least one permitted path is required to commit a sandbox.");
		const environment = projectEnvironment(this.projectPath);
		await git(input.sandbox.path, ["add", "--all", "--", ...input.allowedPaths], operation?.signal, environment);
		await git(input.sandbox.path, ["commit", "-m", input.message], operation?.signal, environment);
		return this.inspectHead(input.sandbox.path, operation);
	}
	async runValidation(
		input: { path: string; commands: readonly string[] },
		operation?: OperationContext,
	): Promise<readonly ValidationResult[]> {
		return runValidationCommands(input, projectEnvironment(this.projectPath), operation);
	}

	async publishSandbox(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<string> {
		await git(
			sandbox.path,
			["push", "--set-upstream", "origin", sandbox.branch],
			operation?.signal,
			projectEnvironment(this.projectPath),
		);
		return this.inspectHead(sandbox.path, operation);
	}
	async removeSandbox(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<void> {
		const projectPath = this.projectPath;
		if (projectPath === undefined) throw new Error("Workspace project path is not initialized.");
		validateSandboxPath(this.worktreeRoot, sandbox.path);
		await removeExistingSandbox(this.worktreeRoot, projectPath, sandbox, operation);
		await removeSandboxBranch(projectPath, sandbox.branch, operation);
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

	async capabilities(
		_operation?: OperationContext,
	): Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>> {
		return { supportsDraft: true, supportsMergeObservation: true };
	}

	async identity(operation?: OperationContext): Promise<Readonly<{ principalId: string; verified: boolean }>> {
		const command = this.provider === "github" ? "gh" : "glab";
		const args = this.provider === "github" ? ["api", "user", "--jq", ".login"] : ["api", "user", "--jq", ".id"];
		const principalId = (await run(command, args, this.cwd, operation?.signal)).trim();
		return { principalId, verified: principalId.length > 0 };
	}
	async ensureReviewRequest(input: ReviewRequestInput, operation?: OperationContext): Promise<ReviewRequest> {
		const body = await reviewRequestBody(input, this.cwd);
		const principal = await this.identity(operation);
		if (!principal.verified) throw new Error("The authenticated code-host identity is not verified.");
		return this.provider === "github"
			? this.ensureGithubReview(input, body, principal.principalId, operation)
			: this.ensureGitlabReview(input, body, principal.principalId, operation);
	}

	private async ensureGithubReview(
		input: ReviewRequestInput,
		body: string,
		principalId: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const repository = await this.repository(operation?.signal);
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
			operation?.signal,
		);
		const first = parseJsonArray(existing).find(
			(row) => row["headRefName"] === input.sandbox.branch && row["baseRefName"] === input.targetBranch,
		);
		return first === undefined
			? this.createGithubReview(input, body, principalId, repository, operation)
			: this.existingGithubReview(first, input, principalId, repository, operation);
	}

	private async existingGithubReview(
		row: Record<string, JsonValue>,
		input: ReviewRequestInput,
		principalId: string,
		repository: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const request = githubReview(row, input, principalId, repository);
		return { ...request, diffSummary: await this.readDiff(request.providerId, operation?.signal) };
	}

	private async createGithubReview(
		input: ReviewRequestInput,
		body: string,
		principalId: string,
		repository: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const title = `Khala: ${input.terms.title}`;
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
				operation?.signal,
			)
		).trim();
		const created = await run(
			"gh",
			["pr", "view", url, "--json", "number,url,state,isDraft,headRefName,baseRefName,headRefOid"],
			this.cwd,
			operation?.signal,
		);
		const row = requireProviderRow(created, "GitHub did not return review request metadata.");
		const request = githubReview(row, input, principalId, repository);
		return { ...request, diffSummary: await this.readDiff(request.providerId, operation?.signal) };
	}

	private async ensureGitlabReview(
		input: ReviewRequestInput,
		body: string,
		principalId: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const existing = await run(
			"glab",
			["mr", "list", "--all", "--search", input.draftMarker, "--output", "json"],
			this.cwd,
			operation?.signal,
		);
		const first = parseJsonArray(existing).find(
			(row) => row["source_branch"] === input.sandbox.branch && row["target_branch"] === input.targetBranch,
		);
		return first === undefined
			? this.createGitlabReview(input, body, principalId, operation)
			: this.existingGitlabReview(first, input, principalId, operation);
	}

	private async existingGitlabReview(
		row: Record<string, JsonValue>,
		input: ReviewRequestInput,
		principalId: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const request = gitlabReview(row, input, principalId);
		return { ...request, diffSummary: await this.readDiff(request.providerId, operation?.signal) };
	}

	private async createGitlabReview(
		input: ReviewRequestInput,
		body: string,
		principalId: string,
		operation: OperationContext | undefined,
	): Promise<ReviewRequest> {
		const title = `Khala: ${input.terms.title}`;
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
			operation?.signal,
		);
		const url = requireReviewUrl(created);
		const viewed = await run("glab", ["mr", "view", url, "--output", "json"], this.cwd, operation?.signal);
		const row = requireProviderRow(viewed, "GitLab did not return merge request metadata.");
		const request = gitlabReview(row, input, principalId);
		return { ...request, diffSummary: await this.readDiff(request.providerId, operation?.signal) };
	}

	private async repository(signal?: AbortSignal): Promise<string> {
		if (this.repositoryName !== undefined) return this.repositoryName;
		const repository = (
			await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], this.cwd, signal)
		).trim();
		if (repository.length === 0) throw new Error("GitHub did not return repository identity.");
		this.repositoryName = repository;
		return repository;
	}

	private async readDiff(providerId: string, signal?: AbortSignal): Promise<string> {
		const command = this.provider === "github" ? "gh" : "glab";
		const args = this.provider === "github" ? ["pr", "diff", providerId] : ["mr", "diff", providerId];
		return (await run(command, args, this.cwd, signal)).slice(0, 16_000);
	}
	async poll(reviewRequest: ReviewRequest, operation?: OperationContext): Promise<readonly ProviderObservation[]> {
		return this.provider === "github"
			? this.pollGithub(reviewRequest, operation)
			: this.pollGitlab(reviewRequest, operation);
	}

	private async pollGithub(
		reviewRequest: ReviewRequest,
		operation: OperationContext | undefined,
	): Promise<readonly ProviderObservation[]> {
		const data = await run(
			"gh",
			[
				"pr",
				"view",
				reviewRequest.providerId,
				"--json",
				"state,isDraft,mergedAt,reviewDecision,statusCheckRollup,comments,reviews,headRefName,baseRefName,headRefOid,baseRefOid",
			],
			this.cwd,
			operation?.signal,
		);
		const row = requireProviderRow(data, "GitHub did not return review request polling data.");
		const repository = await this.repository(operation?.signal);
		const inlineData = await run(
			"gh",
			["api", `repos/${repository}/pulls/${reviewRequest.providerId}/comments`, "--paginate", "--slurp"],
			this.cwd,
			operation?.signal,
		);
		const inlineComments = parseJsonPages(inlineData);
		const details = githubProviderDetails(row, reviewRequest, inlineComments);
		return [
			githubCiObservation(data, row, reviewRequest, repository, details),
			...githubFeedback(row, reviewRequest, inlineComments),
		];
	}

	private async pollGitlab(
		reviewRequest: ReviewRequest,
		operation: OperationContext | undefined,
	): Promise<readonly ProviderObservation[]> {
		const data = await run(
			"glab",
			["mr", "view", reviewRequest.providerId, "--output", "json"],
			this.cwd,
			operation?.signal,
		);
		const row = requireProviderRow(data, "GitLab did not return review request polling data.");
		return [gitlabCiObservation(data, row, reviewRequest)];
	}
	async inspectOutcome(
		reviewRequest: ReviewRequest,
		operation?: OperationContext,
	): Promise<ProviderOutcomeObservation | undefined> {
		return this.provider === "github"
			? this.inspectGithubOutcome(reviewRequest, operation)
			: this.inspectGitlabOutcome(reviewRequest, operation);
	}

	private async inspectGithubOutcome(
		reviewRequest: ReviewRequest,
		operation: OperationContext | undefined,
	): Promise<ProviderOutcomeObservation | undefined> {
		const data = await run(
			"gh",
			[
				"pr",
				"view",
				reviewRequest.providerId,
				"--json",
				"state,mergedAt,mergeCommit,headRefName,baseRefName,headRefOid,baseRefOid",
			],
			this.cwd,
			operation?.signal,
		);
		const row = requireProviderRow(data, "GitHub did not return review request outcome data.");
		if (!isMergedGithubOutcome(row)) return undefined;
		return githubOutcomeObservation(row, reviewRequest);
	}

	private async inspectGitlabOutcome(
		reviewRequest: ReviewRequest,
		operation: OperationContext | undefined,
	): Promise<ProviderOutcomeObservation | undefined> {
		const data = await run(
			"glab",
			["mr", "view", reviewRequest.providerId, "--output", "json"],
			this.cwd,
			operation?.signal,
		);
		const row = requireProviderRow(data, "GitLab did not return review request outcome data.");
		if (readValue(row, "state").toLowerCase() !== "merged") return undefined;
		return gitlabOutcomeObservation(row, reviewRequest);
	}
}

function requireReviewUrl(output: string): string {
	const url = output.trim().split(/\s+/).at(-1);
	if (url === undefined || url.length === 0) throw new Error("GitLab did not return a review request URL.");
	return url;
}

async function reviewRequestBody(input: ReviewRequestInput, projectPath: string): Promise<string> {
	const generated = generatedReviewBody(input);
	const template = await readPullRequestTemplate(projectPath);
	return template === undefined ? generated : `${template.trim()}\n\n${generated}`;
}

function generatedReviewBody(input: ReviewRequestInput): string {
	return [
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

async function git(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	environment: NodeJS.ProcessEnv = sanitizedEnvironment(),
): Promise<string> {
	return (await execFileAsync("git", [...args], commandOptions(cwd, environment, signal))).stdout.trim();
}

async function isRegisteredWorktree(projectPath: string, sandboxPath: string, signal?: AbortSignal): Promise<boolean> {
	const listing = await git(projectPath, ["worktree", "list", "--porcelain"], signal);
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

async function prepareSandboxParent(root: string, path: string): Promise<void> {
	if (!isContainedPath(root, path)) throw new Error(`Sandbox ${path} is outside the worktree root.`);
	const parent = dirname(path);
	await mkdir(parent, { recursive: true });
	if (!(await isRealContainedPath(root, parent)))
		throw new Error(`Sandbox parent ${parent} is outside the worktree root.`);
}

async function createSandbox(
	input: Readonly<{ projectPath: string; baseCommit: string }>,
	branch: string,
	path: string,
	operation: OperationContext | undefined,
): Promise<void> {
	await execFileAsync(
		"git",
		["worktree", "add", "-b", branch, path, input.baseCommit],
		commandOptions(input.projectPath, sanitizedEnvironment(), operation?.signal),
	);
}

async function validateExistingSandbox(
	root: string,
	input: Readonly<{ projectPath: string; baseCommit: string }>,
	branch: string,
	path: string,
	existing: Awaited<ReturnType<typeof lstat>>,
	operation: OperationContext | undefined,
): Promise<void> {
	validateSandboxDirectory(path, existing);
	if (!(await isRealContainedPath(root, path))) throw new Error(`Sandbox ${path} is outside the worktree root.`);
	if (!(await isRegisteredWorktree(input.projectPath, path, operation?.signal)))
		throw new Error(`Sandbox ${path} is not registered by the project repository.`);
	await validateSandboxBranch(path, branch, input.baseCommit, operation);
}

function validateSandboxDirectory(path: string, existing: Awaited<ReturnType<typeof lstat>>): void {
	if (existing.isSymbolicLink() || !existing.isDirectory())
		throw new Error(`Sandbox ${path} is not a directory owned by Khala.`);
}

async function validateSandboxBranch(
	path: string,
	branch: string,
	baseCommit: string,
	operation: OperationContext | undefined,
): Promise<void> {
	const existingBranch = await git(path, ["branch", "--show-current"], operation?.signal);
	assertSandboxBranch(path, branch, existingBranch);
	const existingHead = await git(path, ["rev-parse", "HEAD"], operation?.signal);
	assertSandboxBase(path, baseCommit, existingHead);
}

async function runValidationCommands(
	input: Readonly<{ path: string; commands: readonly string[] }>,
	environment: NodeJS.ProcessEnv,
	operation: OperationContext | undefined,
): Promise<readonly ValidationResult[]> {
	const results: ValidationResult[] = [];
	for (const command of input.commands)
		results.push(await runValidationResult(command, input.path, environment, operation));
	return results;
}

async function runValidationResult(
	command: string,
	path: string,
	environment: NodeJS.ProcessEnv,
	operation: OperationContext | undefined,
): Promise<ValidationResult> {
	const result = await runValidationCommand(command, path, environment, operation?.signal);
	throwIfValidationCancelled(operation);
	return { command, ...result };
}

function throwIfValidationCancelled(operation: OperationContext | undefined): void {
	if (operation?.signal?.aborted === true) throw new Error("Validation was cancelled.");
}

function assertSandboxBranch(path: string, expected: string, actual: string): void {
	if (actual !== expected) throw new Error(`Sandbox ${path} is attached to branch ${actual}, not ${expected}.`);
}

function assertSandboxBase(path: string, expected: string, actual: string): void {
	if (actual !== expected) throw new Error(`Sandbox ${path} has unexpected base ${actual}.`);
}

function validateSandboxPath(root: string, path: string): void {
	if (!isContainedPath(root, path)) throw new Error(`Sandbox ${path} is outside the worktree root.`);
}

async function removeExistingSandbox(
	root: string,
	projectPath: string,
	sandbox: Execution["sandbox"],
	operation: OperationContext | undefined,
): Promise<void> {
	const existing = await lstat(sandbox.path).catch(() => undefined);
	if (existing === undefined) return;
	await validateRemovableSandbox(root, projectPath, sandbox.path, existing, operation);
	await execFileAsync(
		"git",
		["worktree", "remove", "--force", sandbox.path],
		commandOptions(projectPath, sanitizedEnvironment(), operation?.signal),
	);
}

async function removeSandboxBranch(
	projectPath: string,
	branch: string,
	operation: OperationContext | undefined,
): Promise<void> {
	const signal = operationSignal(operation);
	try {
		await git(projectPath, ["branch", "-D", branch], signal);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		if (isMissingBranchError(error)) return;
		throw error;
	}
}

async function validateRemovableSandbox(
	root: string,
	projectPath: string,
	path: string,
	existing: Awaited<ReturnType<typeof lstat>>,
	operation: OperationContext | undefined,
): Promise<void> {
	validateSandboxDirectory(path, existing);
	if (!(await isRealContainedPath(root, path))) throw new Error(`Sandbox ${path} is outside the worktree root.`);
	if (!(await isRegisteredWorktree(projectPath, path, operation?.signal)))
		throw new Error(`Sandbox ${path} is not registered by the project repository.`);
}

function isMissingBranchError(error: Error): boolean {
	return /branch .* not found/i.test(error.message);
}

function operationSignal(operation: OperationContext | undefined): AbortSignal | undefined {
	return operation?.signal;
}

function runValidationCommand(
	command: string,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<Readonly<{ passed: boolean; output: string }>> {
	return new Promise((resolve) => {
		execFile(
			validationShell(),
			validationShellArguments(command),
			commandOptions(cwd, environment, signal),
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ passed: true, output: stdout.slice(-4_000) });
					return;
				}
				resolve({ passed: false, output: failedCommandOutput(stdout, stderr, error.message) });
			},
		);
	});
}

function failedCommandOutput(stdout: string, stderr: string, message: string): string {
	return [
		`stdout:\n${boundedValidationOutput(stdout)}`,
		`stderr:\n${boundedValidationOutput(stderr)}`,
		`error:\n${boundedValidationOutput(message)}`,
	].join("\n");
}

function boundedValidationOutput(value: string): string {
	return value.slice(-1_200);
}

async function run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		return (await execFileAsync(command, [...args], commandOptions(cwd, undefined, signal))).stdout;
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

function requireProviderRow(data: string, message: string): Record<string, JsonValue> {
	const row = parseJsonArray(`[${data}]`)[0];
	if (row === undefined) throw new Error(message);
	return row;
}

function githubCiObservation(
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

function gitlabCiObservation(
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

function isMergedGithubOutcome(row: Record<string, JsonValue>): boolean {
	if (readValue(row, "state").toLowerCase() !== "merged") return false;
	return row["mergedAt"] !== null;
}

function githubOutcomeObservation(
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

function gitlabOutcomeObservation(
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
function readValue(row: Record<string, JsonValue>, key: string): string {
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

function githubProviderDetails(
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
export async function readPullRequestTemplate(projectPath: string): Promise<string | undefined> {
	const root = await realpath(projectPath).catch(() => undefined);
	if (root === undefined) return undefined;
	return readTemplateSources(root);
}

async function readTemplateSources(root: string): Promise<string | undefined> {
	const known = await readFirstTemplate(root, [
		"pull_request_template.md",
		"docs/pull_request_template.md",
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
	]);
	if (known !== undefined) return known;
	const templateDirectory = await safeTemplateDirectory(root);
	if (templateDirectory === undefined) return undefined;
	return readTemplateDirectory(root, templateDirectory);
}

async function readFirstTemplate(root: string, paths: readonly string[]): Promise<string | undefined> {
	for (const relativePath of paths) {
		const content = await readSafeTemplateFile(root, relativePath);
		if (hasTemplateContent(content)) return content;
	}
	return undefined;
}

async function readTemplateDirectory(root: string, directory: string): Promise<string | undefined> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter((candidate) => candidate.isFile())
		.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of files) {
		const content = await readSafeTemplateFile(root, join(".github", "PULL_REQUEST_TEMPLATE", entry.name));
		if (hasTemplateContent(content)) return content;
	}
	return undefined;
}

function hasTemplateContent(content: string | undefined): content is string {
	return content !== undefined && content.trim().length > 0;
}

async function readSafeTemplateFile(root: string, relativePath: string): Promise<string | undefined> {
	const candidate = resolve(root, relativePath);
	if (!isContainedPath(root, candidate)) return;
	if (!(await isRegularContainedFile(root, candidate))) return;
	return readFile(candidate, "utf8").catch(() => undefined);
}

async function isRegularContainedFile(root: string, candidate: string): Promise<boolean> {
	const info = await lstat(candidate).catch(() => undefined);
	if (info === undefined) return false;
	if (!info.isFile()) return false;
	return isRealContainedPath(root, candidate);
}

async function safeTemplateDirectory(root: string): Promise<string | undefined> {
	const directory = resolve(root, ".github", "PULL_REQUEST_TEMPLATE");
	const info = await lstat(directory).catch(() => undefined);
	if (info === undefined || !info.isDirectory() || !(await isRealContainedPath(root, directory))) return;
	return directory;
}
