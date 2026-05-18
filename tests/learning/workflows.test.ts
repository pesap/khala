import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildLearnedWorkflowArtifact,
  listLearnedWorkflows,
  readLearnedWorkflow,
  writeLearnedWorkflowPromptTemplate,
} from "../../extensions/learning/workflows.ts";
import { createTempLearningPaths } from "./helpers.ts";

test("learned workflow prompt templates are listable and readable", async () => {
  const paths = await createTempLearningPaths("khala-workflows-");
  const workflowFile = path.join(paths.workflowsDir, "review-autonomous-workflow.yaml");
  await fs.writeFile(
    workflowFile,
    buildLearnedWorkflowArtifact({
      workflowName: "review-autonomous-workflow",
      taskType: "review",
      date: "2026-05-18",
      sampleSize: 3,
      scoreRate: 1,
      summary: "three successful review runs",
    }),
    "utf8",
  );

  const record = await writeLearnedWorkflowPromptTemplate({
    paths,
    workflowName: "review autonomous workflow",
    taskType: "review",
    summary: "three successful review runs",
  });

  assert.equal(record.name, "review-autonomous-workflow");
  const listed = await listLearnedWorkflows(paths);
  assert.deepEqual(
    listed.map((workflow) => workflow.name),
    ["review-autonomous-workflow"],
  );

  const loaded = await readLearnedWorkflow(paths, "review-autonomous-workflow");
  assert.ok(loaded);
  assert.match(loaded.promptText, /\$ARGUMENTS/);
  assert.match(loaded.workflowText, /steps:/);
});
