import { type ExecFileException, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { type DependencyPreparationReceipt, readPreparationReceipt } from "./dependency-artifacts.js";
import type { Execution, JsonValue, ValidationResult } from "./model.js";
import type { OperationContext } from "./ports.js";

const execFileAsync = promisify(execFile);

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_BUFFER = 8_000_000;
const SENSITIVE_ENVIRONMENT_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i;
export const MAX_PROVIDER_COMMENTS = 8;
export const MAX_PROVIDER_CHECKS = 8;
export const MAX_PROVIDER_COMMENT_BODY = 500;
export const MAX_PROVIDER_FIELD = 200;
const SANDBOX_DEPENDENCIES_PATHSPEC = ":(exclude)node_modules";
const BUBBLEWRAP = "bwrap";
const ISOLATED_HOME = "/tmp/khala-home";

type CommandOptions = {
	cwd: string;
	timeout: number;
	killSignal: "SIGKILL";
	maxBuffer: number;
	encoding?: "utf8";
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
};

type GitToolchain = Readonly<{
	gitExecutable: string;
	environment: NodeJS.ProcessEnv;
}>;

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

export async function sandboxToolchain(sandboxPath: string): Promise<GitToolchain> {
	const toolchain = await inheritedGitToolchain();
	const npmExecutable = await inheritedExecutable("npm", await filteredInheritedEnvironment());
	toolchain.environment["PATH"] = [
		join(sandboxPath, "node_modules", ".bin"),
		dirname(process.execPath),
		dirname(npmExecutable),
		"/usr/bin",
		"/bin",
	]
		.filter((path, index, values) => path !== "" && values.indexOf(path) === index)
		.join(delimiter);
	return toolchain;
}

async function inheritedGitToolchain(): Promise<GitToolchain> {
	const environment = await filteredInheritedEnvironment();
	return { gitExecutable: await inheritedExecutable("git", environment), environment };
}

export async function filteredInheritedEnvironment(): Promise<NodeJS.ProcessEnv> {
	const environment = sanitizedEnvironment();
	const inheritedPaths = (await Promise.all(pathValues(environment).split(delimiter).map(normalizePathEntry))).filter(
		(path) => path !== "" && !isNodeModulesBin(path),
	);
	removePathValues(environment);
	environment["PATH"] = inheritedPaths.join(delimiter);
	return environment;
}

function pathValues(environment: NodeJS.ProcessEnv): string {
	return Object.entries(environment)
		.filter(([key]) => key.toLowerCase() === "path")
		.map(([, value]) => value)
		.filter((value): value is string => value !== undefined)
		.join(delimiter);
}

function removePathValues(environment: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(environment)) {
		if (key.toLowerCase() === "path") delete environment[key];
	}
}

export async function inheritedExecutable(
	command: "git" | "npm" | "bwrap",
	environment: NodeJS.ProcessEnv,
): Promise<string> {
	const [locator, args] =
		process.platform === "win32" ? ["where.exe", [command]] : ["sh", ["-c", `command -v ${command}`]];
	const output = (await execFileAsync(locator, args, commandOptions(process.cwd(), environment))).stdout;
	const executable = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (executable === undefined || !isAbsolute(executable))
		throw new Error(`${command} executable was not found in inherited PATH.`);
	return realpath(executable);
}

async function normalizePathEntry(path: string): Promise<string> {
	const normalized = path.trim().replace(/^"|"$/g, "");
	return realpath(normalized).catch(() => normalized);
}

function isNodeModulesBin(path: string): boolean {
	const normalized = path.toLowerCase();
	return basename(normalized) === ".bin" && basename(dirname(normalized)) === "node_modules";
}

function validationShell(): string {
	return process.platform === "win32" ? (process.env["ComSpec"] ?? "cmd.exe") : "sh";
}

function validationShellArguments(command: string): readonly string[] {
	return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}

export async function git(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	toolchain?: GitToolchain,
): Promise<string> {
	return (await gitRaw(cwd, args, signal, toolchain)).trim();
}

export async function gitRaw(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	toolchain?: GitToolchain,
): Promise<string> {
	const command = toolchain ?? (await inheritedGitToolchain());
	return (await execFileAsync(command.gitExecutable, [...args], commandOptions(cwd, command.environment, signal)))
		.stdout;
}

async function isRegisteredWorktree(projectPath: string, sandboxPath: string, signal?: AbortSignal): Promise<boolean> {
	const listing = await git(projectPath, ["worktree", "list", "--porcelain"], signal);
	const expected = `worktree ${await realpath(sandboxPath)}`;
	return listing.split("\n").some((line) => line.trim() === expected);
}

export function isContainedPath(root: string, candidate: string): boolean {
	const rootRelative = relative(resolve(root), resolve(candidate));
	return rootRelative.length === 0 || (!rootRelative.startsWith("..") && !isAbsolute(rootRelative));
}

export async function isRealContainedPath(root: string, candidate: string): Promise<boolean> {
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

export async function prepareSandboxParent(root: string, path: string): Promise<void> {
	if (!isContainedPath(root, path)) throw new Error(`Sandbox ${path} is outside the worktree root.`);
	const parent = dirname(path);
	await mkdir(parent, { recursive: true });
	if (!(await isRealContainedPath(root, parent)))
		throw new Error(`Sandbox parent ${parent} is outside the worktree root.`);
}

export async function createSandbox(
	input: Readonly<{ projectPath: string; baseCommit: string }>,
	branch: string,
	path: string,
	operation: OperationContext | undefined,
): Promise<void> {
	await git(input.projectPath, ["worktree", "add", "-b", branch, path, input.baseCommit], operation?.signal);
}

export function requireAllowedPaths(allowedPaths: readonly string[]): readonly string[] {
	if (allowedPaths.length === 0) throw new Error("At least one permitted path is required to commit a sandbox.");
	return allowedPaths;
}

export async function prepareSandboxCommit(
	path: string,
	allowedPaths: readonly string[],
	signal: AbortSignal | undefined,
	artifactStore: string,
): Promise<GitToolchain> {
	const toolchain = await sandboxToolchain(path);
	await git(path, ["add", "--all", "--", ...allowedPaths, SANDBOX_DEPENDENCIES_PATHSPEC], signal, toolchain);
	await git(path, ["reset", "--quiet", "HEAD", "--", "node_modules"], signal, toolchain);
	if (!(await hasLockfile(path))) return toolchain;
	const receipt = await readPreparationReceipt(artifactStore, path);
	if (receipt === undefined) throw new Error("Dependency preparation receipt is missing.");
	await hydrateSandboxDependencies(path, signal, undefined, preparationCachePath(artifactStore, receipt));
	return toolchain;
}

export async function validationPath(root: string, input: string): Promise<string> {
	const path = await realpath(input);
	if (!(await isRealContainedPath(root, path)))
		throw new Error("Validation path is outside the configured worktree root.");
	return path;
}

export async function hydrateSandboxDependencies(
	path: string,
	signal?: AbortSignal,
	environment?: NodeJS.ProcessEnv,
	npmCache?: string,
): Promise<void> {
	if (!(await hasLockfile(path))) return;
	if (npmCache === undefined) throw new Error("Dependency preparation cache is required.");
	const cleanEnvironment = environment ?? (await filteredInheritedEnvironment());
	const resolverEnvironment = await filteredInheritedEnvironment();
	await runIsolated(
		await inheritedExecutable("npm", resolverEnvironment),
		["ci", "--ignore-scripts", "--offline", "--cache", "/tmp/khala-npm-cache"],
		path,
		cleanEnvironment,
		signal,
		npmCache,
	);
}

async function runIsolated(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
	npmCache?: string,
): Promise<{ stdout: string; stderr: string }> {
	if (process.platform !== "linux") throw new Error("Validation isolation requires Linux bubblewrap.");
	const bwrap = await validationIsolationExecutable();
	const npmPackageRoot = await validationNpmRoot(command, cwd);
	return runBubblewrap(
		bwrap,
		buildBubblewrapArgs(command, args, cwd, environment, npmPackageRoot, npmCache),
		cwd,
		isolatedEnvironment(environment),
		signal,
	);
}

async function validationIsolationExecutable(): Promise<string> {
	try {
		return await inheritedExecutable(BUBBLEWRAP, await filteredInheritedEnvironment());
	} catch (error) {
		throw new Error(
			`Validation isolation requires bubblewrap (bwrap) installed on PATH; no command was run. ${String(error)}`,
		);
	}
}

async function runBubblewrap(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const options: CommandOptions = {
			...commandOptions(cwd, environment, signal),
			encoding: "utf8",
		};
		execFile(command, [...args], options, (error: ExecFileException | null, stdout: string, stderr: string) => {
			if (error === null) resolvePromise({ stdout, stderr });
			else reject(new CommandExecutionError(error.message, stdout, stderr));
		});
	});
}

class CommandExecutionError extends Error {
	readonly stdout: string;
	readonly stderr: string;

	constructor(message: string, stdout: string, stderr: string) {
		super(message);
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

function buildBubblewrapArgs(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
	npmPackageRoot: string | undefined,
	npmCache?: string,
): string[] {
	const bwrapArgs = [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--assert-userns-disabled",
		"--cap-drop",
		"ALL",
		"--new-session",
		"--die-with-parent",
		"--clearenv",
		"--chdir",
		cwd,
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--bind",
		cwd,
		cwd,
		"--dir",
		ISOLATED_HOME,
	];
	bwrapArgs.push(...readonlyMountArguments(), ...runtimeMountArguments(npmPackageRoot, npmCache));
	const childEnvironment = {
		...isolatedEnvironment(environment),
		PATH: [join(cwd, "node_modules", ".bin"), dirname(process.execPath), "/tmp/khala-bin", "/usr/bin", "/bin"].join(
			delimiter,
		),
	};
	for (const [key, value] of Object.entries(childEnvironment))
		if (value !== undefined) bwrapArgs.push("--setenv", key, value);
	bwrapArgs.push("--", command, ...args);
	return bwrapArgs;
}

function readonlyMountArguments(): string[] {
	return ["/usr", "/bin", "/sbin", "/lib", "/lib64"].flatMap((path) => ["--ro-bind-try", path, path]);
}

function runtimeMountArguments(npmPackageRoot: string | undefined, npmCache?: string): string[] {
	const mounts = [process.execPath];
	const npmMounts =
		npmPackageRoot === undefined
			? []
			: [
					"--ro-bind",
					npmPackageRoot,
					npmPackageRoot,
					"--symlink",
					join(npmPackageRoot, "bin", "npm-cli.js"),
					"/tmp/khala-bin/npm",
					"--symlink",
					join(npmPackageRoot, "bin", "npx-cli.js"),
					"/tmp/khala-bin/npx",
				];
	return [
		...(npmCache === undefined ? [] : ["--bind", npmCache, "/tmp/khala-npm-cache"]),
		...npmMounts,
		...mounts
			.filter((path, index, values) => values.indexOf(path) === index)
			.filter(
				(path) =>
					!["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((root) => path === root || path.startsWith(`${root}/`)),
			)
			.flatMap((path) => ["--ro-bind-try", path, path]),
	];
}

async function validationNpmRoot(command: string, cwd: string): Promise<string | undefined> {
	if (basename(command) === "npm-cli.js") return npmRoot(command);
	const manifest = await lstat(join(cwd, "package.json")).catch(() => undefined);
	if (manifest === undefined) return undefined;
	return npmRoot(await inheritedExecutable("npm", await filteredInheritedEnvironment()));
}

async function npmRoot(executable: string): Promise<string> {
	let current = dirname(await realpath(executable));
	while (current !== dirname(current)) {
		if (await isNpmPackageRoot(current)) return current;
		current = dirname(current);
	}
	throw new Error(`npm package root was not found for ${executable}.`);
}

async function isNpmPackageRoot(directory: string): Promise<boolean> {
	const packageJson = await readFile(join(directory, "package.json"), "utf8").catch(() => undefined);
	if (packageJson === undefined) return false;
	const packageData: JsonValue = JSON.parse(packageJson);
	return isJsonObject(packageData) && isTextValue(packageData["name"]) && packageData["name"] === "npm";
}

export function validationIsolationFailure(commands: readonly string[], message: string): readonly ValidationResult[] {
	const checkedCommands = commands.length === 0 ? ["validation isolation"] : commands;
	return checkedCommands.map((command) => ({ command, passed: false, output: `Validation was not run: ${message}` }));
}

function isolatedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		PATH: environment["PATH"] ?? "/usr/bin:/bin",
		LANG: environment["LANG"] ?? "C",
		HOME: ISOLATED_HOME,
		TMPDIR: "/tmp",
		TMP: "/tmp",
		TEMP: "/tmp",
	};
}

export async function validateExistingSandbox(
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

export async function runValidationCommands(
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

export function validateSandboxPath(root: string, path: string): void {
	if (!isContainedPath(root, path)) throw new Error(`Sandbox ${path} is outside the worktree root.`);
}

export async function removeExistingSandbox(
	root: string,
	projectPath: string,
	sandbox: Execution["sandbox"],
	operation: OperationContext | undefined,
): Promise<void> {
	const existing = await lstat(sandbox.path).catch(() => undefined);
	if (existing === undefined) return;
	await validateRemovableSandbox(root, projectPath, sandbox.path, existing, operation);
	await git(projectPath, ["worktree", "remove", "--force", sandbox.path], operation?.signal);
}

export async function removeSandboxBranch(
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

export async function hasLockfile(path: string): Promise<boolean> {
	return (await lstat(join(path, "package-lock.json")).catch(() => undefined))?.isFile() === true;
}

export async function assertPreparationInputs(path: string, receipt: DependencyPreparationReceipt): Promise<void> {
	const [manifest, lockfile] = await Promise.all([
		readFile(join(path, "package.json"), "utf8").catch(() => undefined),
		readFile(join(path, "package-lock.json"), "utf8").catch(() => undefined),
	]);
	if (manifest === undefined || lockfile === undefined) throw new Error("Dependency preparation inputs are missing.");
	assertPreparationIdentity(manifest, lockfile, receipt);
}

function assertPreparationIdentity(manifest: string, lockfile: string, receipt: DependencyPreparationReceipt): void {
	if (digestText(manifest) !== receipt.manifestSha256 || digestText(lockfile) !== receipt.lockfileSha256)
		throw new Error("Dependency preparation is stale; package inputs changed.");
}

export async function requiredPreparationReceipt(store: string, path: string): Promise<DependencyPreparationReceipt> {
	const receipt = await readPreparationReceipt(store, path);
	if (receipt === undefined) throw new Error("Dependency preparation receipt is missing.");
	return receipt;
}

export function preparationCachePath(store: string, receipt: DependencyPreparationReceipt): string {
	return join(
		store,
		createHash("sha256")
			.update(
				`${receipt.manifestSha256}:${receipt.lockfileSha256}:${receipt.runtime.node}:${receipt.runtime.npm}:${JSON.stringify(receipt.policy)}`,
			)
			.digest("hex"),
		"npm-cache",
	);
}

function digestText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function runValidationCommand(
	command: string,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<Readonly<{ passed: boolean; output: string }>> {
	return runIsolated(validationShell(), validationShellArguments(command), cwd, environment, signal)
		.then(({ stdout }) => ({ passed: true, output: stdout.slice(-4_000) }))
		.catch((error) => ({
			passed: false,
			output: failedCommandOutput(
				error instanceof CommandExecutionError ? error.stdout : "",
				error instanceof CommandExecutionError ? error.stderr : "",
				error instanceof Error ? error.message : String(error),
			),
		}));
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

export async function run(
	command: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	try {
		return (await execFileAsync(command, [...args], commandOptions(cwd, undefined, signal))).stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${command} failed: ${message}`);
	}
}
