import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const theme = { fg: (_color, text) => text };

test("user sessions show a branded Executor status in the footer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-footer-status-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "khala.json"), JSON.stringify({ archiveRoot: join(directory, "archive") }));
		const packagePath = join(process.cwd(), "dist", "package.json");
		const temporaryPackagePath = `${packagePath}.${process.pid}.tmp`;
		await writeFile(temporaryPackagePath, JSON.stringify({ version: "1.0.0", type: "module" }));
		await rename(temporaryPackagePath, packagePath);
		await mkdir(join(process.cwd(), "dist", "system-prompts"), { recursive: true });
		for (const prompt of ["conclave.md", "executor.md", "observer.md", "oracle.md"]) {
			await copyFile(join(process.cwd(), "system-prompts", prompt), join(process.cwd(), "dist", "system-prompts", prompt));
		}
		const { default: khalaExtension, summarizeToolError } = await import("../dist/src/index.js");
		assert.equal(
			summarizeToolError({
				summary: "Runtime failed; the child exited.",
				remediation: "Inspect Evidence; do not restart the primary Pi session.",
				evidenceRefs: [],
			}),
			"Error: Runtime failed. The child exited.\nNext step: Inspect Evidence. Do not restart the primary Pi session.",
		);
		const handlers = new Map();
		const statuses = [];
		const notices = [];
		const pi = {
			registerFlag() {},
			registerTool() {},
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			getFlag() {
				return undefined;
			},
			getActiveTools() {
				return [];
			},
			setActiveTools() {},
		};
		khalaExtension(pi);
		assert.equal(await handlers.get("before_agent_start")({ systemPrompt: "base" }), undefined);
		const context = {
			cwd: directory,
			isProjectTrusted: () => false,
			ui: {
				theme,
				setStatus: (key, text) => statuses.push({ key, text }),
				notify: (message) => notices.push(message),
			},
		};
		await handlers.get("session_start")({}, context);
		assert.deepEqual(notices, []);
		assert.deepEqual(statuses.at(-1), { key: "khala-executors", text: "khala: idle" });
		await handlers.get("session_shutdown")({});
		assert.deepEqual(statuses.at(-1), { key: "khala-executors", text: undefined });
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(join(process.cwd(), "dist", "package.json"), { force: true });
		await rm(join(process.cwd(), "dist", "system-prompts"), { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

// oxlint-disable-next-line complexity
test("Executor write checks resolve symlinks before enforcing sandbox paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-path-scope-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-path-outside-"));
	await symlink(outside, join(root, "linked"));
	const previousRoot = process.env.KHALA_SANDBOX_ROOT;
	const previousPaths = process.env.KHALA_ALLOWED_PATHS;
	process.env.KHALA_SANDBOX_ROOT = root;
	process.env.KHALA_ALLOWED_PATHS = JSON.stringify(["."]);
	try {
		const { default: khalaExtension } = await import("../dist/src/index.js");
		const handlers = new Map();
		const pi = {
			registerFlag() {},
			registerTool() {},
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			getFlag() {
				return "executor";
			},
			getActiveTools() {
				return [];
			},
			setActiveTools() {},
		};
		khalaExtension(pi);
		const handler = handlers.get("tool_call");
		assert.equal(handler({ toolName: "write", input: {} })?.block, true);
		assert.equal(handler({ toolName: "write", input: { path: join(root, "linked", "secret.txt") } })?.block, true);
		assert.equal(handler({ toolName: "read", input: { path: join(root, "linked", "secret.txt") } })?.block, true);
		assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } }), undefined);
		delete process.env.KHALA_SANDBOX_ROOT;
		assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } })?.block, true);
		process.env.KHALA_SANDBOX_ROOT = root;
	} finally {
		if (previousRoot === undefined) delete process.env.KHALA_SANDBOX_ROOT;
		else process.env.KHALA_SANDBOX_ROOT = previousRoot;
		if (previousPaths === undefined) delete process.env.KHALA_ALLOWED_PATHS;
		else process.env.KHALA_ALLOWED_PATHS = previousPaths;
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
