import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { archivePath } from "../dist/src/config.js";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("native cancellation stops an Executor held during authorized provider feedback", { timeout: 120_000 }, async () => {
	const feedback = "Remove the trailing blank line from greeting.txt.";
	const fixture = await createNativeWorkflowFixture({ providerFeedback: true, greeting: "hello\n\n" });
	const terminal = createNativeTerminal(fixture);
	const records = (kinds) => {
		const archive = new SQLiteArchive(archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project), { readOnly: true });
		try { return archive.query({ workId: "native-execution", kinds, limit: 100 }).items; }
		finally { archive.close(); }
	};
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, held: fixture.heldRequests.map((response) => ({ destroyed: response.destroyed })), records: records(["delivery", "invocation", "error"]) });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const reviewed = await waitUntil(terminal.readWork, (work) => work?.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		const reviewPath = join(fixture.root, "review.json");
		const providerReview = JSON.parse(await readFile(reviewPath, "utf8"));
		await writeFile(reviewPath, JSON.stringify({
			...providerReview,
			reviews: [{ id: 9, state: "CHANGES_REQUESTED", body: feedback, author: { login: "fixture-reviewer" }, authorAssociation: "OWNER", submittedAt: new Date().toISOString(), commit_id: reviewed.reviewRequest.headCommit }],
		}));
		fixture.pauseExecutor();
		terminal.send("Poll the provider review and process its current feedback.");
		await waitUntil(() => fixture.heldRequests.length, (count) => count === 1, diagnostic);
		const authorized = terminal.readWork();
		const authorization = records(["delivery"]).find((record) => record.actor === "conclave" && record.payload.delivered === false);
		assert.equal(authorized.execution.executionId, reviewed.execution.executionId);
		assert.equal(authorization.payload.feedback[0], feedback);
		assert.ok(authorized.budget.reservedTokens > 0);

		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		terminal.keys("Enter");
		await see("Reconcile held usage");
		await selectNativeListItem(terminal, "Cancel", diagnostic);
		await see("Cancel Work: saved draft");
		terminal.keys("Down", "Enter");
		await see("Apply this consequential change");
		terminal.keys("Enter");
		const cancelled = await waitUntil(terminal.readWork, (work) => work.state === "stopped" && work.budget.reservedTokens === 0, diagnostic);
		await waitUntil(() => fixture.heldRequests[0].destroyed, Boolean, diagnostic);
		assert.equal(cancelled.stopReason, "cancelled");
		assert.equal(cancelled.execution.executionId, reviewed.execution.executionId);
		assert.deepEqual(cancelled.activeInvocations, []);
		await see("Action complete:");
		await see("Freshness");
		terminal.keys("Escape");
		await see("left/right filters");
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("left/right filters"), diagnostic);
		terminal.send("/khala-recover");
		await see("reconciliation completed for 1 Work item");
		const recovered = terminal.readWork();
		assert.equal(recovered.stopReason, "cancelled");
		assert.equal(recovered.budget.reservedTokens, 0);
		assert.deepEqual(recovered.activeInvocations, []);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
