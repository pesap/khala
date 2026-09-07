import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { RuntimeTurnError } from "../dist/src/ports.js";

const input = {
	model: "model",
	thinking: "low",
	role: "executor",
	promptIdentity: { packageVersion: "1", promptSha256: "test" },
	tools: [],
};
const usage = { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 16 };

async function writeRuntimeStub(directory, body) {
	const script = join(directory, "runtime-stub.mjs");
	await writeFile(script, `import readline from "node:readline";
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
 const request = JSON.parse(line);
 if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
 ${body}
});`);
	await chmod(script, 0o755);
	return script;
}

function runtime(directory, script) {
	return new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 200, agentTimeoutMs: 300 });
}

test("an interrupted real process turn rejects with exact accumulated usage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-interrupted-usage-"));
	const script = await writeRuntimeStub(
		directory,
		`if (request.type === "prompt") {
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { input: 11, output: 7, cacheRead: 13, cacheWrite: 5 } } }) + "\\n");
  setTimeout(() => process.exit(1), 100);
}`,
	);
	const runtimeInstance = runtime(directory, script);
	try {
		const binding = await runtimeInstance.ensureSession({ cwd: directory, ...input });
		await assert.rejects(
			runtimeInstance.send(binding, "fail after partial output"),
			(error) => {
				if (!(error instanceof RuntimeTurnError) || error.usage === undefined) return false;
				assert.deepEqual(error.usage, usage);
				return true;
			},
		);
	} finally {
		await runtimeInstance.close();
	}
});

test("a second runtime reports a live foreign binding as unknown without stopping it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-foreign-binding-"));
	const script = await writeRuntimeStub(
		directory,
		`if (request.type === "abort") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");`,
	);
	const first = runtime(directory, script);
	const second = runtime(directory, script);
	try {
		const binding = await first.ensureSession({ cwd: directory, ...input });
		assert.equal(await second.getState(binding), "unknown");
		assert.equal(await first.getState(binding), "idle");
	} finally {
		await second.close();
		await first.close();
	}
});
