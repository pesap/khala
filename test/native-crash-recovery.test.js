import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi terminal reconciles a crash-held invocation before resuming its Execution", { timeout: 120_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String) });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		await waitUntil(() => fixture.heldRequests.length, (count) => count > 0, diagnostic);
		const interrupted = terminal.readWork();
		const held = interrupted.activeInvocations.find((run) => run.role === "executor");
		assert.ok(held);
		terminal.crash();
		await terminal.waitForExit();
		await terminal.start();
		terminal.send("/khala-recover");
		await see("reconcile");
		assert.ok(terminal.readWork().activeInvocations.some((run) => run.runId === held.runId));
		fixture.resumeExecutor();
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Actions");
		terminal.keys("Enter");
		await see("Reconcile held usage");
		terminal.keys("Down", "Down", "Down", "Down", "Enter");
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
		assert.ok(terminal.readWork().activeInvocations.some((run) => run.runId === held.runId));
		terminal.keys("Enter");
		await waitUntil(terminal.readWork, (work) => !work.activeInvocations.some((run) => run.runId === held.runId), diagnostic);
		assert.equal(terminal.readWork().budget.consumedTokens, interrupted.budget.consumedTokens);
		await see("Action complete:");
		await see("Freshness");
		terminal.keys("Escape");
		await see("left/right filters");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("escape back") && !screen.includes("left/right filters"), diagnostic);
		terminal.send("/khala-recover");
		const recovered = await waitUntil(
			terminal.readWork,
			(work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(recovered.execution.executionId, interrupted.execution.executionId);
		assert.equal(recovered.budget.reservedTokens, 0);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
