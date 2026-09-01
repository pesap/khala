import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

export type RuntimeRole = "conclave" | "executor" | "observer" | "oracle";

type ControllerLeaseRecord = Readonly<{
	pid: number;
	processStartTime: string | undefined;
	marker: string;
}>;

const CONTROLLER_LOCK_TIMEOUT_MS = 10_000;
const CONTROLLER_LOCK_STALE_MS = 60_000;

export class RuntimeStorage {
	readonly root: string;
	private controllerMarker: string | undefined;

	constructor(projectPath: string) {
		const project = realpathSync(resolve(projectPath));
		const projectKey = createHash("sha256").update(project).digest("hex").slice(0, 24);
		this.root = join(realpathSync(tmpdir()), "khala-runtime", projectKey);
	}

	persistentSessionPath(role: RuntimeRole, identity: string): string {
		const identityKey = createHash("sha256").update(`${role}:${identity}`).digest("hex").slice(0, 24);
		return this.ownedPath(join(this.root, "sessions", `khala-${role}-${identityKey}-session.jsonl`));
	}

	ephemeralSessionPath(): string {
		return this.ownedPath(join(this.root, "sessions", `khala-ephemeral-${randomUUID()}.jsonl`));
	}

	capabilityFilePath(): string {
		return this.ownedPath(join(this.root, "capabilities", `khala-capability-${randomUUID()}`));
	}

	launchLeasePath(sessionPath: string): string {
		return this.ownedPath(`${this.ownedPath(sessionPath)}.khala-process`);
	}

	launchLockPath(sessionPath: string): string {
		return this.ownedPath(`${this.launchLeasePath(sessionPath)}.lock`);
	}

	launchTemporaryPath(sessionPath: string): string {
		return this.ownedPath(`${this.launchLeasePath(sessionPath)}.${randomUUID()}.tmp`);
	}

	async prepare(): Promise<void> {
		for (const path of [dirname(this.root), this.root, join(this.root, "sessions"), join(this.root, "capabilities")])
			await this.ensurePrivateDirectory(path);
	}

	async acquireController(): Promise<boolean> {
		if (this.controllerMarker !== undefined) return true;
		await this.prepare();
		const marker = randomUUID();
		const lease = {
			pid: process.pid,
			processStartTime: processStartTime(process.pid),
			marker,
		} satisfies ControllerLeaseRecord;
		return withControllerLock(this, async () => {
			const path = this.controllerLeasePath();
			const existing = await readControllerLease(path);
			if (existing !== undefined && controllerLeaseIsLive(existing)) return false;
			await removeControllerLease(path);
			await writeFile(path, controllerLeaseText(lease), { encoding: "utf8", mode: 0o600, flag: "wx" });
			this.controllerMarker = marker;
			return true;
		});
	}

	async releaseController(): Promise<void> {
		const marker = this.controllerMarker;
		if (marker === undefined) return;
		this.controllerMarker = undefined;
		await withControllerLock(this, async () => {
			const current = await readControllerLease(this.controllerLeasePath());
			if (current?.marker === marker) await removeControllerLease(this.controllerLeasePath());
		});
	}

	controllerLeasePath(): string {
		return this.ownedPath(join(this.root, "controller.lease"));
	}

	controllerLockPath(): string {
		return this.ownedPath(join(this.root, "controller.lock"));
	}

	async prepareSessionFile(path: string, create = true): Promise<void> {
		const owned = this.ownedPath(path);
		await this.ensurePrivateDirectoryTree(dirname(owned));
		await this.ensurePrivateFile(owned, create);
	}

	ownedPath(path: string): string {
		assertOwnedLocation(path, this.root);
		let current = this.root;
		this.assertNotSymlink(current);
		for (const component of pathComponents(path, this.root)) {
			current = component === ".." ? dirname(current) : join(current, component);
			this.assertNotSymlink(current);
			assertInsideRoot(current, this.root);
		}
		if (current === this.root) throw new Error(`Runtime-owned path must be under ${this.root}.`);
		return current;
	}

	private async ensurePrivateDirectoryTree(path: string): Promise<void> {
		const owned = this.ownedPath(path);
		const rootRelative = relative(this.root, owned);
		let current = this.root;
		for (const component of rootRelative.split(sep)) {
			current = join(current, component);
			await this.ensurePrivateDirectory(current);
		}
	}

	private async ensurePrivateFile(path: string, create: boolean): Promise<void> {
		const entry = await this.existingEntry(path);
		if (entry === undefined) {
			if (create) await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
			return;
		}
		if (!entry.isFile()) throw new Error(`Runtime session path must be a regular file: ${path}.`);
		await chmod(path, 0o600);
	}

	private assertNotSymlink(path: string): void {
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error(`Runtime-owned path cannot contain symlinks: ${path}.`);
	}

	private async ensurePrivateDirectory(path: string): Promise<void> {
		if ((await this.existingEntry(path)) === undefined) await mkdir(path, { mode: 0o700, recursive: true });
		await this.assertPrivateDirectory(path);
		await chmod(path, 0o700);
	}

	private async assertPrivateDirectory(path: string): Promise<void> {
		const current = await this.existingEntry(path);
		if (current === undefined || !current.isDirectory())
			throw new Error(`Runtime-owned path must be a directory: ${path}.`);
	}

	private async existingEntry(path: string): Promise<Stats | undefined> {
		try {
			return await lstat(path);
		} catch (error) {
			if (error instanceof Error && isMissingFileError(error)) return undefined;
			throw error;
		}
	}
}

function assertOwnedLocation(path: string, root: string): void {
	if (!isAbsolute(path) || (path !== root && !path.startsWith(`${root}${sep}`)))
		throw new Error(`Runtime-owned path must be under ${root}.`);
}

function pathComponents(path: string, root: string): readonly string[] {
	return path
		.slice(root.length)
		.split(sep)
		.filter((component) => component.length > 0 && component !== ".");
}

function assertInsideRoot(path: string, root: string): void {
	const rootRelative = relative(root, path);
	if (
		[
			rootRelative.length === 0,
			rootRelative === "..",
			rootRelative.startsWith(`..${sep}`),
			isAbsolute(rootRelative),
		].some(Boolean)
	)
		throw new Error(`Runtime-owned path must be under ${root}.`);
}

function isMissingFileError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

async function removeControllerLease(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!(error instanceof Error) || !isMissingFileError(error)) throw error;
	}
}

async function withControllerLock<T>(storage: RuntimeStorage, operation: () => Promise<T>): Promise<T> {
	await acquireControllerLock(storage.controllerLockPath());
	try {
		return await operation();
	} finally {
		await rmdir(storage.controllerLockPath()).catch(() => undefined);
	}
}

async function acquireControllerLock(path: string): Promise<void> {
	const deadline = Date.now() + CONTROLLER_LOCK_TIMEOUT_MS;
	for (;;) {
		if (await tryCreateControllerLock(path)) return;
		if (Date.now() >= deadline) throw new Error(`Could not acquire the Khala controller lock at ${path}.`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function tryCreateControllerLock(path: string): Promise<boolean> {
	try {
		await mkdir(path, { mode: 0o700 });
		return true;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		assertControllerLockContention(error);
		if (await controllerLockIsStale(path)) await rmdir(path).catch(() => undefined);
		return false;
	}
}

function assertControllerLockContention(error: Error): void {
	if (isExistsError(error)) return;
	throw error;
}

async function controllerLockIsStale(path: string): Promise<boolean> {
	const createdAt = await stat(path)
		.then((entry) => entry.mtimeMs)
		.catch(() => Date.now());
	return Date.now() - createdAt >= CONTROLLER_LOCK_STALE_MS;
}

async function readControllerLease(path: string): Promise<ControllerLeaseRecord | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && isMissingFileError(error)) return;
		throw error;
	}
	return parseControllerLease(text);
}

function parseControllerLease(text: string): ControllerLeaseRecord | undefined {
	const lines = text.trimEnd().split("\n");
	if (lines.length !== 3) return;
	// SAFETY: the exact length check establishes that all three lease lines exist.
	const [pidText, startText, marker] = lines as [string, string, string];
	if (!validControllerLeaseFields(pidText, marker)) return;
	return { pid: Number(pidText), processStartTime: startText.length === 0 ? undefined : startText, marker };
}

function validControllerLeaseFields(pidText: string, marker: string): boolean {
	return isPositiveIntegerText(pidText) && marker.length > 0;
}

function isPositiveIntegerText(value: string): boolean {
	return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

function controllerLeaseText(lease: ControllerLeaseRecord): string {
	return `${lease.pid}\n${lease.processStartTime ?? ""}\n${lease.marker}\n`;
}

function controllerLeaseIsLive(lease: ControllerLeaseRecord): boolean {
	const currentStartTime = processStartTime(lease.pid);
	if (lease.processStartTime === undefined) return processExists(lease.pid);
	return currentStartTime === lease.processStartTime || (currentStartTime === undefined && processExists(lease.pid));
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

function processStartTime(pid: number): string | undefined {
	if (process.platform === "win32") return;
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value.length === 0 ? undefined : value;
	} catch {
		return;
	}
}

function isExistsError(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

export function createRuntimeStorage(projectPath: string): RuntimeStorage {
	return new RuntimeStorage(projectPath);
}
