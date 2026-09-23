import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { makeService, meta, admitAndStart } from "./helpers/mvp-fixtures.mjs";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

async function workWithCiFailure(service, controls) {
	const running = await admitAndStart(service, "ci-work-budget");
	const published = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "ci-work-budget:publish", running.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in published, false);
	controls.pollObservations = [{
		observationId: "ci-work-budget:failure",
		kind: "ci-status",
		providerId: published.value.reviewRequest.providerId,
		status: "checks-failed",
		summary: "A provider check failed.",
		repository: published.value.reviewRequest.repository,
		sourceBranch: published.value.reviewRequest.sourceBranch,
		targetBranch: published.value.reviewRequest.targetBranch,
		baseCommit: published.value.reviewRequest.baseCommit,
		headCommit: published.value.reviewRequest.headCommit,
		details: {
			pullRequest: { url: published.value.reviewRequest.url, status: "draft", state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks: [{ kind: "check-run", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }],
		},
		changed: true,
		observedAt: new Date().toISOString(),
	}];
	return service.pollProvider(running.workId, meta("user", "ci-work-budget:poll", published.value.revision));
}

async function performCurrent(service, workId, action, commandId, input = {}) {
	const work = service.inspectWork(workId);
	return service.perform({
		action,
		workId,
		input,
		meta: meta("conclave", commandId, work.revision, workId),
	});
}

test("exhausted Work budget blocks CI repair while Execution allowance remains", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-work-budget-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const work = await workWithCiFailure(service, controls);
		const ledger = new RunLedger(archive);
		const allowance = work.budget.maxTokens;
		ledger.reserve({ workId: work.workId, role: "conclave", missionId: work.mission.missionId, allowance, runId: "consume-work-budget" });
		ledger.settle({ runId: "consume-work-budget", complete: true, usage: { ...ZERO_USAGE, inputTokens: allowance } });
		const current = service.inspectWork(work.workId);
		const usage = current.execution.usage ?? ZERO_USAGE;
		assert.equal(current.budget.consumedTokens, current.budget.maxTokens);
		assert.ok(current.execution.tokenAllowance > usage.inputTokens + usage.outputTokens);
		assert.equal(service.availableActions(work.workId, "conclave").find((action) => action.kind === "repair-ci").enabled, false);
		const result = await performCurrent(service, work.workId, "repair-ci", "ci-work-budget:authorize", {
			observationId: current.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});
