import {
	githubCiObservation,
	githubFeedback,
	githubOutcomeObservation,
	githubProviderDetails,
	githubReview,
	gitlabCiObservation,
	gitlabOutcomeObservation,
	gitlabReview,
	isMergedGithubOutcome,
	parseJsonArray,
	parseJsonPages,
	readValue,
	requireProviderRow,
} from "./adapter-provider.js";
import { run } from "./adapter-shared.js";
import { readPullRequestTemplate } from "./adapter-template.js";
import type { JsonValue, ProviderObservation, ProviderOutcomeObservation, ReviewRequest } from "./model.js";
import type { CodeHostPort, OperationContext, ReviewRequestInput } from "./ports.js";

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
