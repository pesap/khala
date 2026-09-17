import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta } from "./helpers/mvp-fixtures.mjs";

function appendRecords(archive, initialWork) {
	let current = initialWork;
	const visibleExecutionId = current.execution.executionId;
	for (let index = 0; index < 200; index += 1)
		current = appendRecord(archive, current, index, visibleExecutionId);
	return {
		current,
		visibleExecutionId,
		visibleIndexes: Array.from({ length: 199 }, (_, index) => (index < 99 ? index : index + 1)),
	};
}

function appendRecord(archive, current, index, visibleExecutionId) {
	const executionId = index === 99 ? "other-execution" : visibleExecutionId;
	const next = { ...current, revision: current.revision + 1 };
	archive.append({
		commandId: `scoped-pagination:${index}`,
		expectedWorkRevision: current.revision,
		kind: "error",
		actor: "system",
		workId: current.workId,
		missionId: current.mission?.missionId,
		executionId,
		payloadVersion: 1,
		summary: `record-${index}`,
		payload: { index },
		projection: next,
	});
	return next;
}

test("Executor record pagination keeps the page bound and cursor continuity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-scoped-record-pagination-"));
	const { archive, service } = makeService(join(directory, "archive.sqlite"));
	try {
		const running = await admitAndStart(service, "scoped-pagination");
		const { current, visibleExecutionId, visibleIndexes } = appendRecords(archive, service.inspectWork(running.workId));
		const readMeta = meta("executor", "scoped-pagination:read", 0, current.workId, visibleExecutionId);
		const first = service.readRecords({ workId: current.workId, kinds: ["error"] }, readMeta);
		assert.equal(first.items.length, 100);
		assert.ok(first.nextCursor);
		assert.deepEqual(
			first.items.map((record) => record.payload.index),
			visibleIndexes.slice(0, 100),
		);

		const second = service.readRecords({ workId: current.workId, kinds: ["error"] }, readMeta, first.nextCursor);
		assert.equal(second.items.length, 99);
		assert.equal(second.nextCursor, undefined);
		assert.deepEqual(
			[...first.items, ...second.items].map((record) => record.payload.index),
			visibleIndexes,
		);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
