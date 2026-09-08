import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService, meta } from "./helpers/mvp-fixtures.mjs";

test("cancelled failed preparation returns to fresh admission without stale prerequisites", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-cancelled-preparation-"));
	let repaired = false;
	let attempts = 0;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: { workspace: {
			async prepareSandbox(sandbox) {
				attempts += 1;
				if (!repaired) throw new Error("Required lockfile is missing.");
				return { schemaVersion: 1, kind: "no-node", sandboxPath: sandbox.path, baseCommit: sandbox.baseCommit, preparedAt: new Date().toISOString() };
			},
		} },
	});
	const act = async (action, actor, work, suffix) => {
		const result = await service.perform({ action, workId: work.workId, input: {}, meta: meta(actor, `preparation:${suffix}`, work.revision, work.workId) });
		assert.equal("value" in result, true, JSON.stringify(result));
		return result.value;
	};
	try {
		const submitted = service.submitWork({ title: "Prepare", objective: "Implement the change", acceptanceCriteria: ["Verified"] }, meta("user", "preparation:submit", 0));
		const admitted = await act("admit", "conclave", submitted, "admit");
		const waiting = await act("start-execution", "conclave", admitted, "start");
		assert.equal(waiting.preparation.status, "waiting");
		assert.equal(waiting.execution, undefined);
		const cancelled = await act("cancel", "user", waiting, "cancel");
		assert.equal(cancelled.stopReason, "cancelled");
		repaired = true;
		const recovered = await act("recover", "user", cancelled, "recover");
		assert.equal(recovered.state, "submitted");
		assert.equal(recovered.preparation, undefined);
		assert.equal(recovered.mission, undefined);
		assert.equal(recovered.execution, undefined);
		assert.equal(recovered.lastError, undefined);
		assert.deepEqual(recovered.budget, cancelled.budget);
		const readmitted = await act("admit", "conclave", recovered, "readmit");
		assert.notEqual(readmitted.mission.missionId, waiting.mission.missionId);
		const queued = await act("start-execution", "conclave", readmitted, "restart");
		assert.equal(queued.execution.state, "queued");
		assert.equal(attempts, 2);
	} finally {
		await service.close();
	}
});
