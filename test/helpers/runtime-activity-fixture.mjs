import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcRuntime } from "../../dist/src/runtime.js";

export async function fixture(t, role = "executor") {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-activity-"));
	const script = join(directory, "rpc.mjs");
	await writeFile(script, `import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("1.1.0"); process.exit(0); }
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
 const request = JSON.parse(line);
 if (request.type === "get_state") return emit({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "activity-session", sessionFile: sessionPath, isStreaming: false } });
 if (request.type !== "prompt") return;
 emit({ type: "response", id: request.id, command: request.type, success: true });
 if (request.message === "overflow") {
  for (let i = 0; i < 105; i++) emit({ type: "tool_execution_start", toolCallId: "call-" + i, toolName: "read", args: { path: "PRIVATE_ARGUMENT" } });
  emit({ type: "agent_settled", aborted: false });
  return;
 }
 if (request.message === "exit-after-output") {
  for (let i = 0; i < 5000; i++) emit({ type: "tool_execution_start", toolCallId: "call-" + i, toolName: "read" });
  const message = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final output" }], usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } } };
  process.stdout.write(JSON.stringify(message) + "\\n" + JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n", () => process.exit(0));
  return;
 }
 if (request.message === "long") {
  const text = "\\u001b]0;bad\\u0007" + "x".repeat(5000);
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  emit({ type: "agent_settled", aborted: false });
  return;
 }
 if (request.message === "ansi-split") {
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Before\\u001b" } });
  setTimeout(() => {
   emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "]0;PRIVATE_TITLE\\u0007Visible" } });
   setTimeout(() => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Before\\u001b]0;PRIVATE_TITLE\\u0007Visible" }] } });
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\\u001b[" } });
    setTimeout(() => {
     emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "31mStyled" } });
     setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "\\u001b[31mStyled" }] } });
      emit({ type: "agent_settled", aborted: false });
     }, 15);
    }, 15);
   }, 15);
  }, 15);
  return;
 }
 if (request.message === "unicode") {
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\\ud83c" } });
  setTimeout(() => {
   emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\\udf31" } });
   setTimeout(() => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "🌱" }] } });
    emit({ type: "agent_settled", aborted: false });
   }, 30);
  }, 30);
  return;
 }
 if (request.message === "clipping") {
  const text = "x".repeat(3999) + "🌱";
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\\u001b[31m" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
  setTimeout(() => {
   emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
   emit({ type: "agent_settled", aborted: false });
  }, 30);
  return;
 }
 emit({ type: "message_start", message: { role: "assistant", content: [] } });
 emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } });
 setTimeout(() => {
 const frame = Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "🌱!" } }) + "\\n");
 const split = frame.indexOf(Buffer.from("🌱")) + 2;
 process.stdout.write(frame.subarray(0, split));
 process.stdout.write(frame.subarray(split));
 emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "PRIVATE_THINKING" } });
 emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello 🌱!" }], usage: { input: 1, output: 1 } } });
 emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "PRIVATE_ARGUMENT" } });
 emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "PRIVATE_RESULT" }] }, isError: false });
 emit({ type: "agent_settled", aborted: false });
 }, 30);
});
`);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000, agentTimeoutMs: 2_000 });
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "low", role, promptIdentity: { packageVersion: "1", promptSha256: "activity-test" }, tools: [] });
	return { runtime, binding };
}
