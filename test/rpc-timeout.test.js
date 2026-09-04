import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";

test("child sessions disable ambient extension discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-extensions-"));
	const script = join(directory, "rpc-stub.mjs");
	const argumentsPath = join(directory, "arguments.json");
	await writeFile(
		script,
		`import { writeFileSync } from "node:fs";
import readline from "node:readline";
const argumentsPath = ${JSON.stringify(argumentsPath)};
writeFileSync(argumentsPath, JSON.stringify(process.argv.slice(2)));
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
});
`,
	);
	const extensionPath = join(directory, "explicit-extension.ts");
	const runtime = new PiRpcRuntime({
		projectPath: directory,
		command: [process.execPath, script],
		extensionPath,
		rpcTimeoutMs: 100,
	});
	await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});
	const argumentsList = JSON.parse(await readFile(argumentsPath, "utf8"));
	assert.ok(argumentsList.includes("--no-extensions"));
	assert.ok(argumentsList.indexOf("--no-extensions") < argumentsList.indexOf("--extension"));
	assert.equal(argumentsList[argumentsList.indexOf("--extension") + 1], extensionPath);
	await runtime.close();
});

test("RPC output is bounded before malformed children can exhaust memory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-output-limit-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `process.stdout.write("x".repeat(600_000)); setTimeout(() => undefined, 60_000);\n`);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000 });
	await assert.rejects(
		runtime.ensureSession({
			cwd: directory,
			model: "model",
			thinking: "medium",
			role: "executor",
			promptIdentity: { packageVersion: "1", promptSha256: "hash" },
			tools: [],
		}),
		/RPC output exceeded/,
	);
	await runtime.close();
});

test("assistant output is bounded independently of RPC framing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-assistant-limit-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
	if (request.type === "prompt") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100_000) }] } }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
	}
});
`,
	);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000 });
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});
	const turn = await runtime.send(binding, "large response");
	assert.equal(Buffer.byteLength(turn.output, "utf8") <= 64_000, true);
	assert.match(turn.output, /assistant output truncated by Khala/);
	await runtime.close();
});

test("a late prompt acknowledgement does not terminate a completed child turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-prompt-timeout-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
let prompts = 0;
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

	assert.deepEqual(await runtime.send(binding, "delayed acknowledgement"), { output: "completed" });
	assert.equal(await runtime.getState(binding), "idle");
	assert.deepEqual(await runtime.send(binding, "second prompt"), { output: "completed" });
	await runtime.close();
});

test("cancelling a child turn aborts the Pi process and rejects the turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-cancel-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
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
	const turn = runtime.send(binding, "cancel me", { signal: controller.signal });
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

test("child runtimes do not inherit credential-shaped environment variables", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-environment-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
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
	assert.deepEqual(await runtime.send(binding, "inspect environment"), { output: "missing" });
	await runtime.close();
});
