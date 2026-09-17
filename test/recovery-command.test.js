import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recoverUserWork } from "../dist/src/extension-recovery.js";
import { admitAndStart, makeService, meta } from "./helpers/mvp-fixtures.mjs";

test("project recovery continues after one runtime probe fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovery-command-"));
	let failingSession;
	const fixture = makeService(join(directory, "archive.sqlite"), { ports: { runtime: {
		async getState(binding) {
			if (binding.sessionId === failingSession) throw new Error("first runtime transport failed");
			return failingSession === undefined ? "idle" : "working";
		},
	} } });
	try {
		const first = await admitAndStart(fixture.service, "first");
		const second = await admitAndStart(fixture.service, "second");
		failingSession = first.execution.pi.sessionId;
		const result = await recoverUserWork(fixture.service, [{ workId: first.workId }, { workId: second.workId }]);
		assert.equal(fixture.service.inspectWork(second.workId).execution.runtimeState, "working");
		assert.equal(result.completed, 1);
		assert.deepEqual(result.failures.map(({ workId, error }) => [workId, error.message]), [[first.workId, "first runtime transport failed"]]);
	} finally {
		await fixture.service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("project recovery accepts an empty Archive and leaves cancelled Work stopped", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovery-terminal-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	try {
		assert.deepEqual(await recoverUserWork(service, service.listWork()), { completed: 0, failures: [] });
		const submitted = service.submitWork({ title: "Cancelled", objective: "Leave cancelled Work stopped", acceptanceCriteria: ["No runtime starts"] }, meta("user", "submit", 0));
		const cancelled = await service.perform({ action: "cancel", workId: submitted.workId, meta: meta("user", "cancel", submitted.revision) });
		assert.equal(cancelled.value.state, "stopped");
		const before = service.inspectWork(submitted.workId);
		assert.deepEqual(await recoverUserWork(service, service.listWork()), { completed: 1, failures: [] });
		assert.deepEqual(service.inspectWork(submitted.workId), before);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("project recovery reports an unconfirmed replacement as a failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovery-unconfirmed-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	try {
		const work = await admitAndStart(service, "unconfirmed");
		controls.runtimeState = "unreachable";
		const result = await recoverUserWork(service, service.listWork());
		assert.equal(result.completed, 0);
		assert.equal(result.failures[0].workId, work.workId);
		assert.match(result.failures[0].error.message, /still unavailable/);
		assert.equal(service.inspectWork(work.workId).execution.state, "failed");
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
