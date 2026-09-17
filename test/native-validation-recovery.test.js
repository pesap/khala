import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture, git } from "./helpers/native-workflow.mjs";

function selectedEvidenceLine(screen) {
	return screen.split("\n").find((line) => line.includes("→"));
}

async function selectValidationEvidence(terminal, diagnostic) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const screen = terminal.screen();
		if (/→\s+\d+\s+validation\b/.test(screen)) return;
		const selected = selectedEvidenceLine(screen);
		terminal.keys("Down");
		await waitUntil(terminal.screen, (next) => selectedEvidenceLine(next) !== selected, diagnostic);
	}
	assert.fail(diagnostic());
}

test("Pi rejects source-mutating validation and recovers the same idle Execution", { timeout: 120_000 }, async () => {
	const validation = 'test "$(cat greeting.txt)" = hello && if [ ! -e .validation-once ]; then printf bad > greeting.txt; touch .validation-once; fi';
	const options = { greeting: "hello\n\n", validation: [validation] };
	const fixture = await createNativeWorkflowFixture(options);
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () =>
		JSON.stringify({
			screen: terminal.screen(),
			work: terminal.readWork(),
			steps: fixture.steps,
			failures: fixture.failures.map(String),
		});
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await writeFile(join(fixture.project, ".gitignore"), ".validation-once\n");
		git("-C", fixture.project, "add", ".gitignore");
		git("-C", fixture.project, "commit", "-m", "Ignore validation marker");
		git("-C", fixture.project, "push", "origin", "main");
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		await waitUntil(
			terminal.readWork,
			(work) => work?.lastValidation?.sourceVerified === false,
			diagnostic,
		);
		const rejected = await waitUntil(
			terminal.readWork,
			(work) => work?.execution?.runtimeState === "idle" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(rejected.state, "active");
		assert.equal(rejected.lastSignal, undefined);
		assert.equal(rejected.lastValidation.results[0].passed, true);
		assert.match(rejected.lastValidation.sourceFailure, /greeting\.txt/i);
		assert.equal(readFileSync(join(rejected.execution.sandbox.path, "greeting.txt"), "utf8"), "bad");

		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Down", "Enter");
		await see("Evidence");
		await selectValidationEvidence(terminal, diagnostic);
		terminal.keys("Enter");
		await see("Source verification");
		await see("greeting.txt");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("Source verification") && screen.includes("Evidence"), diagnostic);
		terminal.keys("Escape");
		await see("Freshness");
		options.greeting = "hello\n";
		fixture.steps.executor = 0;
		terminal.keys("Enter");
		await see("Recover");
		terminal.keys("Enter");
		const corrected = await waitUntil(
			terminal.readWork,
			(work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0,
			diagnostic,
		);
		assert.equal(corrected.workId, rejected.workId);
		assert.equal(corrected.mission.missionId, rejected.mission.missionId);
		assert.equal(corrected.execution.executionId, rejected.execution.executionId);
		assert.equal(corrected.execution.sandbox.path, rejected.execution.sandbox.path);
		assert.equal(corrected.execution.pi.sessionId, rejected.execution.pi.sessionId);
		assert.equal(corrected.execution.pi.sessionPath, rejected.execution.pi.sessionPath);
		assert.notEqual(corrected.lastValidation.headCommit, rejected.lastValidation.headCommit);
		assert.equal(corrected.lastValidation.sourceVerified, true);
		assert.equal(corrected.lastValidation.sourceFailure, undefined);
		assert.ok(corrected.lastValidation.results.every((result) => result.passed));
		assert.equal(corrected.lastValidation.headCommit, corrected.reviewRequest.headCommit);
		assert.equal(readFileSync(join(corrected.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
