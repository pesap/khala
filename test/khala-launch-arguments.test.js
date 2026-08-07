import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutorStarter } from "../dist/src/executor.js";

function createVcs(root, state) {
	return {
		async createSandbox() {
			state.created += 1;
			return { path: root, name: "launch-test", projectPath: root };
		},
		async removeSandbox() {
			state.removed += 1;
		},
	};
}

function createLauncher(calls) {
	return {
		async launch(request) {
			calls.push(request);
			return {
				id: request.name,
				sandbox: request.sandbox,
				target: "observer-target",
				ready: Promise.resolve(),
			};
		},
		async focus() {},
		async close() {},
	};
}

function observerRequest(root) {
	return {
		projectPath: root,
		workId: "work-id",
		executionId: "execution-id",
		name: "Observer launch",
		executorName: "Observer",
		mission: "Observer mission",
		systemPrompt: "Observer system prompt",
		kind: "observer",
	};
}

test("default Observer argv registers Khala before internal flags and preserves model selection", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-launch-argv-default-"));
	const extensionPath = join(root, "khala-extension.ts");
	writeFileSync(extensionPath, "export default () => {};\n");
	const calls = [];
	const state = { created: 0, removed: 0 };
	try {
		const starter = createExecutorStarter(
			createVcs(root, state),
			createLauncher(calls),
			["pi"],
			"zellij",
			"provider/observer",
			["/package/skills/khala"],
			undefined,
			extensionPath,
		);
		await starter(observerRequest(root));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, "pi");
		assert.deepEqual(calls[0].args, [
			"--extension",
			extensionPath,
			"--model",
			"provider/observer",
			"--skill",
			"/package/skills/khala",
			"--system-prompt",
			"Observer system prompt",
			"--khala-system-prompt-provided",
			"--name",
			"Observer",
			"--khala-work-id",
			"work-id",
			"--khala-execution-id",
			"execution-id",
			"--khala-project-path",
			root,
			"--tools",
			"read,grep,find,ls,khala_read_archive,khala_record_learning",
			"--khala-agent-kind",
			"observer",
			"Observer mission",
		]);
		assert.equal(state.created, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("configured Pi argv preserves arguments without duplicate Khala extensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-launch-argv-configured-"));
	const extensionPath = join(root, "khala-extension.ts");
	writeFileSync(extensionPath, "export default () => {};\n");
	const calls = [];
	try {
		const starter = createExecutorStarter(
			createVcs(root, { created: 0, removed: 0 }),
			createLauncher(calls),
			["/custom/pi", "--offline", "--extension", extensionPath, "--thinking", "low"],
			"tmux",
			"provider/observer",
			[],
			undefined,
			extensionPath,
		);
		await starter(observerRequest(root));
		assert.deepEqual(calls[0].args.slice(0, 6), [
			"--offline",
			"--extension",
			extensionPath,
			"--thinking",
			"low",
			"--model",
		]);
		assert.equal(calls[0].args.filter((argument) => argument === "--extension").length, 1);
		assert.equal(calls[0].args.includes("--khala-work-id"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unavailable Khala extension fails before sandbox creation", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-launch-argv-invalid-"));
	const state = { created: 0, removed: 0 };
	try {
		assert.throws(
			() => createExecutorStarter(
				createVcs(root, state),
				createLauncher([]),
				["pi"],
				"zellij",
				"provider/observer",
				[],
				undefined,
				join(root, "missing-extension.ts"),
			),
			/Khala extension path is unavailable/,
		);
		assert.equal(state.created, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
