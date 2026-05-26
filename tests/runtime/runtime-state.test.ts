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
  assert.equal(state.lastMemoryGateBlockKey, null);
  assert.equal(state.lastMemoryGateBlockCount, 0);
  assert.equal(state.lastEmptyResponseBlockKey, null);
  assert.equal(state.lastEmptyResponseBlockCount, 0);
});

test("resetSessionComplianceState clears obligation loop guard fields", () => {
  const state = createRuntimeState();
  state.lastObligationBlockKey = "tool_required:continue";
  state.lastObligationBlockCount = 4;
  state.lastMemoryGateBlockKey = "write:update readme";
  state.lastMemoryGateBlockCount = 5;
  state.lastEmptyResponseBlockKey = "empty:continue working";
  state.lastEmptyResponseBlockCount = 3;

  resetSessionComplianceState(state);

  assert.equal(state.lastObligationBlockKey, null);
  assert.equal(state.lastObligationBlockCount, 0);
  assert.equal(state.lastMemoryGateBlockKey, null);
  assert.equal(state.lastMemoryGateBlockCount, 0);
  assert.equal(state.lastEmptyResponseBlockKey, null);
  assert.equal(state.lastEmptyResponseBlockCount, 0);
});
