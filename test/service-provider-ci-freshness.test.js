import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService, meta, admitAndStart, validateWork } from "./helpers/mvp-fixtures.mjs";

function successfulCiObservation(request) {
	return {
		observationId: "ci-status:fixture:unchanged-success",
		kind: "ci-status",
		providerId: request.providerId,
		status: "open",
		summary: "Provider checks passed.",
		repository: request.repository,
		sourceBranch: request.sourceBranch,
		targetBranch: request.targetBranch,
		baseCommit: request.baseCommit,
		headCommit: request.headCommit,
		details: {
			pullRequest: { url: request.url, status: request.status, state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks: [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }],
		},
		changed: true,
		observedAt: new Date().toISOString(),
	};
}

function failedCiObservation(request) {
	const observation = successfulCiObservation(request);
	return {
		...observation,
		observationId: "ci-status:fixture:later-failure",
		status: "checks-failed",
		summary: "Provider checks failed.",
		details: {
			...observation.details,
			checks: [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }],
		},
	};
}

function recordSameHeadPublication(archive, work, commandId) {
	return archive.append({
		commandId,
		expectedWorkRevision: work.revision,
		kind: "review-request",
		actor: "executor",
		workId: work.workId,
		missionId: work.mission.missionId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: "The current draft publication was reconciled again.",
		payload: work.reviewRequest,
		projection: { ...work, revision: work.revision + 1 },
	});
}

async function pollSameCi(service, controls, work, observation, commandId) {
	controls.pollObservations = [observation];
	const current = service.inspectWork(work.workId);
	return service.pollProvider(work.workId, meta("user", commandId, current.revision));
}

test("an unchanged successful check is refreshed after a same-head publication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-freshness-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		let work = await admitAndStart(service, "ci-freshness");
		work = await validateWork(service, work, "ci-freshness:validate");
		const result = await service.perform({
			action: "create-review-request",
			workId: work.workId,
			input: {},
			meta: meta("executor", "ci-freshness:publish-first", work.revision, work.workId, work.execution.executionId),
		});
		assert.equal("error" in result, false);
		const request = result.value.reviewRequest;
		const observation = successfulCiObservation(request);
		work = await pollSameCi(service, controls, work, observation, "ci-freshness:poll-first");

		const current = service.inspectWork(work.workId);
		const duplicatePublication = recordSameHeadPublication(
			archive,
			current,
			"ci-freshness:publish-same-head-again",
		);

		work = await pollSameCi(service, controls, work, observation, "ci-freshness:poll-after-republication");
		const observations = archive.query({ workId: work.workId, kinds: ["observation"], order: "desc" }).items;
		const refreshed = observations.find((record) => record.payload.observationId === observation.observationId);
		assert.ok(refreshed);
		assert.ok(refreshed.sequence > duplicatePublication.record.sequence);
		const ready = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: {
				kind: "ready",
				summary: "The current publication has verified successful checks.",
				evidence: [request.headCommit, "validation passed", "provider checks passed"],
			},
			meta: meta("executor", "ci-freshness:ready", work.revision, work.workId, work.execution.executionId),
		});
		assert.equal("error" in ready, false);
	} finally {
		await service.close();
	}
});

test("a previously unseen older successful snapshot cannot replace a newer failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-stale-success-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		let work = await admitAndStart(service, "ci-stale-success");
		work = await validateWork(service, work, "ci-stale-success:validate");
		const result = await service.perform({
			action: "create-review-request",
			workId: work.workId,
			input: {},
			meta: meta("executor", "ci-stale-success:publish-first", work.revision, work.workId, work.execution.executionId),
		});
		assert.equal("error" in result, false);
		const request = result.value.reviewRequest;
		const oldSuccess = successfulCiObservation(request);
		oldSuccess.details.checks[0].completedAt = "2026-09-08T00:00:00.000Z";
		work = await pollSameCi(service, controls, work, oldSuccess, "ci-stale-success:poll-success");
		recordSameHeadPublication(archive, service.inspectWork(work.workId), "ci-stale-success:republish");
		const newerFailure = failedCiObservation(request);
		newerFailure.details.checks[0].completedAt = "2026-09-09T00:00:00.000Z";
		work = await pollSameCi(service, controls, work, newerFailure, "ci-stale-success:poll-failure");
		const failure = work.lastObservation;
		assert.equal(failure.status, "checks-failed");
		const unseenStaleSuccess = successfulCiObservation(request);
		unseenStaleSuccess.observationId = "ci-status:fixture:unseen-stale-success";
		unseenStaleSuccess.details.checks[0].completedAt = "2026-09-08T12:00:00.000Z";

		work = await pollSameCi(service, controls, work, unseenStaleSuccess, "ci-stale-success:poll-stale-success");
		assert.equal(work.lastObservation.observationId, failure.observationId);
		const observations = archive.query({ workId: work.workId, kinds: ["observation"], order: "desc" }).items;
		assert.equal(observations[0].payload.observationId, failure.observationId);
		const ready = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: {
				kind: "ready",
				summary: "Attempted ready using an older success.",
				evidence: [request.headCommit, "validation passed", "old provider success"],
			},
			meta: meta("executor", "ci-stale-success:ready", work.revision, work.workId, work.execution.executionId),
		});
		assert.equal("error" in ready, true);

		const freshSuccess = successfulCiObservation(request);
		freshSuccess.observationId = "ci-status:fixture:fresh-success";
		freshSuccess.details.checks[0].completedAt = "2026-09-10T00:00:00.000Z";
		work = await pollSameCi(service, controls, work, freshSuccess, "ci-stale-success:poll-fresh-success");
		assert.equal(work.lastObservation.observationId, freshSuccess.observationId);
		const currentReady = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: {
				kind: "ready",
				summary: "The current successful check run is newer than the recorded failure.",
				evidence: [request.headCommit, "validation passed", "new provider success"],
			},
			meta: meta("executor", "ci-stale-success:ready-after-current-checks", work.revision, work.workId, work.execution.executionId),
		});
		assert.equal("error" in currentReady, false);
	} finally {
		await service.close();
	}
});
