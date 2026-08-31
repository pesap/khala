import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimeRole = "conclave" | "executor" | "observer" | "oracle";

export class RuntimeStorage {
	readonly root: string;

	constructor(projectPath: string) {
		const canonicalProjectPath = realpathSync(resolve(projectPath));
		const projectKey = createHash("sha256").update(canonicalProjectPath).digest("hex").slice(0, 24);
		this.root = join(realpathSync(tmpdir()), "khala-runtime", projectKey);
	}

	persistentSessionPath(role: RuntimeRole, identity: string): string {
		const identityKey = createHash("sha256").update(`${role}:${identity}`).digest("hex").slice(0, 24);
		return this.runtimePath(join(this.root, "sessions", `khala-${role}-${identityKey}-session.jsonl`));
	}

	ephemeralSessionPath(): string {
		return this.runtimePath(join(this.root, "sessions", `khala-ephemeral-${randomUUID()}.jsonl`));
	}

	capabilityFilePath(): string {
		return this.runtimePath(join(this.root, "capabilities", `khala-capability-${randomUUID()}`));
	}

	launchLeasePath(sessionPath: string): string {
		this.assertOwned(sessionPath);
		return this.runtimePath(`${sessionPath}.khala-process`);
	}

	launchLockPath(sessionPath: string): string {
		return this.runtimePath(`${this.launchLeasePath(sessionPath)}.lock`);
	}

	launchTemporaryPath(sessionPath: string): string {
		return this.runtimePath(`${this.launchLeasePath(sessionPath)}.${randomUUID()}.tmp`);
	}

	async prepare(): Promise<void> {
		for (const path of [join(this.root, ".."), this.root, join(this.root, "sessions"), join(this.root, "capabilities")])
			await this.ensurePrivateDirectory(path);
	}

	async prepareSessionFile(path: string, create = true): Promise<void> {
		this.assertOwned(path);
		await this.ensurePrivateDirectoryTree(resolve(path, ".."));
		await this.ensurePrivateFile(path, create);
	}

	assertOwned(path: string): void {
		const resolvedPath = resolve(path);
		const rootRelative = relative(this.root, resolvedPath);
		if (rootRelative.length === 0 || rootRelative.startsWith("..") || isAbsolute(rootRelative))
			throw new Error(`Runtime-owned path must be under ${this.root}.`);
		this.assertNoSymlinkComponents(resolvedPath);
	}

	private runtimePath(path: string): string {
		this.assertOwned(path);
		return path;
	}

	private assertNoSymlinkComponents(path: string): void {
		let current = this.root;
		this.assertNotSymlink(current);
		for (const component of relative(this.root, path).split(sep)) {
			current = join(current, component);
			this.assertNotSymlink(current);
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

	private async ensurePrivateDirectoryTree(path: string): Promise<void> {
		const rootRelative = relative(this.root, resolve(path));
		if (rootRelative.length === 0) return;
		this.assertUnderRoot(rootRelative);
		let current = this.root;
		for (const component of rootRelative.split(sep)) {
			current = join(current, component);
			await this.ensurePrivateDirectory(current);
		}
	}

	private assertUnderRoot(rootRelative: string): void {
		if (rootRelative.startsWith("..") || isAbsolute(rootRelative))
			throw new Error(`Runtime-owned path must be under ${this.root}.`);
	}

	private async ensurePrivateDirectory(path: string): Promise<void> {
		const existing = await this.existingEntry(path);
		if (existing !== undefined && !existing.isDirectory())
			throw new Error(`Runtime-owned path must be a directory: ${path}.`);
		if (existing === undefined) await mkdir(path, { mode: 0o700 });
		await chmod(path, 0o700);
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

function isMissingFileError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

export function createRuntimeStorage(projectPath: string): RuntimeStorage {
	return new RuntimeStorage(projectPath);
}
