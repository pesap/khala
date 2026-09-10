import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi Recover returns cancelled Work to admission and a fresh Execution reaches review", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, actions: fixture.toolResults.filter((result) => !result.includes("khala-decision-evidence")) });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		await waitUntil(() => fixture.heldRequests.length, (count) => count > 0, diagnostic);
		const running = terminal.readWork();
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Reconcile held usage");
		await selectNativeListItem(terminal, "Cancel", diagnostic);
		await see("Cancel Work: saved draft");
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
		terminal.keys("Enter");
		await see("Action complete:");
		const cancelled = await waitUntil(terminal.readWork, (work) => work.stopReason === "cancelled" && work.budget.reservedTokens === 0, diagnostic);
		await waitUntil(() => existsSync(running.execution.sandbox.path), (exists) => !exists, diagnostic);
		assert.equal(cancelled.budget.consumedTokens, running.budget.consumedTokens);
		// The fixture supplies a fresh admission decision when the User requests a new attempt.
		fixture.steps.conclave = 0;
		fixture.resumeExecutor();
		await see("Freshness");
		terminal.keys("Enter");
		await see("Recover");
		terminal.keys("Enter");
		await see("Returned to admission");
		await see("No action is needed. Khala will continue automatically.");
		const reviewed = await waitUntil(terminal.readWork, (work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(reviewed.workId, running.workId);
		assert.notEqual(reviewed.mission.missionId, running.mission.missionId);
		assert.notEqual(reviewed.execution.executionId, running.execution.executionId);
		assert.equal(reviewed.stopReason, undefined);
		assert.equal(reviewed.lastError, undefined);
		assert.ok(reviewed.budget.consumedTokens > cancelled.budget.consumedTokens);
		assert.equal(readFileSync(join(reviewed.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
