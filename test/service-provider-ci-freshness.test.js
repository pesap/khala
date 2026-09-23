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
		const duplicatePublication = archive.append({
			commandId: "ci-freshness:publish-same-head-again",
			expectedWorkRevision: current.revision,
			kind: "review-request",
			actor: "executor",
			workId: current.workId,
			missionId: current.mission.missionId,
			executionId: current.execution.executionId,
			payloadVersion: 1,
			summary: "The current draft publication was reconciled again.",
			payload: current.reviewRequest,
			projection: { ...current, revision: current.revision + 1 },
		});

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
