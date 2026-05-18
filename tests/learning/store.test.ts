import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
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

test("promotion hint creates reusable workflow artifact for repeated successes", async () => {
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
  assert.match(queue, /\[review\/workflow-created\]/);

  const workflowPath = path.join(
    paths.workflowsDir,
    "review-autonomous-workflow.yaml",
  );
  const workflow = await fs.readFile(workflowPath, "utf8");
  assert.match(workflow, /source: khala-autonomous-memory/);
  assert.match(workflow, /read_memory: call khala_read_memory/);
  const promptPath = path.join(
    paths.promptsDir,
    "review-autonomous-workflow.md",
  );
  const prompt = await fs.readFile(promptPath, "utf8");
  assert.match(
    prompt,
    /description: Run khala learned workflow review-autonomous-workflow/,
  );
  assert.match(prompt, /\$ARGUMENTS/);
  assert.equal(notifications.length, 1);
});
