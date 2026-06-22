import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  advanceWorkflowTracking,
  advanceWorkflowTrackingForTurnBoundary,
  beginWorkflowTracking,
  buildDeterministicWorkflowContract,
  completeWorkflowTracking,
  enqueueWorkflow,
  interruptWorkflowTracking,
  parseWorkflowRuntimeState,
  recordWorkflowToolCall,
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

  const queued = await enqueueWorkflow({
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
  assert.deepEqual(queued.loadedSkills, ["code-review"]);
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "code-review",
      source: "packaged",
      path: "skills/code-review/SKILL.md",
    },
  ]);
});

test("enqueueWorkflow preserves metadata from metadata-aware skill loaders", async () => {
  const skillEvents: unknown[] = [];

  const queued = await enqueueWorkflow({
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
    readSkill: async () => ({
      content: [
        "---",
        "description: User review guidance.",
        "---",
        "Use local review heuristics.",
      ].join("\n"),
      metadata: {
        name: "Code Review",
        source: "user",
        path: "/home/user/.codex/skills/code-review/SKILL.md",
      },
    }),
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  const loaded = skillEvents.find(
    (event) => (event as { type: string }).type === "skill_loaded",
  ) as { skill: unknown } | undefined;
  const routed = skillEvents.find(
    (event) => (event as { type: string }).type === "skill_routed",
  ) as { skill: unknown } | undefined;
  assert.deepEqual(routed?.skill, {
    name: "code-review",
    source: "user",
    path: "/home/user/.codex/skills/code-review/SKILL.md",
  });
  assert.deepEqual(loaded?.skill, {
    name: "code-review",
    source: "user",
    path: "/home/user/.codex/skills/code-review/SKILL.md",
  });
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "code-review",
      source: "user",
      path: "/home/user/.codex/skills/code-review/SKILL.md",
    },
  ]);
});

test("enqueueWorkflow reports actual loaded skill names from loader metadata", async () => {
  const skillEvents: unknown[] = [];

  const queued = await enqueueWorkflow({
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
    readSkill: async () => ({
      content: [
        "---",
        "description: Repo-specific review guidance.",
        "---",
        "Use repo-local review heuristics.",
      ].join("\n"),
      metadata: {
        name: "Repo Review",
        source: "repo-local",
        path: "/work/repo/skills/repo-review/SKILL.md",
      },
    }),
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  assert.deepEqual(queued.loadedSkills, ["repo-review"]);
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "repo-review",
      source: "repo-local",
      path: "/work/repo/skills/repo-review/SKILL.md",
    },
  ]);
  assert.deepEqual(
    skillEvents.map((event) => (event as { skill: { name: string } }).skill.name),
    ["repo-review", "repo-review"],
  );
});

test("enqueueWorkflow routes learned skill metadata from metadata-aware skill loaders", async () => {
  const skillEvents: unknown[] = [];

  const queued = await enqueueWorkflow({
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
        "  - repo-helper",
        "steps:",
        "  - id: inspect",
        "    action: gather_evidence",
      ].join("\n"),
    readSkill: async () => ({
      content: [
        "---",
        "description: Learned repo helper.",
        "---",
        "Use repo-local memory.",
      ].join("\n"),
      metadata: {
        name: "Repo Helper",
        source: "learned",
        path: "/home/user/.pi/khala/skills/repo-helper/SKILL.md",
      },
      attemptedSources: ["packaged", "learned", "learned", "unknown"],
    }),
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  assert.deepEqual(
    skillEvents.map((event) => (event as { type: string }).type),
    ["skill_routed", "skill_loaded"],
  );
  assert.deepEqual(
    skillEvents.map((event) => (event as { skill: unknown }).skill),
    [
      {
        name: "repo-helper",
        source: "learned",
        path: "/home/user/.pi/khala/skills/repo-helper/SKILL.md",
      },
      {
        name: "repo-helper",
        source: "learned",
        path: "/home/user/.pi/khala/skills/repo-helper/SKILL.md",
      },
    ],
  );
  assert.deepEqual(
    skillEvents.map(
      (event) => (event as { attemptedSources?: unknown }).attemptedSources,
    ),
    [
      ["packaged", "learned"],
      ["packaged", "learned"],
    ],
  );
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "repo-helper",
      source: "learned",
      path: "/home/user/.pi/khala/skills/repo-helper/SKILL.md",
    },
  ]);
});

test("enqueueWorkflow does not report routed skills as loaded when loading is unavailable", async () => {
  const skillEvents: unknown[] = [];

  const queued = await enqueueWorkflow({
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
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  assert.deepEqual(queued.loadedSkills, []);
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "code-review",
      source: "packaged",
      path: "skills/code-review/SKILL.md",
    },
  ]);
  assert.deepEqual(
    skillEvents.map((event) => (event as { type: string }).type),
    ["skill_routed", "skill_missing"],
  );
});

test("enqueueWorkflow deduplicates normalized workflow skill names", async () => {
  const skillEvents: unknown[] = [];
  const loadedNames: string[] = [];

  const queued = await enqueueWorkflow({
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
        "  - Code-Review",
        "  - code-review",
        "steps:",
        "  - id: inspect",
        "    action: gather_evidence",
      ].join("\n"),
    readSkill: async (name) => {
      loadedNames.push(name);
      return [
        "---",
        "description: Review code for correctness.",
        "---",
        "Use concrete findings.",
      ].join("\n");
    },
    onSkillEvent: (event) => {
      skillEvents.push(event);
    },
  });

  assert.deepEqual(loadedNames, ["code-review"]);
  assert.deepEqual(
    skillEvents.map((event) => (event as { type: string }).type),
    ["skill_routed", "skill_loaded"],
  );
  assert.deepEqual(queued.loadedSkills, ["code-review"]);
  assert.deepEqual(queued.skillMetadata, [
    {
      name: "code-review",
      source: "packaged",
      path: "skills/code-review/SKILL.md",
    },
  ]);
});

test("enqueueWorkflow applies prompt skill context to workflow skills", async () => {
  const sentMessages: string[] = [];

  const queued = await enqueueWorkflow({
    pi: {
      sendUserMessage: (message: string) => sentMessages.push(message),
    } as never,
    workflowPromptName: "sample-workflow.md",
    workflowFileName: "sample-workflow.yaml",
    sections: [],
    readCommandPrompt: async () =>
      [
        "---",
        "skillContext: full",
        "---",
        "You are running a sample workflow.",
      ].join("\n"),
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
  });

  assert.equal(sentMessages.length, 1);
  const payload = sentMessages[0] ?? "";
  assert.match(payload, /Workflow skills context:/);
  assert.match(payload, /\[SKILL:code-review\]/);
  assert.match(payload, /Use concrete findings\./);
  assert.doesNotMatch(payload, /Workflow skills manifest:/);
  assert.deepEqual(queued.loadedSkills, ["code-review"]);
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
      readSkill: async () => ({
        content: "",
        attemptedSources: ["packaged", "learned", "repo-local"],
      }),
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
  assert.deepEqual((skillEvents.at(-1) as { attemptedSources?: unknown }).attemptedSources, [
    "packaged",
    "learned",
    "repo-local",
  ]);
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
      source: {
        issue: 196,
        pr: 194,
        url: "https://github.com/pesap/agents/issues/196",
      },
      local: {
        worktreePath: "/tmp/worktrunk.khala",
        capsulePath: "/home/user/.pi/khala/github.com/pesap/agents/capsule.md",
        ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/handoff.json",
      },
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
    assert.equal(ledger.source.issue, 196);
    assert.equal(ledger.source.pr, 194);
    assert.equal(ledger.source.url, "https://github.com/pesap/agents/issues/196");
    assert.equal(ledger.local.worktreePath, "/tmp/worktrunk.khala");
    assert.equal(ledger.local.capsulePath, "/home/user/.pi/khala/github.com/pesap/agents/capsule.md");
    assert.equal(ledger.local.ledgerPath, "/home/user/.pi/khala/github.com/pesap/agents/handoff.json");
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

test("parseWorkflowRuntimeState preserves authored step status and current step", () => {
  const state = parseWorkflowRuntimeState([
    "name: sample-workflow",
    "objective: Resume a partially completed workflow",
    "currentStep: validate",
    "steps:",
    "  - id: inspect",
    "    action: gather_evidence",
    "    status: completed",
    "  - id: validate",
    "    action: run_targeted_checks",
    "    status: pending",
    "  - id: report",
    "    action: summarize_result",
    "    status: pending",
  ].join("\n"));

  assert.equal(state.currentStepIndex, 1);
  assert.deepEqual(
    state.steps.map((step) => ({
      id: step.id,
      action: step.action,
      status: step.status,
    })),
    [
      { id: "inspect", action: "gather_evidence", status: "completed" },
      { id: "validate", action: "run_targeted_checks", status: "active" },
      { id: "report", action: "summarize_result", status: "pending" },
    ],
  );
});

test("parseWorkflowRuntimeState marks fully completed authored state inactive", () => {
  const state = parseWorkflowRuntimeState([
    "name: sample-workflow",
    "objective: Completed workflow",
    "steps:",
    "  - id: inspect",
    "    action: gather_evidence",
    "    status: completed",
    "  - id: validate",
    "    action: run_targeted_checks",
    "    status: skipped",
  ].join("\n"));

  assert.equal(state.currentStepIndex, null);
  assert.deepEqual(
    state.steps.map((step) => step.status),
    ["completed", "skipped"],
  );
});

test("workflow parser falls back to ordered steps when non-step YAML is malformed", () => {
  const workflowSpec = [
    "name: ship-workflow",
    "objective: Publish one focused change safely",
    "guards:",
    "  - include a close marker only when durable source is known; otherwise avoid `Closes: none`",
    "steps:",
    "  - id: detect",
    "    action: inspect_git_state",
    "  - id: publish",
    "    action: create_signed_commit_if_needed_and_push",
  ].join("\n");

  const state = parseWorkflowRuntimeState(workflowSpec);
  assert.equal(state.name, "ship-workflow");
  assert.equal(state.objective, "Publish one focused change safely");
  assert.equal(state.currentStepIndex, 0);
  assert.deepEqual(
    state.steps.map((step) => ({
      id: step.id,
      action: step.action,
      status: step.status,
    })),
    [
      { id: "detect", action: "inspect_git_state", status: "active" },
      {
        id: "publish",
        action: "create_signed_commit_if_needed_and_push",
        status: "pending",
      },
    ],
  );

  const contract = buildDeterministicWorkflowContract({
    workflowSpec,
    workflowName: "ship-workflow.yaml",
  });
  assert.match(contract, /Workflow: ship-workflow/);
  assert.match(contract, /Objective: Publish one focused change safely/);
  assert.match(contract, /1\. detect: inspect_git_state/);
  assert.match(contract, /2\. publish: create_signed_commit_if_needed_and_push/);
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
    assert.deepEqual(ledger.events[0].data.workflowState, ledger.workflow.state);
    assert.equal(ledger.resume.classification, "resumable");
    assert.equal(workflow.toolCallCount, 0);
    assert.equal(entries[0]?.name, "khala-workflow-start");
    assert.deepEqual(entries[0]?.value, {
      id: "debug-ledger",
      type: "debug",
      input: "investigate failing test",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      runFile: workflow.runFile,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordWorkflowToolCall appends typed tool and mutation events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-tools-"));
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
      makeId: (prefix) => `${prefix}-tool-ledger`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    const readEvent = await recordWorkflowToolCall({
      workflow,
      toolName: "read",
      input: { path: "README.md" },
      at: "2026-06-20T00:01:00.000Z",
    });
    const mutationEvent = await recordWorkflowToolCall({
      workflow,
      toolName: "functions.exec_command",
      input: { cmd: "touch changed.txt" },
      at: "2026-06-20T00:02:00.000Z",
    });

    assert.equal(workflow.toolCallCount, 2);
    assert.equal(workflow.mutationCount, 1);
    assert.equal(readEvent?.type, "tool_call");
    assert.equal(readEvent?.data?.workflowToolCallCount, 1);
    assert.equal(readEvent?.data?.workflowMutationCount, 0);
    assert.deepEqual(readEvent?.data?.workflowStep, {
      index: 0,
      id: "intake",
      action: "restate_problem",
      status: "active",
      totalSteps: 1,
    });
    assert.equal(mutationEvent?.type, "mutation");
    assert.equal(mutationEvent?.data?.workflowToolCallCount, 2);
    assert.equal(mutationEvent?.data?.workflowMutationCount, 1);
    assert.deepEqual(mutationEvent?.data?.workflowStep, readEvent?.data?.workflowStep);

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    const events = ledger.events.slice(-2);
    assert.deepEqual(
      events.map((event: { type: string }) => event.type),
      ["tool_call", "mutation"],
    );
    assert.equal(events[0].toolName, "read");
    assert.equal(events[0].evidenceClass, "local");
    assert.equal(events[0].replaySafe, true);
    assert.deepEqual(events[0].data.workflowStep, {
      index: 0,
      id: "intake",
      action: "restate_problem",
      status: "active",
      totalSteps: 1,
    });
    assert.equal(events[1].toolName, "functions.exec_command");
    assert.equal(events[1].sideEffectClass, "shell");
    assert.equal(events[1].replaySafe, false);
    assert.deepEqual(events[1].data.workflowStep, events[0].data.workflowStep);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("advanceWorkflowTracking persists active step progress as a checkpoint", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-advance-"));
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
        learningJsonl: path.join(tempDir, "learning.jsonl"),
        memoryMd: path.join(tempDir, "MEMORY.md"),
        promotionQueue: path.join(tempDir, "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-advance`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    const state = await advanceWorkflowTracking({
      workflow,
      at: "2026-06-20T00:03:00.000Z",
      stepId: "intake",
    });

    assert.equal(state?.currentStepIndex, 1);
    assert.equal(workflow.workflowState?.currentStepIndex, 1);
    assert.deepEqual(
      workflow.workflowState?.steps.map((step) => step.status),
      ["completed", "active"],
    );
    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.equal(ledger.workflow.state.currentStepIndex, 1);
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["completed", "active"],
    );
    assert.equal(ledger.events.at(-1).type, "checkpoint");
    assert.equal(ledger.events.at(-1).replaySafe, true);
    assert.equal(
      ledger.events.at(-1).summary,
      "Checkpoint recorded: Workflow advanced to step 2/2: evidence",
    );
    assert.deepEqual(
      ledger.events.at(-1).data.workflowState,
      ledger.workflow.state,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("advanceWorkflowTrackingForTurnBoundary advances non-final workflow turns", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-turn-advance-"));
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
        learningJsonl: path.join(tempDir, "learning.jsonl"),
        memoryMd: path.join(tempDir, "MEMORY.md"),
        promotionQueue: path.join(tempDir, "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-turn-advance`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await advanceWorkflowTrackingForTurnBoundary({
      workflow,
      at: "2026-06-20T00:03:00.000Z",
      assistantText: "Completed intake and gathered the next evidence target.",
      awaitingUserAction: false,
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["completed", "active"],
    );
    assert.equal(
      ledger.events.at(-1).summary,
      "Checkpoint recorded: Workflow turn completed step 1/2: intake",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("advanceWorkflowTrackingForTurnBoundary does not advance clarification turns", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-turn-wait-"));
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
        learningJsonl: path.join(tempDir, "learning.jsonl"),
        memoryMd: path.join(tempDir, "MEMORY.md"),
        promotionQueue: path.join(tempDir, "promotion.md"),
        stateJson: path.join(tempDir, "state.json"),
        workflowsDir: path.join(tempDir, "workflows"),
        promptsDir: path.join(tempDir, "prompts"),
      }),
      makeId: (prefix) => `${prefix}-turn-wait`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await advanceWorkflowTrackingForTurnBoundary({
      workflow,
      at: "2026-06-20T00:03:00.000Z",
      assistantText: "Which failing test should I inspect first?",
      awaitingUserAction: true,
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["active", "pending"],
    );
    assert.equal(ledger.events.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("advanceWorkflowTracking refuses mismatched active step ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-advance-mismatch-"));
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
      makeId: (prefix) => `${prefix}-advance-mismatch`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await assert.rejects(
      advanceWorkflowTracking({
        workflow,
        at: "2026-06-20T00:03:00.000Z",
        stepId: "evidence",
      }),
      /active step is intake/,
    );

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.equal(ledger.workflow.state.currentStepIndex, 0);
    assert.equal(ledger.events.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interruptWorkflowTracking marks pending run ledger interrupted", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-interrupt-"));
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
        "steps:",
        "  - id: intake",
        "    action: restate_problem",
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
      makeId: (prefix) => `${prefix}-interrupt`,
      nowIso: () => "2026-06-20T00:00:00.000Z",
      summarizeEvidence: (text) => text,
      runtimeState,
      appendPreflightEntry: () => undefined,
    });

    await interruptWorkflowTracking({
      workflow,
      at: "2026-06-20T00:05:00.000Z",
      reason: "Operator cancelled workflow.",
    });

    const ledger = JSON.parse(await readFile(workflow.runFile, "utf8"));
    assert.equal(ledger.status, "resumable");
    assert.equal(ledger.resume.classification, "resumable");
    assert.equal(ledger.events.at(-1).type, "interrupted");
    assert.equal(ledger.events.at(-1).summary, "Operator cancelled workflow.");
    assert.deepEqual(ledger.events.at(-1).data.workflowState, ledger.workflow.state);
    assert.equal(ledger.events.at(-1).data.workflowState.currentStepIndex, 0);
    assert.equal(ledger.events.at(-1).data.workflowState.steps[0].status, "active");
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
    workflow.loadedSkills = ["code-review"];
    workflow.skillMetadata = [
      {
        name: "code-review",
        source: "packaged",
        path: "skills/code-review/SKILL.md",
      },
    ];
    const entries: Array<{ name: string; value: Record<string, unknown> }> = [];

    await completeWorkflowTracking({
      pi: { appendEntry: (name: string, value: Record<string, unknown>) => entries.push({ name, value }) } as never,
      ctx: { cwd: tempDir } as never,
      workflow,
      assistantText: [
        "Validation",
        "1. npm test passed",
        "",
        "Open Questions",
        "1. Should resume get a CLI command?",
        "",
        "Learning Candidates",
        "1. Keep workflow state in run ledgers.",
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
    assert.deepEqual(completedEvent.data.workflowState, ledger.workflow.state);
    assert.deepEqual(completedEvent.data.loadedSkills, ["code-review"]);
    assert.deepEqual(completedEvent.data.skillMetadata, [
      {
        name: "code-review",
        source: "packaged",
        path: "skills/code-review/SKILL.md",
      },
    ]);
    assert.equal(completedEvent.data.strictViolation, false);
    assert.equal(completedEvent.data.strictViolationReason, null);
    assert.equal(completedEvent.data.qualityScore, 100);
    assert.equal(completedEvent.data.mutationCount, 0);
    assert.equal(completedEvent.data.postflightMissing, false);
    assert.deepEqual(completedEvent.data.policyWarnings, []);
    assert.deepEqual(ledger.structuredCompletion.learningCandidates, [
      "Keep workflow state in run ledgers.",
    ]);
    assert.equal(ledger.workflow.state.currentStepIndex, null);
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["completed", "completed"],
    );
    assert.equal(ledger.events.at(-1).type, "workflow_completed");
    const completeEntry = entries.find((entry) => entry.name === "khala-workflow-complete");
    assert.ok(completeEntry);
    assert.equal(completeEntry.value.runFile, workflow.runFile);
    assert.deepEqual(completeEntry.value.workflowState, ledger.workflow.state);
    assert.deepEqual(completeEntry.value.structuredCompletion, ledger.structuredCompletion);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeWorkflowTracking parses structured completion heading aliases", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-complete-aliases-"));
  try {
    const runtimeState = createRuntimeState();
    const runsDir = path.join(tempDir, "runs");
    const workflow = await beginWorkflowTracking({
      pi: { appendEntry: () => undefined } as never,
      ctx: { cwd: tempDir } as never,
      type: "debug",
      input: "investigate completion aliases",
      flags: {},
      workflowSpec: [
        "name: debug-workflow",
        "objective: Investigate a symptom",
        "steps:",
        "  - id: validate",
        "    action: run_tests",
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
      makeId: (prefix) => `${prefix}-complete-aliases`,
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
        "Verified: npm run smoke passed",
        "",
        "Follow-ups: Confirm model availability separately.",
        "",
        "Learning notes: Completion aliases should still populate structured fields.",
        "",
        "Result: success",
        "Confidence: 0.91",
      ].join("\n"),
      learningVersion: 7,
      lowConfidenceThreshold: 0.7,
      runtimeState,
      inferOutcomeFromText: () => ({ outcome: "success", confidence: 0.91 }),
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
    assert.deepEqual(ledger.structuredCompletion.validation, [
      "npm run smoke passed",
    ]);
    assert.deepEqual(ledger.structuredCompletion.openQuestions, [
      "Confirm model availability separately.",
    ]);
    assert.deepEqual(ledger.structuredCompletion.learningCandidates, [
      "Completion aliases should still populate structured fields.",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeWorkflowTracking preserves incomplete step status for failed workflows", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workflow-failed-state-"));
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
      makeId: (prefix) => `${prefix}-failed-state`,
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
        "- npm test failed",
        "",
        "Open Questions:",
        "- Need a root cause.",
        "",
        "Result: failed",
        "Confidence: 0.81",
      ].join("\n"),
      learningVersion: 7,
      lowConfidenceThreshold: 0.7,
      runtimeState,
      inferOutcomeFromText: () => ({ outcome: "failed", confidence: 0.81 }),
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
    assert.equal(ledger.workflow.state.currentStepIndex, null);
    assert.deepEqual(
      ledger.workflow.state.steps.map((step: { status: string }) => step.status),
      ["active", "pending"],
    );
    const completedEvent = ledger.events.find(
      (event: { type: string }) => event.type === "workflow_completed",
    );
    assert.ok(completedEvent);
    assert.deepEqual(completedEvent.data.workflowState, ledger.workflow.state);
    assert.equal(completedEvent.data.outcome, "failed");
    assert.deepEqual(ledger.structuredCompletion.validation, ["npm test failed"]);
    assert.deepEqual(ledger.structuredCompletion.openQuestions, [
      "Need a root cause.",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
