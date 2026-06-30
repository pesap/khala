import test from "node:test";
import assert from "node:assert/strict";

import {
  createAssistantPreflightStreamState,
  currentAssistantPreflightText,
  getUnappliedAssistantPreflight,
  markAssistantPreflightApplied,
  updateAssistantPreflightFromMessageStart,
  updateAssistantPreflightFromMessageUpdate,
} from "../../extensions/runtime/assistant-preflight.ts";

test("assistant preflight tracker extracts same-turn text before a tool call", () => {
  const state = createAssistantPreflightStreamState();

  updateAssistantPreflightFromMessageStart(state, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
    },
  } as never);

  updateAssistantPreflightFromMessageUpdate(state, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Preflight: skill=debug-investigation reason="retry blocked write" clarify=no',
        },
      ],
    },
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        type: "toolCall",
        id: "call-write",
        name: "write",
        arguments: { path: "notes.txt", content: "ok" },
      },
      partial: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: 'Preflight: skill=debug-investigation reason="retry blocked write" clarify=no',
          },
          {
            type: "toolCall",
            id: "call-write",
            name: "write",
            arguments: { path: "notes.txt", content: "ok" },
          },
        ],
      },
    },
  } as never);

  assert.equal(
    currentAssistantPreflightText(state),
    'Preflight: skill=debug-investigation reason="retry blocked write" clarify=no',
  );

  const preflight = getUnappliedAssistantPreflight(
    state,
    () => "2026-06-29T00:00:00.000Z",
  );

  assert.ok(preflight);
  assert.deepEqual(preflight, {
    at: "2026-06-29T00:00:00.000Z",
    skill: "debug-investigation",
    reason: "retry blocked write",
    clarify: "no",
    raw: 'Preflight: skill=debug-investigation reason="retry blocked write" clarify=no',
    source: "assistant",
  });

  markAssistantPreflightApplied(state, preflight);
  assert.equal(
    getUnappliedAssistantPreflight(
      state,
      () => "2026-06-29T00:00:00.000Z",
    ),
    null,
  );
});
