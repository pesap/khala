import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";

async function waitUntil(predicate, message) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function executorStops(controls) {
	return controls.stopped.filter((binding) => binding.sessionId.startsWith("executor-")).length;
}

function assertSettledExecutorUsage(service, archive, workId, stopReason) {
	const work = service.inspectWork(workId);
	assert.equal(work.state, "stopped");
	assert.equal(work.stopReason, stopReason);
	assert.equal(work.budget.reservedTokens, 0);
	const invocation = archive
		.query({ workId, kinds: ["invocation"] })
		.items.filter((record) => record.payload.role === "executor")
		.at(-1).payload;
	assert.equal(invocation.state, "settled");
	assert.deepEqual(invocation.usage, {
		inputTokens: 0,
		outputTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
	});
}

async function queueUnrelatedWork(service, controls, prefix) {
	const unrelated = service.submitWork(
		{ title: "Other Work", objective: "Progress after the stopped turn", acceptanceCriteria: ["Admitted"] },
		meta("user", `${prefix}:other-submit`, 0),
	);
	controls.onConclaveWake = async (message) => {
		if (!message.includes(unrelated.workId)) return;
		const current = service.inspectWork(unrelated.workId);
		await service.perform({
			action: "admit",
			workId: unrelated.workId,
			input: {},
			meta: meta("conclave", `${prefix}:other-admit`, current.revision, unrelated.workId),
		});
	};
	return unrelated;
}

async function finishHeldTurn(service, controls, processing, draining) {
	controls.executorHold = false;
	controls.releaseExecutor();
	await Promise.all([processing, draining]);
	await service.processPendingEffects();
}

test("cancellation stops a held authorized feedback turn before it settles", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-stop-"));
	const archivePath = join(directory, "archive.sqlite");
	const { service, controls, archive } = makeService(archivePath);
	try {
		const running = await admitAndStart(service, "held-feedback");
		const review = await service.perform({
			action: "create-review-request",
			workId: running.workId,
			input: {},
			meta: meta("executor", "held-feedback:review", running.revision, running.workId, running.execution.executionId),
		});
		const ready = await service.perform({
			action: "record-signal",
			workId: running.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["head", "validation"] },
			meta: meta("executor", "held-feedback:ready", review.value.revision, running.workId, running.execution.executionId),
		});
		const handoff = await service.perform({
			action: "verdict",
			workId: running.workId,
			input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId },
			meta: meta("conclave", "held-feedback:handoff", ready.value.revision, running.workId),
		});
		controls.executorHold = true;
		await service.perform({
			action: "record-review",
			workId: running.workId,
			input: { status: "changes-requested", feedback: ["Correct the implementation."] },
			meta: meta("user", "held-feedback:changes", handoff.value.revision, running.workId),
		});
		const processing = service.processPendingEffects();
		await waitUntil(() => controls.releaseExecutor !== undefined, "The authorized feedback turn did not start.");
		const cancelled = await service.perform({
			action: "cancel",
			workId: running.workId,
			input: {},
			meta: meta("user", "held-feedback:cancel", service.inspectWork(running.workId).revision, running.workId),
		});
		assert.equal(cancelled.value.stopReason, "cancelled");
		const contender = makeService(archivePath);
		await contender.service.processPendingEffects();
		assert.equal(executorStops(contender.controls), 0);
		assert.equal(executorStops(controls), 0);
		await contender.service.close();
		const unrelated = await queueUnrelatedWork(service, controls, "held-feedback");
		const draining = service.processPendingEffects();
		await waitUntil(() => executorStops(controls) === 1, "Cancellation did not stop the held feedback runtime.");
		assert.equal(service.inspectWork(unrelated.workId).state, "submitted");
		await finishHeldTurn(service, controls, processing, draining);
		assertSettledExecutorUsage(service, archive, running.workId, "cancelled");
		assert.equal(service.inspectWork(unrelated.workId).state, "queued");
	} finally {
		controls.executorHold = false;
		controls.releaseExecutor?.();
		await service.close();
	}
});

test("failure stops a held continued turn before it settles", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-continue-stop-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const running = await admitAndStart(service, "held-continue");
		const blocked = await service.perform({
			action: "record-signal",
			workId: running.workId,
			input: { kind: "blocked", summary: "Need direction", evidence: ["blocked"] },
			meta: meta("executor", "held-continue:blocked", running.revision, running.workId, running.execution.executionId),
		});
		await service.processPendingEffects();
		controls.executorHold = true;
		const continued = await service.perform({
			action: "verdict",
			workId: running.workId,
			input: { decision: "continue", reason: "Continue the work", signalId: blocked.value.lastSignal.signalId },
			meta: meta("conclave", "held-continue:verdict", service.inspectWork(running.workId).revision, running.workId),
		});
		assert.equal(continued.value.execution.state, "running");
		const processing = service.processPendingEffects();
		await waitUntil(() => controls.releaseExecutor !== undefined, "The continued Executor turn did not start.");
		const failed = await service.perform({
			action: "fail-work",
			workId: running.workId,
			input: { reason: "Stop the continued attempt." },
			meta: meta("user", "held-continue:fail", service.inspectWork(running.workId).revision, running.workId),
		});
		assert.equal(failed.value.stopReason, "failed");
		const unrelated = await queueUnrelatedWork(service, controls, "held-continue");
		const draining = service.processPendingEffects();
		await waitUntil(() => executorStops(controls) === 1, "Failure did not stop the held continued runtime.");
		assert.equal(service.inspectWork(unrelated.workId).state, "submitted");
		await finishHeldTurn(service, controls, processing, draining);
		assertSettledExecutorUsage(service, archive, running.workId, "failed");
		assert.equal(service.inspectWork(unrelated.workId).state, "queued");
	} finally {
		controls.executorHold = false;
		controls.releaseExecutor?.();
		await service.close();
	}
});

function heldTurn(usage) {
	let release;
	let markStarted;
	let hasStarted = false;
	const started = new Promise((resolve) => {
		markStarted = resolve;
	});
	return {
		started,
		get hasStarted() {
			return hasStarted;
		},
		start() {
			hasStarted = true;
			markStarted();
			return new Promise((resolve) => {
				release = () => resolve({ output: "", usage });
			});
		},
		release: () => release?.(),
	};
}

function runtimeBinding(input) {
	const workId = input.bindingScope?.workId ?? "global";
	return {
		sessionId: `${input.role}:${workId}`,
		sessionPath: `/tmp/${input.role}-${workId}.jsonl`,
		capabilityNonce: input.tools.length === 0 ? undefined : "test-capability-nonce",
	};
}

function assertExecutorReservation(service, workId) {
	const work = service.inspectWork(workId);
	const invocation = work.activeInvocations.find((candidate) => candidate.role === "executor");
	assert.equal(invocation.state, "reserved");
	assert.equal(work.budget.consumedTokens, 0);
	assert.equal(work.budget.reservedTokens, invocation.allowance);
}

async function verifyIndependentStops(mode) {
	const directory = await mkdtemp(join(tmpdir(), "khala-independent-stops-"));
	const firstTurn = heldTurn({ ...ZERO_USAGE, inputTokens: 7, outputTokens: 3 });
	const secondTurn = heldTurn({ ...ZERO_USAGE, inputTokens: 5, outputTokens: 2 });
	const held = new Map();
	const stops = [];
	let firstWorkId;
	let rejectedFirstStop = false;
	let releaseFirstStop;
	const firstStopAcknowledged = new Promise((resolve) => {
		releaseFirstStop = resolve;
	});
	const { service } = makeService(join(directory, "archive.sqlite"), {
		maxConcurrentExecutions: 2,
		ports: {
			runtime: {
				async ensureSession(input) {
					return runtimeBinding(input);
				},
				async send(binding) {
					return held.get(binding.sessionId)?.start() ?? { output: "", usage: ZERO_USAGE };
				},
				async getState() {
					return "idle";
				},
				async requestStop(binding) {
					stops.push(binding.sessionId);
					if (binding.sessionId === `executor:${firstWorkId}` && !rejectedFirstStop) {
						rejectedFirstStop = true;
						if (mode === "reject") throw new Error("first stop acknowledgement failed");
						return firstStopAcknowledged;
					}
				},
				async close() {},
			},
		},
	});
	try {
		const firstSubmitted = service.submitWork(
			{ title: "First held", objective: "Settle known usage", acceptanceCriteria: ["Stopped"] },
			meta("user", "independent:first-submit", 0),
		);
		firstWorkId = firstSubmitted.workId;
		const firstAdmitted = await service.perform({
			action: "admit",
			workId: firstWorkId,
			input: {},
			meta: meta("conclave", "independent:first-admit", firstSubmitted.revision, firstWorkId),
		});
		await service.perform({
			action: "start-execution",
			workId: firstWorkId,
			input: {},
			meta: meta("conclave", "independent:first-start", firstAdmitted.value.revision, firstWorkId),
		});
		held.set(`executor:${firstWorkId}`, firstTurn);
		await service.processPendingEffects();
		await waitUntil(() => firstTurn.hasStarted, "The first Executor turn did not start.");

		const second = await admitAndStart(service, "independent-second");
		const review = await service.perform({
			action: "create-review-request",
			workId: second.workId,
			input: {},
			meta: meta("executor", "independent:review", second.revision, second.workId, second.execution.executionId),
		});
		assert.equal("value" in review, true, JSON.stringify(review));
		const ready = await service.perform({
			action: "record-signal",
			workId: second.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["head", "validation"] },
			meta: meta("executor", "independent:ready", review.value.revision, second.workId, second.execution.executionId),
		});
		const handoff = await service.perform({
			action: "verdict",
			workId: second.workId,
			input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId },
			meta: meta("conclave", "independent:handoff", ready.value.revision, second.workId),
		});
		held.set(`executor:${second.workId}`, secondTurn);
		await service.perform({
			action: "record-review",
			workId: second.workId,
			input: { status: "changes-requested", feedback: ["Resume the Executor."] },
			meta: meta("user", "independent:changes", handoff.value.revision, second.workId),
		});
		const processing = service.processPendingEffects();
		await waitUntil(() => secondTurn.hasStarted, "The resumed Executor turn did not start.");
		for (const [workId, commandId] of [[firstWorkId, "first"], [second.workId, "second"]]) {
			const current = service.inspectWork(workId);
			await service.perform({
				action: "cancel",
				workId,
				input: {},
				meta: meta("user", `independent:${commandId}-cancel`, current.revision, workId),
			});
		}
		const draining = service.processPendingEffects().catch((error) => error);
		await waitUntil(
			() => stops.includes(`executor:${second.workId}`),
			"The first stop failure blocked the second stopped Executor.",
		);
		assertExecutorReservation(service, firstWorkId);
		assertExecutorReservation(service, second.workId);
		releaseFirstStop();
		firstTurn.release();
		secondTurn.release();
		const [, drainResult] = await Promise.all([processing, draining]);
		if (mode === "reject") {
			assert.ok(drainResult instanceof Error);
			assert.match(drainResult.message, /first stop acknowledgement failed/);
		} else {
			assert.equal(drainResult, undefined);
		}
		for (const [workId, consumed] of [[firstWorkId, 10], [second.workId, 7]]) {
			const stopped = service.inspectWork(workId);
			assert.equal(stopped.state, "stopped");
			assert.equal(stopped.stopReason, "cancelled");
			assert.equal(stopped.budget.reservedTokens, 0);
			assert.equal(stopped.budget.consumedTokens, consumed);
		}
	} finally {
		releaseFirstStop();
		firstTurn.release();
		secondTurn.release();
		await service.close();
	}
}

for (const mode of ["reject", "delay"]) {
	test(`one ${mode === "reject" ? "failed" : "delayed"} stop acknowledgement does not block another stopped Executor`, () =>
		verifyIndependentStops(mode));
}
