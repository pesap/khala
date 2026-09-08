import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi User failure stops a waiting Executor and project recovery preserves the failure", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	const reason = "The greeting requirement was withdrawn by its owner.";
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
		terminal.keys("Down", "Enter");
		await see("Fail Work: saved draft");
		terminal.keys("Enter");
		await see("reason: Escape saves the draft");
		terminal.keys("-l", reason);
		terminal.keys("Escape");
		await see("Fail Work: saved draft");
		assert.equal(terminal.readWork().revision, running.revision);
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
		terminal.keys("Enter");
		await see("Action complete:");
		await waitUntil(terminal.readWork, (work) => work.state === "stopped" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(terminal.readWork().stopReason, "failed");
		assert.equal(terminal.readWork().lastError.summary, `Work failed: ${reason}`);
		await see("Freshness");
		terminal.keys("Escape");
		await see("left/right filters");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("left/right filters"), diagnostic);
		terminal.send("/khala-recover");
		await see("reconciliation completed for 1 Work item");
		assert.equal(terminal.readWork().stopReason, "failed");
		assert.equal(terminal.readWork().execution.executionId, running.execution.executionId);
		assert.equal(fixture.steps.executor, 0);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
