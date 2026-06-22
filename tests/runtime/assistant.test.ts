import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantMessageHasToolCall,
  assistantTurnHasToolCallSinceLatestUser,
  evaluateObligationLoopGuard,
  findPendingMemoryGateRecovery,
  hasRequiredWorkflowFooter,
  inferTurnObligation,
  isEmptyTerminalAssistantResponse,
  normalizeLoopGuardText,
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

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
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

test("workflow footer requires Bias Check plus result and confidence", () => {
  assert.equal(
    hasRequiredWorkflowFooter("Result: success\nConfidence: 0.9"),
    false,
  );
  assert.equal(
    hasRequiredWorkflowFooter(
      [
        "Bias Check (Tier 1):",
        "claim/hypothesis tested: workflow completed",
        "Result: success",
        "Confidence: 0.9",
      ].join("\n"),
    ),
    true,
  );
});

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

test("clears recovery requirement once blocked apply_patch is retried", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("apply_patch"),
    memoryReadRequired("apply_patch"),
    assistantToolCall("khala_read_memory"),
    assistantToolCall("apply_patch"),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("clears recovery requirement once a blocked namespaced command mutation is retried", () => {
  const messages: Parameters<typeof findPendingMemoryGateRecovery>[0] = [
    assistantToolCall("functions.exec_command", { cmd: "npm install" }),
    memoryReadRequired("functions.exec_command"),
    assistantToolCall("khala_read_memory"),
    assistantToolCall("functions.exec_command", { cmd: "npm install" }),
  ];

  assert.equal(findPendingMemoryGateRecovery(messages), null);
});

test("does not clear recovery when a memory tool runs instead of the blocked mutation", () => {
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
      mode: "enforce",
      obligation: "tool_required",
    }),
    true,
  );
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "warn",
      obligation: "tool_required",
    }),
    false,
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
      mode: "enforce",
      obligation: "approval_required",
    }),
    true,
  );
  assert.equal(
    shouldBlockUnsatisfiedTurnObligation({
      mode: "warn",
      obligation: "approval_required",
    }),
    false,
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

test("obligation loop guard blocks first two repeats then warns", () => {
  const first = evaluateObligationLoopGuard({
    current: { key: null, count: 0 },
    key: "tool_required:continue",
    blockThreshold: 3,
  });
  assert.equal(first.block, true);
  assert.deepEqual(first.next, { key: "tool_required:continue", count: 1 });

  const second = evaluateObligationLoopGuard({
    current: first.next,
    key: "tool_required:continue",
    blockThreshold: 3,
  });
  assert.equal(second.block, true);
  assert.deepEqual(second.next, { key: "tool_required:continue", count: 2 });

  const third = evaluateObligationLoopGuard({
    current: second.next,
    key: "tool_required:continue",
    blockThreshold: 3,
  });
  assert.equal(third.block, false);
  assert.deepEqual(third.next, { key: "tool_required:continue", count: 3 });
});

test("obligation loop guard resets count when key changes", () => {
  const decision = evaluateObligationLoopGuard({
    current: { key: "tool_required:continue", count: 2 },
    key: "approval_required:delete files",
    blockThreshold: 3,
  });
  assert.equal(decision.block, true);
  assert.deepEqual(decision.next, {
    key: "approval_required:delete files",
    count: 1,
  });
});

test("loop guard counts normalized prompt variants as the same key", () => {
  const key1 = `tool_required:${normalizeLoopGuardText("Continue working...")}`;
  const key2 = `tool_required:${normalizeLoopGuardText("  `Continue   working!`  ")}`;
  const key3 = `tool_required:${normalizeLoopGuardText("(continue working?)")}`;
  assert.equal(key1, key2);
  assert.equal(key2, key3);

  const first = evaluateObligationLoopGuard({
    current: { key: null, count: 0 },
    key: key1,
    blockThreshold: 3,
  });
  const second = evaluateObligationLoopGuard({
    current: first.next,
    key: key2,
    blockThreshold: 3,
  });
  const third = evaluateObligationLoopGuard({
    current: second.next,
    key: key3,
    blockThreshold: 3,
  });

  assert.equal(first.block, true);
  assert.equal(second.block, true);
  assert.equal(third.block, false);
});

test("normalizeLoopGuardText collapses punctuation and spacing noise", () => {
  assert.equal(normalizeLoopGuardText(" Continue   working... "), "continue working");
  assert.equal(
    normalizeLoopGuardText("CONTINUE working!?"),
    "continue working",
  );
  assert.equal(
    normalizeLoopGuardText("Continue working;"),
    "continue working",
  );
  assert.equal(
    normalizeLoopGuardText("Continue working,"),
    "continue working",
  );
  assert.equal(
    normalizeLoopGuardText("`Continue working.`"),
    "continue working",
  );
  assert.equal(
    normalizeLoopGuardText("(Continue working!)"),
    "continue working",
  );
  assert.equal(
    normalizeLoopGuardText("Please review src/app.ts."),
    "please review src/app.ts",
  );
  assert.equal(
    normalizeLoopGuardText(`"'(\`Continue working...\`)!'"`),
    "continue working",
  );
  assert.equal(normalizeLoopGuardText("..."), "_empty_");
  assert.equal(normalizeLoopGuardText("(`...`)"), "_empty_");
  assert.equal(normalizeLoopGuardText(`"'(\`...\`)!'"`), "_empty_");
});
