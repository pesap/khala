import test from "node:test";
import assert from "node:assert/strict";

import {
  createRuntimeState,
  resetSessionComplianceState,
} from "../../extensions/state/runtime.ts";

test("runtime state initializes obligation loop guard fields", () => {
  const state = createRuntimeState();
  assert.equal(state.lastObligationBlockKey, null);
  assert.equal(state.lastObligationBlockCount, 0);
});

test("resetSessionComplianceState clears obligation loop guard fields", () => {
  const state = createRuntimeState();
  state.lastObligationBlockKey = "tool_required:continue";
  state.lastObligationBlockCount = 4;

  resetSessionComplianceState(state);

  assert.equal(state.lastObligationBlockKey, null);
  assert.equal(state.lastObligationBlockCount, 0);
});
