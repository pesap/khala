// biome-ignore-all lint/style/noExcessiveLinesPerFile: Git VCS and Pull Request publication share one provider boundary.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
const MAX_CHILD_PROCESS_ERROR_MESSAGE_LENGTH = 512;
const MAX_CHILD_PROCESS_OUTPUT_LENGTH = 2048;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
// Git worktrees are created from the same resolved PR target used by review preparation, so caller-only commits cannot leak into the PR.
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
		// Git reports worktrees through the physical filesystem path. Persist the
		// same identity so a macOS /var alias cannot split one sandbox in two.
		const worktreeRoot = realpathSync(this.#worktreeRoot);
		const name = this.generateSandboxName(request.name);
		const sandboxPath = join(worktreeRoot, name);

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

		const baseBranch = request.baseBranch?.trim() || (await defaultTargetBranch(projectRoot));
		let baseRef: string;
		if (request.baseCommit !== undefined) {
			baseRef = await resolveExactCommit(projectRoot, request.baseCommit);
		} else if (request.baseRef === undefined) {
			baseRef = await resolveBranchRef(projectRoot, baseBranch);
		} else {
			baseRef = await resolveExactRef(projectRoot, request.baseRef);
		}
		await git(projectRoot, ["worktree", "add", "-b", `${this.#branchPrefix}${name}`, sandboxPath, baseRef]);
		const actualHead = await git(sandboxPath, ["rev-parse", "HEAD"]);
		if (request.baseCommit !== undefined && actualHead !== request.baseCommit) {
			throw new Error(
				`Sandbox ${sandboxPath} was created at ${actualHead}, not the required exact base ${request.baseCommit}.`,
			);
		}
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
		if (request.supersedesPullRequestUrl !== undefined) {
			bodyParts.push(`Supersedes Pull Request: ${request.supersedesPullRequestUrl}`);
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
		let finalization: ReviewFinalization;
		if (url === undefined) {
			const discovered = await findPullRequest(sourceBranch);
			if (discovered === undefined) {
				throw new Error(`No published Pull Request was found for Executor branch '${sourceBranch}'.`);
			}
			if (discovered.number === undefined) {
				finalization = { headCommit, url: discovered.url };
			} else {
				finalization = { headCommit, url: discovered.url, number: discovered.number };
			}
		} else {
			const number = parsePullRequestNumber(url);
			if (number === undefined) {
				finalization = { headCommit, url };
			} else {
				finalization = { headCommit, url, number };
			}
		}
		return finalization;
	}

	override async supersedePullRequest(previousUrl: string, successorUrl: string): Promise<void> {
		await closeSupersededPullRequest(previousUrl, successorUrl);
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

async function resolveExactCommit(cwd: string, commit: string): Promise<string> {
	const exact = commit.trim();
	if (!FULL_COMMIT_PATTERN.test(exact)) {
		throw new Error(`An upstream sandbox requires a full 40-character commit, received '${commit}'.`);
	}
	const resolved = await git(cwd, ["rev-parse", "--verify", `${exact}^{commit}`]);
	if (resolved !== exact) {
		throw new Error(`The requested upstream base ${exact} was not verified exactly.`);
	}
	return exact;
}

function resolveExactRef(cwd: string, ref: string): Promise<string> {
	const normalized = ref.trim();
	if (normalized.length === 0) {
		throw new Error("An exact sandbox base ref cannot be empty.");
	}
	return git(cwd, ["rev-parse", "--verify", `${normalized}^{commit}`]);
}

async function resolveBranchRef(cwd: string, branch: string): Promise<string> {
	await git(cwd, ["check-ref-format", "--branch", branch]);
	try {
		await git(cwd, ["remote", "get-url", "origin"]);
	} catch {
		await git(cwd, ["rev-parse", "--verify", `${branch}^{commit}`]);
		return branch;
	}
	const remoteBranch = `origin/${branch}`;
	await git(cwd, ["fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/${remoteBranch}`]);
	await git(cwd, ["rev-parse", "--verify", `${remoteBranch}^{commit}`]);
	return remoteBranch;
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

async function closeSupersededPullRequest(previousUrl: string, successorUrl: string): Promise<void> {
	if (previousUrl === successorUrl) {
		throw new Error("A Pull Request cannot supersede itself.");
	}
	const previous = parsePullRequestState(await gh(["pr", "view", previousUrl, "--json", "state,body,comments"]));
	const successorLink = `Superseded by ${successorUrl}.`;
	if (previous.state === "OPEN") {
		if (
			!(previous.body.includes(successorUrl) || previous.comments.some((comment) => comment.includes(successorUrl)))
		) {
			await gh(["pr", "comment", previousUrl, "--body", successorLink]);
		}
		await gh(["pr", "close", previousUrl]);
		return;
	}
	if (
		previous.state === "CLOSED" &&
		(previous.body.includes(successorUrl) || previous.comments.some((comment) => comment.includes(successorUrl)))
	) {
		return;
	}
	throw new Error(
		`Predecessor Pull Request ${boundGitDiagnostic(previousUrl, MAX_CHILD_PROCESS_ERROR_MESSAGE_LENGTH)} is not open or already linked to ${boundGitDiagnostic(successorUrl, MAX_CHILD_PROCESS_ERROR_MESSAGE_LENGTH)}.`,
	);
}

type PullRequestState = Readonly<{ state: string; body: string; comments: readonly string[] }>;

function parsePullRequestState(output: string): PullRequestState {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(output);
	} catch {
		parsed = null;
	}
	if (parsed === null) {
		throw new Error("GitHub returned invalid Pull Request state JSON.");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("GitHub returned invalid Pull Request state.");
	}
	const record = parsed as { state?: unknown; body?: unknown; comments?: unknown };
	if (typeof record.state !== "string" || typeof record.body !== "string" || !Array.isArray(record.comments)) {
		throw new Error("GitHub returned incomplete Pull Request state.");
	}
	const comments: string[] = [];
	for (const comment of record.comments) {
		if (typeof comment === "object" && comment !== null && typeof (comment as { body?: unknown }).body === "string") {
			comments.push((comment as { body: string }).body);
		}
	}
	return { state: record.state, body: record.body, comments };
}

async function gh(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("gh", args, { encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof Error) {
			// biome-ignore lint/style/useErrorCause: Preserve the existing repository error style for Node strip-only compatibility.
			throw new Error(childProcessFailureDiagnostic("gh", args, error));
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

type ChildProcessError = Error & Readonly<{ stdout?: unknown; stderr?: unknown }>;

function processOutput(error: Error, stream: "stdout" | "stderr"): string {
	const value = (error as ChildProcessError)[stream];
	if (typeof value === "string") {
		return value;
	}
	if (Buffer.isBuffer(value)) {
		return value.toString("utf8");
	}
	return "";
}

function redactGitDiagnostic(value: string): string {
	// Match credential-shaped keys, including URL query parameters, without attempting arbitrary secret detection.
	return value
		.replace(/(\bBearer\s+)[^\s,;&#"'()[\]{}]+/gi, "$1[REDACTED]")
		.replace(
			/(\b(?:awsaccesskeyid|accesskeyid|awssecretaccesskey|awssecuritytoken|securitytoken|password|passwd|credential(?:s)?|auth(?:orization)?|signature|sig|x-amz-(?:signature|credential|security-token)|(?:[a-z\d]+[_-])*(?:token|key|secret|credential(?:s)?)|(?:access|api|auth|client|id|oauth|private|refresh|session)(?:token|key|secret|credential(?:s)?))\s*[:=]\s*)(?!Bearer\b)[^\s,;&#"'()[\]{}]+/gi,
			"$1[REDACTED]",
		)
		.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
}

function boundGitDiagnostic(value: string, maxLength: number): string {
	const diagnostic = redactGitDiagnostic(value).trim();
	if (diagnostic.length <= maxLength) {
		return diagnostic;
	}
	return `${diagnostic.slice(0, maxLength)}… [truncated]`;
}

function childProcessFailureDiagnostic(commandName: string, args: string[], error: Error): string {
	const message = boundGitDiagnostic(error.message, MAX_CHILD_PROCESS_ERROR_MESSAGE_LENGTH);
	const stderr = boundGitDiagnostic(processOutput(error, "stderr"), MAX_CHILD_PROCESS_OUTPUT_LENGTH);
	const stdout = boundGitDiagnostic(processOutput(error, "stdout"), MAX_CHILD_PROCESS_OUTPUT_LENGTH);
	const output: string[] = [];
	if (stderr.length > 0) {
		output.push(`stderr: ${stderr}`);
	}
	if (stdout.length > 0) {
		output.push(`stdout: ${stdout}`);
	}
	const command = args.map((arg) => boundGitDiagnostic(arg, MAX_CHILD_PROCESS_OUTPUT_LENGTH)).join(" ");
	let diagnostic = `${commandName} ${command} failed: ${message}`;
	if (output.length > 0) {
		diagnostic += `\n${output.join("\n")}`;
	}
	return diagnostic;
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
			throw new Error(childProcessFailureDiagnostic("git", args, error));
		}
		throw error;
	}
}

export { createGitWorktreeProvider };
