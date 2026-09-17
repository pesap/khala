import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService, meta, admitAndStart, validateWork } from "./helpers/mvp-fixtures.mjs";

test("Awaiting-review recovery reconciles an idle replacement runtime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-awaiting-recovery-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { recoverExecutor: true });
	const running = await admitAndStart(service, "awaiting-recovery");
	const awaiting = {
		...running,
		revision: running.revision + 1,
		execution: { ...running.execution, state: "awaiting-review", runtimeState: "unreachable" },
		nextAction: "Work is awaiting User review.",
	};
	archive.append({
		commandId: "awaiting-recovery:state",
		expectedWorkRevision: running.revision,
		kind: "execution",
		actor: "system",
		workId: running.workId,
		missionId: running.mission.missionId,
		executionId: running.execution.executionId,
		payloadVersion: 1,
		summary: "Execution is awaiting User review.",
		payload: awaiting.execution,
		projection: awaiting,
	});
	controls.runtimeState = "unreachable";
	const authorized = await service.perform({
		action: "recover",
		workId: running.workId,
		input: {},
		meta: meta("conclave", "awaiting-recovery:authorize", awaiting.revision, running.workId),
	});
	assert.equal("error" in authorized, false);
	assert.equal(authorized.value.execution.runtimeState, "pending");
	await service.processPendingEffects();
	const recovered = service.inspectWork(running.workId);
	assert.equal(recovered.execution.state, "awaiting-review");
	assert.equal(recovered.execution.runtimeState, "idle");
	await service.close();
});

test("stopped Work can be explicitly recovered after cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-cancel-recovery-"));
	const { service, archive } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Recoverable Work", objective: "Verify recovery", acceptanceCriteria: ["The Work can be recovered"] },
		meta("user", "cancel-recovery:submit", 0),
	);
	const withError = {
		...submitted,
		revision: submitted.revision + 1,
		lastError: {
			code: "external-failure",
			summary: "A previous attempt failed.",
			retryable: true,
			remediation: "Recover and retry.",
			evidenceRefs: [],
		},
	};
	archive.append({
		commandId: "cancel-recovery:error",
		expectedWorkRevision: submitted.revision,
		kind: "error",
		actor: "system",
		workId: submitted.workId,
		payloadVersion: 1,
		summary: "A previous attempt failed.",
		payload: { message: "A previous attempt failed." },
		projection: withError,
	});
	const stopped = await service.perform({
		action: "cancel",
		workId: submitted.workId,
		input: {},
		meta: meta("user", "cancel-recovery:cancel", withError.revision, submitted.workId),
	});
	assert.equal(stopped.value.state, "stopped");
	assert.equal(stopped.value.stopReason, "cancelled");
	assert.equal(service.listWork().find((item) => item.workId === stopped.value.workId)?.stopReason, "cancelled");
	const recovery = service.availableActions(stopped.value.workId, "user", stopped.value.revision).find(
		(action) => action.kind === "recover",
	);
	assert.equal(recovery?.enabled, true);
	const recovered = await service.perform({
		action: "recover",
		workId: submitted.workId,
		input: {},
		meta: meta("user", "cancel-recovery:recover", stopped.value.revision, submitted.workId),
	});
	assert.equal("error" in recovered, false);
	assert.equal(recovered.value.state, "submitted");
	assert.equal(recovered.value.mission, undefined);
	assert.equal(recovered.value.execution, undefined);
	assert.equal(recovered.value.lastError, undefined);
	assert.equal(recovered.value.nextAction, "Recovered Work is pending Conclave admission.");
	const admitted = await service.perform({
		action: "admit",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", "cancel-recovery:admit", recovered.value.revision, submitted.workId),
	});
	assert.equal(admitted.value.state, "queued");
	await service.close();
});

test("A late Conclave wake failure cannot overwrite a settled Outcome", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-terminal-wake-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async requestStop(binding) {
					if (binding.sessionId.startsWith("conclave-")) throw new Error("simulated stop race");
				},
			},
		},
	});
	const running = await admitAndStart(service, "terminal-wake");
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "terminal-wake:review", running.revision, running.workId, running.execution.executionId) });
	const validated = await validateWork(service, review.value, "terminal-wake:validate");
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head"] }, meta: meta("executor", "terminal-wake:ready", validated.revision, running.workId, running.execution.executionId) });
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "Review", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "terminal-wake:handoff", ready.value.revision, running.workId) });
	const merged = await service.perform({ action: "record-review", workId: running.workId, input: { status: "merged" }, meta: meta("user", "terminal-wake:merged", handoff.value.revision) });
	controls.outcome = true;
	await service.pollProvider(running.workId, meta("user", "terminal-wake:poll", merged.value.revision));
	const outcomeWork = service.inspectWork(running.workId);
	const outcome = await service.perform({ action: "record-outcome", workId: running.workId, input: {}, meta: meta("conclave", "terminal-wake:outcome", outcomeWork.revision, running.workId) });
	assert.equal(outcome.value.state, "succeeded");
	await service.processPendingEffects();
	const settled = service.inspectWork(running.workId);
	assert.equal(settled.state, "succeeded");
	assert.equal(settled.lastError, undefined);
	assert.equal(settled.nextAction, "Work succeeded.");
	await service.close();
});

test("a Work reaches success through branch publication, handoff, polling, and outcome evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-lifecycle-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "success");
	assert.equal(running.state, "active");
	assert.equal(running.execution.state, "running");
	assert.equal(controls.prompts.some((entry) => entry.message.includes("is bound")), true);

	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "success:review", running.revision, running.workId, running.execution.executionId) });
	const validated = await validateWork(service, review.value, "success:validate");
	assert.equal(review.value.reviewRequest.sourceBranch, running.execution.sandbox.branch);
	assert.equal(review.value.reviewRequest.headCommit, "head");
	assert.equal(controls.published.length, 1);
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready for review", evidence: ["head", "diff", "validation"] }, meta: meta("executor", "success:ready", validated.revision, running.workId, running.execution.executionId) });
	const conclavesBeforeReadyWake = controls.sessions.filter((entry) => entry.input.role === "conclave").length;
	await service.processPendingEffects();
	assert.equal(controls.sessions.filter((entry) => entry.input.role === "conclave").length > conclavesBeforeReadyWake, true);
	assert.equal(controls.sessions.find((entry) => entry.input.role === "conclave").input.sessionPath, undefined);
	const readyCurrent = service.inspectWork(running.workId);
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "The evidence is complete", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "success:handoff", readyCurrent.revision, running.workId) });
	assert.equal(handoff.value.state, "awaiting-review");

	const merged = await service.perform({ action: "record-review", workId: running.workId, input: { status: "merged" }, meta: meta("user", "success:reviewed", handoff.value.revision) });
	controls.outcome = true;
	const observed = await service.pollProvider(running.workId, meta("user", "success:poll", merged.value.revision));
	assert.equal(observed.lastObservation.status, "merged");
	controls.outcome = false;
	controls.pollObservations = [{ observationId: "ci:42", kind: "ci-status", providerId: "42", status: "open", summary: "Checks passed", changed: true, observedAt: new Date().toISOString() }];
	const refreshed = await service.pollProvider(running.workId, meta("user", "success:poll-ci", observed.revision));
	assert.equal(refreshed.lastObservation.kind, "ci-status");
	const outcome = await service.perform({ action: "record-outcome", workId: running.workId, input: {}, meta: meta("conclave", "success:outcome", refreshed.revision, running.workId) });
	assert.equal(outcome.value.state, "succeeded");
	assert.equal(outcome.value.missionState, "succeeded");
	await service.processPendingEffects();
	assert.equal(controls.cleaned.some((sandbox) => sandbox.branch === running.execution.sandbox.branch), true);
	assert.equal(controls.stopped.some((binding) => binding.sessionId.startsWith("executor-")), true);
	await service.close();
});
async function drainMockEffects(archive, owner) {
	for (;;) {
		const effects = archive.pendingEffects(owner);
		if (effects.length === 0) return;
		for (const effect of effects) assert.equal(archive.completeEffect(effect.effectId, owner), true);
	}
}

function providerOutcomeWakeHandler(service, workId) {
	return async (message) => {
		if (!message.includes("provider merge outcome")) return;
		const current = service.inspectWork(workId);
		const outcome = await service.perform({
			action: "record-outcome",
			workId,
			input: {},
			meta: meta("conclave", "provider-outcome-wake:outcome", current.revision, workId),
		});
		assert.equal("error" in outcome, false);
	};
}

test("Provider merge evidence wakes the Conclave and repairs an unsettled Work after restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-provider-outcome-wake-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const running = await admitAndStart(first.service, "provider-outcome-wake");
	const review = await first.service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "provider-outcome-wake:review", running.revision, running.workId, running.execution.executionId),
	});
	const merge = {
		observationId: "merge:42",
		kind: "provider-outcome",
		providerId: review.value.reviewRequest.providerId,
		status: "merged",
		repository: review.value.reviewRequest.repository,
		summary: "Merged",
		sourceBranch: review.value.reviewRequest.sourceBranch,
		targetBranch: review.value.reviewRequest.targetBranch,
		headCommit: review.value.reviewRequest.headCommit,
		mergeCommit: "merge-commit",
		changed: true,
		observedAt: new Date().toISOString(),
	};
	first.controls.pollObservations = [];
	first.controls.outcomeObservation = merge;
	const observed = await first.service.pollProvider(
		running.workId,
		meta("user", "provider-outcome-wake:poll", review.value.revision),
	);
	assert.equal(observed.state, "active");
	await first.service.processPendingEffects();
	assert.equal(observed.reviewRequest.status, "merged");
	assert.equal(first.controls.prompts.some((entry) => entry.message.includes("provider merge outcome")), true);
	assert.match(first.service.inspectWork(running.workId).lastError.summary, /outcome settlement failed/);
	await drainMockEffects(first.archive, "provider-outcome-test");
	await first.service.close();

	const second = makeService(path);
	second.controls.pollObservations = [];
	second.controls.outcomeObservation = merge;
	second.controls.onConclaveWake = providerOutcomeWakeHandler(second.service, running.workId);
	await second.service.runAutonomousCycle();
	const succeeded = second.service.inspectWork(running.workId);
	assert.equal(succeeded.state, "succeeded");
	assert.equal(succeeded.missionState, "succeeded");
	assert.equal(second.controls.prompts.some((entry) => entry.message.includes("provider merge outcome")), true);
	await second.service.close();
});

test("Provider polling remains idempotent across restart and requeues unsettled merge outcomes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-observations-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const running = await admitAndStart(first.service, "observations");
	const review = await first.service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "observations:review", running.revision, running.workId, running.execution.executionId) });
	const ci = { observationId: "ci:42", kind: "ci-status", providerId: "42", status: "open", summary: "Checks passed", changed: true, observedAt: new Date().toISOString() };
	const merge = { observationId: "merge:42", kind: "provider-outcome", providerId: "42", status: "merged", repository: review.value.reviewRequest.repository, summary: "Merged", sourceBranch: review.value.reviewRequest.sourceBranch, targetBranch: review.value.reviewRequest.targetBranch, headCommit: review.value.reviewRequest.headCommit, mergeCommit: "merge-commit", changed: true, observedAt: new Date().toISOString() };
	first.controls.pollObservations = [ci];
	first.controls.outcomeObservation = merge;
	const observed = await first.service.pollProvider(running.workId, meta("user", "observations:poll", review.value.revision));
	await first.service.close();

	const second = makeService(path);
	second.controls.pollObservations = [ci];
	second.controls.outcomeObservation = merge;
	const replayed = await second.service.pollProvider(running.workId, meta("user", "observations:replay", observed.revision));
	assert.equal(replayed.revision, observed.revision + 1);
	assert.equal(replayed.nextAction, "Provider merge observed; Conclave is recording the Outcome.");
	await second.service.close();
});

test("Provider observations resolve stale monitor failures and retain provider evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-provider-evidence-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "provider-evidence");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "provider-evidence:review", running.revision, running.workId, running.execution.executionId),
	});
	const failure = {
		code: "external-failure",
		summary: "Provider monitor failed: temporary provider error",
		retryable: true,
		remediation: "Retry provider polling.",
		evidenceRefs: [review.value.reviewRequest.providerId],
	};
	const withFailure = {
		...review.value,
		revision: review.value.revision + 1,
		lastError: failure,
		nextAction: "Provider monitor failed; retrying automatically.",
	};
	archive.append({
		commandId: "provider-evidence:failure",
		expectedWorkRevision: review.value.revision,
		kind: "error",
		actor: "monitor",
		workId: running.workId,
		missionId: running.mission.missionId,
		executionId: running.execution.executionId,
		payloadVersion: 1,
		summary: failure.summary,
		evidenceRefs: failure.evidenceRefs,
		payload: failure,
		projection: withFailure,
	});
	const feedback = "Add the cleanup-waits sentence.";
	controls.pollObservations = [
		{
			observationId: "review-comment:42:comment-1",
			kind: "review-comment",
			providerId: review.value.reviewRequest.providerId,
			status: "commented",
			summary: feedback,
			feedback: [feedback],
			author: "user-1",
			authorAssociation: "OWNER",
			actionable: true,
			changed: true,
			observedAt: new Date().toISOString(),
		},
	];
	const observed = await service.pollProvider(
		running.workId,
		meta("user", "provider-evidence:poll", withFailure.revision),
	);
	assert.equal(observed.lastError, undefined);
	const records = service.readRecords(
		{ workId: running.workId, kinds: ["observation"] },
		meta("user", "provider-evidence:records", observed.revision),
	);
	assert.deepEqual(records.items[0]?.evidenceRefs, [review.value.reviewRequest.url, "review-comment:42:comment-1"]);
	assert.deepEqual(records.items[0]?.payload.feedback, [feedback]);
	await service.close();
});

test("Provider polling clears stale monitor failures when no observations change", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-provider-recovery-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "provider-recovery");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "provider-recovery:review", running.revision, running.workId, running.execution.executionId),
	});
	const failure = {
		code: "external-failure",
		summary: "Provider monitor failed: temporary provider error",
		retryable: true,
		remediation: "Retry provider polling.",
		evidenceRefs: [review.value.reviewRequest.providerId],
	};
	const withFailure = {
		...review.value,
		revision: review.value.revision + 1,
		lastError: failure,
		nextAction: "Provider monitor failed; retrying automatically.",
	};
	archive.append({
		commandId: "provider-recovery:failure",
		expectedWorkRevision: review.value.revision,
		kind: "error",
		actor: "monitor",
		workId: running.workId,
		missionId: running.mission.missionId,
		executionId: running.execution.executionId,
		payloadVersion: 1,
		summary: failure.summary,
		evidenceRefs: failure.evidenceRefs,
		payload: failure,
		projection: withFailure,
	});
	controls.pollObservations = [];
	const recovered = await service.pollProvider(
		running.workId,
		meta("user", "provider-recovery:poll", withFailure.revision),
	);
	assert.equal(recovered.lastError, undefined);
	assert.match(recovered.nextAction, /continuing the Work automatically/);
	const records = service.readRecords(
		{ workId: running.workId, kinds: ["observation"] },
		meta("user", "provider-recovery:records", recovered.revision),
	);
	assert.match(records.items.at(-1)?.summary ?? "", /Provider polling succeeded/);
	const unrelated = {
		code: "external-failure",
		summary: "Conclave feedback assessment failed: temporary child error",
		retryable: true,
		remediation: "Restore Conclave and retry delivery.",
		evidenceRefs: [],
	};
	const withUnrelatedFailure = {
		...recovered,
		revision: recovered.revision + 1,
		lastError: unrelated,
		nextAction: "Conclave could not assess provider feedback; retrying automatically.",
	};
	archive.append({
		commandId: "provider-recovery:unrelated-failure",
		expectedWorkRevision: recovered.revision,
		kind: "error",
		actor: "conclave",
		workId: running.workId,
		missionId: running.mission.missionId,
		executionId: running.execution.executionId,
		payloadVersion: 1,
		summary: unrelated.summary,
		evidenceRefs: unrelated.evidenceRefs,
		payload: unrelated,
		projection: withUnrelatedFailure,
	});
	const preserved = await service.pollProvider(
		running.workId,
		meta("user", "provider-recovery:poll-unrelated", withUnrelatedFailure.revision),
	);
	assert.deepEqual(preserved.lastError, unrelated);
	await service.close();
});

test("authorized review feedback resumes the same Execution instead of leaving it idle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "feedback");
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback:review", running.revision, running.workId, running.execution.executionId) });
	const validated = await validateWork(service, review.value, "feedback:validate");
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "feedback:ready", validated.revision, running.workId, running.execution.executionId) });
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "feedback:handoff", ready.value.revision, running.workId) });
	const reviewed = await service.perform({ action: "record-review", workId: running.workId, input: { status: "changes-requested", feedback: ["Add the missing regression test."] }, meta: meta("user", "feedback:changes", handoff.value.revision) });
	assert.equal(reviewed.value.state, "active");
	assert.equal(reviewed.value.execution.state, "running");
	assert.equal(reviewed.value.missionState, "active");
	assert.equal(service.availableActions(running.workId, "executor").find((action) => action.kind === "create-review-request")?.enabled, true);
	await service.processPendingEffects();
	assert.equal(controls.prompts.some((entry) => entry.message.includes("missing regression test")), true);
	const deliveries = service.readRecords(
		{ workId: running.workId, kinds: ["delivery"] },
		meta("user", "feedback:deliveries", service.inspectWork(running.workId).revision),
	);
	assert.equal(deliveries.items.some((record) => record.payload.delivered === true && record.payload.observationId === undefined), true);
	const resumed = service.inspectWork(running.workId);
	controls.head = "feedback-head";
	const republished = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback:republish", resumed.revision, running.workId, running.execution.executionId) });
	assert.equal(republished.value.reviewRequest.headCommit, "feedback-head");
	const revalidated = await validateWork(service, republished.value, "feedback:revalidate");
	const readyAgain = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Updated and validated", evidence: ["feedback-head", "validation"] }, meta: meta("executor", "feedback:ready-again", revalidated.revision, running.workId, running.execution.executionId) });
	assert.equal(readyAgain.value.lastSignal.kind, "ready");
	await service.close();
});

test("provider feedback from another review head cannot be delivered", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-stale-feedback-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "stale-feedback");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "stale-feedback:review", running.revision, running.workId, running.execution.executionId),
	});
	controls.pollObservations = [
		{
			observationId: "review-comment:42:stale",
			kind: "review-comment",
			providerId: review.value.reviewRequest.providerId,
			status: "changes-requested",
			summary: "Stale feedback",
			feedback: ["Stale feedback"],
			actionable: true,
			repository: "another/project",
			sourceBranch: review.value.reviewRequest.sourceBranch,
			targetBranch: review.value.reviewRequest.targetBranch,
			headCommit: review.value.reviewRequest.headCommit,
			changed: true,
			observedAt: new Date().toISOString(),
		},
	];
	const observed = await service.pollProvider(running.workId, meta("user", "stale-feedback:poll", review.value.revision));
	const result = await service.perform({
		action: "deliver-feedback",
		workId: running.workId,
		input: { observationId: observed.lastObservation.observationId },
		meta: meta("conclave", "stale-feedback:deliver", observed.revision, running.workId),
	});
	assert.equal("error" in result, true);
	assert.equal(result.error.code, "invalid-state");

	controls.pollObservations[0] = {
		...controls.pollObservations[0],
		repository: review.value.reviewRequest.repository,
	};
	const current = await service.pollProvider(
		running.workId,
		meta("user", "stale-feedback:poll-current", service.inspectWork(running.workId).revision),
	);
	const firstDelivery = await service.perform({
		action: "deliver-feedback",
		workId: running.workId,
		input: { observationId: current.lastObservation.observationId },
		meta: meta("conclave", "stale-feedback:deliver-first", current.revision, running.workId),
	});
	const duplicateDelivery = await service.perform({
		action: "deliver-feedback",
		workId: running.workId,
		input: { observationId: current.lastObservation.observationId },
		meta: meta("conclave", "stale-feedback:deliver-duplicate", firstDelivery.value.revision, running.workId),
	});
	assert.equal("error" in firstDelivery, false);
	assert.equal("error" in duplicateDelivery, false);
	assert.equal(duplicateDelivery.value.revision, firstDelivery.value.revision);
	await service.close();
});

test("stale provider observations remain idempotent after a service restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-stale-feedback-restart-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const running = await admitAndStart(first.service, "stale-feedback-restart");
	const review = await first.service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "stale-feedback-restart:review", running.revision, running.workId, running.execution.executionId),
	});
	const stale = {
		observationId: "review-comment:42:stale-restart",
		kind: "review-comment",
		providerId: review.value.reviewRequest.providerId,
		status: "changes-requested",
		summary: "Stale feedback",
		feedback: ["Stale feedback"],
		actionable: true,
		repository: "another/project",
		sourceBranch: review.value.reviewRequest.sourceBranch,
		targetBranch: review.value.reviewRequest.targetBranch,
		headCommit: review.value.reviewRequest.headCommit,
		changed: true,
		observedAt: new Date().toISOString(),
	};
	first.controls.pollObservations = [stale];
	const observed = await first.service.pollProvider(
		running.workId,
		meta("user", "stale-feedback-restart:poll", review.value.revision),
	);
	await first.service.close();

	const second = makeService(path);
	second.controls.pollObservations = [stale];
	const repeated = await second.service.pollProvider(
		running.workId,
		meta("user", "stale-feedback-restart:poll-again", observed.revision),
	);
	assert.equal(repeated.revision, observed.revision);
	assert.equal(repeated.lastObservation.actionable, false);
	await second.service.close();
});

test("Cancellation stops the Executor before waiting for its final turn and sandbox cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-late-turn-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { executorHold: true });
	try {
		const running = await admitAndStart(service, "late-turn");
		const cancelled = await service.perform({
			action: "cancel",
			workId: running.workId,
			input: {},
			meta: meta("user", "late-turn:cancel", running.revision),
		});
		assert.equal(cancelled.value.state, "stopped");
		const cleanup = service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(controls.stopped.filter((binding) => binding.sessionId.startsWith("executor-")).length, 1);
		assert.equal(controls.cleaned.some((sandbox) => sandbox.path === running.execution.sandbox.path), false);
		controls.executorHold = false;
		controls.releaseExecutor();
		await cleanup;
		assert.equal(controls.cleaned.some((sandbox) => sandbox.path === running.execution.sandbox.path), true);
		const executorStops = controls.stopped.filter((binding) => binding.sessionId.startsWith("executor-"));
		assert.ok(executorStops.length >= 1);
		const owned = running.execution.pi;
		for (const binding of executorStops)
			assert.deepEqual(
				[
					binding.sessionId,
					binding.sessionPath,
					binding.processGroupId,
					binding.processStartTime,
					binding.capabilityNonce,
					binding.processMarker,
				],
				[
					owned.sessionId,
					owned.sessionPath,
					owned.processGroupId,
					owned.processStartTime,
					owned.capabilityNonce,
					owned.processMarker,
				],
			);
		const records = service.readRecords(
			{ workId: running.workId, kinds: ["execution"] },
			meta("user", "late-turn:records", service.inspectWork(running.workId).revision),
		);
		assert.equal(records.items.some((record) => record.summary.includes("turn completed")), false);
	} finally {
		controls.executorHold = false;
		controls.releaseExecutor();
		await service.close();
	}
});

test("A stale Executor stop effect does not stop a resumed Execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-stale-stop-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "stale-stop");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "stale-stop:review", running.revision, running.workId, running.execution.executionId),
	});
	const validated = await validateWork(service, review.value, "stale-stop:validate");
	const ready = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] },
		meta: meta("executor", "stale-stop:ready", validated.revision, running.workId, running.execution.executionId),
	});
	const handoff = await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId },
		meta: meta("conclave", "stale-stop:handoff", ready.value.revision, running.workId),
	});
	const resumed = await service.perform({
		action: "record-review",
		workId: running.workId,
		input: { status: "changes-requested", feedback: ["Fix the edge case."] },
		meta: meta("user", "stale-stop:changes", handoff.value.revision),
	});
	assert.equal(resumed.value.execution.state, "running");
	await service.processPendingEffects();
	assert.equal(controls.stopped.filter((binding) => binding.sessionId.startsWith("executor-")).length, 0);
	await service.close();
});
