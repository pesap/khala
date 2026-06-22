import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

import { parseWorkflowRuntimeState } from "../../extensions/workflows/engine.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("packaged workflow specs are valid YAML with ordered steps", async () => {
  const workflowDir = path.join(repoRoot, "workflows");
  const workflowFiles = (await readdir(workflowDir))
    .filter((file) => file.endsWith(".yaml"))
    .sort();

  assert.ok(workflowFiles.length > 0);
  for (const workflowFile of workflowFiles) {
    const raw = await readFile(path.join(workflowDir, workflowFile), "utf8");
    const parsed = loadYaml(raw) as unknown;
    assert.equal(typeof parsed, "object", workflowFile);
    assert.notEqual(parsed, null, workflowFile);
    assert.ok(!Array.isArray(parsed), workflowFile);

    const record = parsed as Record<string, unknown>;
    assert.equal(typeof record.name, "string", workflowFile);
    assert.equal(typeof record.objective, "string", workflowFile);
    assert.ok(Array.isArray(record.steps), workflowFile);
    assert.ok(record.steps.length > 0, workflowFile);

    const runtimeState = parseWorkflowRuntimeState(raw);
    assert.equal(runtimeState.name, record.name, workflowFile);
    assert.equal(runtimeState.objective, record.objective, workflowFile);
    assert.equal(runtimeState.currentStepIndex, 0, workflowFile);
    assert.equal(runtimeState.steps.length, record.steps.length, workflowFile);

    runtimeState.steps.forEach((step, index) => {
      assert.equal(step.index, index, workflowFile);
      assert.equal(typeof step.id, "string", workflowFile);
      assert.ok(step.id.length > 0, workflowFile);
      assert.equal(typeof step.action, "string", workflowFile);
      assert.ok(step.action.length > 0, workflowFile);
      assert.equal(step.status, index === 0 ? "active" : "pending", workflowFile);
    });
  }
});
