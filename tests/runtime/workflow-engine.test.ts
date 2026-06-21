import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  beginWorkflowTracking,
  buildDeterministicWorkflowContract,
  completeWorkflowTracking,
  enqueueWorkflow,
  parseWorkflowRuntimeState,
} from "../../extensions/workflows/engine.ts";
import { appendLine } from "../../extensions/lib/io.ts";
import { appendRunLedgerEvent } from "../../extensions/runtime/run-ledger.ts";
import { createRuntimeState } from "../../extensions/state/runtime.ts";

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

test("enqueueWorkflow emits skill route and load events", async () => {
  const skillEvents: unknown[] = [];

  await enqueueWorkflow({
    pi: {
      sendUserMessage: () => undefined,
    } as never,
    workflowPromptName: "sample-workflow.md",
    workflowFileName: "sample-workflow.yaml",
    sections: [],
    readCommandPrompt: async () => "You are running a sample workflow.",
    readWorkflow: async () =>
      [
        "name: sample-workflow",
        "skills:",
        "  - code-review",
        "steps:",
        "  - id: inspect",
        "    action: gather_evidence",
      ].join("\n"),
    readSkill: async () =>
      [
        "---",
        "description: Review code for correctness.",
        "---",
        "Use concrete findings.",
      ].join("\n"),
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  assert.deepEqual(
    skillEvents.map((event) => (event as { type: string }).type),
    ["skill_routed", "skill_loaded"],
  );
  assert.deepEqual((skillEvents[0] as { skill: unknown }).skill, {
    name: "code-review",
    source: "packaged",
    path: "skills/code-review/SKILL.md",
  });
});

test("enqueueWorkflow emits missing event before failing missing required skill", async () => {
  const skillEvents: unknown[] = [];

  await assert.rejects(
    enqueueWorkflow({
      pi: {
        sendUserMessage: () => undefined,
      } as never,
      workflowPromptName: "sample-workflow.md",
      workflowFileName: "sample-workflow.yaml",
      sections: [],
      readCommandPrompt: async () => "You are running a sample workflow.",
      readWorkflow: async () =>
        [
          "name: sample-workflow",
          "skills:",
          "  - missing-skill",
          "steps:",
          "  - id: inspect",
          "    action: gather_evidence",
        ].join("\n"),
      readSkill: async () => "",
      onSkillEvent: (event) => {
        skillEvents.push(event);
      },
    }),
    /requires missing skill: missing-skill/,
  );

  assert.deepEqual(
    skillEvents.map((event) => (event as { type: string }).type),
    ["skill_routed", "skill_missing"],
  );
});

test("workflow skill events can be recorded in the active run ledger", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-skills-"));
  try {
    const runtimeState = createRuntimeState();
    const runsDir = path.join(tempDir, "runs");
    const workflow = await beginWorkflowTracking({
      pi: { appendEntry: () => undefined } as never,
      ctx: { cwd: tempDir } as never,
      type: "review",
      input: "review current diff",
      flags: {},
      workflowSpec: [
        "name: review-workflow",
        "steps:",
        "  - id: inspect",
        "    action: inspect_diff",
      ].join("\n"),
      learningVersion: 7,
      runLedgerDir: runsDir,
      ensureLearningStore: async () => ({
        runsDir,
        learningJsonl: path.join(tempDir, "memory", "learning.jsonl"),
        memoryMd: path.join(tempDir, "memory", "MEMORY.md"),
        promotionQueue: path.join(tempDir, "memory", "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-skills`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await enqueueWorkflow({
      pi: { sendUserMessage: () => undefined } as never,
      workflowPromptName: "review-workflow.md",
      workflowFileName: "review-workflow.yaml",
      sections: [],
      readCommandPrompt: async () => "Review workflow.",
      readWorkflow: async () =>
        [
          "name: review-workflow",
          "skills:",
          "  - code-review",
          "steps:",
          "  - id: inspect",
          "    action: inspect_diff",
        ].join("\n"),
      readSkill: async () => "---\ndescription: Review code.\n---\n",
      onSkillEvent: async (event) => {
        await appendRunLedgerEvent({
          runFile: workflow.runFile,
          event: {
            id: `${workflow.id}:${event.type}:${event.skill.name}`,
            at: "2026-06-20T00:01:00.000Z",
            type: event.type,
            summary: `${event.type}: ${event.skill.name}`,
            replaySafe: true,
            data: {
              skill: event.skill,
              reason: event.reason,
            },
          },
        });
      },
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.deepEqual(
      ledger.events
        .filter((event: { type: string }) => event.type.startsWith("skill_"))
        .map((event: { type: string }) => event.type),
      ["skill_routed", "skill_loaded"],
    );
    assert.equal(
      ledger.events.find((event: { type: string }) => event.type === "skill_loaded")
        .data.skill.source,
      "packaged",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseWorkflowRuntimeState builds ordered active workflow state from YAML", () => {
  const state = parseWorkflowRuntimeState([
    "name: sample-workflow",
    "objective: Produce a reusable workflow artifact",
    "steps:",
    "  - id: inspect",
    "    action: gather_evidence",
    "  - id: validate",
    "    action: run_targeted_checks",
  ].join("\n"));

  assert.equal(state.name, "sample-workflow");
  assert.equal(state.objective, "Produce a reusable workflow artifact");
  assert.equal(state.currentStepIndex, 0);
  assert.deepEqual(state.steps, [
    {
      index: 0,
      id: "inspect",
      action: "gather_evidence",
      status: "active",
    },
    {
      index: 1,
      id: "validate",
      action: "run_targeted_checks",
      status: "pending",
    },
  ]);
});

test("beginWorkflowTracking opens structured durable run ledger", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-"));
  try {
    const runsDir = path.join(tempDir, "runs");
    const entries: Array<{ name: string; value: unknown }> = [];
    const workflow = await beginWorkflowTracking({
      pi: { appendEntry: (name: string, value: unknown) => entries.push({ name, value }) } as never,
      ctx: { cwd: tempDir } as never,
      type: "debug",
      input: "investigate failing test",
      flags: {},
      workflowSpec: [
        "name: debug-workflow",
        "objective: Investigate a symptom",
        "steps:",
        "  - id: intake",
        "    action: restate_problem",
        "  - id: evidence",
        "    action: collect_signals",
      ].join("\n"),
      learningVersion: 7,
      runLedgerDir: runsDir,
      ensureLearningStore: async () => ({
        runsDir,
        learningJsonl: path.join(tempDir, "learning.jsonl"),
        memoryMd: path.join(tempDir, "MEMORY.md"),
        promotionQueue: path.join(tempDir, "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-ledger`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState: {
        latestPostflight: null,
        activePreflight: null,
      } as never,
      appendPreflightEntry: () => undefined,
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.equal(ledger.status, "started");
    assert.equal(ledger.workflow.type, "debug");
    assert.equal(ledger.workflow.state.name, "debug-workflow");
    assert.equal(ledger.workflow.state.currentStepIndex, 0);
    assert.equal(ledger.workflow.state.steps[0].status, "active");
    assert.equal(ledger.events[0].type, "workflow_started");
    assert.equal(ledger.resume.classification, "resumable");
    assert.equal(entries[0]?.name, "khala-workflow-start");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeWorkflowTracking writes structured completion and completed workflow state", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-complete-"));
  try {
    const runtimeState = createRuntimeState();
    const runsDir = path.join(tempDir, "runs");
    const workflow = await beginWorkflowTracking({
      pi: { appendEntry: () => undefined } as never,
      ctx: { cwd: tempDir } as never,
      type: "debug",
      input: "investigate failing test",
      flags: {},
      workflowSpec: [
        "name: debug-workflow",
        "objective: Investigate a symptom",
        "steps:",
        "  - id: intake",
        "    action: restate_problem",
        "  - id: evidence",
        "    action: collect_signals",
      ].join("\n"),
      learningVersion: 7,
      runLedgerDir: runsDir,
      ensureLearningStore: async () => ({
        runsDir,
        learningJsonl: path.join(tempDir, "memory", "learning.jsonl"),
        memoryMd: path.join(tempDir, "memory", "MEMORY.md"),
        promotionQueue: path.join(tempDir, "memory", "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-complete`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await completeWorkflowTracking({
      pi: { appendEntry: () => undefined } as never,
      ctx: { cwd: tempDir } as never,
      workflow,
      assistantText: [
        "Validation:",
        "- npm test passed",
        "",
        "Open Questions:",
        "- Should resume get a CLI command?",
        "",
        "Learning Candidates:",
        "- Keep workflow state in run ledgers.",
        "",
        "Result: success",
        "Confidence: 0.92",
      ].join("\n"),
      learningVersion: 7,
      lowConfidenceThreshold: 0.7,
      runtimeState,
      inferOutcomeFromText: () => ({ outcome: "success", confidence: 0.92 }),
      nowIso: () => "2026-06-20T00:10:00.000Z",
      extractPostflightFromAssistantText: () => null,
      modeOutcome: () => "allow",
      addPolicyEvent: () => undefined,
      appendPostflightEntry: () => undefined,
      summarizeEvidence: (text) => text.slice(0, 200),
      appendLine,
      ensureLearningStore: async () => ({
        runsDir,
        learningJsonl: path.join(tempDir, "memory", "learning.jsonl"),
        memoryMd: path.join(tempDir, "memory", "MEMORY.md"),
        promotionQueue: path.join(tempDir, "memory", "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      maybeEmitPromotionHint: async () => undefined,
      notify: () => undefined,
      onLowConfidence: () => undefined,
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.deepEqual(ledger.structuredCompletion.validation, ["npm test passed"]);
    assert.deepEqual(ledger.structuredCompletion.openQuestions, [
      "Should resume get a CLI command?",
    ]);
    const completedEvent = ledger.events.find(
      (event: { type: string }) => event.type === "workflow_completed",
    );
    assert.ok(completedEvent);
    assert.deepEqual(completedEvent.data.structuredCompletion, ledger.structuredCompletion);
    assert.deepEqual(ledger.structuredCompletion.learningCandidates, [
      "Keep workflow state in run ledgers.",
    ]);
    assert.equal(ledger.workflow.state.currentStepIndex, null);
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["completed", "completed"],
    );
    assert.equal(ledger.events.at(-1).type, "workflow_completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
