import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyPromotionTarget,
  ensureLearningStore,
  getActiveLearningLessonsTail,
  getLearningMemoryTail,
  maybeEmitPromotionHint,
  type LearningObservation,
} from "../../extensions/learning/store.ts";
import { createTempLearningPaths } from "./helpers.ts";

function observation(id: string): LearningObservation<"review", "success"> {
  return {
    version: 1,
    id,
    timestamp: "2026-05-18T00:00:00.000Z",
    taskType: "review",
    input: "review current changes",
    flags: {},
    outcome: "success",
    confidence: 0.9,
    evidenceSnippet: "Result: success",
    workflowId: id,
  };
}

test("promotion target classification covers durable gate types", () => {
  assert.equal(classifyPromotionTarget("docs", "promote"), "docs");
  assert.equal(classifyPromotionTarget("command prompt", "promote"), "command prompt");
  assert.equal(classifyPromotionTarget("workflow", "promote"), "CI gate");
  assert.equal(classifyPromotionTarget("skill", "promote"), "skill");
  assert.equal(classifyPromotionTarget("test", "promote"), "test");
  assert.equal(classifyPromotionTarget("lint rule", "promote"), "lint/harness rule");
  assert.equal(classifyPromotionTarget("hook", "promote"), "hook");
  assert.equal(classifyPromotionTarget("ci", "promote"), "CI gate");
  assert.equal(classifyPromotionTarget("review", "improve"), "workflow spec");
});

test("promotion hint queues workflow candidates instead of auto-creating runnable workflows", async () => {
  const paths = await createTempLearningPaths();
  await fs.writeFile(paths.promotionQueue, "# Promotion Queue\n", "utf8");
  await fs.writeFile(paths.stateJson, JSON.stringify({ hints: {} }), "utf8");
  await fs.writeFile(
    paths.learningJsonl,
    [observation("one"), observation("two"), observation("three")]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
    "utf8",
  );

  const notifications: string[] = [];
  await maybeEmitPromotionHint({
    paths,
    observation: observation("four"),
    ctx: {} as never,
    promotionMinObservations: 3,
    promotionSuccessThreshold: 0.75,
    promotionImprovementThreshold: 0.4,
    nowIso: () => "2026-05-18T12:00:00.000Z",
    summarizeEvidence: (text) => text,
    notify: (_ctx, message) => {
      notifications.push(message);
    },
  });

  const queue = await fs.readFile(paths.promotionQueue, "utf8");
  assert.match(queue, /\[review\/promote\]/);
  assert.match(queue, /Target: workflow spec\./);
  assert.match(queue, /Evidence: Result: success/);
  assert.match(queue, /Confidence: 0\.90\./);
  assert.match(queue, /Safe workflow: review evidence, apply one promotion only, run targeted validation, then seek maintainer review before any durable gate or broad self-edit\./);
  assert.match(queue, /\[review\/workflow-candidate\]/);

  const workflowPath = path.join(
    paths.workflowsDir,
    "review-autonomous-workflow.yaml",
  );
  await assert.rejects(fs.access(workflowPath), {
    code: "ENOENT",
  });
  const promptPath = path.join(
    paths.promptsDir,
    "review-autonomous-workflow.md",
  );
  await assert.rejects(fs.access(promptPath), {
    code: "ENOENT",
  });
  assert.equal(notifications.length, 1);
});

test("memory tail reads recent entries from large memory files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "khala-memory-tail-"));
  await fs.mkdir(path.join(cwd, ".pi"));
  const paths = await ensureLearningStore(cwd, new Map());
  await fs.writeFile(
    paths.memoryMd,
    [
      "# MEMORY",
      ...Array.from(
        { length: 6_000 },
        (_, index) => `- 2026-05-18 old memory line ${index}`,
      ),
      "- 2026-05-18 recent alpha",
      "- 2026-05-18 recent beta",
    ].join("\n"),
    "utf8",
  );

  const tail = await getLearningMemoryTail(cwd, new Map(), 2);

  assert.equal(
    tail,
    "- 2026-05-18 recent alpha\n- 2026-05-18 recent beta",
  );
});

test("active lessons tail reads recent records from large lessons files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "khala-lessons-tail-"));
  await fs.mkdir(path.join(cwd, ".pi"));
  const paths = await ensureLearningStore(cwd, new Map());
  await fs.writeFile(
    paths.lessonsJsonl,
    [
      ...Array.from({ length: 4_000 }, (_, index) =>
        JSON.stringify({
          version: 1,
          id: `old-${index}`,
          timestamp: "2026-05-18T00:00:00.000Z",
          scope: "repo",
          type: "project_fact",
          trigger: `old trigger ${index}`,
          lesson: `old lesson ${index}`,
          evidenceSnippet: "old",
          confidence: 0.8,
          status: "active",
        }),
      ),
      JSON.stringify({
        version: 1,
        id: "recent-one",
        timestamp: "2026-05-18T00:00:00.000Z",
        scope: "repo",
        type: "tool_rule",
        trigger: "recent trigger one",
        lesson: "recent lesson one",
        evidenceSnippet: "recent",
        confidence: 0.9,
        status: "active",
      }),
      JSON.stringify({
        version: 1,
        id: "recent-two",
        timestamp: "2026-05-18T00:00:00.000Z",
        scope: "repo",
        type: "tool_rule",
        trigger: "recent trigger two",
        lesson: "recent lesson two",
        evidenceSnippet: "recent",
        confidence: 0.9,
        status: "active",
      }),
    ].join("\n"),
    "utf8",
  );

  const lessons = await getActiveLearningLessonsTail(cwd, new Map(), 2);

  assert.equal(
    lessons,
    "- When recent trigger one: recent lesson one\n- When recent trigger two: recent lesson two",
  );
});
