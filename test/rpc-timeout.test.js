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
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_state") {
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: ${JSON.stringify(join(directory, "session.jsonl"))}, isStreaming: false } }) + "\\n");
	} else if (request.type === "prompt") {
		prompts += 1;
		const respond = () => process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n");
		const complete = () => {
			respond();
			process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed" }] } }) + "\\n");
			process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
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
	const runtime = new PiRpcRuntime({ command: [process.execPath, script], rpcTimeoutMs: 100, agentTimeoutMs: 500 });
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
