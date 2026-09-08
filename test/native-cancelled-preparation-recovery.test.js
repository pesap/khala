import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture, git } from "./helpers/native-workflow.mjs";

test("Pi recovers cancelled preparation through fresh admission after the target is repaired", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture();
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () =>
		JSON.stringify({
			screen: terminal.screen(),
			work: terminal.readWork(),
			steps: fixture.steps,
			actions: fixture.toolResults.filter((result) => !result.includes("khala-decision-evidence")),
		});
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		const manifest = { name: "native-cancelled-preparation-fixture", version: "1.0.0" };
		await writeFile(join(fixture.project, "package.json"), JSON.stringify(manifest));
		git("-C", fixture.project, "add", "package.json");
		git("-C", fixture.project, "commit", "-m", "Add manifest without lockfile");
		git("-C", fixture.project, "push", "origin", "main");

		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const waiting = await waitUntil(
			terminal.readWork,
			(work) => work?.preparation?.status === "waiting" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(waiting.execution, undefined);
		assert.equal(fixture.steps.executor, 0);

		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Recover");
		await see("Cancel");
		terminal.keys("Down", "Down", "Down", "Down", "Enter");
		await see("Cancel Work: saved draft");
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
		terminal.keys("Enter");
		await see("Action complete:");
		const cancelled = await waitUntil(
			terminal.readWork,
			(work) => work.state === "stopped" && work.stopReason === "cancelled" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(cancelled.execution, undefined);
		assert.equal(cancelled.mission.missionId, waiting.mission.missionId);

		await writeFile(
			join(fixture.project, "package-lock.json"),
			JSON.stringify({ ...manifest, lockfileVersion: 3, requires: true, packages: { "": manifest } }),
		);
		git("-C", fixture.project, "add", "package-lock.json");
		git("-C", fixture.project, "commit", "-m", "Repair cancelled dependency preparation");
		git("-C", fixture.project, "push", "origin", "main");
		const repairedBase = git("-C", fixture.project, "rev-parse", "HEAD");

		fixture.steps.conclave = 0;
		await see("Freshness");
		terminal.keys("Enter");
		await see("Recover");
		terminal.keys("Enter");
		await see("Returned to admission");
		await see("No action is needed. Khala will continue automatically.");
		const reviewed = await waitUntil(
			terminal.readWork,
			(work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(reviewed.workId, waiting.workId);
		assert.notEqual(reviewed.mission.missionId, waiting.mission.missionId);
		assert.equal(reviewed.execution.sandbox.baseCommit, repairedBase);
		assert.equal(reviewed.preparation, undefined);
		assert.equal(reviewed.stopReason, undefined);
		assert.equal(reviewed.lastError, undefined);
		assert.equal(await readFile(join(reviewed.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
