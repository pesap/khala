import test from "node:test";
import assert from "node:assert/strict";

import { evaluateMutationPreflightPolicy, evaluateSpawnPolicy } from "../../extensions/policy/pipeline.ts";

test("spawn policy blocks Pi slash preflight sent to shell", () => {
  const decision = evaluateSpawnPolicy(
    '/preflight Preflight: skill=github reason="Investigate CI" clarify=no',
    {
      hookConfig: { pre_risky_action: [] },
      hasValidRiskApproval: false,
      nowIso: () => "2026-06-23T00:00:00.000Z",
    },
  );

  assert.match(decision.blockedMessage ?? "", /Blocked shell execution of \/preflight/);
  assert.match(decision.blockedMessage ?? "", /Pi chat command, not a shell command/);
  assert.equal(decision.riskEvent, null);
  assert.equal(decision.consumeRiskApproval, false);
});

test("enforced mutation preflight tells agents to send the record as chat text", () => {
  const decision = evaluateMutationPreflightPolicy({
    preflightMode: "enforce",
    preflight: null,
    toolName: "bash",
    activeWorkflowId: null,
  });

  assert.equal(decision.outcome, "block");
  assert.match(decision.blockReason ?? "", /Send this as chat text, not through the shell/);
  assert.match(decision.blockReason ?? "", /\/preflight Preflight:/);
});
