import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi cancellation stops an in-flight Conclave before admission and settles its usage", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdConclave: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, requests: fixture.heldRequests.map((response) => ({ destroyed: response.destroyed })) });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		await waitUntil(() => fixture.heldRequests.length, (count) => count === 1, diagnostic);
		const submitted = terminal.readWork();
		assert.equal(submitted.state, "submitted");
		assert.equal(submitted.execution, undefined);
		assert.ok(submitted.budget.reservedTokens > 0);
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Reconcile held usage");
		terminal.keys("Down", "Down", "Down", "Down", "Enter");
		await see("Cancel Work: saved draft");
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
		terminal.keys("Enter");
		await waitUntil(terminal.readWork, (work) => work.state === "stopped", diagnostic);
		await see("Action complete:");
		await waitUntil(() => fixture.heldRequests[0].destroyed, Boolean, diagnostic);
		const uncertain = await waitUntil(terminal.readWork, (work) => work.activeInvocations?.[0]?.state === "uncertain", diagnostic);
		assert.equal(uncertain.budget.reservedTokens, submitted.budget.reservedTokens);
		assert.equal(uncertain.budget.consumedTokens, submitted.budget.consumedTokens);
		await see("Freshness");
		terminal.keys("Enter");
		await see("Reconcile held usage");
		terminal.keys("Down", "Down", "Enter");
		await see("saved draft");
		terminal.keys("Enter");
		await see("Held invocation to reconcile");
		terminal.keys("Enter");
		for (const field of ["Cumulative input tokens", "Cumulative output tokens", "Cumulative cache hit tokens", "Cumulative cache miss tokens"]) {
			await see(field);
			terminal.send("0");
		}
		await see("Usage evidence reference");
		terminal.send("Local fixture received the request but produced no completion or tokens.");
		await see("saved draft");
		terminal.keys("Down", "Enter");
		await see("Record 0 input");
		terminal.keys("Enter");
		await waitUntil(terminal.readWork, (work) => work.budget.reservedTokens === 0, diagnostic);
		await see("Freshness");
		terminal.keys("Escape");
		await see("left/right filters");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("left/right filters"), diagnostic);
		terminal.send("/khala-recover");
		await see("reconciliation completed for 1 Work item");
		const stopped = await waitUntil(terminal.readWork, (work) => work.budget.reservedTokens === 0, diagnostic);
		assert.equal(stopped.stopReason, "cancelled");
		assert.equal(stopped.execution, undefined);
		assert.equal(stopped.budget.consumedTokens, submitted.budget.consumedTokens);
		assert.equal(fixture.steps.conclave, 0);
		assert.equal(fixture.steps.executor, 0);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
