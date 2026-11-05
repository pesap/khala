import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta } from "./helpers/mvp-fixtures.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "khala-work-activity-"));
	let onActivity;
	let observedBinding;
	let closed = 0;
	let snapshotHook = () => {};
	let observeHook = () => {};
	let closeHook = () => {};
	const snapshot = { state: "attached", entries: [{ kind: "message", text: "Working", truncated: false }], discarded: 0 };
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		executorHold: true,
		ports: { runtime: {
			observe(binding, onChange) {
				observedBinding = binding;
				onActivity = onChange;
				observeHook();
				return { snapshot: () => { snapshotHook(); return snapshot; }, close: () => { closed += 1; closeHook(); } };
			},
		} },
	});
	t.after(async () => {
		controls.releaseExecutor?.();
		await service.close();
		await rm(directory, { recursive: true, force: true });
	});
	const work = await admitAndStart(service, "activity");
	return { service, work, archive, snapshot, observedBinding: () => observedBinding, emit: () => onActivity?.(), closed: () => closed,
		setSnapshotHook: (hook) => { snapshotHook = hook; }, setObserveHook: (hook) => { observeHook = hook; },
		setCloseHook: (hook) => { closeHook = hook; } };
}

test("only the user can observe the current Work Executor at the selected revision", async (t) => {
	const { service, work, snapshot, observedBinding } = await fixture(t);
	const user = meta("user", "observe", work.revision);
	assert.throws(() => service.observeExecutor(work.workId, { ...user, actor: "executor" }, () => {}), /only the user/i);
	assert.throws(() => service.observeExecutor(work.workId, { ...user, expectedWorkRevision: work.revision - 1 }, () => {}), /revision/i);
	const subscription = service.observeExecutor(work.workId, user, () => {});
	assert.deepEqual(observedBinding(), work.execution.pi);
	assert.deepEqual(subscription.snapshot(), snapshot);
	assert.doesNotMatch(JSON.stringify(subscription.snapshot()), /sessionPath|capabilityNonce|processMarker/);
	subscription.close();
});

test("closing during runtime snapshot retrieval never returns the old snapshot", async (t) => {
	const { service, work, setSnapshotHook } = await fixture(t);
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => {});
	setSnapshotHook(() => subscription.close());
	assert.throws(() => subscription.snapshot(), /closed/i);
});

test("cancellation during runtime snapshot retrieval never returns the old snapshot", async (t) => {
	const { service, work, setSnapshotHook, closed } = await fixture(t);
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => {});
	let cancellation;
	setSnapshotHook(() => {
		const current = service.inspectWork(work.workId);
		cancellation = service.perform({ action: "cancel", workId: work.workId, input: {}, meta: meta("user", "cancel", current.revision) });
	});
	assert.deepEqual(subscription.snapshot(), { state: "detached", entries: [], discarded: 0 });
	assert.equal((await cancellation).value.state, "stopped");
	assert.equal(closed(), 1);
	subscription.close();
});

test("synchronous invalidation during subscription rejects and closes without notifying", async (t) => {
	const { service, work, emit, closed, setObserveHook } = await fixture(t);
	let changes = 0;
	let cancellation;
	setObserveHook(() => {
		const current = service.inspectWork(work.workId);
		cancellation = service.perform({ action: "cancel", workId: work.workId, input: {}, meta: meta("user", "cancel", current.revision) });
		emit();
	});
	assert.throws(() => service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { changes += 1; }), /changed while observation/i);
	assert.equal((await cancellation).value.state, "stopped");
	assert.equal(closed(), 1);
	assert.equal(changes, 0);
});

for (const kind of ["execution", "binding", "terminal"]) {
	test(`activity detaches when the Work projects a different ${kind}`, async (t) => {
		const { service, work, archive, emit, closed } = await fixture(t);
		let changes = 0;
		const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { changes += 1; });
		const current = service.inspectWork(work.workId);
		const execution = { ...current.execution };
		if (kind === "execution") execution.executionId = "replacement";
		if (kind === "binding") execution.pi = { ...execution.pi, processMarker: "replacement" };
		archive.append({ commandId: `test:${kind}`, expectedWorkRevision: current.revision, kind: "execution", actor: "system",
			workId: current.workId, payloadVersion: 1, payload: {}, summary: "Project the replacement fixture.",
			projection: { ...current, revision: current.revision + 1, state: kind === "terminal" ? "succeeded" : current.state, execution } });
		emit();
		assert.deepEqual(subscription.snapshot(), { state: "detached", entries: [], discarded: 0 });
		assert.equal(closed(), 1);
		assert.equal(changes, 1);
		subscription.close();
	});
}

test("a throwing User callback does not disrupt the runtime adapter", async (t) => {
	const { service, work, emit } = await fixture(t);
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { throw new Error("viewer failed"); });
	assert.doesNotThrow(emit);
	subscription.close();
});

test("an asynchronously rejecting User callback does not escape observation", async (t) => {
	const { service, work, emit } = await fixture(t);
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), async () => { throw new Error("viewer rejected"); });
	emit();
	await new Promise((resolve) => setImmediate(resolve));
	subscription.close();
});

test("a synchronous callback during close cannot deliver activity", async (t) => {
	const { service, work, emit, closed, setCloseHook } = await fixture(t);
	let changes = 0;
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { changes += 1; });
	setCloseHook(emit);
	subscription.close();
	assert.equal(changes, 0);
	assert.equal(closed(), 1);
});

test("queued activity is ignored after the subscriber closes", async (t) => {
	const { service, work, emit, closed } = await fixture(t);
	let changes = 0;
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { changes += 1; });
	subscription.close();
	emit();
	assert.equal(changes, 0);
	assert.equal(closed(), 1);
});

test("an unavailable Work projection fails closed", async (t) => {
	const { service, work, archive, closed } = await fixture(t);
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => {});
	const project = archive.project.bind(archive);
	try {
		archive.project = () => { throw new Error("archive unavailable"); };
		assert.deepEqual(subscription.snapshot(), { state: "detached", entries: [], discarded: 0 });
		assert.equal(closed(), 1);
	} finally {
		archive.project = project;
	}
	subscription.close();
});

test("a cancelled Work detaches activity and cannot expose subsequent child output", async (t) => {
	const { service, work, emit, closed } = await fixture(t);
	let changes = 0;
	const subscription = service.observeExecutor(work.workId, meta("user", "observe", work.revision), () => { changes += 1; });
	const current = service.inspectWork(work.workId);
	const result = await service.perform({ action: "cancel", workId: work.workId, input: {}, meta: meta("user", "cancel", current.revision) });
	assert.equal(result.value.state, "stopped");
	emit();
	assert.deepEqual(subscription.snapshot(), { state: "detached", entries: [], discarded: 0 });
	assert.equal(closed(), 1);
	assert.equal(changes, 1);
	emit();
	assert.equal(changes, 1);
	subscription.close();
	assert.throws(() => subscription.snapshot(), /closed/i);
});
