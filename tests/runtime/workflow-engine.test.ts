import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeterministicWorkflowContract,
  enqueueWorkflow,
} from "../../extensions/workflows/engine.ts";

test("deterministic workflow contract extracts objective and ordered steps", () => {
  const contract = buildDeterministicWorkflowContract({
    workflowSpec: [
      "name: sample-workflow",
      "objective: Produce a reusable workflow artifact",
      "steps:",
      "  - id: inspect",
      "    action: gather_evidence",
      "  - id: validate",
      "    action: run_targeted_checks",
    ].join("\n"),
  });

  assert.match(contract, /Workflow: sample-workflow/);
  assert.match(contract, /Objective: Produce a reusable workflow artifact/);
  assert.match(contract, /1\. inspect: gather_evidence/);
  assert.match(contract, /2\. validate: run_targeted_checks/);
  assert.match(contract, /clear triggers\/use-when conditions/);
  assert.match(contract, /validation or eval prompts/);
});

test("enqueueWorkflow sends deterministic execution contract with workflow payload", async () => {
  const sentMessages: string[] = [];

  await enqueueWorkflow({
    pi: {
      sendUserMessage: (message: string) => sentMessages.push(message),
    } as never,
    workflowPromptName: "sample-workflow.md",
    workflowFileName: "sample-workflow.yaml",
    sections: ["User input: create the workflow"],
    readCommandPrompt: async () => "You are running a sample workflow.",
    readWorkflow: async () =>
      [
        "name: sample-workflow",
        "objective: Produce a reusable workflow artifact",
        "steps:",
        "  - id: draft",
        "    action: draft_artifact",
        "  - id: test",
        "    action: add_eval_prompts",
      ].join("\n"),
  });

  assert.equal(sentMessages.length, 1);
  const payload = sentMessages[0] ?? "";
  assert.match(payload, /Workflow spec:/);
  assert.match(payload, /Deterministic workflow contract:/);
  assert.match(payload, /1\. draft: draft_artifact/);
  assert.match(payload, /2\. test: add_eval_prompts/);
  assert.match(payload, /User input: create the workflow/);
});
