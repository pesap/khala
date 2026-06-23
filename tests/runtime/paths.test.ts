import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function importPathsModule() {
  return import(`../../extensions/runtime/paths.ts?case=${Date.now()}-${Math.random()}`);
}

test("workflow model config lives under Pi agent config dir", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-config-test";

  try {
    const { RUNTIME_PATHS } = await importPathsModule();
    assert.equal(
      RUNTIME_PATHS.workflowModelConfigPath,
      "/tmp/pi-agent-config-test/khala/workflow-model.yaml",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("workflow model config can resolve from trusted project config", async () => {
  const tempDir = path.join(tmpdir(), `khala-paths-${process.pid}-${Date.now()}`);
  const configPath = path.join(tempDir, ".pi", "khala", "workflow-model.yaml");

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "profiles:\n", "utf8");

    const { resolveWorkflowModelConfigPath } = await importPathsModule();
    assert.equal(await resolveWorkflowModelConfigPath(tempDir, true), configPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
