import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi terminal reconciles a crash-held invocation before resuming its Execution", { timeout: 120_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ holdExecutor: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String) });
	const see = (text) => waitUntil(terminal.text, (screen) => screen.includes(text), diagnostic);
	const editor = (text) => waitUntil(terminal.text, (screen) => screen.includes(text) && screen.includes("enter submit"), diagnostic);
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
		await selectNativeListItem(terminal, "Reconcile held usage", diagnostic);
		await see("Effect Settles a held invocation reservation with its actual cumulative usage.");
		await selectNativeListItem(terminal, "Held invocation *", diagnostic);
		await see("reserved reservation of");
		terminal.keys("Enter");
		await see(`Held invocation * ${held.runId}`);
		for (const field of ["Cumulative input tokens", "Cumulative output tokens", "Cumulative cache hit tokens", "Cumulative cache miss tokens"]) {
			await selectNativeListItem(terminal, `${field} *`, diagnostic);
			await editor(field);
			terminal.keys("-l", "0");
			terminal.keys("Enter");
			await see(`${field} * 0`);
		}
		await selectNativeListItem(terminal, "Usage evidence *", diagnostic);
		await editor("Usage evidence");
		terminal.keys("-l", "Local fixture received the request but produced no completion or tokens.");
		terminal.keys("Enter");
		await see("Usage evidence * Local fixture received the request");
		await selectNativeListItem(terminal, "Reconcile held usage", diagnostic);
		await see("Settles the held reservation with the entered cumulative usage");
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
