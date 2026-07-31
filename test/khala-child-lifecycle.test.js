import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { waitForStartup } from "../dist/src/launcher.js";

function runBootstrap(markerPath, code) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [
			"dist/src/executor-bootstrap.js",
			markerPath,
			process.execPath,
			"-e",
			code,
		], { stdio: "ignore" });
		child.once("exit", (exitCode) => resolve(exitCode));
	});
}

test("bootstrap reports child readiness without shell interpretation", async () => {
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

test("bootstrap reports a child exit during startup", async () => {
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
