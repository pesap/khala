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
  const trackedRuns: Array<{
    workflowName: string;
    input: string;
    flags: Record<string, unknown>;
    workflowSpec: string;
  }> = [];
  const handlers = createLearnedWorkflowCommandHandlers({
    pi: {
      sendUserMessage: (message: string) => sentMessages.push(message),
    } as never,
    ensureLearningStore: async () => paths,
    notify: (_ctx, message) => notifications.push(message),
    beginWorkflowTracking: async (_ctx, workflowName, input, flags, workflowSpec) => {
      trackedRuns.push({ workflowName, input, flags, workflowSpec });
      return { id: "workflow-run-ledger", runFile: "/tmp/workflow-run-ledger.json" };
    },
  });

  await handlers.workflowRun("review-autonomous-workflow --model anthropic/claude-haiku-4-5 inspect branch", {
    cwd: process.cwd(),
    isIdle: () => true,
  } as never);

  assert.deepEqual(notifications, []);
  assert.equal(sentMessages.length, 1);
  const payload = sentMessages[0] ?? "";
  assert.match(payload, /Run khala learned workflow `review-autonomous-workflow`/);
  assert.match(payload, /Run ledger: \/tmp\/workflow-run-ledger\.json/);
  assert.match(payload, /Requested model: anthropic\/claude-haiku-4-5/);
  assert.match(payload, /Deterministic workflow contract:/);
  assert.match(payload, /Workflow: review-autonomous-workflow/);
  assert.match(payload, /validate: run targeted validation/);
  assert.match(payload, /eval: define reusable validation prompts or checks/);
  assert.match(payload, /User input: inspect branch/);
  assert.equal(trackedRuns.length, 1);
  assert.equal(trackedRuns[0]?.workflowName, "workflow-run:review-autonomous-workflow");
  assert.equal(trackedRuns[0]?.input, "inspect branch");
  assert.deepEqual(trackedRuns[0]?.flags, {
    workflow: "review-autonomous-workflow",
    model: "anthropic/claude-haiku-4-5",
  });
  assert.match(trackedRuns[0]?.workflowSpec ?? "", /name: review-autonomous-workflow/);
});

test("workflow-run usage documents model override", async () => {
  const paths = await createTempLearningPaths("khala-learned-workflow-usage-");
  const notifications: string[] = [];
  const handlers = createLearnedWorkflowCommandHandlers({
    pi: {
      sendUserMessage: () => assert.fail("workflow-run without a name should not enqueue a message"),
    } as never,
    ensureLearningStore: async () => paths,
    notify: (_ctx, message) => notifications.push(message),
  });

  await handlers.workflowRun("", {
    cwd: process.cwd(),
    isIdle: () => true,
  } as never);

  assert.deepEqual(notifications, ["Usage: /workflow-run <name> [--model provider/model] [input]"]);
});
