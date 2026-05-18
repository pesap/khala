import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantMessageHasToolCall,
  findPendingMemoryGateRecovery,
  inferTurnObligation,
  isAssistantClarification,
} from "../../extensions/runtime/assistant.ts";

type Message = Parameters<typeof findPendingMemoryGateRecovery>[0][number];

function textMessage(role: Message["role"], text: string): Message {
  return {
    role,
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: {} }],
  };
}

function memoryReadRequired(toolName: string): Message {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: "MEMORY READ REQUIRED\n\nCall khala_read_memory." }],
  };
}

test("detects incomplete same-turn recovery after khala_read_memory", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    textMessage("assistant", "I refreshed memory and will do it next turn."),
  ];

  assert.deepEqual(findPendingMemoryGateRecovery(messages), {
    blockedToolName: "write",
  });
});

test("clears recovery requirement once the blocked mutation is retried", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    assistantToolCall("write"),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("ignores memory-read-required when no memory read happened yet", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    memoryReadRequired("edit"),
    textMessage("assistant", "Need to refresh memory first."),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("infers tool obligation for concrete inspection requests", () => {
  assert.equal(
    inferTurnObligation("Load your librarian skill and inspect the Torc repo").obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation("Can you analyze the pi-session at /tmp/session.jsonl?").obligation,
    "tool_required",
  );
  assert.equal(inferTurnObligation("do it").obligation, "tool_required");
});

test("allows normal explanation questions without tools", () => {
  assert.equal(inferTurnObligation("Is there a way I can avoid this?").obligation, "answer_allowed");
});

test("detects assistant tool-call and clarification output shapes", () => {
  assert.equal(assistantMessageHasToolCall(assistantToolCall("read")), true);
  assert.equal(isAssistantClarification(textMessage("assistant", "Which file should I inspect?")), true);
  assert.equal(isAssistantClarification(textMessage("assistant", "I will inspect that next.")), false);
});
