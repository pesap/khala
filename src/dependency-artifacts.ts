import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import Value from "typebox/value";
import type { DependencyPreparationReceipt } from "./ports.js";

const execFileAsync = promisify(execFile);

export type { DependencyPreparationReceipt } from "./ports.js";

export const DEPENDENCY_POLICY: DependencyPreparationReceipt["policy"] = {
	registries: ["registry.npmjs.org"] as const,
	maxArtifactBytes: 52428800,
	maxPreparationBytes: 524288000,
	maxConcurrentDownloads: 2,
	timeoutMs: 120_000,
} as const;

type Lockfile = Static<typeof lockfileSchema>;
type Receipt = Static<typeof receiptSchema>;
type NpmIsolation = Readonly<{ cwd: string; home: string; userConfig: string; globalConfig: string }>;

const lockPackageSchema = Type.Object(
	{
		resolved: Type.Optional(Type.String({ minLength: 1 })),
		integrity: Type.Optional(Type.String({ minLength: 1 })),
		link: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);
const lockfileSchema = Type.Object(
	{ packages: Type.Record(Type.String(), lockPackageSchema) },
	{ additionalProperties: true },
);
const policySchema = Type.Object({
	registries: Type.Tuple([Type.Literal("registry.npmjs.org")]),
	maxArtifactBytes: Type.Number({ exclusiveMinimum: 0 }),
	maxPreparationBytes: Type.Number({ exclusiveMinimum: 0 }),
	maxConcurrentDownloads: Type.Number({ exclusiveMinimum: 0 }),
	timeoutMs: Type.Number({ exclusiveMinimum: 0 }),
});
const receiptSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	sandboxPath: Type.String({ minLength: 1 }),
	baseCommit: Type.String(),
	manifestSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	lockfileSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	runtime: Type.Object({ node: Type.String(), npm: Type.String() }),
	policy: policySchema,
	artifactDigests: Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	preparedAt: Type.String(),
});

export function preparationIdentity(sandboxPath: string): string {
	return createHash("sha256").update(resolve(sandboxPath)).digest("hex").slice(0, 32);
}
export function preparationReceiptPath(store: string, sandboxPath: string): string {
	return join(store, preparationIdentity(sandboxPath), "receipt.json");
}

export async function prepareDependencyArtifacts(
	input: Readonly<{
		sandboxPath: string;
		baseCommit: string;
		store: string;
		npmExecutable: string;
		environment: NodeJS.ProcessEnv;
		signal: AbortSignal | undefined;
	}>,
): Promise<DependencyPreparationReceipt> {
	const deadline = preparationSignal(input.signal);
	const manifestPath = join(input.sandboxPath, "package.json");
	const lockfilePath = join(input.sandboxPath, "package-lock.json");
	const [manifest, lockfileText] = await Promise.all([
		readWorkspaceMetadata(manifestPath, deadline),
		readWorkspaceMetadata(lockfilePath, deadline),
	]);
	const lock = parseLockfile(lockfileText);
	const manifestSha256 = digest(manifest);
	const lockfileSha256 = digest(lockfileText);
	const runtimeIsolation = await createNpmIsolation(join(input.store, ".npm-runtime"));
	const runtime = await npmRuntime(input.npmExecutable, input.environment, deadline, runtimeIsolation);
	const identity = createHash("sha256")
		.update(`${manifestSha256}:${lockfileSha256}:${runtime.node}:${runtime.npm}:${JSON.stringify(DEPENDENCY_POLICY)}`)
		.digest("hex");
	const cache = join(input.store, identity, "npm-cache");
	await privateDirectory(cache);
	const npmIsolation = await createNpmIsolation(cache);
	let totalBytes = 0;
	const artifacts: string[] = [];
	await validateWorkspaceLinks(lock, input.sandboxPath);
	const remoteEntries = Object.entries(lock.packages).filter(
		([, value]) => value.resolved !== undefined && value.link !== true,
	);
	for (let offset = 0; offset < remoteEntries.length; offset += DEPENDENCY_POLICY.maxConcurrentDownloads) {
		const batch = remoteEntries.slice(offset, offset + DEPENDENCY_POLICY.maxConcurrentDownloads);
		const results = await Promise.all(
			batch.map(async ([name, value]) => {
				const resolved = requireText(value.resolved, `${name} resolved`);
				const integrity = requireText(value.integrity, `${name} integrity`);
				const artifact = await acquireArtifact({
					name,
					resolved,
					integrity,
					sandboxPath: input.sandboxPath,
					store: input.store,
					signal: deadline,
				});
				totalBytes += artifact.bytes;
				if (totalBytes > DEPENDENCY_POLICY.maxPreparationBytes)
					throw new PreparationError("preparation-size", "The dependency preparation size limit was exceeded.");
				await npmCacheAdd(input.npmExecutable, artifact.path, cache, input.environment, deadline, npmIsolation);
				return artifact.digest;
			}),
		);
		artifacts.push(...results);
	}
	await npmCacheVerify(input.npmExecutable, cache, input.environment, deadline, npmIsolation);
	const receipt: DependencyPreparationReceipt = {
		schemaVersion: 1,
		sandboxPath: resolve(input.sandboxPath),
		baseCommit: input.baseCommit,
		manifestSha256,
		lockfileSha256,
		runtime,
		policy: DEPENDENCY_POLICY,
		artifactDigests: [...new Set(artifacts)].sort(),
		preparedAt: new Date().toISOString(),
	};
	const receiptPath = preparationReceiptPath(input.store, input.sandboxPath);
	await privateDirectory(dirname(receiptPath));
	await publishReceipt(receiptPath, `${JSON.stringify(receipt)}\n`);
	return receipt;
}

async function validateWorkspaceLinks(lock: Lockfile, sandboxPath: string): Promise<void> {
	const root = await realpath(sandboxPath);
	for (const entry of Object.values(lock.packages)) {
		if (entry.link !== true) continue;
		const target = resolve(root, requireText(entry.resolved, "workspace link resolved"));
		assertContainedWorkspace(root, target);
		const actual = await realpath(target);
		if (!isContainedPath(root, actual))
			throw new PreparationError("workspace-path", "A workspace dependency link escapes the authorized workspace.");
	}
}

async function readWorkspaceMetadata(path: string, signal: AbortSignal): Promise<string> {
	await assertNoSymlinkAncestors(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 8_000_000)
			throw new PreparationError("manifest", "Dependency metadata must be a regular file within the 8 MB bound.");
		return await file.readFile({ encoding: "utf8", signal });
	} finally {
		await file.close();
	}
}

export async function readPreparationReceipt(
	store: string,
	sandboxPath: string,
): Promise<DependencyPreparationReceipt | undefined> {
	const value = await readReceiptText(preparationReceiptPath(store, sandboxPath));
	return value === undefined ? undefined : parseReceipt(value, sandboxPath);
}

async function readReceiptText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && isMissingReceiptError(error)) return undefined;
		throw new PreparationError("receipt", "The preparation receipt could not be read.");
	}
}
function isMissingReceiptError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}
function parseReceipt(value: string, sandboxPath: string): DependencyPreparationReceipt {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
		return validateReceipt(Value.Parse(receiptSchema, parsed), sandboxPath);
	} catch {
		throw new PreparationError("receipt", "The preparation receipt is invalid.");
	}
}

export function assertContainedWorkspace(root: string, candidate: string): void {
	const rootPath = resolve(root);
	const candidatePath = resolve(candidate);
	if (relative(rootPath, candidatePath).startsWith("..") || resolve(rootPath, candidatePath) !== candidatePath)
		throw new PreparationError("workspace-path", "A dependency path escapes the authorized workspace.");
}
export class PreparationError extends Error {
	readonly operation: string;
	constructor(operation: string, message: string) {
		super(message);
		this.name = "PreparationError";
		this.operation = operation;
	}
}

type ArtifactInput = Readonly<{
	name: string;
	resolved: string;
	integrity: string;
	sandboxPath: string;
	store: string;
	signal: AbortSignal;
}>;
type Artifact = Readonly<{ path: string; digest: string; bytes: number }>;
async function acquireArtifact(input: ArtifactInput): Promise<Artifact> {
	return input.resolved.startsWith("file:") ? acquireLocalArtifact(input) : acquireRemoteArtifact(input);
}
async function acquireLocalArtifact(input: ArtifactInput): Promise<Artifact> {
	const path = resolve(input.sandboxPath, decodeURIComponent(input.resolved.slice(5)));
	assertContainedWorkspace(input.sandboxPath, path);
	const workspace = await realpath(input.sandboxPath).catch(() => {
		throw new PreparationError("local-artifact", "The workspace is inaccessible.");
	});
	const parent = await localArtifactParent(path, input.name);
	if (!isContainedPath(workspace, parent))
		throw new PreparationError("workspace-path", "A dependency path escapes the authorized workspace.");
	const bytes = await localArtifactSize(path, input.name);
	if (bytes > DEPENDENCY_POLICY.maxArtifactBytes)
		throw new PreparationError("artifact-size", `${input.name} exceeds the artifact size limit.`);
	await verifyIntegrity(path, input.integrity, input.name);
	return { path, digest: digest(input.integrity), bytes };
}
async function localArtifactParent(path: string, name: string): Promise<string> {
	return realpath(dirname(path)).catch(() => {
		throw new PreparationError("local-artifact", `${name} has an inaccessible parent.`);
	});
}
async function localArtifactSize(path: string, name: string): Promise<number> {
	const entry = await lstat(path).catch(() => undefined);
	if (entry === undefined || !entry.isFile() || entry.isSymbolicLink())
		throw new PreparationError("local-artifact", `${name} is not a regular workspace file.`);
	return entry.size;
}
async function acquireRemoteArtifact(input: ArtifactInput): Promise<Artifact> {
	checkedRegistryUrl(input.resolved);
	const artifactPath = join(input.store, "downloads", `${digest(input.integrity)}.tgz`);
	await privateDirectory(join(input.store, "downloads"));
	const existing = await cachedArtifactEntry(artifactPath);
	return existing === undefined
		? downloadArtifact(input, artifactPath)
		: verifyCachedArtifact(input, artifactPath, existing.size);
}
async function verifyCachedArtifact(input: ArtifactInput, path: string, bytes: number): Promise<Artifact> {
	if (bytes > DEPENDENCY_POLICY.maxArtifactBytes)
		throw new PreparationError("artifact-size", `${input.name} exceeds the artifact size limit.`);
	await verifyIntegrity(path, input.integrity, input.name);
	return { path, digest: digest(input.integrity), bytes };
}
async function cachedArtifactEntry(path: string): Promise<{ size: number } | undefined> {
	const entry = await lstat(path).catch(() => undefined);
	if (entry === undefined) return undefined;
	if (entry.isSymbolicLink() || !entry.isFile())
		throw new PreparationError("cache", "The cached dependency artifact is not a regular file.");
	return { size: entry.size };
}
async function publishArtifact(temporary: string, target: string, input: ArtifactInput): Promise<void> {
	try {
		await link(temporary, target);
	} catch {
		const existing = await cachedArtifactEntry(target);
		if (existing === undefined) throw preparationFailure(input.name);
		await verifyCachedArtifact(input, target, existing.size);
	}
}
async function downloadArtifact(input: ArtifactInput, artifactPath: string): Promise<Artifact> {
	const temporary = `${artifactPath}.${nanoid()}.tmp`;
	try {
		const result = await downloadArtifactBody(input, temporary);
		await publishArtifact(temporary, artifactPath, input);
		return { path: artifactPath, digest: digest(input.integrity), bytes: result.bytes };
	} catch (error) {
		throw error instanceof PreparationError ? error : preparationFailure(input.name);
	} finally {
		await rm(temporary, { force: true });
	}
}
async function downloadArtifactBody(input: ArtifactInput, path: string): Promise<{ digest: string; bytes: number }> {
	const response = await fetch(checkedRegistryUrl(input.resolved), { redirect: "manual", signal: input.signal });
	const body = requireDownloadBody(response, input.name);
	const result = await streamArtifact(body, path, input);
	assertDownloadedIntegrity(result.digest, input.integrity, input.name);
	return result;
}
function requireDownloadBody(response: Response, name: string): ReadableStream<Uint8Array> {
	if (!response.ok || response.status >= 300)
		throw new PreparationError("download", `Dependency ${name} was not downloaded (${response.status}).`);
	if (response.body === null) throw new PreparationError("download", `Dependency ${name} returned no body.`);
	return response.body;
}
function assertDownloadedIntegrity(actual: string, expected: string, name: string): void {
	if (actual !== expected) throw new PreparationError("integrity", `Integrity verification failed for ${name}.`);
}
function preparationSignal(signal: AbortSignal | undefined): AbortSignal {
	const deadline = AbortSignal.timeout(DEPENDENCY_POLICY.timeoutMs);
	return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}
function checkedArtifactBytes(current: number, added: number, name: string): number {
	const total = current + added;
	if (total > DEPENDENCY_POLICY.maxArtifactBytes)
		throw new PreparationError("artifact-size", `${name} exceeds the artifact size limit.`);
	return total;
}
function preparationFailure(name: string): PreparationError {
	return new PreparationError("download", `Dependency ${name} could not be acquired.`);
}
async function streamArtifact(
	body: ReadableStream<Uint8Array>,
	path: string,
	input: ArtifactInput,
): Promise<{ digest: string; bytes: number }> {
	const hash = createHash("sha512");
	const progress = { bytes: 0 };
	// Pipeline owns backpressure, abort propagation, and errors from opening the output file.
	await pipeline(
		Readable.from(body),
		(source: AsyncIterable<Uint8Array>) => countedChunks(source, input.name, hash, progress),
		createWriteStream(path, { mode: 0o600, flags: "wx" }),
		{ signal: input.signal },
	);
	return { digest: `sha512-${hash.digest("base64")}`, bytes: progress.bytes };
}

type TransferProgress = { bytes: number };
async function* countedChunks(
	source: AsyncIterable<Uint8Array>,
	name: string,
	hash: Hash,
	progress: TransferProgress,
): AsyncGenerator<Uint8Array> {
	for await (const chunk of source) {
		progress.bytes = checkedArtifactBytes(progress.bytes, chunk.byteLength, name);
		hash.update(chunk);
		yield chunk;
	}
}

function checkedRegistryUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PreparationError("registry-url", "Dependency URL is invalid.");
	}
	if (
		![
			url.protocol === "https:",
			url.hostname === "registry.npmjs.org",
			!url.username,
			!url.password,
			!url.port,
			!url.hash,
		].every(Boolean)
	)
		throw new PreparationError("registry-url", "Dependency URL is outside the approved npm registry policy.");
	return url.toString();
}
async function verifyIntegrity(path: string, integrity: string, name: string): Promise<void> {
	if (!integrity.startsWith("sha512-"))
		throw new PreparationError("integrity", `Unsupported integrity for ${basename(path)}.`);
	const actual = await integrityOfFile(path, name);
	if (actual !== integrity) throw new PreparationError("integrity", `Integrity verification failed for ${name}.`);
}
async function integrityOfFile(path: string, name: string): Promise<string> {
	const hash = createHash("sha512");
	let bytes = 0;
	try {
		for await (const chunk of createReadStream(path)) {
			bytes = checkedArtifactBytes(bytes, chunk.length, name);
			hash.update(chunk);
		}
	} catch {
		throw new PreparationError("integrity", `Could not verify ${name}.`);
	}
	return `sha512-${hash.digest("base64")}`;
}

async function npmCacheAdd(
	npm: string,
	artifact: string,
	cache: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
	isolation: NpmIsolation,
): Promise<void> {
	await npmCommand(
		npm,
		["cache", "add", artifact, "--cache", cache, "--offline", "--ignore-scripts"],
		environment,
		signal,
		isolation,
	);
}
async function npmCacheVerify(
	npm: string,
	cache: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
	isolation: NpmIsolation,
): Promise<void> {
	await npmCommand(
		npm,
		["cache", "verify", "--cache", cache, "--offline", "--ignore-scripts"],
		environment,
		signal,
		isolation,
	);
}
async function npmRuntime(
	npm: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
	isolation: NpmIsolation,
): Promise<{ node: string; npm: string }> {
	return {
		node: process.versions.node,
		npm: (await npmCommand(npm, ["--version", "--offline", "--ignore-scripts"], environment, signal, isolation)).trim(),
	};
}
async function npmCommand(
	npm: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
	isolation: NpmIsolation,
): Promise<string> {
	try {
		return (
			await execFileAsync(npm, [...args, "--prefix", isolation.cwd], {
				cwd: isolation.cwd,
				env: npmEnvironment(environment, isolation),
				signal,
				maxBuffer: 2_000_000,
				encoding: "utf8",
			})
		).stdout;
	} catch (error) {
		throw new PreparationError("npm", error instanceof Error ? error.message : String(error));
	}
}
function npmEnvironment(environment: NodeJS.ProcessEnv, isolation: NpmIsolation): NodeJS.ProcessEnv {
	const clean = { ...environment };
	for (const key of Object.keys(clean)) if (key.toLowerCase().startsWith("npm_config_")) delete clean[key];
	return {
		...clean,
		HOME: isolation.home,
		npm_config_userconfig: isolation.userConfig,
		npm_config_globalconfig: isolation.globalConfig,
		npm_config_ignore_scripts: "true",
		npm_config_offline: "true",
	};
}
async function createNpmIsolation(cache: string): Promise<NpmIsolation> {
	const home = join(cache, "npm-home");
	const cwd = join(cache, "npm-cwd");
	await privateDirectory(home);
	await privateDirectory(cwd);
	const userConfig = join(home, ".npmrc");
	const globalConfig = join(home, "global.npmrc");
	await privateFile(userConfig, "");
	await privateFile(globalConfig, "");
	return { cwd, home, userConfig, globalConfig };
}
async function privateDirectory(path: string): Promise<void> {
	await assertNoSymlinkAncestors(path);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const normalized = resolve(path);
	if ((await realpath(normalized).catch(() => undefined)) !== normalized)
		throw new PreparationError("filesystem", `${path} contains a symbolic-link directory.`);
	const info = await lstat(normalized);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new PreparationError("filesystem", `${path} is not a private directory.`);
	await chmod(normalized, 0o700);
}
async function assertNoSymlinkAncestors(path: string): Promise<void> {
	const target = resolve(path);
	let current = target;
	while (current !== dirname(current)) {
		await assertSafeAncestor(current, target, path);
		current = dirname(current);
	}
}
async function assertSafeAncestor(current: string, target: string, path: string): Promise<void> {
	const info = await lstat(current).catch(() => undefined);
	if (info === undefined) return;
	if (info.isSymbolicLink() || unsafeAncestorType(info.isDirectory(), current, target))
		throw new PreparationError("filesystem", `${path} contains an unsafe parent.`);
}
function unsafeAncestorType(isDirectory: boolean, current: string, target: string): boolean {
	return !isDirectory && current !== target;
}
async function privateFile(path: string, content: string): Promise<void> {
	const existing = await lstat(path).catch(() => undefined);
	if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile()))
		throw new PreparationError("filesystem", `${path} is not a regular private file.`);
	await writeFile(path, content, { mode: 0o600 });
}
function parseLockfile(value: string): Lockfile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new PreparationError("lockfile", "package-lock.json is invalid JSON.");
	}
	try {
		return Value.Parse(lockfileSchema, parsed);
	} catch {
		throw new PreparationError("lockfile", "package-lock.json does not contain a supported packages map.");
	}
}
function requireText(value: string | undefined, label: string): string {
	if (value === undefined || value.length === 0)
		throw new PreparationError("lockfile", `${label} is missing or unsupported.`);
	return value;
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function isContainedPath(root: string, candidate: string): boolean {
	const part = relative(resolve(root), resolve(candidate));
	return part === "" || (!part.startsWith("..") && !part.startsWith("/"));
}
async function publishReceipt(path: string, content: string): Promise<void> {
	await assertNoSymlinkAncestors(path);
	const existing = await lstat(path).catch(() => undefined);
	if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile()))
		throw new PreparationError("filesystem", `${path} is not a regular private file.`);
	const temporary = `${path}.${nanoid()}.tmp`;
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function validateReceipt(value: Receipt, sandboxPath: string): DependencyPreparationReceipt {
	if (value.sandboxPath !== resolve(sandboxPath))
		throw new PreparationError("receipt", "The preparation receipt belongs to another sandbox.");
	return value satisfies DependencyPreparationReceipt;
}
