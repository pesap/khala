import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimeRole = "conclave" | "executor" | "observer" | "oracle";

export class RuntimeStorage {
	readonly root: string;

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

export function createRuntimeStorage(projectPath: string): RuntimeStorage {
	return new RuntimeStorage(projectPath);
}
