import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  DEFAULT_RUNTIME_PROFILE,
  WORKFLOW_TYPES,
  loadRuntimeProfile,
  validateRuntimeProfile,
} from "../../extensions/runtime/profile.ts";

test("default runtime profile enables every packaged workflow", () => {
  const disabled = WORKFLOW_TYPES.filter(
    (workflowType) => !DEFAULT_RUNTIME_PROFILE.workflows[workflowType].enabled,
  );

  assert.deepEqual(disabled, []);
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
