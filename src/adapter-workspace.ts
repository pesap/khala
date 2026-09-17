import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertPreparationInputs,
	createSandbox,
	filteredInheritedEnvironment,
	git,
	gitRaw,
	hasLockfile,
	hydrateSandboxDependencies,
	inheritedExecutable,
	preparationCachePath,
	prepareSandboxCommit,
	prepareSandboxParent,
	removeExistingSandbox,
	removeSandboxBranch,
	requireAllowedPaths,
	requiredPreparationReceipt,
	runValidationCommands,
	sandboxToolchain,
	validateExistingSandbox,
	validateSandboxPath,
	validationIsolationFailure,
	validationPath,
} from "./adapter-shared.js";
import {
	assertContainedWorkspace,
	prepareDependencyArtifacts,
	readPreparationReceipt,
} from "./dependency-artifacts.js";
import type { Execution, Mission, ValidationResult } from "./model.js";
import type { OperationContext, PreparationReceipt, WorkspacePort, WorkspacePreflight } from "./ports.js";

export class GitWorkspace implements WorkspacePort {
	private readonly worktreeRoot: string;
	private readonly branchPrefix: string;
	private readonly artifactStore: string;
	private projectPath: string | undefined;

	constructor(worktreeRoot: string, branchPrefix: string, projectPath?: string) {
		this.worktreeRoot = worktreeRoot;
		this.branchPrefix = branchPrefix;
		this.artifactStore = resolve(worktreeRoot, ".khala-artifacts");
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

	async prepareSandbox(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<PreparationReceipt> {
		assertContainedWorkspace(this.worktreeRoot, sandbox.path);
		const path = await validationPath(this.worktreeRoot, sandbox.path);
		const files = await readdir(path);
		if (!files.includes("package.json") && !files.includes("package-lock.json"))
			return {
				schemaVersion: 1,
				kind: "no-node",
				sandboxPath: path,
				baseCommit: sandbox.baseCommit,
				preparedAt: new Date().toISOString(),
			};
		const environment = await filteredInheritedEnvironment();
		const npm = await inheritedExecutable("npm", environment);
		const preparationInput = {
			sandboxPath: sandbox.path,
			baseCommit: sandbox.baseCommit,
			store: this.artifactStore,
			npmExecutable: npm,
			environment,
			signal: operation?.signal,
		};
		return prepareDependencyArtifacts(preparationInput);
	}

	async inspectHead(path: string, operation?: OperationContext): Promise<string> {
		return git(path, ["rev-parse", "HEAD"], operation?.signal);
	}

	async inspectChanges(
		input: Readonly<{ path: string; baseCommit: string }>,
		operation?: OperationContext,
	): Promise<readonly string[]> {
		const signal = operation?.signal;
		const outputs = await Promise.all([
			gitRaw(input.path, ["diff", "--name-only", "-z", "--no-renames", `${input.baseCommit}...HEAD`], signal),
			gitRaw(input.path, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"], signal),
			gitRaw(input.path, ["diff", "--name-only", "-z", "--no-renames"], signal),
			gitRaw(input.path, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
		]);
		return [...new Set(outputs.flatMap((output) => output.split("\0").filter((path) => path.length > 0)))];
	}

	async commitSandbox(
		input: {
			sandbox: Execution["sandbox"];
			allowedPaths: readonly string[];
			message: string;
		},
		operation?: OperationContext,
	): Promise<string> {
		await this.ensurePrepared(input.sandbox, operation);
		const toolchain = await prepareSandboxCommit(
			input.sandbox.path,
			requireAllowedPaths(input.allowedPaths),
			operation?.signal,
			this.artifactStore,
		);
		await git(input.sandbox.path, ["commit", "-m", input.message], operation?.signal, toolchain);
		return git(input.sandbox.path, ["rev-parse", "HEAD"], operation?.signal, toolchain);
	}
	async runValidation(
		input: { path: string; commands: readonly string[] },
		operation?: OperationContext,
	): Promise<readonly ValidationResult[]> {
		try {
			const path = await validationPath(this.worktreeRoot, input.path);
			const toolchain = await sandboxToolchain(path);
			if (await hasLockfile(path)) await this.prepareValidationDependencies(path, operation, toolchain.environment);
			return runValidationCommands({ ...input, path }, toolchain.environment, operation);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return validationIsolationFailure(input.commands, message);
		}
	}

	private async prepareValidationDependencies(
		path: string,
		operation: OperationContext | undefined,
		environment: NodeJS.ProcessEnv,
	): Promise<void> {
		const sandbox = { path, baseCommit: "", branch: "" };
		await this.ensurePrepared(sandbox, operation);
		const receipt = await requiredPreparationReceipt(this.artifactStore, path);
		await hydrateSandboxDependencies(
			path,
			operation?.signal,
			environment,
			preparationCachePath(this.artifactStore, receipt),
		);
	}

	private async ensurePrepared(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<void> {
		const receipt = await readPreparationReceipt(this.artifactStore, sandbox.path);
		if (receipt === undefined) return this.prepareSandbox(sandbox, operation).then(() => undefined);
		await assertPreparationInputs(sandbox.path, receipt);
	}

	async publishSandbox(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<string> {
		const toolchain = await sandboxToolchain(sandbox.path);
		await git(sandbox.path, ["push", "--set-upstream", "origin", sandbox.branch], operation?.signal, toolchain);
		return git(sandbox.path, ["rev-parse", "HEAD"], operation?.signal, toolchain);
	}
	async removeSandbox(sandbox: Execution["sandbox"], operation?: OperationContext): Promise<void> {
		const projectPath = this.projectPath;
		if (projectPath === undefined) throw new Error("Workspace project path is not initialized.");
		validateSandboxPath(this.worktreeRoot, sandbox.path);
		await removeExistingSandbox(this.worktreeRoot, projectPath, sandbox, operation);
		await removeSandboxBranch(projectPath, sandbox.branch, operation);
	}
}
