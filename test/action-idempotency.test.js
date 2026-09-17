import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { makeService, meta } from "./helpers/mvp-fixtures.mjs";

test("reconciliation command identity includes nested usage and ignores object key order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-action-idempotency-"));
	let runtimeCalls = 0;
	const { service, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: { runtime: { async reconcileInvocation() { runtimeCalls += 1; return { complete: false }; } } },
	});
	try {
		const work = service.submitWork({ title: "Usage", objective: "Keep settlement exact", acceptanceCriteria: ["Exact accounting"] }, meta("user", "submit", 0));
		const held = new RunLedger(archive).reserve({ workId: work.workId, role: "conclave", allowance: 40 });
		const command = {
			action: "reconcile-invocation",
			workId: work.workId,
			input: { runId: held.runId, usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 3, cacheMissTokens: 4 }, evidence: ["receipt"] },
			meta: meta("user", "settle", held.projection.revision),
		};
		const first = await service.perform(command);
		assert.equal(first.value.budget.consumedTokens, 7);
		const reordered = await service.perform({ ...command, input: { ...command.input, usage: { cacheMissTokens: 4, outputTokens: 2, inputTokens: 5, cacheHitTokens: 3 } } });
		assert.equal(reordered.value.budget.consumedTokens, 7);
		const changed = await service.perform({ ...command, input: { ...command.input, usage: { ...command.input.usage, inputTokens: 6 } } });
		assert.equal(changed.error.code, "invalid-input");
		assert.equal(service.inspectWork(work.workId).budget.consumedTokens, 7);
		assert.equal(runtimeCalls, 1);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
