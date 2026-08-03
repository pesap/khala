import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { createExecutorStarter } from "../dist/src/executor.js";
import { createZellijLauncher } from "../dist/src/launch-zellij.js";
import { waitForStartup } from "../dist/src/launcher.js";

function runBootstrap(markerPath, code) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["dist/src/executor-bootstrap.js", markerPath, process.execPath, "-e", code], {
			stdio: "ignore",
		});
		child.once("exit", (exitCode) => resolve(exitCode));
	});
}

test("Observer bootstrap reports child readiness without shell interpretation", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-startup-success-"));
	const marker = join(root, "startup-marker");
	try {
		const child = runBootstrap(marker, "require('node:fs').writeFileSync(process.env.KHALA_STARTUP_MARKER, 'ready')");
		await waitForStartup(marker);
		assert.equal(await child, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Observer bootstrap reports a child exit during startup", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-startup-failure-"));
	const marker = join(root, "startup-marker");
	try {
		const child = runBootstrap(marker, "process.exit(7)");
		await assert.rejects(waitForStartup(marker), /exited during startup/);
		assert.equal(await child, 7);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Zellij closes a created Observer tab and removes the sandbox when the child exits", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-zellij-startup-"));
	const bin = join(root, "bin");
	const zellij = join(bin, "zellij");
	mkdirSync(bin);
	writeFileSync(zellij, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("new-tab")) {
  process.stdout.write("tab-7\\n");
  const separator = args.indexOf("--");
  spawn(args[separator + 1], args.slice(separator + 2), { stdio: "ignore" });
}
`);
	chmodSync(zellij, 0o755);
	const previousPath = process.env.PATH;
	const previousZellij = process.env.ZELLIJ;
	const previousZellijSession = process.env.ZELLIJ_SESSION_NAME;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.ZELLIJ = "session-marker";
	process.env.ZELLIJ_SESSION_NAME = "session-marker";
	let removed = false;
	let closed = false;
	try {
		const launcher = createZellijLauncher();
		const originalClose = launcher.close.bind(launcher);
		const starter = createExecutorStarter(
			{
				async createSandbox() {
					return { path: root, name: "child-failure", projectPath: root };
				},
				async removeSandbox() {
					removed = true;
				},
			},
			{
				launch: launcher.launch.bind(launcher),
				focus: launcher.focus.bind(launcher),
				async close(target) {
					closed = target === "session-marker:tab-7";
					await originalClose(target);
				},
			},
			[process.execPath, "-e", "process.exit(3)"],
		);
		await assert.rejects(
			starter({
				projectPath: root,
				workId: "work-zellij",
				executionId: "execution-zellij",
				name: "Zellij child failure",
				executorName: "Observer",
				mission: "",
				systemPrompt: "",
				kind: "observer",
			}),
			/exited during startup/,
		);
		assert.equal(closed, true);
		assert.equal(removed, true);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousZellij === undefined) delete process.env.ZELLIJ;
		else process.env.ZELLIJ = previousZellij;
		if (previousZellijSession === undefined) delete process.env.ZELLIJ_SESSION_NAME;
		else process.env.ZELLIJ_SESSION_NAME = previousZellijSession;
		rmSync(root, { recursive: true, force: true });
	}
});
