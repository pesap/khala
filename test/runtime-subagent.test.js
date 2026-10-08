import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { createRuntimeStorage } from "../dist/src/runtime-storage.js";
import { readProcessStartTime } from "../dist/src/runtime-process.js";

const usage = { inputTokens: 4, outputTokens: 3, cacheHitTokens: 2, cacheMissTokens: 5 };

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-subagent-receipt-"));
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, "unused-pi-entrypoint"] });
	t.after(async () => {
		try {
			await runtime.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	return { directory, runtime };
}

test("in-session Conclave receipts retain complete model usage for recovery", async (t) => {
	const { directory, runtime } = await fixture(t);
	const recorder = await runtime.beginNestedInvocation("nested-complete", "parent-session");
	recorder.reportUsage({ inputTokens: 2, outputTokens: 1, cacheHitTokens: 1, cacheMissTokens: 2 });
	recorder.complete(usage);

	assert.deepEqual(await runtime.reconcileInvocation("nested-complete"), { complete: true, usage });
	assert.throws(() => recorder.reportUsage(usage), /Runtime invocation nested-complete is already settled/);
	const receipt = JSON.parse(await readFile(createRuntimeStorage(directory).nestedInvocationPath("nested-complete"), "utf8"));
	assert.equal(receipt.sessionId, "parent-session");
	assert.equal("processGroupId" in receipt, false);
});

test("stale same-PID in-session receipts reconcile without killing Pi", async (t) => {
	const currentStartTime = readProcessStartTime(process.pid);
	if (currentStartTime === undefined) {
		t.skip("process start time is unavailable on this platform");
		return;
	}
	const { directory, runtime } = await fixture(t);
	const storage = createRuntimeStorage(directory);
	await storage.prepare();
	await writeFile(
		storage.nestedInvocationPath("nested-reused-pid"),
		JSON.stringify({
			schemaVersion: 1,
			runId: "nested-reused-pid",
			writerProcessId: process.pid,
			writerProcessStartTime: "an earlier process with this ID",
			sessionId: "previous-parent-session",
			complete: false,
		}),
		{ encoding: "utf8", mode: 0o600, flag: "wx" },
	);

	assert.deepEqual(await runtime.reconcileInvocation("nested-reused-pid"), { complete: false });
	assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("incomplete in-session receipts reconcile only after the writer stops without killing Pi", async (t) => {
	const { runtime } = await fixture(t);
	const recorder = await runtime.beginNestedInvocation("nested-partial", "active-parent-session");
	recorder.reportUsage(usage);
	await assert.rejects(runtime.reconcileInvocation("nested-partial"), /still active in this runtime/);
	recorder.stop();

	assert.doesNotThrow(() => process.kill(process.pid, 0));
	assert.deepEqual(await runtime.reconcileInvocation("nested-partial"), { complete: false, usage });
});
