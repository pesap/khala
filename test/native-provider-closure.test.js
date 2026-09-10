import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

test("Pi reconciles a provider-closed review as failed Work", { timeout: 90_000 }, async () => {
	const reason = "The provider review was closed without acceptance.";
	const fixture = await createNativeWorkflowFixture({ providerClosed: true });
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String) });
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const reviewed = await waitUntil(terminal.readWork, (work) => work?.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		const reviewPath = join(fixture.root, "review.json");
		const providerReview = JSON.parse(await readFile(reviewPath, "utf8"));
		await writeFile(reviewPath, JSON.stringify({ ...providerReview, state: "CLOSED", isDraft: false, mergedAt: null }));

		terminal.send("Poll the provider review and reconcile its current state.");
		const failed = await waitUntil(terminal.readWork, (work) => work?.state === "stopped" && work.stopReason === "failed" && work.budget.reservedTokens === 0, diagnostic);

		assert.notEqual(failed.state, "succeeded");
		assert.equal(failed.execution.executionId, reviewed.execution.executionId);
		assert.equal(failed.execution.state, "failed");
		assert.equal(failed.reviewRequest.providerId, reviewed.reviewRequest.providerId);
		assert.equal(failed.reviewRequest.headCommit, reviewed.reviewRequest.headCommit);
		assert.equal(failed.reviewRequest.status, "closed");
		assert.equal(failed.lastObservation.kind, "ci-status");
		assert.equal(failed.lastObservation.status, "closed");
		assert.equal(failed.lastObservation.repository, reviewed.reviewRequest.repository);
		assert.equal(failed.lastObservation.sourceBranch, reviewed.reviewRequest.sourceBranch);
		assert.equal(failed.lastObservation.targetBranch, reviewed.reviewRequest.targetBranch);
		assert.equal(failed.lastObservation.headCommit, reviewed.reviewRequest.headCommit);
		assert.equal(failed.lastError.summary, `Work failed: ${reason}`);
		assert.equal(failed.budget.reservedTokens, 0);

		terminal.send("/khala");
		await waitUntil(terminal.screen, (screen) => /^\s*Work\s*$/m.test(screen) && screen.includes("left/right filters"), diagnostic);
		terminal.keys("h");
		await waitUntil(terminal.screen, (screen) => /^\s*History\s*$/m.test(screen) && screen.includes("Native greeting") && screen.includes("failed"), diagnostic);
		terminal.keys("Enter");
		await waitUntil(
			terminal.screen,
			(screen) =>
				/^\s*Native greeting\s*$/m.test(screen) &&
				screen.includes("Attention") &&
				screen.includes("Work failed") &&
				!screen.includes(reason),
			diagnostic,
		);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
