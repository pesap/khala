import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { createRuntimeStorage } from "../dist/src/runtime-storage.js";

async function runtimeWithWriter() {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-cleanup-"));
	const script = join(directory, "writer.mjs");
	await writeFile(script, `import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const output = process.env.KHALA_TEST_OUTPUT;
const writer = setInterval(() => appendFileSync(output, "x"), 10);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
 const request = JSON.parse(line);
 if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "writer", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
 else if (request.type === "abort") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
});
process.on("SIGTERM", () => clearInterval(writer));
`);
	await chmod(script, 0o755);
	const output = join(directory, "writes");
	await writeFile(output, "");
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], baseEnvironment: { KHALA_TEST_OUTPUT: output }, rpcTimeoutMs: 200, agentTimeoutMs: 500 });
	return { runtime, output, directory };
}

test("requestStop prevents further writer activity", async () => {
	const { runtime, output } = await runtimeWithWriter();
	const binding = await runtime.ensureSession({ cwd: process.cwd(), model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "test" }, tools: [] });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await runtime.requestStop(binding);
	const stoppedAt = (await readFile(output)).length;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await readFile(output)).length, stoppedAt);
	await runtime.close();
});

test("requestStop refuses a forged process identity without releasing the lease", async () => {
	const { runtime, directory } = await runtimeWithWriter();
	const storage = createRuntimeStorage(directory);
	const sessionPath = storage.persistentSessionPath("executor", "identity");
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "test" }, tools: [], sessionPath });
	const forged = { ...binding, processStartTime: "forged-start-time" };
	await runtime.requestStop(forged);
	assert.ok(await stat(storage.launchLeasePath(sessionPath)));
	await runtime.requestStop(binding);
	await runtime.close();
});

test("requestStop kills a descendant after the leader exits and releases its lease last", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-descendant-"));
	const script = join(directory, "leader.mjs");
	const output = join(directory, "writes");
	await writeFile(output, "");
	await writeFile(script, `import { spawn } from "node:child_process"; import readline from "node:readline"; if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); } const sessionPath = process.argv[process.argv.indexOf("--session") + 1]; spawn(process.execPath, ["--input-type=module", "-e", "import { appendFileSync } from 'node:fs'; setInterval(() => appendFileSync(process.env.KHALA_TEST_OUTPUT, 'x'), 10)"], { env: process.env, stdio: "ignore" }); readline.createInterface({ input: process.stdin }).on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") { process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "descendant", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); setTimeout(() => process.exit(0), 30); } });`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], baseEnvironment: { KHALA_TEST_OUTPUT: output }, rpcTimeoutMs: 500, agentTimeoutMs: 500 });
	const storage = createRuntimeStorage(directory);
	const sessionPath = storage.persistentSessionPath("executor", "descendant");
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "test" }, tools: [], sessionPath });
	assert.ok(await stat(storage.launchLeasePath(sessionPath)));
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.ok((await readFile(output)).length > 0);
	await runtime.requestStop(binding);
	const stoppedAt = (await readFile(output)).length;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await readFile(output)).length, stoppedAt);
	await assert.rejects(stat(storage.launchLeasePath(sessionPath)), { code: "ENOENT" });
	await runtime.close();
});
