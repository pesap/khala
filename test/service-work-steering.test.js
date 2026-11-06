import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService, meta, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";

test("only the supervising User can queue guidance for the exact active Conclave run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-service-steering-"));
	const { service } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	const work = service.submitWork({
		title: "Steering test",
		objective: "Queue guidance for an active run",
		acceptanceCriteria: ["Guidance remains bound to the invocation"],
		scope: "Test scope",
		validation: ["node --test"],
	}, meta("user", "submit", 0));
	let release;
	let started;
	const blocked = new Promise((resolve) => { release = resolve; });
	const running = new Promise((resolve) => { started = resolve; });
	const effect = service.processPendingEffects({
		sessionId: "parent-session",
		runConclaveSubagent: async (request) => {
			started(request);
			await blocked;
			return { output: "Done", usage: ZERO_USAGE };
		},
	});
	try {
		const invocation = await running;
		const current = service.inspectWork(work.workId);
		assert.throws(() => service.steerWork(work.workId, invocation.runId, "wrong actor", meta("conclave", "bad-actor", current.revision)), /user/i);
		assert.throws(() => service.steerWork(work.workId, invocation.runId, "stale", meta("user", "bad-revision", current.revision - 1)), /revision/i);
		assert.throws(() => service.steerWork(work.workId, "other-run", "wrong run", meta("user", "bad-run", current.revision)), /run|invocation/i);
		const receipt = service.steerWork(work.workId, invocation.runId, "Use the public API.", meta("user", "steer", current.revision));
		assert.equal(receipt.status, "queued");
		assert.deepEqual(invocation.steering.pending().map(({ text }) => text), ["Use the public API."]);
		const admission = await service.perform({
			action: "admit",
			workId: work.workId,
			input: {},
			meta: meta("conclave", "admit", current.revision, work.workId),
		});
		assert.equal("error" in admission, false);
		assert.deepEqual(invocation.steering.pending(), []);
		assert.equal(invocation.steering.snapshot()[0].status, "not-inserted");
		release();
		await effect;
		const latest = service.inspectWork(work.workId);
		assert.throws(() => service.steerWork(work.workId, invocation.runId, "late", meta("user", "late", latest.revision)), /run|invocation/i);
		assert.deepEqual(service.readWorkSteering(work.workId, invocation.runId, meta("user", "receipts", latest.revision)), [
			{ ...receipt, status: "not-inserted" },
		]);
	} finally {
		release();
		await Promise.allSettled([effect]);
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a reserved run is not steerable until its receiver is attached", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-steering-startup-"));
	let releaseRecorder;
	let recorderStarted;
	let receiverStarted;
	let finishReceiver;
	const recorderGate = new Promise((resolve) => { releaseRecorder = resolve; });
	const reserved = new Promise((resolve) => { recorderStarted = resolve; });
	const ready = new Promise((resolve) => { receiverStarted = resolve; });
	const receiverGate = new Promise((resolve) => { finishReceiver = resolve; });
	const { service } = makeService(join(directory, "archive.sqlite"), {
		conclaveMode: "subagent",
		ports: { runtime: { beginNestedInvocation: async (runId) => {
			recorderStarted(runId);
			await recorderGate;
			return { reportUsage() {}, complete() {}, stop() {} };
		} } },
	});
	const work = service.submitWork({
		title: "Receiver startup",
		objective: "Wait for the receiver before accepting steering",
		acceptanceCriteria: ["Steering is unavailable during recorder startup"],
		scope: "Test scope",
		validation: ["node --test"],
	}, meta("user", "submit", 0));
	const effect = service.processPendingEffects({
		sessionId: "parent-session",
		runConclaveSubagent: async (request) => {
			receiverStarted(request);
			await receiverGate;
			return { output: "Done", usage: ZERO_USAGE };
		},
	});
	try {
		const runId = await reserved;
		const revision = service.inspectWork(work.workId).revision;
		assert.throws(() => service.steerWork(work.workId, runId, "too early", meta("user", "early", revision)), /unavailable/i);
		assert.throws(() => service.readWorkSteering(work.workId, runId, meta("user", "read-early", revision)), /no.*steering/i);
		releaseRecorder();
		await ready;
		assert.equal(service.steerWork(work.workId, runId, "ready", meta("user", "ready", service.inspectWork(work.workId).revision)).status, "queued");
	} finally {
		releaseRecorder();
		finishReceiver();
		await Promise.allSettled([effect]);
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("parent cancellation fences pending and new nested steering", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-steering-cancel-"));
	const { service } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	const work = service.submitWork({
		title: "Cancellation test",
		objective: "Fence guidance when the parent cancels",
		acceptanceCriteria: ["No steering survives the abort"],
		scope: "Test scope",
		validation: ["node --test"],
	}, meta("user", "submit", 0));
	const controller = new AbortController();
	let release;
	let started;
	const blocked = new Promise((resolve) => { release = resolve; });
	const running = new Promise((resolve) => { started = resolve; });
	const effect = service.processPendingEffects({
		sessionId: "parent-session",
		signal: controller.signal,
		runConclaveSubagent: async (request) => {
			started(request);
			await blocked;
			return { output: "Done", usage: ZERO_USAGE };
		},
	});
	try {
		const invocation = await running;
		const revision = service.inspectWork(work.workId).revision;
		service.steerWork(work.workId, invocation.runId, "queued", meta("user", "steer", revision));
		controller.abort();
		assert.throws(() => service.steerWork(work.workId, invocation.runId, "late", meta("user", "late", revision)), /cannot accept|settled/i);
		assert.equal(invocation.steering.snapshot()[0].status, "not-inserted");
	} finally {
		release();
		await Promise.allSettled([effect]);
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
