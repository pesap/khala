import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

function isTokenExhausted(work) {
	if (work === undefined) return false;
	const error = work.lastError;
	return error === undefined
		? false
		: [error.code === "external-failure", /token-exhaustion/u.test(error.summary), work.budget.reservedTokens === 0].every(Boolean);
}

test("Pi rejects a budget below recorded usage and a confirmed increase resumes exhausted Work", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ maxTokens: 2 });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, actions: fixture.toolResults.filter((result) => !result.includes("khala-decision-evidence")) });
	const see = (text) => waitUntil(terminal.text, (screen) => screen.includes(text), diagnostic);
	const editor = (text) => waitUntil(terminal.text, (screen) => screen.includes(text) && screen.includes("enter submit"), diagnostic);
	const openBudget = async () => {
		terminal.keys("Enter");
		await see("Amend budget");
		await selectNativeListItem(terminal, "Amend budget", diagnostic);
		await see("Effect Changes this Work's total token cap.");
		await selectNativeListItem(terminal, "Token cap *", diagnostic);
		await editor("Token cap");
	};
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const exhausted = await waitUntil(
			terminal.readWork,
			(work) => isTokenExhausted(work),
			diagnostic,
		);
		assert.ok(exhausted.budget.consumedTokens >= 15);
		assert.equal(exhausted.execution, undefined);
		assert.equal(fixture.steps.executor, 0);
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		await openBudget();
		terminal.keys("-l", "2");
		terminal.keys("Enter");
		await see("Token cap * 2");
		await selectNativeListItem(terminal, "Amend budget", diagnostic);
		await see("Dispatch resumes when the new cap");
		terminal.keys("Enter");
		await see("The amended cap cannot be below reserved or consumed tokens.");
		assert.equal(terminal.readWork().budget.maxTokens, 2);
		assert.equal(terminal.readWork().budget.consumedTokens, exhausted.budget.consumedTokens);
		assert.equal(terminal.readWork().revision, exhausted.revision);
		await see("Freshness");
		await openBudget();
		terminal.keys("C-a", "C-k");
		terminal.keys("-l", "20000");
		terminal.keys("Enter");
		await see("Token cap * 20000");
		assert.equal(terminal.readWork().budget.maxTokens, 2);
		fixture.steps.conclave = 0;
		await selectNativeListItem(terminal, "Amend budget", diagnostic);
		await see("Dispatch resumes when the new cap");
		terminal.keys("Enter");
		const reviewed = await waitUntil(terminal.readWork, (work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(reviewed.workId, exhausted.workId);
		assert.equal(reviewed.budget.maxTokens, 20000);
		assert.ok(reviewed.budget.consumedTokens > exhausted.budget.consumedTokens);
		assert.equal(reviewed.lastError, undefined);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
