import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";

test("a late prompt acknowledgement does not terminate a completed child turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-prompt-timeout-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
let prompts = 0;
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
	} else if (request.type === "prompt") {
		prompts += 1;
		const respond = () => process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
		const complete = () => {
			respond();
			process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed" }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
			setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), 50);
		};
		if (prompts === 1) setTimeout(complete, 250);
		else complete();
	} else if (request.type === "abort") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
	}
});
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 100, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});

	assert.deepEqual(await runtime.send(binding, "delayed acknowledgement", { tokenAllowance: 100 }), { output: "completed" });
	assert.equal(await runtime.getState(binding), "idle");
	assert.deepEqual(await runtime.send(binding, "second prompt", { tokenAllowance: 100 }), { output: "completed" });
	await runtime.close();
});

test("cancelling a child turn aborts the Pi process and rejects the turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-cancel-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
	else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
	else if (request.type === "abort") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
});
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 100, agentTimeoutMs: 5000 });
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});
	const controller = new AbortController();
	const turn = runtime.send(binding, "cancel me", { tokenAllowance: 100 }, { signal: controller.signal });
	controller.abort();
	await assert.rejects(turn, /cancelled/);
	await runtime.close();
});

test("runtime state inspection honors cancellation before binding lookup", async () => {
	const runtime = new PiRpcRuntime({ projectPath: process.cwd(), command: [process.execPath, "missing-pi-command.mjs"] });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		runtime.getState({ sessionId: "missing", sessionPath: "/tmp/missing.jsonl" }, { signal: controller.signal }),
		/cancelled/,
	);
	await runtime.close();
});

test("rejects an oversized RPC frame and cleans up the child", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-oversized-frame-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") process.stdout.write("x".repeat(300000) + "\\n");
});
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500, maxRpcFrameBytes: 256_000 });
	await assert.rejects(
		runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] }),
		/exceeded the 256000-byte limit/,
	);
	await runtime.close();
});

test("rejects an active turn when a later RPC frame is oversized", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-turn-frame-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n" + "x".repeat(300000)); });
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500, maxRpcFrameBytes: 256_000 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	await assert.rejects(runtime.send(binding, "overflow", { tokenAllowance: 100 }), /exceeded the 256000-byte limit/);
	await runtime.close();
});

test("rejects a malformed JSON RPC frame", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-malformed-frame-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }\nprocess.stdout.write("{not-json}\\n");`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500 });
	await assert.rejects(
		runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] }),
		/valid JSON/,
	);
	await runtime.close();
});

test("rejects an unterminated oversized RPC frame", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-unterminated-frame-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }\nprocess.stdout.write("x".repeat(300000));`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500, maxRpcFrameBytes: 256_000 });
	await assert.rejects(
		runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] }),
		/exceeded the 256000-byte limit/,
	);
	await runtime.close();
});

test("rejects invalid RPC frame limits", () => {
	assert.throws(() => new PiRpcRuntime({ projectPath: process.cwd(), command: [process.execPath, "missing"], maxRpcFrameBytes: 0 }), /positive safe integer/);
	assert.throws(() => new PiRpcRuntime({ projectPath: process.cwd(), command: [process.execPath, "missing"], maxRpcFrameBytes: Number.POSITIVE_INFINITY }), /positive safe integer/);
});

test("rejects malformed RPC event shapes and pending turns", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-malformed-event-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n" + JSON.stringify({ type: "message_end", message: { role: "assistant", content: "not-an-array" } }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n"); });`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	await assert.rejects(runtime.send(binding, "malformed", { tokenAllowance: 100 }), /message content is invalid/);
	await runtime.close();
});

test("preserves fragmented Unicode and multiple LF-delimited RPC lines", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-fragmented-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
	} else if (request.type === "prompt") {
		const events = [
			{ type: "response", id: request.id, command: request.type, success: true },
			{ type: "message_end", message: { role: "user", content: "native string content" } },
			{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "héllo\\u2028world" }] } },
			{ type: "agent_settled" },
		];
		const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
		const split = bytes.indexOf(Buffer.from("é")) + 1;
		process.stdout.write(bytes.subarray(0, split));
		setTimeout(() => process.stdout.write(bytes.subarray(split)), 25);
	}
});
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	assert.deepEqual(await runtime.send(binding, "unicode", { tokenAllowance: 100 }), { output: "héllo\u2028world" });
	await runtime.close();
});

test("bounds retained assistant output with a truncation indicator", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-assistant-limit-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n" + JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(100000) }] } }) + "\\n" + JSON.stringify({ type: "agent_settled" }) + "\\n"); });
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 500, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	const turn = await runtime.send(binding, "large output", { tokenAllowance: 100 });
	assert.ok(turn.output.length <= 16_000);
	assert.match(turn.output, /truncated/);
	await runtime.close();
});

test("child runtimes do not inherit credential-shaped environment variables", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-environment-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
	} else if (request.type === "prompt") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.env.OPENAI_API_KEY ?? "missing" }] } }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
	}
});
`,
	);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({
		projectPath: directory,
		command: [process.execPath, script],
		baseEnvironment: { OPENAI_API_KEY: "must-not-leak" },
		rpcTimeoutMs: 100,
		agentTimeoutMs: 500,
	});
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});
	assert.deepEqual(await runtime.send(binding, "inspect environment", { tokenAllowance: 100 }), { output: "missing" });
	await runtime.close();
});
