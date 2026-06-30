import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkMessagesToKhalaTranscript,
  hashKhalaTranscript,
  khalaTranscriptFromJsonl,
  khalaTranscriptToHarnessMessages,
  khalaTranscriptToJsonl,
  khalaTranscriptToolCalls,
  piAgentEndMessagesToKhalaTranscript,
  readKhalaTranscriptJsonl,
  runKhalaHarnessScript,
  transcriptFromJsonlLines,
  transcriptToJsonlLines,
  writeKhalaTranscriptJsonl,
  type KhalaHarnessRunnerInput,
} from "../../khala/harness.ts";

test("harness transcript converts benchmark messages and round-trips as JSONL", () => {
  const transcript = benchmarkMessagesToKhalaTranscript({
    assistantText: "Done after reading README.md.",
    messages: [
      { role: "user", text: "Inspect README.md." },
      {
        role: "assistant",
        toolCall: { arguments: { path: "README.md" }, name: "read" },
      },
      { role: "toolResult", text: "README contents" },
    ],
  });

  assert.deepEqual(
    transcript.events.map((event) => event.type),
    ["user_input", "tool_call_requested", "tool_result", "assistant_final"],
  );
  assert.equal(transcript.events[0].seq, 1);
  assert.equal(transcript.events[0].id, "ev-000001-user_input");
  assert.equal(khalaTranscriptToolCalls(transcript)[0].name, "read");

  const projected = khalaTranscriptToHarnessMessages(transcript);
  assert.deepEqual(projected[1], {
    content: [
      {
        arguments: { path: "README.md" },
        id: "call-2-read",
        name: "read",
        type: "toolCall",
      },
    ],
    role: "assistant",
  });

  const jsonl = khalaTranscriptToJsonl(transcript);
  const roundTrip = khalaTranscriptFromJsonl(jsonl);
  assert.equal(hashKhalaTranscript(roundTrip), hashKhalaTranscript(transcript));

  const lines = transcriptToJsonlLines(transcript);
  assert.match(lines[0], /"kind":"khala_transcript_start"/);
  assert.equal(
    hashKhalaTranscript(transcriptFromJsonlLines(lines)),
    hashKhalaTranscript(transcript),
  );
});

test("harness transcript JSONL file helpers preserve metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "khala-transcript-"));
  const filePath = path.join(dir, "transcript.jsonl");
  const transcript = benchmarkMessagesToKhalaTranscript({
    assistantText: "Done.",
    messages: [{ role: "user", text: "Export this transcript." }],
    metadata: { runLedgerId: "run-123", source: "unit-test" },
  });

  await writeKhalaTranscriptJsonl(filePath, transcript);
  const roundTrip = await readKhalaTranscriptJsonl(filePath);

  assert.deepEqual(roundTrip.metadata, transcript.metadata);
  assert.equal(hashKhalaTranscript(roundTrip), hashKhalaTranscript(transcript));
});

test("Pi agent_end messages convert to Khala transcript tool events", () => {
  const transcript = piAgentEndMessagesToKhalaTranscript([
    {
      content: [{ text: "Run tests.", type: "text" }],
      role: "user",
    },
    {
      content: [
        {
          arguments: { cmd: "npm test" },
          id: "call-bash",
          name: "bash",
          type: "toolCall",
        },
      ],
      role: "assistant",
    },
    {
      content: [{ text: "tests passed", type: "text" }],
      role: "toolResult",
      toolCallId: "call-bash",
      toolName: "bash",
    },
  ]);

  assert.deepEqual(
    khalaTranscriptToolCalls(transcript).map((event) => event.name),
    ["exec_command"],
  );
  assert.deepEqual(
    transcript.events.map((event) => event.type),
    ["user_input", "tool_call_requested", "tool_result"],
  );
});

test("scripted harness runner emits deterministic gate and fake tool events", async () => {
  const input: KhalaHarnessRunnerInput = {
    expectedEvents: [
      { type: "user_input", textIncludes: "Inspect package metadata." },
      { toolName: "read", type: "tool_call_requested" },
      { toolName: "read", type: "tool_call_warned", code: "large_file" },
      { toolName: "read", type: "tool_result", textIncludes: "package" },
      { type: "assistant_final", textIncludes: "metadata" },
    ],
    fakeTools: {
      read: (args: unknown) => ({ args, name: "package" }),
    },
    script: [
      {
        toolCall: { arguments: { path: "package.json" }, name: "read" },
        type: "tool_call",
      },
      {
        gate: {
          code: "large_file",
          decision: "warn",
          message: "bounded read recommended",
        },
        type: "gate",
      },
      { type: "tool_result" },
      { text: "The package metadata is consistent.", type: "assistant_final" },
    ],
    userText: "Inspect package metadata.",
    workflowType: "analysis",
  };

  const first = await runKhalaHarnessScript(input);
  const second = await runKhalaHarnessScript(input);

  assert.equal(hashKhalaTranscript(first), hashKhalaTranscript(second));
  assert.deepEqual(
    first.events.map((event) => event.type),
    [
      "user_input",
      "workflow_state",
      "tool_call_requested",
      "tool_call_warned",
      "tool_result",
      "assistant_final",
    ],
  );
});

test("scripted harness runner blocks fake tools and emits routing events", async () => {
  let executed = false;
  const transcript = await runKhalaHarnessScript({
    expectedEvents: [
      { type: "skill_routed", textIncludes: "docs" },
      { type: "skill_loaded", dataIncludes: "skills/docs-authoring/SKILL.md" },
      { type: "memory_gate", textIncludes: "MEMORY READ REQUIRED" },
      { toolName: "apply_patch", type: "tool_call_blocked" },
      { toolName: "apply_patch", type: "tool_result", textIncludes: "blocked" },
    ],
    fakeTools: {
      apply_patch: () => {
        executed = true;
        return "patched";
      },
    },
    script: [
      {
        skill: { name: "docs-authoring", reason: "docs update" },
        type: "skill_routed",
      },
      {
        skill: {
          name: "docs-authoring",
          path: "skills/docs-authoring/SKILL.md",
          source: "packaged",
        },
        type: "skill_loaded",
      },
      {
        toolCall: { arguments: { path: "README.md" }, name: "apply_patch" },
        type: "tool_call",
      },
      {
        memoryGate: {
          decision: "blocked",
          message: "MEMORY READ REQUIRED",
          toolName: "apply_patch",
        },
        type: "memory_gate",
      },
      {
        gate: {
          code: "memory_read_required",
          decision: "block",
          message: "MEMORY READ REQUIRED",
        },
        type: "gate",
      },
      { type: "tool_result" },
      {
        issue: {
          block: true,
          code: "memory_search",
          message: "mutation blocked until memory is fresh",
        },
        type: "policy_issue",
      },
    ],
    userText: "Update README.md.",
  });

  assert.equal(executed, false);
  assert.ok(
    transcript.events.some(
      (event) =>
        event.type === "policy_issue" && event.code === "memory_search",
    ),
  );
});
