import assert from "node:assert/strict";
import { makeService as makeBaseService, meta, admitAndStart } from "./mvp-fixtures.mjs";

function makeService(path, overrides = {}) {
	return makeBaseService(path, { ...overrides, enableCiRepair: true });
}

function ciFailure(reviewRequest, overrides = {}) {
	return {
		observationId: "ci-failure:42:run-1",
		kind: "ci-status",
		providerId: reviewRequest.providerId,
		status: "checks-failed",
		summary: "A provider check failed.",
		repository: reviewRequest.repository,
		sourceBranch: reviewRequest.sourceBranch,
		targetBranch: reviewRequest.targetBranch,
		baseCommit: reviewRequest.baseCommit,
		headCommit: reviewRequest.headCommit,
		details: {
			pullRequest: { url: reviewRequest.url, status: reviewRequest.status, state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks: [
				{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" },
				{ kind: "check-run", name: "format", status: "COMPLETED", conclusion: "SUCCESS" },
			],
		},
		changed: true,
		observedAt: new Date().toISOString(),
		...overrides,
	};
}

function ciSuccess(reviewRequest) {
	return ciFailure(reviewRequest, {
		observationId: "ci-success:42:run-2",
		status: "open",
		summary: "All provider checks passed.",
		details: {
			pullRequest: { url: reviewRequest.url, status: reviewRequest.status, state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks: [{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "SUCCESS" }],
		},
	});
}

async function workWithCiFailure(service, controls, prefix, overrides = {}) {
	const running = await admitAndStart(service, prefix);
	const published = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", `${prefix}:publish`, running.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in published, false);
	controls.pollObservations = [ciFailure(published.value.reviewRequest, overrides)];
	const observed = await service.pollProvider(
		running.workId,
		meta("user", `${prefix}:poll-ci`, published.value.revision),
	);
	return { work: observed, reviewRequest: published.value.reviewRequest };
}

async function performCurrent(service, actor, action, commandId, input = {}) {
	const summary = service.listWork()[0];
	const work = service.inspectWork(summary.workId);
	const executionId = actor === "executor" ? work.execution.executionId : undefined;
	return service.perform({
		action,
		workId: work.workId,
		input,
		meta: meta(actor, commandId, work.revision, work.workId, executionId),
	});
}

function repairAction(service, workId) {
	return service.availableActions(workId, "conclave").find((action) => action.kind === "repair-ci");
}

export { ciFailure, ciSuccess, makeService, performCurrent, repairAction, workWithCiFailure };
