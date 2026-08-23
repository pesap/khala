import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Execution, JsonValue, Mission, ProviderObservation, ReviewRequest } from "./model.js";
import type { CodeHostPort, ReviewRequestInput, WorkspacePort, WorkspacePreflight } from "./ports.js";

const execFileAsync = promisify(execFile);

export class GitWorkspace implements WorkspacePort {
	private readonly worktreeRoot: string;
	private readonly branchPrefix: string;

	constructor(worktreeRoot: string, branchPrefix: string) {
		this.worktreeRoot = worktreeRoot;
		this.branchPrefix = branchPrefix;
	}

	async preflight(projectPath: string, targetBranch: string): Promise<WorkspacePreflight> {
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
			await execFileAsync("git", ["worktree", "add", "-b", branch, path, input.baseCommit], { cwd: input.projectPath });
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
}

export class CommandCodeHost implements CodeHostPort {
	readonly provider: "github" | "gitlab";
	private readonly cwd: string;

	constructor(provider: "github" | "gitlab", cwd: string) {
		this.provider = provider;
		this.cwd = cwd;
	}

	async capabilities(): Promise<Readonly<{ supportsDraft: boolean; supportsMergeObservation: boolean }>> {
		return { supportsDraft: true, supportsMergeObservation: true };
	}

	async identity(): Promise<Readonly<{ principalId: string; verified: boolean }>> {
		const command = this.provider === "github" ? "gh" : "glab";
		const args = this.provider === "github" ? ["api", "user", "--jq", ".node_id"] : ["api", "user", "--jq", ".id"];
		const principalId = (await run(command, args, this.cwd)).trim();
		return { principalId, verified: principalId.length > 0 };
	}

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
			const first = rows[0];
			if (first !== undefined) {
				const request = githubReview(first, input, principal.principalId);
				return { ...request, diffSummary: await this.readDiff(request.providerId) };
			}
			const url = (
				await run(
					"gh",
					["pr", "create", "--draft", "--title", title, "--body", body, "--base", input.targetBranch],
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
			const request = githubReview(createdRow, input, principal.principalId);
			return { ...request, diffSummary: await this.readDiff(request.providerId) };
		}
		const existing = await run(
			"glab",
			["mr", "list", "--all", "--search", input.draftMarker, "--output", "json"],
			this.cwd,
		);
		const rows = parseJsonArray(existing);
		const first = rows[0];
		if (first !== undefined) {
			const request = gitlabReview(first, input, principal.principalId);
			return { ...request, diffSummary: await this.readDiff(request.providerId) };
		}
		const created = await run(
			"glab",
			["mr", "create", "--draft", "--title", title, "--description", body, "--target-branch", input.targetBranch],
			this.cwd,
		);
		const url = created.trim().split(/\s+/).at(-1);
		if (url === undefined || url.length === 0) {
			throw new Error("GitLab did not return a review request URL.");
		}
		const request: ReviewRequest = {
			provider: "gitlab",
			principalId: principal.principalId,
			providerId: url,
			url,
			status: "draft",
			sourceBranch: input.sandbox.branch,
			targetBranch: input.targetBranch,
			headCommit: input.sandbox.baseCommit,
			diffSummary: body,
			validation: input.terms.validation,
		};
		return { ...request, diffSummary: await this.readDiff(request.providerId) };
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
				["pr", "view", reviewRequest.providerId, "--json", "state,reviewDecision,statusCheckRollup"],
				this.cwd,
			);
			return [{ ...observation("ci-status", reviewRequest.providerId, data), status: reviewRequest.status }];
		}
		const data = await run("glab", ["mr", "view", reviewRequest.providerId, "--output", "json"], this.cwd);
		return [observation("ci-status", reviewRequest.providerId, data)];
	}

	async inspectOutcome(reviewRequest: ReviewRequest): Promise<ProviderObservation | undefined> {
		if (this.provider === "github") {
			const data = await run(
				"gh",
				["pr", "view", reviewRequest.providerId, "--json", "state,mergedAt,mergeCommit"],
				this.cwd,
			);
			if (!data.includes("mergedAt") || data.includes('"mergedAt":null')) {
				return;
			}
			return observation("provider-outcome", reviewRequest.providerId, data);
		}
		const data = await run("glab", ["mr", "view", reviewRequest.providerId, "--output", "json"], this.cwd);
		if (!data.toLowerCase().includes("merged")) {
			return;
		}
		return observation("provider-outcome", reviewRequest.providerId, data);
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
	return (await execFileAsync("git", [...args], { cwd })).stdout.trim();
}

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
	try {
		return (await execFileAsync(command, [...args], { cwd })).stdout;
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

function githubReview(row: Record<string, JsonValue>, input: ReviewRequestInput, principalId: string): ReviewRequest {
	return {
		provider: "github",
		principalId,
		providerId: readValue(row, "number"),
		url: readValue(row, "url"),
		status: githubStatus(readValue(row, "state"), readBoolean(row, "isDraft")),
		sourceBranch: readValue(row, "headRefName"),
		targetBranch: readValue(row, "baseRefName"),
		headCommit: readValue(row, "headRefOid"),
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
		status: "draft",
		sourceBranch: input.sandbox.branch,
		targetBranch: readValue(row, "target_branch"),
		headCommit: input.sandbox.baseCommit,
		diffSummary: `Review request ${id} for ${input.terms.title}.`,
		validation: input.terms.validation,
	};
}

function readValue(row: Record<string, JsonValue>, key: string): string {
	const value = row[key];
	const number = Number(value);
	if (value === null || value === undefined || (value !== String(value) && number !== value)) {
		throw new Error(`Code-host response is missing ${key}.`);
	}
	return String(value);
}

function observation(kind: ProviderObservation["kind"], providerId: string, summary: string): ProviderObservation {
	return {
		observationId: `${kind}:${providerId}`,
		kind,
		providerId,
		status: "observed",
		summary: summary.slice(0, 2000),
		changed: true,
		observedAt: new Date().toISOString(),
	};
}

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
