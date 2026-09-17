import assert from "node:assert/strict";
import { test } from "node:test";
import { providerEvidenceAllowsReady } from "../dist/src/service-provider-readiness.js";

const request = {
	provider: "github",
	principalId: "fixture-user",
	providerId: "42",
	url: "https://example.test/review/42",
	repository: "fixture/project",
	status: "draft",
	sourceBranch: "khala/work",
	targetBranch: "main",
	baseCommit: "base",
	headCommit: "new-head",
	diffSummary: "diff",
	validation: ["check"],
};
const work = { workId: "work", execution: { executionId: "execution" } };

function record(sequence, kind, payload, executionId = "execution") {
	return { sequence, kind, payload, executionId };
}

function publication(sequence, headCommit = request.headCommit) {
	return record(sequence, "review-request", { ...request, headCommit });
}

function checks(sequence, status, headCommit, repository = request.repository) {
	return record(sequence, "observation", {
		observationId: `ci-${sequence}`,
		kind: "ci-status",
		providerId: request.providerId,
		status,
		summary: "CI observation",
		changed: true,
		observedAt: "2026-09-08T00:00:00.000Z",
		repository,
		sourceBranch: request.sourceBranch,
		targetBranch: request.targetBranch,
		baseCommit: request.baseCommit,
		headCommit,
	});
}

function archive(...pages) {
	return {
		query(_query, cursor) {
			const index = cursor === undefined ? 0 : Number(cursor);
			return { items: pages[index], asOfSequence: 1000, nextCursor: index + 1 < pages.length ? String(index + 1) : undefined };
		},
	};
}

test("provider readiness uses publication order without weakening current CI guards", () => {
	assert.equal(providerEvidenceAllowsReady(archive([publication(4), checks(3, "checks-failed", "old-head", "wrong/project")]), work, request), true);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", "other-head"), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "checks-failed", request.headCommit), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([publication(4)]), work, request), true);
});

test("provider readiness paginates until the current publication is proven", () => {
	const noise = Array.from({ length: 100 }, (_, index) => publication(200 - index, `unrelated-${index}`));
	assert.equal(providerEvidenceAllowsReady(archive(noise, [publication(4), checks(3, "checks-failed", "old-head")]), work, request), true);
	assert.equal(providerEvidenceAllowsReady(archive(noise, [checks(5, "open", "other-head")]), work, request), false);
});
