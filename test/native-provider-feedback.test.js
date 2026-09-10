import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { archivePath } from "../dist/src/config.js";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

function feedbackCompleted(work, firstHead, fixture) {
	if (work === undefined) return false;
	return [
		work.state === "awaiting-review",
		work.reviewRequest.headCommit !== firstHead,
		work.budget.reservedTokens === 0,
		fixture.steps.conclave >= 13,
	].every(Boolean);
}

test("native provider feedback is authorized before the same Executor corrects and republishes", { timeout: 120_000 }, async () => {
	const feedback = "Remove the trailing blank line from greeting.txt.";
	const fixture = await createNativeWorkflowFixture({ providerFeedback: true, greeting: "hello\n\n" });
	const terminal = createNativeTerminal(fixture);
	const records = (kinds) => {
		const archive = new SQLiteArchive(archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project), { readOnly: true });
		try { return archive.query({ workId: "native-execution", kinds, limit: 100 }).items; }
		finally { archive.close(); }
	};
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String), records: records(["observation", "delivery", "verdict", "review-request", "error"]) });
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const firstReview = await waitUntil(terminal.readWork, (work) => work?.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		const firstRevision = firstReview.revision;
		const reviewPath = join(fixture.root, "review.json");
		const providerReview = JSON.parse(await readFile(reviewPath, "utf8"));
		await writeFile(reviewPath, JSON.stringify({
			...providerReview,
			reviews: [{
				id: 7,
				state: "CHANGES_REQUESTED",
				body: feedback,
				author: { login: "fixture-reviewer" },
				authorAssociation: "OWNER",
				submittedAt: new Date().toISOString(),
				commit_id: firstReview.reviewRequest.headCommit,
			}],
		}));

		assert.equal(terminal.readWork().revision, firstRevision, "provider text alone must not authorize Executor work");
		assert.equal(readFileSync(join(firstReview.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n\n");
		terminal.send("Poll the provider review and process its current feedback.");
		const corrected = await waitUntil(terminal.readWork, (work) => feedbackCompleted(work, firstReview.reviewRequest.headCommit, fixture), diagnostic);
		const evidence = records(["observation", "delivery", "verdict", "review-request", "error"]);
		const observation = evidence.find((record) => record.kind === "observation" && record.payload.kind === "review-comment");
		const deliveries = evidence.filter((record) => record.kind === "delivery" && record.payload.observationId === observation.payload.observationId);
		const handoffs = evidence.filter((record) => record.kind === "verdict" && record.payload.decision === "handoff");
		const authorization = deliveries.find((record) => record.payload.delivered === false);
		const correctedPublication = evidence.find((record) => record.kind === "review-request" && record.payload.headCommit === corrected.reviewRequest.headCommit);

		assert.equal(corrected.workId, firstReview.workId);
		assert.equal(corrected.mission.missionId, firstReview.mission.missionId);
		assert.equal(corrected.execution.executionId, firstReview.execution.executionId);
		assert.equal(corrected.execution.sandbox.path, firstReview.execution.sandbox.path);
		assert.equal(corrected.reviewRequest.providerId, firstReview.reviewRequest.providerId);
		assert.equal(observation.payload.actionable, true);
		assert.equal(observation.payload.headCommit, firstReview.reviewRequest.headCommit);
		assert.deepEqual(observation.payload.feedback, [feedback]);
		assert.equal(deliveries.some((record) => record.payload.delivered === false), true);
		assert.equal(deliveries.some((record) => record.payload.delivered === true), true);
		assert.ok(observation.sequence < deliveries[0].sequence);
		assert.equal(authorization.actor, "conclave");
		assert.ok(authorization.sequence < correctedPublication.sequence);
		assert.equal(handoffs.length, 2);
		assert.equal(handoffs.at(-1).executionId, corrected.execution.executionId);
		assert.equal(readFileSync(join(corrected.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.equal(corrected.lastValidation.headCommit, corrected.reviewRequest.headCommit);
		assert.ok(corrected.lastValidation.results.every((result) => result.passed));
		assert.equal(evidence.some((record) => record.kind === "error"), false);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
