import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi User amends requested input through a saved draft and the same Work reaches review", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ needsInput: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String), actions: fixture.toolResults.filter((result) => !result.includes("khala-decision-evidence")) });
	const see = (text) => waitUntil(terminal.text, (screen) => screen.includes(text), diagnostic);
	const editor = (text) => waitUntil(terminal.text, (screen) => screen.includes(text) && screen.includes("enter submit"), diagnostic);
	const scope = "Create only greeting.txt with exactly hello and a trailing newline.";
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const waiting = await waitUntil(terminal.readWork, (work) => work?.state === "needs-input" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(waiting.execution, undefined);
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Amend terms");
		await selectNativeListItem(terminal, "Amend terms", diagnostic);
		await see("Effect Changes this Work's terms before a Mission exists.");
		await selectNativeListItem(terminal, "Scope", diagnostic);
		await editor("Scope");
		terminal.keys("C-a", "C-k");
		terminal.keys("-l", scope);
		terminal.keys("Enter");
		await see("Scope Create only greeting.txt with exactly hello");
		assert.equal(terminal.readWork().terms.scope, waiting.terms.scope);
		assert.equal(terminal.readWork().revision, waiting.revision);
		await selectNativeListItem(terminal, "Amend terms", diagnostic);
		const reviewed = await waitUntil(terminal.readWork, (work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(reviewed.workId, waiting.workId);
		assert.equal(reviewed.terms.scope, scope);
		assert.equal(reviewed.mission.assignment.scope, scope);
		assert.equal(reviewed.budget.reservedTokens, 0);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
