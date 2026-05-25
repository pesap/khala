import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  DEFAULT_RUNTIME_PROFILE,
  WORKFLOW_TYPES,
  loadRuntimeProfile,
  parseRuntimeProfile,
  validateRuntimeProfile,
} from "../../extensions/runtime/profile.ts";

test("default runtime profile enables every packaged workflow", () => {
  const disabled = WORKFLOW_TYPES.filter(
    (workflowType) => !DEFAULT_RUNTIME_PROFILE.workflows[workflowType].enabled,
  );

  assert.deepEqual(disabled, []);
});

test("runtime profile parses harness limits", () => {
  const loaded = parseRuntimeProfile(`
version: 1
quality:
  low_confidence_threshold: 0.82
harness:
  bootstrap_memory_tail_lines: 6
  bootstrap_runtime_rules: 5
  substantial_tool_call_threshold: 3
  tool_failure_escalation_threshold: 2
`);

  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.profile.lowConfidenceThreshold, 0.82);
  assert.deepEqual(loaded.profile.harnessLimits, {
    bootstrapMemoryTailLines: 6,
    bootstrapRuntimeRules: 5,
    substantialToolCallThreshold: 3,
    toolFailureEscalationThreshold: 2,
  });
});

test("runtime profile rejects invalid harness limits", () => {
  const loaded = parseRuntimeProfile(`
version: 1
harness:
  bootstrap_memory_tail_lines: 0
  bootstrap_runtime_rules: 1.5
  unknown_limit: 7
`);

  assert.deepEqual(
    loaded.profile.harnessLimits,
    DEFAULT_RUNTIME_PROFILE.harnessLimits,
  );
  assert.deepEqual(loaded.warnings, [
    "runtime/profile.yaml: harness.bootstrap_memory_tail_lines must be a positive integer; default kept.",
    "runtime/profile.yaml: harness.bootstrap_runtime_rules must be a positive integer; default kept.",
    "runtime/profile.yaml: unknown harness key 'unknown_limit' ignored.",
  ]);
});

test("packaged runtime profile keeps documented workflows enabled", async () => {
  const repoRoot = process.cwd();
  const loaded = await loadRuntimeProfile(
    path.join(repoRoot, "runtime", "profile.yaml"),
  );
  const validation = await validateRuntimeProfile(loaded.profile, {
    commandsDir: path.join(repoRoot, "commands"),
    skillflowsDir: path.join(repoRoot, "workflows"),
  });
  const disabled = WORKFLOW_TYPES.filter(
    (workflowType) => !validation.profile.workflows[workflowType].enabled,
  );

  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(validation.warnings, []);
  assert.deepEqual(disabled, []);
  assert.equal(validation.enabledWorkflowCount, WORKFLOW_TYPES.length);
});
