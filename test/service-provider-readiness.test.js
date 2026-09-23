import assert from "node:assert/strict";
import { test } from "node:test";
import {
	providerCiObservationIsStale,
	providerCiObservationNeedsRefresh,
	providerEvidenceAllowsReady,
} from "../dist/src/service-provider-readiness.js";

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

function publication(sequence, headCommit = request.headCommit, url = request.url, status = request.status) {
	return record(sequence, "review-request", { ...request, headCommit, url, status });
}

function checks(
	sequence,
	status,
	headCommit,
	repository = request.repository,
	providerChecks = [],
	url = request.url,
) {
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
		details: {
			pullRequest: { url, status: request.status, state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks: providerChecks,
		},
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
	assert.equal(providerEvidenceAllowsReady(archive([publication(4), checks(3, "checks-failed", "old-head", "wrong/project")]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", "other-head"), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "checks-failed", request.headCommit), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit, request.repository, [{ kind: "check-run", name: "tests", status: "IN_PROGRESS" }]), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit, request.repository, [{ kind: "check-run", name: "tests", status: "COMPLETED" }]), publication(4)]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit, request.repository, [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }]), publication(4)]), work, request), true);
});

test("CI freshness matches GitLab reruns by pipeline identity rather than generated display name", () => {
	const failed = checks(5, "checks-failed", request.headCommit, request.repository, [
		{
			kind: "status-context",
			name: "GitLab pipeline 73",
			status: "failed",
			completedAt: "2026-09-09T00:00:00.000Z",
		},
	]);
	const successfulRerun = checks(6, "open", request.headCommit, request.repository, [
		{
			kind: "status-context",
			name: "GitLab pipeline 74",
			status: "success",
			completedAt: "2026-09-10T00:00:00.000Z",
		},
	]);
	const staleSuccessfulRerun = checks(6, "open", request.headCommit, request.repository, [
		{
			kind: "status-context",
			name: "GitLab pipeline 74",
			status: "success",
			completedAt: "2026-09-08T00:00:00.000Z",
		},
	]);
	const current = { ...work, reviewRequest: request };
	assert.equal(providerCiObservationIsStale(archive([failed]), current, successfulRerun.payload), false);
	assert.equal(providerCiObservationIsStale(archive([failed]), current, staleSuccessfulRerun.payload), true);
});

test("status-context success without a terminal completion timestamp cannot replace failure", () => {
	const failed = checks(5, "checks-failed", request.headCommit, request.repository, [
		{ kind: "status-context", name: "coverage", status: "failure" },
	]);
	const successful = checks(6, "open", request.headCommit, request.repository, [
		{ kind: "status-context", name: "coverage", status: "success" },
	]);
	assert.equal(
		providerCiObservationIsStale(archive([failed]), { ...work, reviewRequest: request }, successful.payload),
		true,
	);
});

test("provider readiness fails closed when the current publication has no CI evidence", () => {
	assert.equal(providerEvidenceAllowsReady(archive([publication(4)]), work, request), false);
});

test("provider readiness permits missing CI evidence only when no-CI is explicitly configured", () => {
	assert.equal(providerEvidenceAllowsReady(archive([publication(4)]), work, request, false), true);
	assert.equal(
		providerEvidenceAllowsReady(
			archive([publication(6), checks(5, "open", "previous-head")]),
			work,
			request,
			false,
		),
		false,
	);
	assert.equal(
		providerEvidenceAllowsReady(
			archive([publication(6), checks(5, "checks-failed", request.headCommit)]),
			work,
			request,
			false,
		),
		false,
	);
});

test("explicit no-CI does not excuse newer empty or mismatched CI evidence", async (t) => {
	const newerEmpty = checks(5, "open", request.headCommit);
	const newerForeignProvider = checks(5, "checks-failed", request.headCommit, request.repository, [
		{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "FAILURE" },
	]);
	newerForeignProvider.payload.providerId = "other-provider";
	for (const [identity, observation] of [
		["empty current checks", newerEmpty],
		["different provider ID", newerForeignProvider],
	]) {
		await t.test(identity, () => {
			assert.equal(providerEvidenceAllowsReady(archive([observation, publication(4)]), work, request, false), false);
		});
	}
});

test("explicit no-CI configuration does not excuse mismatched PR evidence", async (t) => {
	for (const [identity, observation] of [
		["head", checks(5, "open", "different-head")],
		["repository", checks(5, "open", request.headCommit, "other/project")],
		["URL", checks(5, "open", request.headCommit, request.repository, [], "https://example.test/review/99")],
	]) {
		await t.test(identity, () => {
			assert.equal(providerEvidenceAllowsReady(archive([observation, publication(4)]), work, request, false), false);
		});
	}
});

test("provider readiness rejects a newer CI observation for a different PR head", () => {
	const successfulChecks = [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }];
	assert.equal(
		providerEvidenceAllowsReady(
			archive([
				checks(6, "open", "different-head", request.repository, successfulChecks),
				checks(5, "open", request.headCommit, request.repository, successfulChecks),
				publication(4),
			]),
			work,
			request,
		),
		false,
	);
});

test("provider readiness requires draft identity to remain current", () => {
	const successfulChecks = [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }];
	const openPullRequestChecks = checks(5, "open", request.headCommit, request.repository, successfulChecks);
	openPullRequestChecks.payload.details.pullRequest.status = "open";
	assert.equal(
		providerEvidenceAllowsReady(archive([openPullRequestChecks, publication(4)]), work, request),
		false,
	);
	assert.equal(
		providerEvidenceAllowsReady(
			archive([checks(5, "open", request.headCommit, request.repository, successfulChecks), publication(4, request.headCommit, request.url, "open")]),
			work,
			request,
		),
		false,
	);
});

test("provider readiness requires exact PR URL identity for publication and CI evidence", () => {
	const successfulChecks = [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }];
	assert.equal(
		providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit, request.repository, successfulChecks, "https://example.test/review/99"), publication(4)]), work, request),
		false,
	);
	assert.equal(
		providerEvidenceAllowsReady(archive([checks(5, "open", request.headCommit, request.repository, successfulChecks), publication(4, request.headCommit, "https://example.test/review/99")]), work, request),
		false,
	);
});

test("a stale successful snapshot cannot refresh readiness after a newer failure for the same head", () => {
	const successChecks = [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }];
	const failureChecks = [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }];
	const staleSuccess = checks(3, "open", request.headCommit, request.repository, successChecks);
	const newerFailure = checks(5, "checks-failed", request.headCommit, request.repository, failureChecks);
	assert.equal(
		providerCiObservationNeedsRefresh(
			archive([newerFailure, publication(4), staleSuccess]),
			{ ...work, reviewRequest: request },
			staleSuccess.payload,
		),
		false,
	);
});

test("provider readiness requires successful CI evidence recorded after the current publication", () => {
	assert.equal(
		providerEvidenceAllowsReady(
			archive([
				publication(5),
				checks(4, "open", request.headCommit, request.repository, [
					{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" },
				]),
			]),
			work,
			request,
		),
		false,
	);
});

test("provider readiness paginates until the current publication is proven", () => {
	const noise = Array.from({ length: 100 }, (_, index) => publication(200 - index, `unrelated-${index}`));
	assert.equal(providerEvidenceAllowsReady(archive(noise, [publication(4), checks(3, "checks-failed", "old-head")]), work, request), false);
	assert.equal(providerEvidenceAllowsReady(archive(noise, [checks(5, "open", "other-head")]), work, request), false);
});
