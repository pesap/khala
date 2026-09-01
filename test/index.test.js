import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

const theme = { fg: (_color, text) => text };

test("user sessions show a Khala activity status in the footer", async () => {
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
		initTheme();
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
		const tools = new Map();
		const pi = {
			registerFlag() {},
			registerTool: (tool) => tools.set(tool.name, tool),
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
		assert.deepEqual(statuses.at(-1), { key: "khala-activity", text: "khala: ◇" });
		const archiveTool = tools.get("khala_read_archive");
		const archiveResult = await archiveTool.execute("unknown-work", { workId: "unknown-work" }, new AbortController().signal, undefined, context);
		assert.deepEqual(archiveResult.details.items, []);
		const collapsed = archiveTool.renderResult(archiveResult, { expanded: false, isPartial: false }, theme, {});
		assert.match(collapsed.render(120).join("\n"), /0 recent summaries through sequence 0/);
		const expanded = archiveTool.renderResult(archiveResult, { expanded: true, isPartial: false }, theme, {});
		assert.match(expanded.render(120).join("\n"), /Archive records: 0/);
		const populatedResult = {
			content: [{ type: "text", text: "Archive records: 1\n#1 signal: Completed" }],
			details: {
				items: [{ sequence: 1, kind: "signal", summary: "Completed", payload: { secret: "hidden" } }],
				asOfSequence: 1,
			},
		};
		const populatedCollapsed = archiveTool.renderResult(populatedResult, { expanded: false, isPartial: false }, theme, {});
		assert.doesNotMatch(populatedCollapsed.render(120).join("\n"), /Completed/);
		const populatedExpanded = archiveTool.renderResult(populatedResult, { expanded: true, isPartial: false }, theme, {});
		assert.match(populatedExpanded.render(120).join("\n"), /Completed/);
		assert.doesNotMatch(populatedExpanded.render(120).join("\n"), /hidden/);
		await handlers.get("session_shutdown")({});
		assert.deepEqual(statuses.at(-1), { key: "khala-activity", text: undefined });
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(join(process.cwd(), "dist", "package.json"), { force: true });
		await rm(join(process.cwd(), "dist", "system-prompts"), { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
function restoreEnvironmentVariable(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function assertSandboxPathScope(root) {
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
	assert.equal(handler({ toolName: "write", input: {} }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: join(root, "linked", "secret.txt") } }).block, true);
	assert.equal(handler({ toolName: "read", input: { path: join(root, "linked", "secret.txt") } }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } }), undefined);
	delete process.env.KHALA_SANDBOX_ROOT;
	assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } }).block, true);
	process.env.KHALA_SANDBOX_ROOT = root;
}

async function cleanupSandboxPathScope(root, outside, previousRoot, previousPaths) {
	restoreEnvironmentVariable("KHALA_SANDBOX_ROOT", previousRoot);
	restoreEnvironmentVariable("KHALA_ALLOWED_PATHS", previousPaths);
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
}

test("Executor write checks resolve symlinks before enforcing sandbox paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-path-scope-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-path-outside-"));
	await symlink(outside, join(root, "linked"));
	const previousRoot = process.env.KHALA_SANDBOX_ROOT;
	const previousPaths = process.env.KHALA_ALLOWED_PATHS;
	process.env.KHALA_SANDBOX_ROOT = root;
	process.env.KHALA_ALLOWED_PATHS = JSON.stringify(["."]);
	try {
		await assertSandboxPathScope(root);
	} finally {
		await cleanupSandboxPathScope(root, outside, previousRoot, previousPaths);
	}
});
