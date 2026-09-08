import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { RuntimeStorage } from "../dist/src/runtime-storage.js";

const EXPECTED_USAGE = { inputTokens: 7, outputTokens: 3, cacheHitTokens: 11, cacheMissTokens: 20 };

async function makeFixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-invocation-"));
	const rpc = join(directory, "rpc.mjs");
	await writeFile(rpc, `import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("0.85.0"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
let abortCount = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 if (request.type === "get_state") emit({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "invocation-session", sessionFile: sessionPath, isStreaming: false } });
 if (request.type === "prompt") {
  emit({ type: "response", id: request.id, command: request.type, success: true });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: request.message }], usage: { input: 7, output: 3, cacheRead: 11, cacheWrite: 13 } } });
  if (request.message !== "partial") setTimeout(() => emit({ type: "agent_settled" }), 150);
 }
 if (request.type === "abort") {
  abortCount += 1;
  setTimeout(() => emit({ type: "response", id: request.id, command: request.type, success: true }), abortCount === 1 ? 300 : 0);
 }
});
setInterval(() => undefined, 1000);
`);
	t.after(async () => rm(directory, { recursive: true, force: true }));
	return { directory, rpc, storage: new RuntimeStorage(directory) };
}

async function waitForUsage(path) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const record = await readFile(path, "utf8").then(JSON.parse).catch(() => undefined);
		if (record?.usage !== undefined) return record;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for durable invocation usage.");
}

function runtimeOptions(directory, rpc) {
	return { projectPath: directory, command: [process.execPath, rpc], rpcTimeoutMs: 300, agentTimeoutMs: 10_000 };
}

test("a restarted runtime stops the proven old writer and reports partial usage", async (t) => {
	const { directory, rpc, storage } = await makeFixture(t);
	const sessionPath = storage.persistentSessionPath("executor", "crash-recovery");
	const runtimeUrl = pathToFileURL(join(process.cwd(), "dist/src/runtime.js")).href;
	const harness = join(directory, "writer.mjs");
	await writeFile(harness, `import { PiRpcRuntime } from ${JSON.stringify(runtimeUrl)};
const runtime = new PiRpcRuntime(${JSON.stringify(runtimeOptions(directory, rpc))});
const binding = await runtime.ensureSession({ cwd: ${JSON.stringify(directory)}, model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "recovery" }, tools: [], sessionPath: ${JSON.stringify(sessionPath)} });
console.log(JSON.stringify(binding));
await runtime.send(binding, "partial", { tokenAllowance: 100, runId: "crashed-run" });
`);
	const writer = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => writer.kill("SIGKILL"));
	await waitForUsage(storage.invocationPath("crashed-run"));
	writer.kill("SIGKILL");
	await new Promise((resolve) => writer.once("exit", resolve));

	const restarted = new PiRpcRuntime(runtimeOptions(directory, rpc));
	t.after(async () => restarted.close());
	const leasePath = storage.launchLeasePath(sessionPath);
	const leaseText = await readFile(leasePath, "utf8");
	const lease = JSON.parse(leaseText);
	await writeFile(leasePath, JSON.stringify({ ...lease, ownerProcessId: lease.ownerProcessId + 1 }));
	await assert.rejects(restarted.reconcileInvocation("crashed-run"), /owned by another writer/);
	process.kill(-lease.processGroupId, 0);
	await writeFile(leasePath, leaseText);
	const expected = {
		complete: false,
		usage: EXPECTED_USAGE,
	};
	assert.deepEqual(await restarted.reconcileInvocation("crashed-run"), expected);
	assert.deepEqual(await restarted.reconcileInvocation("crashed-run"), expected);
});

test("a completed receipt is returned without interrupting a newer session turn", async (t) => {
	const { directory, rpc, storage } = await makeFixture(t);
	const runtime = new PiRpcRuntime(runtimeOptions(directory, rpc));
	t.after(async () => runtime.close());
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "low",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "completed" },
		tools: [],
		sessionPath: storage.persistentSessionPath("executor", "completed"),
	});
	await runtime.send(binding, "completed", { tokenAllowance: 100, runId: "completed-run" });
	const newer = runtime.send(binding, "newer", { tokenAllowance: 100, runId: "newer-run" });
	await assert.rejects(runtime.reconcileInvocation("newer-run"), /still active/);
	assert.deepEqual(await runtime.reconcileInvocation("completed-run"), {
		complete: true,
		usage: EXPECTED_USAGE,
	});
	assert.equal((await newer).output, "newer");
});

test("a timed-out turn retains partial usage and durable cleanup proof", async (t) => {
	const { directory, rpc, storage } = await makeFixture(t);
	const runtime = new PiRpcRuntime({ ...runtimeOptions(directory, rpc), agentTimeoutMs: 100 });
	t.after(async () => runtime.close());
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "low",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "timeout" },
		tools: [],
		sessionPath: storage.persistentSessionPath("executor", "timeout"),
	});
	await assert.rejects(
		runtime.send(binding, "partial", { tokenAllowance: 100, runId: "timed-out-run" }),
		/timed out/,
	);
	assert.deepEqual(await runtime.reconcileInvocation("timed-out-run"), {
		complete: false,
		usage: EXPECTED_USAGE,
	});
});

test("cleanup accepts a completed receipt while allowance acknowledgement is pending", async (t) => {
	const { directory, rpc, storage } = await makeFixture(t);
	const runtime = new PiRpcRuntime(runtimeOptions(directory, rpc));
	t.after(async () => runtime.close());
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "low",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "completed-cleanup" },
		tools: [],
		sessionPath: storage.persistentSessionPath("executor", "completed-cleanup"),
	});
	const turn = runtime.send(binding, "completed-cleanup", {
		tokenAllowance: 10,
		runId: "completed-cleanup-run",
	});
	void turn.catch(() => undefined);
	for (;;) {
		const receipt = await waitForUsage(storage.invocationPath("completed-cleanup-run"));
		if (receipt.complete === true) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await runtime.requestStop(binding);
	await turn.catch(() => undefined);
	assert.deepEqual(await runtime.reconcileInvocation("completed-cleanup-run"), {
		complete: true,
		usage: EXPECTED_USAGE,
	});
});

test("missing and malformed invocation receipts fail closed", async (t) => {
	const { directory, rpc, storage } = await makeFixture(t);
	const runtime = new PiRpcRuntime(runtimeOptions(directory, rpc));
	t.after(async () => runtime.close());
	await assert.rejects(runtime.reconcileInvocation("missing-run"), /no durable receipt/);
	await storage.prepare();
	await writeFile(storage.invocationPath("malformed-run"), "{}", { mode: 0o600 });
	await assert.rejects(runtime.reconcileInvocation("malformed-run"), /malformed durable receipt/);
});
