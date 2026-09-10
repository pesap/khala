import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta, validateWork, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";

function deferredRequest() {
	let release;
	let started;
	const began = new Promise((resolve) => {
		started = resolve;
	});
	return {
		began,
		complete: () => release?.(),
		wait(operation, result) {
			started(operation?.signal);
			return new Promise((resolve, reject) => {
				release = () => resolve(result);
				operation?.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true });
			});
		},
	};
}

async function bounded(promise, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function assertStoppedAndAccounted(service, archive, workId, reason, role) {
	const stopped = service.inspectWork(workId);
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.stopReason, reason);
	const invocation = archive
		.query({ workId, kinds: ["invocation"] })
		.items.filter((record) => record.payload.role === role)
		.at(-1).payload;
	assert.equal(invocation.state, "uncertain");
	assert.equal(invocation.usage, undefined);
	assert.equal(stopped.budget.reservedTokens, invocation.allowance);
	assert.equal(stopped.activeInvocations.find((run) => run.runId === invocation.runId)?.state, "uncertain");
	return stopped;
}

test("cancelling Work aborts only its pending Conclave request", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-cancel-"));
	const targetRequest = deferredRequest();
	const otherRequest = deferredRequest();
	const targetId = { value: "" };
	let otherSignal;
	let targetAborted = false;
	const { service, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send(_binding, message, _options, operation) {
					if (message.includes(targetId.value)) {
						operation?.signal.addEventListener("abort", () => {
							targetAborted = true;
						}, { once: true });
						return targetRequest.wait(operation, { output: "", usage: ZERO_USAGE });
					}
					otherSignal = operation?.signal;
					return otherRequest.wait(operation, { output: "", usage: ZERO_USAGE });
				},
			},
		},
	});
	const target = service.submitWork(
		{ title: "Target", objective: "Cancel pending decision", acceptanceCriteria: ["Stopped"] },
		meta("user", "target:submit", 0),
	);
	targetId.value = target.workId;
	const other = service.submitWork(
		{ title: "Other", objective: "Remain queued", acceptanceCriteria: ["Unaffected"] },
		meta("user", "other:submit", 0),
	);
	try {
		const pump = service.processPendingEffects();
		await bounded(targetRequest.began, "Conclave request did not start");
		const cancelled = await service.perform({
			action: "cancel",
			workId: target.workId,
			input: {},
			meta: meta("user", "target:cancel", service.inspectWork(target.workId).revision, target.workId),
		});
		assert.equal(cancelled.value.state, "stopped");
		const draining = service.processPendingEffects();
		await bounded(otherRequest.began, "Unrelated Conclave request did not remain dispatchable");
		assert.equal(targetAborted, true);
		assert.equal(otherSignal.aborted, false);
		targetRequest.complete();
		otherRequest.complete();
		await bounded(Promise.all([pump, draining]), "Conclave requests did not drain");
		assertStoppedAndAccounted(service, archive, target.workId, "cancelled", "conclave");
		assert.equal(service.inspectWork(other.workId).state, "submitted");
	} finally {
		targetRequest.complete();
		otherRequest.complete();
		await service.close();
	}
});

test("failing Work aborts its pending Oracle request and preserves the failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-oracle-cancel-"));
	const held = deferredRequest();
	let aborted = false;
	const { service, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			oracle: {
				review(_packet, _model, _thinking, _options, operation) {
					operation?.signal.addEventListener("abort", () => {
						aborted = true;
					}, { once: true });
					return held.wait(operation, {
						usage: ZERO_USAGE,
						verdict: "pass",
						findings: [],
						validationGaps: [],
						durationMs: 1,
						output: "pass",
					});
				},
			},
		},
	});
	try {
		let work = await admitAndStart(service, "oracle-stop");
		const review = await service.perform({
			action: "create-review-request",
			workId: work.workId,
			input: {},
			meta: meta("executor", "oracle-stop:review", work.revision, work.workId, work.execution.executionId),
		});
		work = review.value;
		work = await validateWork(service, work, "oracle-stop:validate");
		const ready = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["head", "validation"] },
			meta: meta("executor", "oracle-stop:ready", work.revision, work.workId, work.execution.executionId),
		});
		work = ready.value;
		const queued = await service.perform({
			action: "run-oracle",
			workId: work.workId,
			input: { subject: "Review this handoff" },
			meta: meta("conclave", "oracle-stop:queue", work.revision, work.workId),
		});
		assert.equal(queued.value.oraclePending.subject, "Review this handoff");
		const pump = service.processPendingEffects();
		await bounded(held.began, "Oracle request did not start");
		const current = service.inspectWork(work.workId);
		const failed = await service.perform({
			action: "fail-work",
			workId: work.workId,
			input: { reason: "Stop the pending review." },
			meta: meta("user", "oracle-stop:fail", current.revision, work.workId),
		});
		assert.equal(failed.value.stopReason, "failed");
		await bounded(service.processPendingEffects(), "Oracle cancellation did not drain");
		held.complete();
		await pump;
		assert.equal(aborted, true);
		assertStoppedAndAccounted(service, archive, work.workId, "failed", "oracle");
	} finally {
		held.complete();
		await service.close();
	}
});
