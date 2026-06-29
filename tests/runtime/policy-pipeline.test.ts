import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPreflightFromText,
  isPreflightOnlyText,
  parsePreflightLine,
} from "../../extensions/policy/first-principles.ts";
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
  assert.match(decision.blockReason ?? "", /assistant\/chat text, not through the shell/);
  assert.match(decision.blockReason ?? "", /immediately before the retrying tool call/);
  assert.match(decision.blockReason ?? "", /Preflight: skill=<name\|none> reason="<short>" clarify=<yes\|no>/);
});

test("manual chat preflight guidance satisfies the active workflow gate", () => {
  const parsed = parsePreflightLine(
    'Preflight: skill=github reason="Investigate CI" clarify=no',
    () => "2026-06-23T00:00:00.000Z",
  );

  assert.deepEqual(parsed, {
    at: "2026-06-23T00:00:00.000Z",
    skill: "github",
    reason: "Investigate CI",
    clarify: "no",
    raw: 'Preflight: skill=github reason="Investigate CI" clarify=no',
    source: "manual",
  });

  const decision = evaluateMutationPreflightPolicy({
    preflightMode: "enforce",
    preflight: { ...parsed, workflowId: "workflow-123" },
    toolName: "bash",
    activeWorkflowId: "workflow-123",
  });

  assert.equal(decision.outcome, "allow");
  assert.match(decision.detail, /Using manual preflight: Preflight: skill=github reason="Investigate CI" clarify=no/);
});

test("assistant same-turn preflight text satisfies the mutation gate", () => {
  const parsed = extractPreflightFromText(
    [
      "Preflight: skill=debug-investigation reason=\"validate harness preflight fix\" clarify=no",
      "I will retry the blocked write now.",
    ].join("\n"),
    () => "2026-06-29T00:00:00.000Z",
    "assistant",
  );

  assert.deepEqual(parsed, {
    at: "2026-06-29T00:00:00.000Z",
    skill: "debug-investigation",
    reason: "validate harness preflight fix",
    clarify: "no",
    raw: 'Preflight: skill=debug-investigation reason="validate harness preflight fix" clarify=no',
    source: "assistant",
  });

  const decision = evaluateMutationPreflightPolicy({
    preflightMode: "enforce",
    preflight: parsed,
    toolName: "write",
    activeWorkflowId: null,
  });

  assert.equal(decision.outcome, "allow");
  assert.match(
    decision.detail,
    /Using assistant preflight: Preflight: skill=debug-investigation reason="validate harness preflight fix" clarify=no/,
  );
});

test("preflight-only text is recognized as a control response", () => {
  assert.equal(
    isPreflightOnlyText(
      'Preflight: skill=none reason="prepare mutation" clarify=no',
    ),
    true,
  );
  assert.equal(
    isPreflightOnlyText(
      'Preflight: skill=none reason="prepare mutation" clarify=no\nRetrying now.',
    ),
    false,
  );
});
