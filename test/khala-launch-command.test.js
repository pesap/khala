import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutorStarter } from "../dist/src/executor.js";
import { addKhalaExtension } from "../dist/src/khala-pi-command.js";

function createDependencies(root) {
	let launchRequest;
	let closeTarget;
	return {
		vcs: {
			async createSandbox() {
				return { path: root, name: "observer", projectPath: root };
			},
			async removeSandbox() {},
		},
		launcher: {
			async launch(request) {
				launchRequest = request;
				return { id: "observer-session", sandbox: request.sandbox, target: "observer-target", ready: Promise.resolve() };
			},
			async focus() {},
			async close(target) {
				closeTarget = target;
			},
		},
		getLaunchRequest() {
			return launchRequest;
		},
		getCloseTarget() {
			return closeTarget;
		},
	};
}

function observerRequest(overrides = {}) {
	return {
		projectPath: "/project",
		workId: "work",
		executionId: "execution",
		name: "Observer",
		executorName: "Observer",
		mission: "Observe this Work.",
		systemPrompt: "Observer prompt",
		kind: "observer",
		missionId: "mission",
		mandateId: "mandate",
		participantId: "observer:execution",
		...overrides,
	};
}

test("default Observer command loads Khala before internal flags", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-launch-command-default-"));
	const extensionPath = join(root, "index.ts");
	writeFileSync(extensionPath, "export default {};\n");
	const dependencies = createDependencies(root);
	try {
		const starter = createExecutorStarter(dependencies.vcs, dependencies.launcher, ["pi"], "zellij", undefined, [], undefined, extensionPath);
		const launched = await starter(observerRequest());
		const request = dependencies.getLaunchRequest();
		assert.equal(request.command, "pi");
		assert.deepEqual(request.args.slice(0, 2), ["--extension", extensionPath]);
		assert.ok(request.args.indexOf("--khala-work-id") > 1);
		assert.equal(request.args.filter((argument) => argument === "--extension").length, 1);
		await launched.cleanup();
		assert.equal(dependencies.getCloseTarget(), "observer-target");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("configured Observer command preserves arguments, model, and one Khala extension", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-launch-command-configured-"));
	const extensionPath = join(root, "index.ts");
	writeFileSync(extensionPath, "export default {};\n");
	const dependencies = createDependencies(root);
	try {
		const configuredCommand = ["pi", "--verbose", "--extension", extensionPath];
		const starter = createExecutorStarter(
			dependencies.vcs,
			dependencies.launcher,
			configuredCommand,
			"zellij",
			"observer-model",
			["/package/skills/khala"],
			"low",
			extensionPath,
		);
		await (await starter(observerRequest())).cleanup();
		const request = dependencies.getLaunchRequest();
		assert.deepEqual(request.args.slice(0, 6), [
			"--verbose",
			"--extension",
			extensionPath,
			"--model",
			"observer-model",
			"--skill",
		]);
		assert.equal(request.args[6], "/package/skills/khala");
		assert.equal(request.args.at(-1), "Observe this Work.");
		assert.equal(request.args.filter((argument) => argument === "--extension").length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unavailable or malformed Khala extension configuration fails before launch", () => {
	assert.throws(
		() => addKhalaExtension(["pi"], "/path/that/does/not/exist"),
		/Khala child extension was not found/,
	);
	const root = mkdtempSync(join(tmpdir(), "khala-launch-command-invalid-"));
	const extensionPath = join(root, "index.ts");
	writeFileSync(extensionPath, "export default {};\n");
	try {
		assert.throws(
			() => addKhalaExtension(["pi", "--extension"], extensionPath),
			/Configured Pi option '--extension' requires a value/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
