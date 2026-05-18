import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantMessageHasToolCall,
  findPendingMemoryGateRecovery,
  inferTurnObligation,
  isActionOrApprovalObligation,
  isAssistantClarification,
  shouldBlockUnsatisfiedTurnObligation,
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
    content: [
      { type: "text", text: "MEMORY READ REQUIRED\n\nCall khala_read_memory." },
    ],
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

test("clears recovery requirement once a blocked khala_learn is retried", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("khala_learn"),
    memoryReadRequired("khala_learn"),
    assistantToolCall("khala_read_memory"),
    assistantToolCall("khala_learn"),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("does not clear recovery when a different retry-capable tool runs", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    assistantToolCall("khala_learn"),
  ];

  assert.deepEqual(findPendingMemoryGateRecovery(messages), {
    blockedToolName: "write",
  });
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
    inferTurnObligation("Load your librarian skill and inspect the Torc repo")
      .obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation("Can you analyze the pi-session at /tmp/session.jsonl?")
      .obligation,
    "tool_required",
  );
  assert.equal(inferTurnObligation("do it").obligation, "tool_required");
  assert.equal(
    inferTurnObligation("Please address the Copilot comments").obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation(
      "Load your github skill. Draft it to a untracked file md that we can review.",
    ).obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation("Draft a markdown file with inline review comments.")
      .obligation,
    "tool_required",
  );
});

test("blocks unsatisfied action and approval obligations outside monitor mode", () => {
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "warn",
      obligation: "tool_required",
    }),
    true,
  );
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "monitor",
      obligation: "tool_required",
    }),
    false,
  );
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "warn",
      obligation: "answer_allowed",
    }),
    false,
  );
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "warn",
      obligation: "approval_required",
    }),
    true,
  );
  assert.equal(isActionOrApprovalObligation("approval_required"), true);
  assert.equal(isActionOrApprovalObligation("answer_allowed"), false);
});

test("infers approval obligation for destructive requests", () => {
  assert.equal(
    inferTurnObligation("Delete the generated files.").obligation,
    "approval_required",
  );
  assert.equal(
    inferTurnObligation("Please reset --hard and clean the repo.").obligation,
    "approval_required",
  );
});

test("allows normal explanation questions without tools", () => {
  assert.equal(
    inferTurnObligation("Is there a way I can avoid this?").obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("I read that already and want your opinion").obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("Have you seen this find?").obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("this is a great review").obligation,
    "answer_allowed",
  );
});

test("detects assistant tool-call and clarification output shapes", () => {
  assert.equal(assistantMessageHasToolCall(assistantToolCall("read")), true);
  assert.equal(
    isAssistantClarification(
      textMessage("assistant", "Which file should I inspect?"),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage("assistant", "Can I proceed with deleting the generated files?"),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage("assistant", "Here is the answer. Does that match what you expected?"),
    ),
    false,
  );
  assert.equal(
    isAssistantClarification(
      textMessage("assistant", "I will inspect that next."),
    ),
    false,
  );
});
