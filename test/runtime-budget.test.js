import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { RuntimeTurnError } from "../dist/src/ports.js";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-budget-"));
	const script = join(directory, "rpc.mjs");
	const aborts = join(directory, "aborts");
	await writeFile(script, `import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("0.85.0"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const message = (text, input, output = 0) => emit({ type: "message_end", message: {
 role: "assistant", content: [{ type: "text", text }],
 usage: { input, output, cacheRead: 100000, cacheWrite: 200000 }
} });
let scenario;
let next;
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 const reply = (success = true) => emit({ type: "response", id: request.id, command: request.type, success });
 if (request.type === "get_state") {
  emit({ type: "response", id: request.id, command: request.type, success: true,
   data: { sessionId: "budget-session", sessionFile: sessionPath, isStreaming: false } });
 }
 if (request.type === "prompt") {
  scenario = request.message;
  reply();
  if (scenario === "below") { message("below", 4, 5); emit({ type: "agent_settled" }); return; }
  if (scenario === "cumulative") { message("first", 4, 1); message("boundary", 3, 2); return; }
  if (scenario === "overshoot") { message("boundary", 8, 7); message("already in flight", 2); return; }
  message("boundary", 5, 5);
  if (scenario === "settled-before-ack") { emit({ type: "agent_settled" }); return; }
  if (scenario === "exit") { process.exit(1); return; }
  next = setTimeout(() => message("unbounded continuation", 100), 2000);
 }
 if (request.type === "abort") {
  appendFileSync(${JSON.stringify(aborts)}, "abort\\n");
  if (scenario === "ignore") return;
  if (scenario === "settled-before-ack") {
   setTimeout(() => { appendFileSync(${JSON.stringify(aborts)}, "ack\\n"); reply(); }, 50);
   return;
  }
  if (scenario === "reject") { reply(false); return; }
  reply();
  if (scenario === "ack-without-settlement") return;
  clearTimeout(next);
  emit({ type: "agent_settled" });
 }
});
`);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 300, agentTimeoutMs: 10000 });
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "budget-test" }, tools: [] });
	return { runtime, binding, aborts };
}

function usage(inputTokens, outputTokens, messages = 1) {
	return { inputTokens, outputTokens, cacheHitTokens: 100000 * messages, cacheMissTokens: inputTokens + 200000 * messages };
}

test("a completed message reaching its allowance requests abort and retains exact usage", async (t) => {
	const { runtime, binding, aborts } = await fixture(t);
	const turn = await runtime.send(binding, "boundary", { tokenAllowance: 10 });
	assert.equal(turn.output, "boundary");
	assert.deepEqual(turn.usage, usage(5, 5));
	assert.equal(await readFile(aborts, "utf8"), "abort\n");
});

test("cache metadata is not charged and each send starts a new allowance", async (t) => {
	const { runtime, binding, aborts } = await fixture(t);
	for (let index = 0; index < 2; index++) {
		const turn = await runtime.send(binding, "below", { tokenAllowance: 10 });
		assert.equal(turn.output, "below");
		assert.deepEqual(turn.usage, usage(4, 5));
	}
	assert.equal(await readFile(aborts, "utf8").catch(() => undefined), undefined);
});

test("the allowance covers cumulative completed messages in one invocation", async (t) => {
	const { runtime, binding, aborts } = await fixture(t);
	const turn = await runtime.send(binding, "cumulative", { tokenAllowance: 10 });
	assert.equal(turn.output, "boundary");
	assert.deepEqual(turn.usage, usage(7, 3, 2));
	assert.equal(await readFile(aborts, "utf8"), "abort\n");
});

test("overshoot and already-in-flight usage are retained without replacing boundary output", async (t) => {
	const { runtime, binding } = await fixture(t);
	const turn = await runtime.send(binding, "overshoot", { tokenAllowance: 10 });
	assert.equal(turn.output, "boundary");
	assert.deepEqual(turn.usage, usage(10, 7, 2));
});

for (const scenario of ["exit", "ignore", "reject", "ack-without-settlement"]) {
	test(`an allowance stop with ${scenario} fails within the stop deadline and retains usage`, { timeout: 4000 }, async (t) => {
		const { runtime, binding } = await fixture(t);
		await assert.rejects(runtime.send(binding, scenario, { tokenAllowance: 10 }), (error) => {
			assert.ok(error instanceof RuntimeTurnError);
			assert.deepEqual(error.usage, usage(5, 5));
			return true;
		});
		assert.equal(await runtime.getState(binding), "unreachable");
	});
}

test("settlement waits for the invocation's abort acknowledgement before allowing another prompt", async (t) => {
	const { runtime, binding, aborts } = await fixture(t);
	await runtime.send(binding, "settled-before-ack", { tokenAllowance: 10 });
	assert.equal(await readFile(aborts, "utf8"), "abort\nack\n");
	const next = await runtime.send(binding, "below", { tokenAllowance: 10 });
	assert.equal(next.output, "below");
});

test("invalid allowances fail before sending a model prompt", async (t) => {
	const { runtime, binding, aborts } = await fixture(t);
	for (const tokenAllowance of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(runtime.send(binding, "boundary", { tokenAllowance }), /positive safe integer/);
	}
	assert.equal(await readFile(aborts, "utf8").catch(() => undefined), undefined);
	assert.equal(await runtime.getState(binding), "idle");
});
