import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createLearnedWorkflowCommandHandlers } from "../../extensions/commands/learned-workflows.ts";
import { buildLearnedWorkflowArtifact } from "../../extensions/learning/workflows.ts";
import { createTempLearningPaths } from "../learning/helpers.ts";

test("workflow-run includes deterministic contract for learned workflows", async () => {
  const paths = await createTempLearningPaths("khala-learned-workflow-run-");
  await fs.writeFile(
    path.join(paths.workflowsDir, "review-autonomous-workflow.yaml"),
    buildLearnedWorkflowArtifact({
      workflowName: "review-autonomous-workflow",
      taskType: "review",
      date: "2026-06-09",
      sampleSize: 3,
      scoreRate: 1,
      summary: "repeated successful review runs",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(paths.promptsDir, "review-autonomous-workflow.md"),
    "Prompt template body.",
    "utf8",
  );

  const sentMessages: string[] = [];
  const notifications: string[] = [];
  const handlers = createLearnedWorkflowCommandHandlers({
    pi: {
      sendUserMessage: (message: string) => sentMessages.push(message),
    } as never,
    ensureLearningStore: async () => paths,
    notify: (_ctx, message) => notifications.push(message),
  });

  await handlers.workflowRun("review-autonomous-workflow inspect branch", {
    cwd: process.cwd(),
    isIdle: () => true,
  } as never);

  assert.deepEqual(notifications, []);
  assert.equal(sentMessages.length, 1);
  const payload = sentMessages[0] ?? "";
  assert.match(payload, /Run khala learned workflow `review-autonomous-workflow`/);
  assert.match(payload, /Deterministic workflow contract:/);
  assert.match(payload, /Workflow: review-autonomous-workflow/);
  assert.match(payload, /validate: run targeted validation/);
  assert.match(payload, /eval: define reusable validation prompts or checks/);
  assert.match(payload, /User input: inspect branch/);
});
