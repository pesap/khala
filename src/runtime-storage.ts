import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type RuntimeRole = "conclave" | "executor" | "observer" | "oracle";

export class RuntimeStorage {
	readonly root: string;

	constructor(projectPath: string) {
		const projectKey = createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 24);
		this.root = join(tmpdir(), "khala-runtime", projectKey);
	}

	persistentSessionPath(role: RuntimeRole, identity: string): string {
		const identityKey = createHash("sha256").update(`${role}:${identity}`).digest("hex").slice(0, 24);
		return join(this.root, "sessions", `khala-${role}-${identityKey}-session.jsonl`);
	}

	ephemeralSessionPath(): string {
		return join(this.root, "sessions", `khala-ephemeral-${randomUUID()}.jsonl`);
	}

	capabilityFilePath(): string {
		return join(this.root, "capabilities", `khala-capability-${randomUUID()}`);
	}

	launchLeasePath(sessionPath: string): string {
		this.assertOwned(sessionPath);
		return `${sessionPath}.khala-process`;
	}

	launchLockPath(sessionPath: string): string {
		return `${this.launchLeasePath(sessionPath)}.lock`;
	}

	launchTemporaryPath(sessionPath: string): string {
		return `${this.launchLeasePath(sessionPath)}.${randomUUID()}.tmp`;
	}

	assertOwned(path: string): void {
		const rootRelative = relative(this.root, resolve(path));
		if (rootRelative.length === 0 || rootRelative.startsWith("..") || isAbsolute(rootRelative))
			throw new Error(`Runtime-owned path must be under ${this.root}.`);
	}
}

export function createRuntimeStorage(projectPath: string): RuntimeStorage {
	return new RuntimeStorage(projectPath);
}
