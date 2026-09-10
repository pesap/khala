import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openKhalaArchive } from "../dist/src/archive-view.js";
import { archivePath } from "../dist/src/config.js";
import { createNativeWorkflowFixture, git, packageRoot } from "./helpers/native-workflow.mjs";

function tmux(...args) {
	return execFileSync("tmux", ["-L", `khala-native-${process.pid}`, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function waitUntil(read, accepts, diagnostic) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const value = read();
		if (accepts(value)) return value;
		await setTimeout(100);
	}
	assert.fail(diagnostic());
}

function readWork(path) {
	if (!existsSync(path)) return undefined;
	const archive = openKhalaArchive(path);
	try {
		return archive.listWork().length === 0 ? undefined : archive.inspectWork("native-execution");
	} finally {
		archive.close();
	}
}

test("Pi terminal submits native Work, recovers after restart, and records success", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture();
	const session = `khala-native-${process.pid}-${Date.now()}`;
	const path = archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project);
	const screen = () => tmux("capture-pane", "-p", "-t", session);
	const send = (text) => {
		tmux("send-keys", "-t", session, "-l", text);
		tmux("send-keys", "-t", session, "Enter");
	};
	const start = async () => {
		tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "36", "-c", fixture.project,
			"env", `PI_CODING_AGENT_DIR=${fixture.agent}`, `PATH=${fixture.bin}:${process.env.PATH}`,
			join(packageRoot, "node_modules/.bin/pi"), "-ne", "-ns", "-np", "-nc", "--no-themes", "--offline", "-a", "--no-session", "-e", join(packageRoot, "src/index.ts"), "--model", "fixture/user", "--thinking", "off");
		await waitUntil(screen, (value) => value.includes("khala: idle"), screen);
	};
	try {
		await start();
		send("Submit the greeting Work now.");
		const current = await waitUntil(() => readWork(path), (work) => work?.state === "awaiting-review", () => JSON.stringify({ screen: screen(), work: readWork(path), failures: fixture.failures.map(String) }));
		send("/khala");
		await waitUntil(screen, (value) => value.includes("Native greeting"), screen);
		tmux("send-keys", "-t", session, "Escape");
		await waitUntil(screen, (value) => !value.includes("left/right filters"), screen);
		const completedSteps = { ...fixture.steps };
		tmux("send-keys", "-t", session, "C-d");
		await waitUntil(() => {
			try { return tmux("has-session", "-t", session); } catch { return "exited"; }
		}, (value) => value === "exited", screen);
		await start();
		send("/khala-recover");
		await waitUntil(screen, (value) => value.includes("reconciliation completed for 1 Work item"), screen);
		const recovered = readWork(path);
		assert.equal(recovered.execution.executionId, current.execution.executionId);
		assert.equal(recovered.reviewRequest.headCommit, current.reviewRequest.headCommit);
		assert.deepEqual(fixture.steps, completedSteps);
		git("-C", fixture.project, "merge", "--ff-only", recovered.execution.sandbox.branch);
		git("-C", fixture.project, "push", "origin", "main");
		const reviewPath = join(fixture.root, "review.json");
		const review = JSON.parse(await readFile(reviewPath, "utf8"));
		await writeFile(reviewPath, JSON.stringify({ ...review, state: "MERGED", isDraft: false, mergedAt: new Date().toISOString(), mergeCommit: { oid: recovered.reviewRequest.headCommit } }));
		send("Check the merged review and finish the Work.");
		const succeeded = await waitUntil(() => readWork(path), (work) => work?.state === "succeeded", () => JSON.stringify({ screen: screen(), work: readWork(path) }));
		assert.equal(succeeded.execution.executionId, current.execution.executionId);
		assert.equal(succeeded.budget.reservedTokens, 0);
		send("/khala");
		await waitUntil(screen, (value) => value.includes("left/right filters"), screen);
		tmux("send-keys", "-t", session, "h");
		await waitUntil(screen, (value) => value.includes("Native greeting") && value.includes("succeeded"), screen);
		assert.deepEqual(fixture.failures, []);
	} finally {
		try { tmux("kill-session", "-t", session); } catch { /* The terminal may already have exited. */ }
		await fixture.close();
	}
});
