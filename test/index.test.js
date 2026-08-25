import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		await writeFile(join(process.cwd(), "dist", "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
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
