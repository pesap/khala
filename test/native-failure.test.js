import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi User failure stops a waiting Executor and project recovery preserves the failure", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps });
	const see = (text) => waitUntil(terminal.text, (screen) => screen.includes(text), diagnostic);
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
		await selectNativeListItem(terminal, "Mark as failed", diagnostic);
		await see("Requires Reason is required.");
		await selectNativeListItem(terminal, "Reason *", diagnostic);
		await see("enter submit");
		terminal.keys("-l", reason);
		terminal.keys("Enter");
		await see(`Reason * ${reason}`);
		assert.equal(terminal.readWork().revision, running.revision);
		await selectNativeListItem(terminal, "Mark as failed", diagnostic);
		await see("prevents recovery");
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
