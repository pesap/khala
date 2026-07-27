import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { Sandbox, SandboxRequest } from "./executor.js";
import { VCSProvider } from "./vcs.js";

const execFileAsync = promisify(execFile);
const MAX_SANDBOX_NAME_LENGTH = 48;
const NAME_RADIX = 36;
const RANDOM_SUFFIX_LENGTH = 8;

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
		return { path: sandboxPath, name };
	}

	override async removeSandbox(sandbox: Sandbox): Promise<void> {
		await git(sandbox.path, ["worktree", "remove", "--force", sandbox.path]);
		await git(this.#worktreeRoot, ["branch", "-D", `${this.#branchPrefix}${sandbox.name}`]);
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
