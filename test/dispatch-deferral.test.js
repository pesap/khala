import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvocationCapacityExceeded } from "../dist/src/archive.js";
import { RunGateUnavailable } from "../dist/src/service-contracts.js";
import { DispatchEligibilityError } from "../dist/src/workflow-dispatch.js";
import { makeService } from "./helpers/mvp-fixtures.mjs";

function terms() {
	return {
		title: "Dispatch",
		objective: "Test dispatch deferral",
		context: "",
		scope: "scope",
		acceptanceCriteria: ["The dispatch remains retryable"],
		constraints: [],
		validation: ["check"],
		allowedPaths: ["."],
		maxTokens: 100,
	};
}

function executionWork(workId) {
	const mission = { missionId: `mission-${workId}`, workId, assignment: terms(), mandateRevision: 1, createdAt: new Date().toISOString() };
	const execution = {
		executionId: `execution-${workId}`,
		workId,
		missionId: mission.missionId,
		state: "running",
		runtimeState: "idle",
		model: "provider/executor",
		thinking: "medium",
		tokenAllowance: 50,
		promptIdentity: { packageVersion: "test", promptSha256: "test" },
		sandbox: { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" },
		pi: { sessionId: "executor-session", sessionPath: "/tmp/executor" },
	};
	return {
		workId,
		revision: 1,
		state: "active",
		terms: terms(),
		budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 },
		mission,
		missionState: "active",
		execution,
		nextAction: "Executor is idle.",
		queuedSequence: 1,
	};
}

function observerWork(workId) {
	return {
		workId,
		revision: 1,
		state: "submitted",
		terms: terms(),
		budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 },
		observerInFlight: true,
		nextAction: "Observer is queued.",
		queuedSequence: 1,
	};
}

function seed(archive, work, effect) {
	archive.append({
		commandId: `seed:${work.workId}`,
		expectedWorkRevision: 0,
		kind: "execution",
		actor: "system",
		workId: work.workId,
		missionId: work.mission?.missionId,
		executionId: work.execution?.executionId,
		payloadVersion: 1,
		summary: "seed",
		payload: {},
		projection: work,
		effects: [effect],
	});
}

function cases() {
	return [
		{
			role: "executor",
			work: executionWork("executor-dispatch-deferral"),
			effect: {
				effectId: "executor-dispatch-deferral:wake",
				kind: "executor-wake",
				payload: { workId: "executor-dispatch-deferral" },
			},
		},
		{
			role: "feedback",
			work: executionWork("feedback-dispatch-deferral"),
			effect: {
				effectId: "feedback-dispatch-deferral:wake",
				kind: "feedback-wake",
				payload: { workId: "feedback-dispatch-deferral", executionId: "execution-feedback-dispatch-deferral", feedback: ["Address the requested change."] },
			},
		},
		{
			role: "observer",
			work: observerWork("observer-dispatch-deferral"),
			effect: {
				effectId: "observer-dispatch-deferral:wake",
				kind: "observer-wake",
				payload: { workId: "observer-dispatch-deferral" },
			},
		},
	];
}

function deferrableErrors() {
	return [new RunGateUnavailable(), new InvocationCapacityExceeded(), new DispatchEligibilityError("budget-exhausted")];
}

function assertDeferredDispatch(role, current, archive, failure, effect, workId) {
	const errors = archive.query({ workId, kinds: ["error"] }).items;
	if (failure instanceof DispatchEligibilityError) {
		assert.equal(current.lastError.code, "budget-exhausted");
		assert.equal(errors.length, 1);
	} else {
		assert.equal(current.lastError, undefined, `${role} dispatch recorded a durable error`);
		assert.equal(errors.length, 0);
	}
	assert.equal(current.observerInFlight, role === "observer" ? true : undefined);
	if (role !== "observer") {
		assert.equal(current.execution.state, "running");
		assert.notEqual(current.execution.runtimeState, "unreachable");
	}
	assert.deepEqual(archive.pendingEffects("assertion").map(({ effectId }) => effectId), [effect.effectId]);
	archive.releaseEffect(effect.effectId, "assertion");
}

function assertGenuineDispatchFailure(role, current, archive, workId) {
	if (role === "observer") {
		assert.equal(current.observerInFlight, false);
		assert.equal(archive.query({ workId, kinds: ["error"] }).items.some(({ summary }) => summary === "Observer runtime failed."), true);
		return;
	}
	assert.equal(current.execution.state, role === "executor" ? "failed" : "running");
	assert.equal(current.execution.runtimeState, "unreachable");
	if (role === "feedback") {
		assert.equal(
			archive.query({ workId, kinds: ["delivery"] }).items.some(({ payload }) => payload.message === "provider runtime failed"),
			true,
		);
	}
}

test("executor, feedback, and observer dispatch gates remain retryable", async () => {
	for (const { role, work, effect } of cases()) {
		const directory = await mkdtemp(join(tmpdir(), `khala-${role}-dispatch-deferral-`));
		const { service, archive } = makeService(join(directory, "archive.sqlite"));
		seed(archive, work, effect);
		try {
			for (const failure of deferrableErrors()) {
				service.invocations.dispatch = async () => { throw failure; };
				await service.processPendingEffects();
				assertDeferredDispatch(role, service.inspectWork(work.workId), archive, failure, effect, work.workId);
			}
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("genuine dispatch errors still record runtime failures", async () => {
	for (const { role, work, effect } of cases()) {
		const directory = await mkdtemp(join(tmpdir(), `khala-${role}-dispatch-failure-`));
		const { service, archive } = makeService(join(directory, "archive.sqlite"));
		seed(archive, work, effect);
		try {
			service.invocations.dispatch = async () => { throw new Error("provider runtime failed"); };
			await service.processPendingEffects();
			assertGenuineDispatchFailure(role, service.inspectWork(work.workId), archive, work.workId);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});
