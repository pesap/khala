import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi cancellation requires confirmation and project recovery leaves cancelled Work stopped", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	const openCancel = async () => {
		terminal.keys("Enter");
		await see("Reconcile held usage");
		terminal.keys("Down", "Down", "Down", "Enter");
		await see("Cancel Work: saved draft");
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
	};
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		await waitUntil(() => fixture.heldRequests.length, (count) => count > 0, diagnostic);
		const running = terminal.readWork();
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		await openCancel();
		terminal.keys("Down", "Enter");
		await see("Freshness");
		assert.equal(terminal.readWork().revision, running.revision);
		assert.equal(terminal.readWork().state, "active");
		await openCancel();
		terminal.keys("Enter");
		await waitUntil(terminal.readWork, (work) => work.state === "stopped", diagnostic);
		await see("Action complete:");
		await see("Freshness");
		assert.equal(terminal.readWork().stopReason, "cancelled");
		assert.equal(terminal.readWork().execution.executionId, running.execution.executionId);
		terminal.keys("Escape");
		await see("left/right filters");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("left/right filters"), diagnostic);
		terminal.send("/khala-recover");
		await see("reconciliation completed for 1 Work item");
		assert.equal(terminal.readWork().stopReason, "cancelled");
		assert.equal(terminal.readWork().budget.reservedTokens, 0);
		assert.equal(terminal.readWork().budget.consumedTokens, running.budget.consumedTokens);
		assert.equal(fixture.steps.executor, 0);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
