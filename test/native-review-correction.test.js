import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { archivePath } from "../dist/src/config.js";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture, git } from "./helpers/native-workflow.mjs";

test("Pi review feedback resumes the same Execution and republishes a validated correction", { timeout: 90_000 }, async () => {
	const options = { greeting: "hello\n" };
	const fixture = await createNativeWorkflowFixture(options);
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => {
		const archive = new SQLiteArchive(archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project), { readOnly: true });
		try {
			return JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, records: archive.query({ workId: "native-execution", kinds: ["delivery", "error"], limit: 30 }).items });
		} finally { archive.close(); }
	};
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const reviewed = await waitUntil(terminal.readWork, (work) => work?.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Record review");
		terminal.keys("Down", "Down", "Down", "Enter");
		await see("Record provider review: saved draft");
		terminal.keys("Enter");
		await see("Provider review result:");
		terminal.keys("Enter");
		await see("Text editor: feedback");
		terminal.keys("-l", "Keep hello and add one trailing blank line.");
		terminal.keys("Enter");
		await see("Record provider review: saved draft");
		assert.equal(terminal.readWork().revision, reviewed.revision);
		options.greeting = "hello\n\n";
		fixture.steps.executor = 0;
		fixture.steps.conclave = 5;
		terminal.keys("Down", "Enter");
		const corrected = await waitUntil(terminal.readWork, (work) => work.state === "awaiting-review" && work.reviewRequest.headCommit !== reviewed.reviewRequest.headCommit && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(corrected.workId, reviewed.workId);
		assert.equal(corrected.execution.executionId, reviewed.execution.executionId);
		assert.equal(corrected.execution.sandbox.path, reviewed.execution.sandbox.path);
		assert.equal(corrected.reviewRequest.providerId, reviewed.reviewRequest.providerId);
		assert.equal(readFileSync(join(corrected.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n\n");
		assert.equal(corrected.lastValidation.headCommit, corrected.reviewRequest.headCommit);
		assert.ok(corrected.lastValidation.results.every((result) => result.passed));
		assert.equal(git("--git-dir", fixture.remote, "rev-parse", corrected.execution.sandbox.branch), corrected.reviewRequest.headCommit);
		assert.equal(corrected.lastError, undefined);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
