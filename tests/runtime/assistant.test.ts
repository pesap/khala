import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantMessageHasToolCall,
  assistantTurnHasToolCallSinceLatestUser,
  findPendingMemoryGateRecovery,
  inferTurnObligation,
  isEmptyTerminalAssistantResponse,
  isActionOrApprovalObligation,
  isAssistantClarification,
  isAssistantClarificationAllowedForObligation,
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

test("clears recovery when blocked tool name is unknown but a retry-capable tool runs", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("custom_mutation_tool"),
    memoryReadRequired("custom_mutation_tool"),
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

test("does not carry memory-gate recovery requirement across a new user turn", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    textMessage("assistant", "I refreshed memory and will retry."),
    textMessage("user", "Different request: explain what happened."),
    textMessage("assistant", "Here is an explanation."),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("allows a blocking clarification instead of forced same-turn mutation retry", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    textMessage("assistant", "Which file should I patch first?"),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("does not treat generic permission as valid memory-gate recovery clarification", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("write"),
    memoryReadRequired("write"),
    assistantToolCall("khala_read_memory"),
    textMessage("assistant", "Should I proceed?"),
  ];

  assert.deepEqual(findPendingMemoryGateRecovery(messages), {
    blockedToolName: "write",
  });
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
  assert.equal(inferTurnObligation("continue").obligation, "answer_allowed");
  assert.equal(inferTurnObligation("proceed").obligation, "answer_allowed");
  assert.equal(
    inferTurnObligation("Keep working on the agent feedback loop").obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation("Clean up the repo and improve the runtime").obligation,
    "tool_required",
  );
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
  assert.equal(
    inferTurnObligation("Can you review this PR and suggest fixes?").obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation("Could you analyze src/runtime/assistant.ts for bugs?")
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
  assert.equal(
    inferTurnObligation("Please remove dead code in runtime helpers.").obligation,
    "tool_required",
  );
  assert.equal(
    inferTurnObligation(
      "Can you verify this strategy to delete all repository files?",
    ).obligation,
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
  assert.equal(
    inferTurnObligation(
      "Can you explain why this path is used in the config file?",
    ).obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation(
      "Please explain what changed in the README.md and why.",
    ).obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("Can you review this architecture idea?").obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("Could you analyze this design approach?").obligation,
    "answer_allowed",
  );
  assert.equal(
    inferTurnObligation("Please verify this strategy proposal.").obligation,
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
      textMessage("assistant", "Which file should I inspect first"),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage("assistant", "Please confirm whether I should patch src/app.ts or src/server.ts first"),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage(
        "assistant",
        "Before I continue, can you confirm the target file to patch first",
      ),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage(
        "assistant",
        "Which file should I inspect first? I can proceed once you confirm.",
      ),
    ),
    true,
  );
  assert.equal(
    isAssistantClarification(
      textMessage(
        "assistant",
        `${"Context ".repeat(400)} Which file should I inspect first?`,
      ),
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

test("detects tool usage across the whole assistant turn span", () => {
  const withEarlierToolCall: Parameters<
    typeof findPendingMemoryGateRecovery
  >[0] = [
    textMessage("user", "Please inspect runtime behavior."),
    assistantToolCall("read"),
    textMessage("assistant", "I inspected it and found the issue."),
  ];
  assert.equal(assistantTurnHasToolCallSinceLatestUser(withEarlierToolCall), true);

  const noToolCall: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    textMessage("user", "Please inspect runtime behavior."),
    textMessage("assistant", "I can inspect that next."),
  ];
  assert.equal(assistantTurnHasToolCallSinceLatestUser(noToolCall), false);

  const toolCallBeforeLatestUser: Parameters<
    typeof findPendingMemoryGateRecovery
  >[0] = [
    assistantToolCall("read"),
    textMessage("user", "Different request now."),
    textMessage("assistant", "Acknowledged."),
  ];
  assert.equal(
    assistantTurnHasToolCallSinceLatestUser(toolCallBeforeLatestUser),
    false,
  );
});

test("does not treat blank terminal assistant stop as empty when earlier tool call exists", () => {
  const messagesWithToolCallBeforeBlank: Parameters<
    typeof findPendingMemoryGateRecovery
  >[0] = [
    textMessage("user", "Inspect the runtime."),
    assistantToolCall("read"),
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "   " }],
    },
  ];
  assert.equal(
    isEmptyTerminalAssistantResponse(messagesWithToolCallBeforeBlank),
    false,
  );

  const trulyEmptyTerminal: Parameters<typeof findPendingMemoryGateRecovery>[0] =
    [
      textMessage("user", "Inspect the runtime."),
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "   " }],
      },
    ];
  assert.equal(isEmptyTerminalAssistantResponse(trulyEmptyTerminal), true);
});

test("generic permission questions do not satisfy concrete tool obligations", () => {
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage("assistant", "Should I proceed?"),
      "tool_required",
    ),
    false,
  );
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage("assistant", "Which file should I inspect?"),
      "tool_required",
    ),
    true,
  );
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage("assistant", "Can I proceed with deleting the generated files?"),
      "approval_required",
    ),
    true,
  );
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage("assistant", "Can I inspect src/app.ts or src/server.ts first?"),
      "tool_required",
    ),
    true,
  );
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage("assistant", "Should I review the API docs or runtime tests first?"),
      "tool_required",
    ),
    true,
  );
  assert.equal(
    isAssistantClarificationAllowedForObligation(
      textMessage(
        "assistant",
        "Should I proceed with inspecting src/app.ts or src/server.ts first?",
      ),
      "tool_required",
    ),
    true,
  );
});
