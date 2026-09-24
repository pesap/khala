import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ciFailure,
	ciSuccess,
	makeService,
	performCurrent,
	repairAction,
} from "./helpers/ci-repair-fixtures.mjs";
import { admitAndStart, meta } from "./helpers/mvp-fixtures.mjs";

test("an actionable CI failure resumes the same idle Execution after handoff", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-after-handoff-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const running = await admitAndStart(service, "ci-after-handoff");
		const published = await performCurrent(service, "executor", "create-review-request", "ci-after-handoff:publish");
		assert.equal("error" in published, false);
		const validation = await performCurrent(service, "executor", "run-validation", "ci-after-handoff:validate");
		assert.equal("error" in validation, false);
		controls.pollObservations = [ciSuccess(published.value.reviewRequest)];
		const beforeSuccessPoll = service.inspectWork(running.workId);
		await service.pollProvider(
			running.workId,
			meta("user", "ci-after-handoff:poll-success", beforeSuccessPoll.revision),
		);
		const ready = await performCurrent(service, "executor", "record-signal", "ci-after-handoff:ready", {
			kind: "ready",
			summary: "The validated draft is ready for review.",
			evidence: [published.value.reviewRequest.headCommit, "validation passed", "provider checks passed"],
		});
		assert.equal("error" in ready, false);
		const handedOff = await performCurrent(service, "conclave", "verdict", "ci-after-handoff:handoff", {
			decision: "handoff",
			reason: "The current checks passed and the draft is ready for review.",
			signalId: ready.value.lastSignal.signalId,
		});
		assert.equal("error" in handedOff, false);
		assert.equal(handedOff.value.state, "awaiting-review");
		assert.equal(handedOff.value.execution.state, "awaiting-review");

		controls.pollObservations = [ciFailure(published.value.reviewRequest)];
		const beforeFailurePoll = service.inspectWork(running.workId);
		await service.pollProvider(
			running.workId,
			meta("user", "ci-after-handoff:poll-failure", beforeFailurePoll.revision),
		);
		const failure = service.inspectWork(running.workId);
		assert.equal(failure.execution.runtimeState, "idle");
		assert.equal(repairAction(service, running.workId).enabled, true);
		const authorized = await performCurrent(service, "conclave", "repair-ci", "ci-after-handoff:authorize", {
			observationId: failure.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in authorized, false);
		await service.processPendingEffects();

		const resumed = service.inspectWork(running.workId);
		assert.equal(resumed.workId, running.workId);
		assert.equal(resumed.mission.missionId, running.mission.missionId);
		assert.equal(resumed.execution.executionId, running.execution.executionId);
		assert.equal(resumed.state, "active");
		assert.equal(resumed.missionState, "active");
		assert.equal(resumed.execution.state, "running");
		assert.equal(resumed.lastSignal, undefined);
		assert.equal(
			archive.query({ workId: running.workId, kinds: ["delivery"] }).items.some(
				(record) => record.payload.kind === "ci-repair" && record.payload.status === "started",
			),
			true,
		);
	} finally {
		await service.close();
	}
});
