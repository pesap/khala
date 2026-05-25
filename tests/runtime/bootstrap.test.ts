import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_HOOK_CONFIG } from "../../extensions/hooks/config.ts";
import {
  DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT,
  getBootstrapPayload,
} from "../../extensions/runtime/bootstrap.ts";
import { ensureLearningStore } from "../../extensions/learning/store.ts";

async function makeRuntimeDir(root: string): Promise<{
  runtimeDir: string;
  hooksDir: string;
}> {
  const runtimeDir = path.join(root, "runtime");
  const hooksDir = path.join(runtimeDir, "hooks");
  await fs.mkdir(path.join(runtimeDir, "compliance"), { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(runtimeDir, "RULES.md"), "stable rules\n", "utf8"),
    fs.writeFile(path.join(runtimeDir, "DUTIES.md"), "stable duties\n", "utf8"),
    fs.writeFile(
      path.join(runtimeDir, "INSTRUCTIONS.md"),
      "stable instructions\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(runtimeDir, "compliance", "risk-assessment.md"),
      "stable compliance\n",
      "utf8",
    ),
    fs.writeFile(path.join(hooksDir, "bootstrap.md"), "stable hook\n", "utf8"),
  ]);

  return { runtimeDir, hooksDir };
}

test("bootstrap keeps stable context first and bounds startup memory", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-bootstrap-"));
  const cwd = path.join(root, "repo");
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  const { runtimeDir, hooksDir } = await makeRuntimeDir(root);
  const learningPathCache = new Map();
  const learningPaths = await ensureLearningStore(cwd, learningPathCache);
  const memoryLines = Array.from(
    { length: 12 },
    (_, index) => `- memory line ${index + 1}`,
  );
  await fs.writeFile(
    learningPaths.memoryMd,
    ["# MEMORY", ...memoryLines, ""].join("\n"),
    "utf8",
  );

  const payload = await getBootstrapPayload({
    cwd,
    runtimeDir,
    hooksDir,
    activeHookConfig: DEFAULT_HOOK_CONFIG,
    learningPathCache,
    memoryTailLines: 20,
    memoryToolCallLimit: 15,
    lowConfidenceThreshold: 0.7,
  });

  assert.ok(payload.includes("stable rules"));
  assert.ok(payload.includes("stable duties"));
  assert.ok(payload.includes("stable instructions"));
  assert.ok(
    payload.includes(
      `Bootstrap injects only the most recent ${DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT} memory lines`,
    ),
  );
  assert.equal(payload.includes("memory line 4"), false);
  assert.equal(payload.includes("memory line 5"), true);
  assert.equal(payload.includes("memory line 12"), true);

  const rulesIndex = payload.indexOf("[RULES]");
  const dutiesIndex = payload.indexOf("[DUTIES]");
  const instructionsIndex = payload.indexOf("[INSTRUCTIONS]");
  const turnRulesIndex = payload.indexOf("[TURN EXECUTION RULES]");
  const budgetIndex = payload.indexOf("[CONTEXT BUDGET]");
  const memoryIndex = payload.indexOf("[LEARNING MEMORY TAIL]");

  assert.ok(rulesIndex < dutiesIndex);
  assert.ok(dutiesIndex < instructionsIndex);
  assert.ok(instructionsIndex < turnRulesIndex);
  assert.ok(turnRulesIndex < budgetIndex);
  assert.ok(budgetIndex < memoryIndex);
});

test("bootstrap honors configured harness startup limits", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-bootstrap-config-"));
  const cwd = path.join(root, "repo");
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  const { runtimeDir, hooksDir } = await makeRuntimeDir(root);
  const learningPathCache = new Map();
  const learningPaths = await ensureLearningStore(cwd, learningPathCache);
  await fs.writeFile(
    learningPaths.memoryMd,
    [
      "# MEMORY",
      "- memory line 1",
      "- memory line 2",
      "- memory line 3",
      "",
    ].join("\n"),
    "utf8",
  );

  const payload = await getBootstrapPayload({
    cwd,
    runtimeDir,
    hooksDir,
    activeHookConfig: DEFAULT_HOOK_CONFIG,
    learningPathCache,
    memoryTailLines: 20,
    memoryToolCallLimit: 15,
    lowConfidenceThreshold: 0.7,
    harnessLimits: {
      bootstrapMemoryTailLines: 2,
      bootstrapRuntimeRules: 3,
    },
  });

  assert.equal(
    payload.includes(
      `Bootstrap injects only the most recent ${DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT} memory lines`,
    ),
    false,
  );
  assert.ok(
    payload.includes(
      "Bootstrap injects only the most recent 2 memory lines and 3 active rules",
    ),
  );
  assert.equal(payload.includes("memory line 1"), false);
  assert.equal(payload.includes("memory line 2"), true);
});
