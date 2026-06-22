import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommandHandlers } from "../../extensions/commands/agent.ts";
import { createRuntimeState } from "../../extensions/state/runtime.ts";

test("end-agent awaits pending workflow cleanup before teardown", async () => {
  const runtimeState = createRuntimeState();
  runtimeState.agentEnabled = true;
  const events: string[] = [];

  const handlers = createAgentCommandHandlers({
    runtimeState,
    setAgentEnabledState: () => events.push("disabled"),
    appendAgentStateEntry: () => events.push("session-entry"),
    clearPendingWorkflow: async () => {
      await Promise.resolve();
      events.push("cleared");
    },
    runSessionEndHooks: async () => {
      events.push("hooks");
    },
    notify: () => undefined,
  });

  await handlers.endAgent("", { hasUI: false, ui: undefined } as never);

  assert.deepEqual(events, ["cleared", "hooks", "disabled", "session-entry"]);
});
