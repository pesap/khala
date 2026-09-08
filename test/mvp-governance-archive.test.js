import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApplication } from "../dist/src/factory.js";
import { makeService, meta, admitAndStart } from "./helpers/mvp-fixtures.mjs";

async function waitUntil(predicate, message) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("Terminal cleanup waits for an active feedback turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-cleanup-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	try {
		const running = await admitAndStart(service, "feedback-cleanup");
		const review = await service.perform({
			action: "create-review-request",
			workId: running.workId,
			input: {},
			meta: meta("executor", "feedback-cleanup:review", running.revision, running.workId, running.execution.executionId),
		});
		const ready = await service.perform({
			action: "record-signal",
			workId: running.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] },
			meta: meta("executor", "feedback-cleanup:ready", review.value.revision, running.workId, running.execution.executionId),
		});
		const handoff = await service.perform({
			action: "verdict",
			workId: running.workId,
			input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId },
			meta: meta("conclave", "feedback-cleanup:handoff", ready.value.revision, running.workId),
		});
		const changed = await service.perform({
			action: "record-review",
			workId: running.workId,
			input: { status: "changes-requested", feedback: ["Fix the edge case."] },
			meta: meta("user", "feedback-cleanup:changes", handoff.value.revision),
		});
		controls.executorHold = true;
		const processing = service.processPendingEffects();
		await waitUntil(() => controls.releaseExecutor !== undefined, "The feedback turn did not start.");
		const cancelled = await service.perform({
			action: "cancel",
			workId: running.workId,
			input: {},
			meta: meta("user", "feedback-cleanup:cancel", service.inspectWork(running.workId).revision),
		});
		assert.equal(cancelled.value.state, "stopped");
		const cleanup = service.processPendingEffects();
		await waitUntil(
			() => controls.stopped.some((binding) => binding.sessionId === running.execution.pi.sessionId),
			"Cancellation did not stop the active feedback runtime.",
		);
		assert.equal(controls.cleaned.some((sandbox) => sandbox.path === running.execution.sandbox.path), false);
		controls.executorHold = false;
		controls.releaseExecutor();
		await Promise.all([processing, cleanup]);
		assert.equal(controls.cleaned.some((sandbox) => sandbox.path === running.execution.sandbox.path), true);
		const deliveries = service.readRecords(
			{ workId: running.workId, kinds: ["delivery"] },
			meta("user", "feedback-cleanup:deliveries", service.inspectWork(running.workId).revision),
		);
		assert.equal(deliveries.items.some((record) => record.payload.delivered === true), false);
		assert.equal(service.inspectWork(running.workId).revision >= changed.value.revision, true);
	} finally {
		controls.executorHold = false;
		controls.releaseExecutor?.();
		await service.close();
	}
});

test("Feedback waits for an active Executor turn instead of being dropped", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-race-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { executorHold: true });
	const submitted = service.submitWork({ title: "Feedback race", objective: "Deliver feedback", acceptanceCriteria: ["Feedback is delivered"] }, meta("user", "feedback-race:submit", 0));
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "feedback-race:admit", submitted.revision, submitted.workId) });
	await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "feedback-race:start", admitted.value.revision, submitted.workId) });
	await service.processPendingEffects();
	const running = service.inspectWork(submitted.workId);
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback-race:review", running.revision, running.workId, running.execution.executionId) });
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "feedback-race:ready", review.value.revision, running.workId, running.execution.executionId) });
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "feedback-race:handoff", ready.value.revision, running.workId) });
	const changed = await service.perform({ action: "record-review", workId: running.workId, input: { status: "changes-requested", feedback: ["Fix the edge case."] }, meta: meta("user", "feedback-race:changes", handoff.value.revision) });
	const processing = service.processPendingEffects();
	controls.executorHold = false;
	controls.releaseExecutor();
	await processing;
	assert.equal(controls.prompts.some((entry) => entry.message.includes("Fix the edge case.")), true);
	assert.equal(service.inspectWork(running.workId).revision > changed.value.revision, true);
	await service.close();
});

function isFeedbackWakeMessage(message) {
	return message.includes("provider observation") || message.includes("provider feedback");
}

function feedbackObservationId(message) {
	return message.match(/observation (review-comment:42:\d+)/)?.[1];
}

async function deliverFeedbackOnWake(message, service, workId) {
	if (!isFeedbackWakeMessage(message)) return;
	const observationId = feedbackObservationId(message);
	if (observationId === undefined) return;
	const current = service.inspectWork(workId);
	const delivered = await service.perform({
		action: "deliver-feedback",
		workId,
		input: { observationId },
		meta: meta("conclave", `github-feedback:deliver:${observationId}`, current.revision, workId),
	});
	assert.equal("error" in delivered, false);
}

test("GitHub review feedback wakes the Conclave and resumes the same Execution without User action", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-github-feedback-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "github-feedback");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "github-feedback:review", running.revision, running.workId, running.execution.executionId),
	});
	const ready = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] },
		meta: meta("executor", "github-feedback:ready", review.value.revision, running.workId, running.execution.executionId),
	});
	await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId },
		meta: meta("conclave", "github-feedback:handoff", ready.value.revision, running.workId),
	});
	controls.pollObservations = [7, 8].map((id) => ({
		observationId: `review-comment:42:${id}`,
		kind: "review-comment",
		repository: review.value.reviewRequest.repository,
		sourceBranch: review.value.reviewRequest.sourceBranch,
		targetBranch: review.value.reviewRequest.targetBranch,
		headCommit: review.value.reviewRequest.headCommit,
		providerId: "42",
		status: "changes-requested",
		summary: `Please address review comment ${id}.`,
		feedback: [`Please address review comment ${id}.`],
		actionable: true,
		changed: true,
		observedAt: new Date().toISOString(),
	}));
	controls.onConclaveWake = (message) => deliverFeedbackOnWake(message, service, running.workId);
	controls.failFeedbackOnce = true;
	await service.runAutonomousCycle();
	await service.runAutonomousCycle();
	await service.runAutonomousCycle();
	const resumed = service.inspectWork(running.workId);
	assert.equal(resumed.state, "active");
	assert.equal(resumed.execution.state, "running");
	assert.equal(controls.prompts.some((entry) => entry.message.includes("Please address review comment 7.")), true);
	assert.equal(controls.prompts.some((entry) => entry.message.includes("Please address review comment 8.")), true);
	const revisionAfterDelivery = resumed.revision;
	const replayed = await service.pollProvider(
		running.workId,
		meta("user", "github-feedback:poll-replay", revisionAfterDelivery),
	);
	assert.equal(replayed.revision, revisionAfterDelivery);
	const deliveries = service.readRecords(
		{ workId: running.workId, kinds: ["delivery"] },
		meta("user", "github-feedback:deliveries", replayed.revision),
	);
	const firstDelivery = deliveries.items.filter((record) => record.payload.observationId === "review-comment:42:7");
	const secondDelivery = deliveries.items.filter((record) => record.payload.observationId === "review-comment:42:8");
	if (!firstDelivery.some((record) => record.payload.delivered === true)) {
		throw new Error(`First feedback delivery did not complete: ${JSON.stringify(firstDelivery.map((record) => record.payload))}`);
	}
	if (!secondDelivery.some((record) => record.payload.delivered === true)) {
		throw new Error(`Second feedback delivery did not complete: ${JSON.stringify(secondDelivery.map((record) => record.payload))}`);
	}
	assert.equal(firstDelivery.some((record) => record.payload.delivered === false), true);
	assert.equal(secondDelivery.some((record) => record.payload.delivered === false), true);
	await service.close();
});

test("Verdicts resume blocked Executors and prevent rejected Missions from restarting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-verdicts-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "verdicts");
	const blocked = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "blocked", summary: "Waiting for a decision", evidence: ["blocked"] },
		meta: meta("executor", "verdicts:blocked", running.revision, running.workId, running.execution.executionId),
	});
	await service.processPendingEffects();
	const executorPrompts = () => controls.prompts.filter((entry) => entry.binding.sessionId.startsWith("executor-")).length;
	const beforeContinue = executorPrompts();
	const blockedCurrent = service.inspectWork(running.workId);
	const continued = await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "continue", reason: "The Executor can continue", signalId: blocked.value.lastSignal.signalId },
		meta: meta("conclave", "verdicts:continue", blockedCurrent.revision, running.workId),
	});
	await service.processPendingEffects();
	assert.equal(continued.value.execution.state, "running");
	assert.equal(executorPrompts() > beforeContinue, true);
	const continuedCurrent = service.inspectWork(running.workId);
	const progress = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "progress", summary: "Progress before rejection", evidence: ["progress"] },
		meta: meta("executor", "verdicts:progress", continuedCurrent.revision, running.workId, running.execution.executionId),
	});
	const rejected = await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "reject", reason: "The Mission no longer applies", signalId: progress.value.lastSignal.signalId },
		meta: meta("conclave", "verdicts:reject", progress.value.revision, running.workId),
	});
	assert.equal(rejected.value.missionState, "rejected");
	assert.equal(service.availableActions(running.workId, "conclave").find((action) => action.kind === "start-execution").enabled, false);
	const restart = await service.perform({
		action: "start-execution",
		workId: running.workId,
		input: {},
		meta: meta("conclave", "verdicts:restart", rejected.value.revision, running.workId),
	});
	assert.equal(restart.error.code, "invalid-state");
	await service.close();
});

test("replaying a replacement Verdict returns the resulting replacement Execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-verdict-replay-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "verdict-replay");
	const progress = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "progress", summary: "Ready to replace", evidence: ["progress"] },
		meta: meta("executor", "verdict-replay:signal", running.revision, running.workId, running.execution.executionId),
	});
	const verdictInput = { decision: "replace", reason: "Try a fresh Execution", signalId: progress.value.lastSignal.signalId };
	const verdictMeta = meta("conclave", "verdict-replay:replace", progress.value.revision, running.workId);
	const replacement = await service.perform({ action: "verdict", workId: running.workId, input: verdictInput, meta: verdictMeta });
	assert.equal("error" in replacement, false);
	assert.equal(replacement.value.execution.state, "queued");
	assert.notEqual(replacement.value.execution.executionId, running.execution.executionId);
	const replay = await service.perform({ action: "verdict", workId: running.workId, input: verdictInput, meta: verdictMeta });
	assert.equal("error" in replay, false);
	assert.equal(replay.value.execution.executionId, replacement.value.execution.executionId);
	assert.equal(replay.value.execution.state, replacement.value.execution.state);
	await service.close();
});
async function restoreEnvironment(saved) {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

async function closeSharedArchive(parent, child, saved) {
	if (child !== undefined) await child.service.close();
	if (parent !== undefined) await parent.service.close();
	await restoreEnvironment(saved);
}

test("child role sessions resolve the parent project Archive instead of their sandbox Archive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-shared-archive-"));
	const project = await mkdtemp(join(directory, "project-"));
	const sandbox = await mkdtemp(join(directory, "sandbox-"));
	const names = ["PI_CODING_AGENT_DIR", "KHALA_PROJECT_PATH", "KHALA_PROJECT_TRUSTED", "KHALA_BOUND_WORK_ID", "KHALA_ROLE_TOKEN"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	let parent;
	let child;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		delete process.env.KHALA_PROJECT_PATH;
		delete process.env.KHALA_PROJECT_TRUSTED;
		delete process.env.KHALA_ROLE_TOKEN;
		parent = createApplication(project, false, process.cwd(), { requireModels: false });
		const submitted = parent.service.submitWork({ title: "Shared Archive", objective: "Use the parent project archive", acceptanceCriteria: ["The child sees the Work"] }, meta("user", "shared:submit", 0));
		process.env.KHALA_PROJECT_PATH = project;
		process.env.KHALA_PROJECT_TRUSTED = "0";
		process.env.KHALA_BOUND_WORK_ID = submitted.workId;
		process.env.KHALA_ROLE_TOKEN = "unused";
		child = createApplication(sandbox, false, process.cwd(), { requireModels: false });
		assert.equal(child.service.inspectWork(submitted.workId).workId, submitted.workId);
	} finally {
		await closeSharedArchive(parent, child, saved);
	}
});

test("a queued Execution is resumed after a crash window without creating a second attempt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovery-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const submitted = first.service.submitWork({ title: "Recovery feature", objective: "Recover queued work", acceptanceCriteria: ["The same attempt resumes"] }, meta("user", "recovery:submit", 0));
	const admitted = await first.service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "recovery:admit", submitted.revision, submitted.workId) });
	const queued = await first.service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "recovery:start", admitted.value.revision, submitted.workId) });
	const executionId = queued.value.execution.executionId;
	assert.equal(queued.value.execution.state, "queued");
	await first.service.close();

	const second = makeService(path);
	const current = second.service.inspectWork(submitted.workId);
	const recovered = await second.service.recoverWork(submitted.workId, meta("user", "recovery:resume", current.revision));
	assert.equal(recovered.execution.executionId, executionId);
	assert.equal(recovered.execution.state, "running");
	await second.service.processPendingEffects();
	const running = second.service.inspectWork(submitted.workId);
	assert.equal(running.execution.executionId, executionId);
	const reconciled = await second.service.recoverWork(submitted.workId, meta("user", "recovery:already-running", running.revision));
	assert.equal(reconciled.revision, running.revision);
	await second.service.close();
});

test("Concurrent idempotent starts clean up the losing sandbox", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-start-race-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork({ title: "Start race", objective: "Start once", acceptanceCriteria: ["One Execution is reserved"] }, meta("user", "start-race:submit", 0));
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "start-race:admit", submitted.revision, submitted.workId) });
	const command = { action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "start-race:start", admitted.value.revision, submitted.workId) };
	const results = await Promise.all([service.perform(command), service.perform(command)]);
	assert.equal("value" in results[0], true);
	assert.equal("value" in results[1], true);
	assert.equal(results[0].value.execution.executionId, results[1].value.execution.executionId);
	assert.equal(controls.cleaned.length, 1);
	await service.close();
});

test("Observer evidence is read-only, bound to one Work, and becomes admission context", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-observer-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { observerHold: true });
	const submitted = service.submitWork({ title: "Context feature", objective: "Use repository facts", acceptanceCriteria: ["Facts are used"], allowedPaths: ["docs"] }, meta("user", "observer:submit", 0));
	const launched = await service.perform({ action: "launch-observer", workId: submitted.workId, input: {}, meta: meta("conclave", "observer:launch", submitted.revision, submitted.workId) });
	assert.equal(launched.value.observerInFlight, true);
	await service.processPendingEffects();
	const bound = service.inspectWork(submitted.workId);
	const observerSession = controls.sessions.find((entry) => entry.input.role === "observer");
	assert.deepEqual(observerSession.input.tools, ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"]);
	assert.deepEqual(observerSession.input.allowedPaths, ["docs"]);
	assert.equal(observerSession.input.agentTimeoutMs, 120_000);
	const denied = await service.perform({ action: "record-assessment", workId: submitted.workId, input: { summary: "Facts", evidence: ["README.md"] }, meta: meta("observer", "observer:wrong-scope", bound.revision, "other-work") });
	assert.equal(denied.error.code, "forbidden");
	const assessment = await service.perform({ action: "record-assessment", workId: submitted.workId, input: { summary: "The project uses SQLite", evidence: ["docs/data-model.md"] }, meta: meta("observer", "observer:record", bound.revision, submitted.workId) });
	assert.equal(assessment.value.observerInFlight, false);
	assert.match(assessment.value.terms.context, /The project uses SQLite/);
	assert.equal(service.availableActions(submitted.workId, "conclave").find((action) => action.kind === "launch-observer").enabled, false);
	await service.processPendingEffects();
	assert.equal(controls.stopped.some((binding) => binding.sessionId.startsWith("observer-")), true);
	controls.releaseObserver();
	await service.close();
});

test("Observer recovery resumes a rebound turn while the stale turn finishes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-observer-recovery-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		observerHold: true,
		ports: {
			runtime: {
				async getState(binding) {
					return binding.sessionId.startsWith("observer-") ? "unreachable" : controls.runtimeState;
				},
			},
		},
	});
	const submitted = service.submitWork(
		{ title: "Observer recovery", objective: "Recover the assessment", acceptanceCriteria: ["The assessment resumes"] },
		meta("user", "observer-recovery:submit", 0),
	);
	await service.perform({
		action: "launch-observer",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", "observer-recovery:launch", submitted.revision, submitted.workId),
	});
	await service.processPendingEffects();
	const bound = service.inspectWork(submitted.workId);
	await new Promise((resolve) => setImmediate(resolve));
	const releaseOld = controls.releaseObserver;
	assert.ok(releaseOld);
	await service.recoverWork(
		submitted.workId,
		meta("user", "observer-recovery:recover", bound.revision, submitted.workId),
	);
	assert.equal(controls.sessions.filter((entry) => entry.input.role === "observer").length, 2);
	await new Promise((resolve) => setImmediate(resolve));
	const releaseNew = controls.releaseObserver;
	assert.ok(releaseNew);
	releaseOld();
	releaseNew();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(controls.prompts.filter((entry) => entry.binding.sessionId.startsWith("observer-")).length, 2);
	await service.close();
});
