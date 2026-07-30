import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { Sandbox, SandboxRequest } from "./executor.js";
import { type ReviewFinalization, type ReviewPreparation, type ReviewWorkflowRequest, VCSProvider } from "./vcs.js";

const execFileAsync = promisify(execFile);
const MAX_SANDBOX_NAME_LENGTH = 48;
const NAME_RADIX = 36;
const RANDOM_SUFFIX_LENGTH = 8;
const PULL_REQUEST_NUMBER_PATTERN = /\/pull\/(\d+)(?:$|[?#])/;

// PATH_MAX is 4096 on Linux; most filesystems cap path components at 255 bytes.
const MAX_PATH_LENGTH = 4096;
const MAX_COMPONENT_LENGTH = 255;

// Git worktrees are created from HEAD so the executor never inherits uncommitted changes from the active checkout.
class GitWorktreeProvider extends VCSProvider {
	readonly #worktreeRoot: string;
	readonly #branchPrefix: string;

	constructor(worktreeRoot: string, branchPrefix: string) {
		super();
		this.#worktreeRoot = resolve(worktreeRoot);
		this.#branchPrefix = branchPrefix;
	}

	override async createSandbox(request: SandboxRequest): Promise<Sandbox> {
		const projectRoot = await git(request.projectPath, ["rev-parse", "--show-toplevel"]);
		await assertMainWorktree(request.projectPath, projectRoot);
		assertWorktreeRootDoesNotContainProject(this.#worktreeRoot, projectRoot);
		await mkdir(this.#worktreeRoot, { recursive: true });

		const name = this.generateSandboxName(request.name);
		const sandboxPath = join(this.#worktreeRoot, name);

		if (Buffer.byteLength(name) > MAX_COMPONENT_LENGTH) {
			throw new Error(
				`Sandbox name exceeds ${MAX_COMPONENT_LENGTH} byte limit: ${name} (${Buffer.byteLength(name)} bytes)`,
			);
		}
		if (Buffer.byteLength(sandboxPath) > MAX_PATH_LENGTH) {
			throw new Error(
				`Sandbox path exceeds ${MAX_PATH_LENGTH} byte limit: ${sandboxPath} (${Buffer.byteLength(sandboxPath)} bytes)`,
			);
		}

		if (existsSync(sandboxPath)) {
			throw new Error(`Sandbox path already exists: ${sandboxPath}`);
		}

		await git(projectRoot, ["worktree", "add", "-b", `${this.#branchPrefix}${name}`, sandboxPath, "HEAD"]);
		return { path: sandboxPath, name, projectPath: projectRoot };
	}

	override async removeSandbox(sandbox: Sandbox): Promise<void> {
		await git(sandbox.path, ["worktree", "remove", "--force", sandbox.path]);
		await git(sandbox.projectPath, ["branch", "-D", `${this.#branchPrefix}${sandbox.name}`]);
	}

	override async prepareReview(request: ReviewWorkflowRequest): Promise<ReviewPreparation> {
		const sourceBranch = await git(request.sandbox.path, ["branch", "--show-current"]);
		const targetBranch = request.targetBranch?.trim() || (await defaultTargetBranch(request.sandbox.path));
		const subject = planningCommitSubject(request);
		const bodyParts = [`Work: ${request.workId}`, `Execution: ${request.executionId}`];
		if (request.previousPullRequestUrl !== undefined) {
			bodyParts.push(`Related Pull Request: ${request.previousPullRequestUrl}`);
		}
		bodyParts.push("", request.mission);
		const body = bodyParts.join("\n");
		await git(request.sandbox.path, ["commit", "--allow-empty", "-m", subject, "-m", body]);
		const planningCommit = await git(request.sandbox.path, ["rev-parse", "HEAD"]);
		if (request.publish) {
			// The Executor owns Pull Request creation after it has inspected the
			// repository template and assembled the factual description.
			await git(request.sandbox.path, ["push", "--set-upstream", "origin", sourceBranch]);
		}
		return { sourceBranch, targetBranch, planningCommit };
	}

	override async finalizeReview(request: ReviewWorkflowRequest, url?: string): Promise<ReviewFinalization> {
		const headCommit = await git(request.sandbox.path, ["rev-parse", "HEAD"]);
		if (!request.publish) {
			return { headCommit };
		}
		const sourceBranch = await git(request.sandbox.path, ["branch", "--show-current"]);
		await git(request.sandbox.path, ["push", "origin", sourceBranch]);
		if (url !== undefined) {
			const number = parsePullRequestNumber(url);
			if (number === undefined) {
				return { headCommit, url };
			}
			return { headCommit, url, number };
		}
		const discovered = await findPullRequest(sourceBranch);
		if (discovered === undefined) {
			return { headCommit };
		}
		if (discovered.number === undefined) {
			return { headCommit, url: discovered.url };
		}
		return { headCommit, url: discovered.url, number: discovered.number };
	}

	protected generateSandboxName(name: string): string {
		const slug = name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, MAX_SANDBOX_NAME_LENGTH);
		return `${slug || "executor"}-${Date.now().toString(NAME_RADIX)}-${nanoid(RANDOM_SUFFIX_LENGTH)}`;
	}
}

function createGitWorktreeProvider(worktreeRoot: string, branchPrefix: string): VCSProvider {
	return new GitWorktreeProvider(worktreeRoot, branchPrefix);
}

async function assertMainWorktree(projectPath: string, projectRoot: string): Promise<void> {
	const gitDirectory = resolve(projectPath, await git(projectPath, ["rev-parse", "--git-dir"]));
	const commonDirectory = resolve(projectPath, await git(projectPath, ["rev-parse", "--git-common-dir"]));
	if (gitDirectory !== commonDirectory) {
		throw new Error(`Cannot create a sandbox from an existing worktree: ${projectRoot}`);
	}
}

function assertWorktreeRootDoesNotContainProject(worktreeRoot: string, projectRoot: string): void {
	const pathFromRoot = relative(worktreeRoot, projectRoot);
	const isOutsideRoot = pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
	if (pathFromRoot === "" || !isOutsideRoot) {
		throw new Error(`The active project is already inside the configured worktree root: ${worktreeRoot}`);
	}
}

function planningCommitSubject(request: ReviewWorkflowRequest): string {
	const convention = request.commitConvention?.trim() ?? "project";
	if (convention === "conventional") {
		return `chore(khala): record Mission ${request.executionId} plan`;
	}
	if (convention === "project") {
		return `Khala: record Mission ${request.executionId} plan`;
	}
	return `${convention} record Mission ${request.executionId} plan`;
}

async function defaultTargetBranch(cwd: string): Promise<string> {
	try {
		const remoteHead = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
		if (remoteHead.startsWith("origin/")) {
			return remoteHead.slice("origin/".length);
		}
	} catch {
		// Repositories without origin/HEAD use the conventional branch fallback below.
	}
	const branchChecks = await Promise.all(
		["main", "master"].map(async (branch) => {
			try {
				await git(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]);
				return branch;
			} catch {
				// The branch is not present; the next fallback is checked concurrently.
				// biome-ignore lint/complexity/noUselessUndefined: The callback must resolve with an explicit optional branch.
				return undefined;
			}
		}),
	);
	return branchChecks.find((branch): branch is string => branch !== undefined) ?? "main";
}

async function gh(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("gh", args, { encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			// biome-ignore lint/style/useErrorCause: Preserve the existing repository error style for Node strip-only compatibility.
			throw new Error(`gh ${args.join(" ")} failed: ${error.message}`);
		}
		throw error;
	}
}

function parsePullRequestNumber(url: string): number | undefined {
	const match = PULL_REQUEST_NUMBER_PATTERN.exec(url);
	if (match === null) {
		return;
	}
	const number = Number(match[1]);
	if (!Number.isSafeInteger(number) || number <= 0) {
		return;
	}
	return number;
}

type PullRequestLookup = Readonly<{ url: string; number?: number }>;

async function findPullRequest(sourceBranch: string): Promise<PullRequestLookup | undefined> {
	const output = await gh(["pr", "list", "--head", sourceBranch, "--json", "url,number", "--limit", "1"]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return;
	}
	if (!Array.isArray(parsed)) {
		return;
	}
	const [first] = parsed;
	if (typeof first !== "object" || first === null) {
		return;
	}
	const record = first as { url?: unknown; number?: unknown };
	if (typeof record.url !== "string" || record.url.length === 0) {
		return;
	}
	if (typeof record.number === "number" && Number.isSafeInteger(record.number) && record.number > 0) {
		return { url: record.url, number: record.number };
	}
	return { url: record.url };
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		// Git is invoked as an executable with argv, so this provider does not depend on Bash syntax either.
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			// The package targets ES2020, whose TypeScript lib omits ErrorOptions.cause.
			// biome-ignore lint/style/useErrorCause: Preserve ES2020 compatibility.
			throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
		}
		throw error;
	}
}

export { createGitWorktreeProvider };
