import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRunLedgerEvent,
  buildRunLedgerCheckpointEvent,
  buildRunLedgerInterruptedEvent,
  buildRunLedgerRecord,
  buildRunLedgerResumeAttemptEvent,
  buildRunLedgerSkillEvent,
  buildRunLedgerToolCallEvent,
  buildRunLedgerToolCallEventFromRegistry,
  buildRunLedgerWorkflowCompletedEvent,
  buildRunLedgerWorkflowStartedEvent,
  classifyInterruptedRun,
  completeRunLedger,
  getGlobalRunLedgerDir,
  markRunInterrupted,
  readRunLedger,
  writeRunLedger,
  type RunLedgerRecord,
} from "../../extensions/runtime/run-ledger.ts";
import { getToolMetadata } from "../../extensions/runtime/tool-registry.ts";
import { buildSkillRegistryEvent } from "../../extensions/runtime/skill-registry.ts";

test("global run ledger directory is under the global khala store", () => {
  assert.equal(getGlobalRunLedgerDir(), path.join(homedir(), ".pi", "khala", "runs"));
});

test("writeRunLedger replaces run files without leaving temporary files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-write-"));
  try {
    const runFile = path.join(tempDir, "runs", "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "first write",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "replacement write",
        flags: {},
        startedAt: "2026-06-20T00:01:00.000Z",
      }),
    );

    const persisted = await readRunLedger(runFile);
    assert.equal(persisted?.input, "replacement write");
    assert.equal(persisted?.startedAt, "2026-06-20T00:01:00.000Z");
    assert.deepEqual(
      (await readdir(path.dirname(runFile))).filter((file) =>
        file.endsWith(".tmp"),
      ),
      [],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeRunLedger retries transient rename permission failures", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-rename-retry-"));
  const originalRename = fs.rename;
  let attempts = 0;
  fs.rename = (async (...args: unknown[]) => {
    attempts += 1;
    if (attempts <= 2) {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
        code: "EPERM",
      });
    }
    return originalRename(args[0] as never, args[1] as never);
  }) as typeof fs.rename;
  try {
    const runFile = path.join(tempDir, "runs", "plan-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "plan-1",
        type: "plan",
        input: "transient Windows rename failure",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    assert.equal(attempts, 3);
    assert.equal((await readRunLedger(runFile))?.input, "transient Windows rename failure");
    assert.deepEqual(
      (await readdir(path.dirname(runFile))).filter((file) =>
        file.endsWith(".tmp"),
      ),
      [],
    );
  } finally {
    fs.rename = originalRename;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeRunLedger persists canonical source, local, and event metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-write-normalize-"));
  try {
    const runFile = path.join(tempDir, "runs", "debug-legacy.json");
    await writeRunLedger(
      runFile,
      {
        ...buildRunLedgerRecord({
          version: 1,
          id: "debug-legacy",
          type: "debug",
          input: "normalize durable run metadata",
          flags: {},
          startedAt: "2026-06-20T00:00:00.000Z",
        }),
        source: {
          issue: " 196 ",
          pr: " ",
          url: " https://github.com/pesap/agents/issues/196 ",
        },
        local: {
          worktreePath: " /tmp/worktrunk.khala ",
          capsulePath: "",
          ledgerPath: " /home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl ",
        },
        status: "interrupted",
        resume: {
          classification: "resumable",
          reason: "stale recovery metadata",
          unsafeEventIds: ["", "debug-legacy:web", 42],
          unsafeEvents: [
            {
              id: " ",
              reason: "",
            },
            {
              id: "debug-legacy:web",
              reason: " stale reason ",
              toolName: " web.search_query ",
              replaySafe: "false",
            },
          ],
        } as unknown as RunLedgerRecord["resume"],
        events: [
          {
            id: "debug-legacy:web",
            at: "2026-06-20T00:01:00.000Z",
            type: "tool_call",
            summary: "legacy web search event",
            toolName: "web.search_query",
          },
        ],
      },
    );

    const persisted = JSON.parse(await readFile(runFile, "utf8")) as RunLedgerRecord;

    assert.deepEqual(persisted.source, {
      issue: "196",
      url: "https://github.com/pesap/agents/issues/196",
    });
    assert.deepEqual(persisted.local, {
      worktreePath: "/tmp/worktrunk.khala",
      ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl",
    });
    assert.equal(persisted.events[0]?.evidenceClass, "external");
    assert.equal(persisted.events[0]?.mutationClass, "none");
    assert.equal(persisted.events[0]?.sideEffectClass, "external");
    assert.equal(persisted.events[0]?.replaySafe, false);
    assert.equal(persisted.events[0]?.memoryRefreshRequirement, "not_required");
    assert.deepEqual(persisted.events[0]?.data?.metadata, getToolMetadata({
      toolName: "web.search_query",
    }));
    assert.equal(persisted.status, "needs_operator_review");
    assert.deepEqual(persisted.resume, {
      classification: "needs_operator_review",
      reason: "Run has uncertain mutation, shell, forge, external, or tool side effects in the run ledger.",
      unsafeEventIds: ["debug-legacy:web"],
      unsafeEvents: [
        {
          id: "debug-legacy:web",
          reason: "not explicitly replay-safe; external side effect",
          toolName: "web.search_query",
          sideEffectClass: "external",
          replaySafe: false,
          mutationClass: "none",
          memoryRefreshRequirement: "not_required",
        },
      ],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeRunLedger persists canonical structured completion metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-write-completion-"));
  try {
    const runFile = path.join(tempDir, "runs", "ship-complete.json");
    await writeRunLedger(
      runFile,
      {
        ...buildRunLedgerRecord({
          version: 1,
          id: "ship-complete",
          type: "ship",
          input: "ship durable completion",
          flags: {},
          startedAt: "2026-06-20T00:00:00.000Z",
        }),
        status: "completed",
        outcome: " ",
        confidence: "not-a-number",
        structuredCompletion: {
          outcome: " success ",
          confidence: "92%",
          validation: "- npm test passed\n- npm test passed\n2. smoke passed",
          openQuestions: "1. Need owner approval",
          learningCandidates: [
            " Keep completion writes canonical. ",
            "Keep completion writes canonical.",
          ],
        },
        finishedAt: "2026-06-20T00:12:00.000Z",
        events: [],
      } as unknown as RunLedgerRecord,
    );

    const persisted = JSON.parse(await readFile(runFile, "utf8")) as RunLedgerRecord;

    assert.equal(persisted.outcome, "success");
    assert.equal(persisted.confidence, 0.92);
    assert.deepEqual(persisted.structuredCompletion, {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed", "smoke passed"],
      openQuestions: ["Need owner approval"],
      learningCandidates: ["Keep completion writes canonical."],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger ignores legacy events with unknown or blank event identity", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-event-type-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeFile(
      runFile,
      JSON.stringify({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        status: "started",
        startedAt: "2026-06-20T00:00:00.000Z",
        workflow: {
          type: "debug",
          input: "debug issue",
          flags: {},
        },
        events: [
          {
            id: "workflow-1:unknown",
            at: "2026-06-20T00:01:00.000Z",
            type: "mystery_event",
            summary: "legacy event from an unknown writer",
            replaySafe: true,
          },
          {
            id: " ",
            at: "2026-06-20T00:01:30.000Z",
            type: "checkpoint",
            summary: "blank event id",
            replaySafe: true,
          },
          {
            id: " workflow-1:checkpoint:2026-06-20T00:02:00.000Z ",
            at: " 2026-06-20T00:02:00.000Z ",
            type: "checkpoint",
            summary: " Checkpoint recorded. ",
            toolName: " read_file ",
            replaySafe: true,
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.equal(loaded?.events.length, 1);
    assert.equal(loaded?.events[0]?.type, "checkpoint");
    assert.equal(loaded?.events[0]?.id, "workflow-1:checkpoint:2026-06-20T00:02:00.000Z");
    assert.equal(loaded?.events[0]?.at, "2026-06-20T00:02:00.000Z");
    assert.equal(loaded?.events[0]?.summary, "Checkpoint recorded.");
    assert.equal(loaded?.events[0]?.toolName, "read_file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interrupted run remains resumable after read-only events", () => {
  const classification = classifyInterruptedRun([
    {
      id: "run-1:start",
      at: "2026-06-20T00:00:00.000Z",
      type: "workflow_started",
      summary: "started",
      replaySafe: true,
    },
    {
      id: "run-1:read",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "read file",
      toolName: "read",
      sideEffectClass: "read_only",
      replaySafe: true,
    },
  ]);

  assert.equal(classification.classification, "resumable");
  assert.equal(
    classification.reason,
    "No uncertain side effects recorded in the run ledger.",
  );
  assert.deepEqual(classification.unsafeEventIds, []);
});

test("interrupted run classification uses tool metadata snapshots when event fields are missing", () => {
  const classification = classifyInterruptedRun([
    {
      id: "run-1:start",
      at: "2026-06-20T00:00:00.000Z",
      type: "workflow_started",
      summary: "started",
    },
    {
      id: "run-1:bash",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "shell command",
      toolName: "bash",
      data: {
        metadata: {
          name: "bash",
          evidenceClass: "local",
          mutationClass: "filesystem",
          sideEffectClass: "shell",
          replaySafe: false,
          memoryRefreshRequirement: "not_required",
          gateSatisfaction: {
            countsTaskToolCall: true,
            agesMemory: true,
            satisfiesMemoryRead: false,
            persistsMemory: false,
          },
        },
      },
    },
  ]);

  assert.equal(classification.classification, "needs_operator_review");
  assert.equal(
    classification.reason,
    "Run has uncertain mutation, shell, forge, external, or tool side effects in the run ledger.",
  );
  assert.deepEqual(classification.unsafeEventIds, ["run-1:bash"]);
  assert.deepEqual(classification.unsafeEvents, [
    {
      id: "run-1:bash",
      reason: "not explicitly replay-safe; shell side effect",
      toolName: "bash",
      sideEffectClass: "shell",
      replaySafe: false,
      mutationClass: "filesystem",
      memoryRefreshRequirement: "not_required",
    },
  ]);
});

test("interrupted run classification falls back to registry metadata for legacy tool events", () => {
  const readOnly = classifyInterruptedRun([
    {
      id: "run-1:start",
      at: "2026-06-20T00:00:00.000Z",
      type: "workflow_started",
      summary: "started",
    },
    {
      id: "run-1:read",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "legacy read event",
      toolName: "read",
    },
  ]);
  assert.equal(readOnly.classification, "resumable");
  assert.deepEqual(readOnly.unsafeEventIds, []);

  const external = classifyInterruptedRun([
    {
      id: "run-1:start",
      at: "2026-06-20T00:00:00.000Z",
      type: "workflow_started",
      summary: "started",
    },
    {
      id: "run-1:web",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "legacy web event",
      toolName: "web.search_query",
    },
  ]);
  assert.equal(external.classification, "needs_operator_review");
  assert.equal(
    external.reason,
    "Run has uncertain mutation, shell, forge, external, or tool side effects in the run ledger.",
  );
  assert.deepEqual(external.unsafeEventIds, ["run-1:web"]);

  const shellWithoutInput = classifyInterruptedRun([
    {
      id: "run-1:start",
      at: "2026-06-20T00:00:00.000Z",
      type: "workflow_started",
      summary: "started",
    },
    {
      id: "run-1:bash",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "legacy shell event without input",
      toolName: "bash",
    },
  ]);
  assert.equal(shellWithoutInput.classification, "needs_operator_review");
  assert.equal(
    shellWithoutInput.reason,
    "Run has uncertain mutation, shell, forge, external, or tool side effects in the run ledger.",
  );
  assert.deepEqual(shellWithoutInput.unsafeEventIds, ["run-1:bash"]);
});

test("tool call ledger event snapshots typed registry metadata", () => {
  const metadata = getToolMetadata({ toolName: "web.search_query" });

  const event = buildRunLedgerToolCallEvent({
    workflowId: "workflow-1",
    workflowMutationCount: 2,
    workflowToolCallCount: 7,
    toolName: "web.search_query",
    at: "2026-06-20T00:03:00.000Z",
    mutation: false,
    metadata,
    input: { q: "khala run ledger" },
    workflowStep: {
      index: 1,
      id: "collect-evidence",
      action: "Search for prior art",
      status: "active",
      totalSteps: 3,
    },
  });

  assert.equal(event.id, "workflow-1:tool:2026-06-20T00:03:00.000Z:web.search_query:7");
  assert.equal(event.type, "tool_call");
  assert.equal(event.evidenceClass, "external");
  assert.equal(event.mutationClass, "none");
  assert.equal(event.sideEffectClass, "external");
  assert.equal(event.replaySafe, false);
  assert.equal(event.memoryRefreshRequirement, "not_required");
  assert.deepEqual(event.gateSatisfaction, metadata.gateSatisfaction);
  assert.deepEqual(event.data?.metadata, metadata);
  assert.equal(event.data?.workflowMutationCount, 2);
  assert.equal(event.data?.workflowToolCallCount, 7);
  assert.deepEqual(event.data?.input, { q: "khala run ledger" });
  assert.deepEqual(event.data?.workflowStep, {
    index: 1,
    id: "collect-evidence",
    action: "Search for prior art",
    status: "active",
    totalSteps: 3,
  });

  const repeatedReadOnlyEvent = buildRunLedgerToolCallEvent({
    workflowId: "workflow-1",
    workflowMutationCount: 2,
    workflowToolCallCount: 8,
    toolName: "web.search_query",
    at: "2026-06-20T00:03:00.000Z",
    mutation: false,
    metadata,
  });
  assert.notEqual(repeatedReadOnlyEvent.id, event.id);
  assert.equal(repeatedReadOnlyEvent.data?.workflowMutationCount, 2);
  assert.equal(repeatedReadOnlyEvent.data?.workflowToolCallCount, 8);

  const mutationEvent = buildRunLedgerToolCallEvent({
    workflowId: "workflow-1",
    workflowMutationCount: 3,
    workflowToolCallCount: 9,
    toolName: "write",
    at: "2026-06-20T00:04:00.000Z",
    mutation: true,
    metadata: getToolMetadata({ toolName: "write" }),
  });

  assert.equal(mutationEvent.type, "mutation");
  assert.equal(mutationEvent.evidenceClass, "none");
  assert.equal(mutationEvent.mutationClass, "filesystem");
  assert.equal(mutationEvent.memoryRefreshRequirement, "required_before_mutation");
  assert.equal(mutationEvent.replaySafe, false);
});

test("tool call ledger event builder derives classification from registry metadata", () => {
  const readOnlyShell = buildRunLedgerToolCallEventFromRegistry({
    workflowId: "workflow-1",
    workflowMutationCount: 0,
    workflowToolCallCount: 1,
    toolName: "functions.exec_command",
    at: "2026-06-20T00:03:00.000Z",
    input: { cmd: "git status --short" },
    workflowStep: {
      index: 0,
      id: "status",
      action: "Inspect worktree",
      status: "active",
      totalSteps: 2,
    },
  });

  assert.equal(readOnlyShell.type, "tool_call");
  assert.equal(readOnlyShell.evidenceClass, "local");
  assert.equal(readOnlyShell.mutationClass, "none");
  assert.equal(readOnlyShell.sideEffectClass, "read_only");
  assert.equal(readOnlyShell.replaySafe, true);
  assert.equal(readOnlyShell.memoryRefreshRequirement, "not_required");
  assert.equal(readOnlyShell.gateSatisfaction?.countsTaskToolCall, true);
  assert.equal(readOnlyShell.data?.workflowMutationCount, 0);
  assert.equal(readOnlyShell.data?.workflowToolCallCount, 1);
  assert.deepEqual(readOnlyShell.data?.workflowStep, {
    index: 0,
    id: "status",
    action: "Inspect worktree",
    status: "active",
    totalSteps: 2,
  });

  const mutatingShell = buildRunLedgerToolCallEventFromRegistry({
    workflowId: "workflow-1",
    workflowMutationCount: 1,
    workflowToolCallCount: 2,
    toolName: "functions.exec_command",
    at: "2026-06-20T00:04:00.000Z",
    input: { cmd: "touch changed.txt" },
  });

  assert.equal(mutatingShell.type, "mutation");
  assert.equal(mutatingShell.evidenceClass, "none");
  assert.equal(mutatingShell.mutationClass, "shell");
  assert.equal(mutatingShell.sideEffectClass, "shell");
  assert.equal(mutatingShell.replaySafe, false);
  assert.equal(mutatingShell.memoryRefreshRequirement, "required_before_mutation");
  assert.equal(mutatingShell.data?.workflowMutationCount, 1);
  assert.equal(mutatingShell.data?.workflowToolCallCount, 2);
});

test("skill ledger event snapshots registry metadata and reason", () => {
  const skillEvent = buildSkillRegistryEvent({
    type: "skill_loaded",
    name: "code-review",
    path: "/repo/skills/code-review/SKILL.md",
    reason: "Workflow declared code-review.",
  });

  const ledgerEvent = buildRunLedgerSkillEvent({
    workflowId: "workflow-1",
    event: skillEvent,
    at: "2026-06-20T00:05:00.000Z",
  });

  assert.equal(ledgerEvent.id, "workflow-1:skill_loaded:code-review:2026-06-20T00:05:00.000Z");
  assert.equal(ledgerEvent.type, "skill_loaded");
  assert.equal(
    ledgerEvent.summary,
    "skill_loaded: code-review source=packaged path=/repo/skills/code-review/SKILL.md. reason=Workflow declared code-review.",
  );
  assert.equal(ledgerEvent.evidenceClass, "local");
  assert.equal(ledgerEvent.sideEffectClass, "read_only");
  assert.equal(ledgerEvent.replaySafe, true);
  assert.deepEqual(ledgerEvent.data?.skill, {
    name: "code-review",
    source: "packaged",
    path: "/repo/skills/code-review/SKILL.md",
  });
  assert.equal(ledgerEvent.data?.reason, "Workflow declared code-review.");
});

test("skill ledger event ids remain unique for repeated skill events", () => {
  const skillEvent = buildSkillRegistryEvent({
    type: "skill_loaded",
    name: "code-review",
    path: "/repo/skills/code-review/SKILL.md",
    reason: "Workflow declared code-review.",
  });

  const first = buildRunLedgerSkillEvent({
    workflowId: "workflow-1",
    event: skillEvent,
    at: "2026-06-20T00:05:00.000Z",
  });
  const second = buildRunLedgerSkillEvent({
    workflowId: "workflow-1",
    event: skillEvent,
    at: "2026-06-20T00:06:00.000Z",
  });

  assert.notEqual(first.id, second.id);
  assert.equal(second.id, "workflow-1:skill_loaded:code-review:2026-06-20T00:06:00.000Z");
});

test("resume attempt ledger event is replay-safe operator metadata", () => {
  const event = buildRunLedgerResumeAttemptEvent({
    runId: "review-1",
    at: "2026-06-20T00:10:00.000Z",
    recovery: {
      classification: "resumable",
      reason: "Interrupted without unsafe side effects.",
      recommendedAction:
        "Resume from the latest safe checkpoint and skip already recorded side effects.",
      unsafeEventIds: [],
    },
  });

  assert.deepEqual(event, {
    id: "review-1:resume_attempted:2026-06-20T00:10:00.000Z",
    at: "2026-06-20T00:10:00.000Z",
    type: "resume_attempted",
    summary: "Operator requested conservative run resume.",
    evidenceClass: "local",
    sideEffectClass: "read_only",
    replaySafe: true,
    data: {
      recovery: {
        classification: "resumable",
        reason: "Interrupted without unsafe side effects.",
        recommendedAction:
          "Resume from the latest safe checkpoint and skip already recorded side effects.",
        unsafeEventIds: [],
      },
    },
  });
});

test("resume attempt ledger event snapshots structured unsafe recovery details", () => {
  const event = buildRunLedgerResumeAttemptEvent({
    runId: "ship-1",
    at: "2026-06-20T00:10:00.000Z",
    recovery: {
      classification: "needs_operator_review",
      reason: "Unsafe side effects require review.",
      recommendedAction:
        "Review unsafe events before resuming; do not repeat uncertain side effects.",
      unsafeEventIds: ["ship-1:mutation"],
      unsafeEvents: [
        {
          id: "ship-1:mutation",
          reason: "not explicitly replay-safe; shell side effect",
          toolName: "bash",
          sideEffectClass: "shell",
          replaySafe: false,
          mutationClass: "shell",
          memoryRefreshRequirement: "required_before_mutation",
        },
      ],
    },
  });

  assert.deepEqual(event.data?.recovery, {
    classification: "needs_operator_review",
    reason: "Unsafe side effects require review.",
    recommendedAction:
      "Review unsafe events before resuming; do not repeat uncertain side effects.",
    unsafeEventIds: ["ship-1:mutation"],
    unsafeEvents: [
      {
        id: "ship-1:mutation",
        reason: "not explicitly replay-safe; shell side effect",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
        mutationClass: "shell",
        memoryRefreshRequirement: "required_before_mutation",
      },
    ],
  });
});

test("workflow completed ledger event snapshots structured completion", () => {
  const structuredCompletion = {
    outcome: "success",
    confidence: 0.92,
    validation: ["npm test passed"],
    openQuestions: ["Should resume get a CLI command?"],
    learningCandidates: ["Keep workflow state in run ledgers."],
  };
  const workflowState = {
    name: "debug-workflow",
    objective: "Investigate a symptom",
    currentStepIndex: null,
    steps: [
      {
        index: 0,
        id: "inspect",
        action: "collect evidence",
        status: "completed",
      },
    ],
  };

  const event = buildRunLedgerWorkflowCompletedEvent({
    workflowId: "workflow-1",
    at: "2026-06-20T00:12:00.000Z",
    outcome: "success",
    confidence: 0.92,
    structuredCompletion,
    data: {
      workflowState,
      loadedSkills: ["code-review"],
      skillMetadata: [
        {
          name: "code-review",
          source: "packaged",
          path: "skills/code-review/SKILL.md",
        },
      ],
      postflightMissing: false,
      validation: structuredCompletion.validation,
      openQuestions: structuredCompletion.openQuestions,
      learningCandidates: structuredCompletion.learningCandidates,
    },
  });

  assert.equal(event.id, "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z");
  assert.equal(event.type, "workflow_completed");
  assert.equal(event.evidenceClass, "local");
  assert.equal(event.sideEffectClass, "read_only");
  assert.equal(event.replaySafe, true);
  assert.equal(event.data?.outcome, "success");
  assert.equal(event.data?.confidence, 0.92);
  assert.deepEqual(event.data?.structuredCompletion, structuredCompletion);
  assert.deepEqual(event.data?.workflowState, workflowState);
  assert.deepEqual(event.data?.loadedSkills, ["code-review"]);
  assert.deepEqual(event.data?.validation, ["npm test passed"]);
});

test("completeRunLedger backfills structured completion from event data", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-complete-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    const structuredCompletion = {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: ["Should this be reusable?"],
      learningCandidates: ["Keep completion data durable."],
    };

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.92,
      event: buildRunLedgerWorkflowCompletedEvent({
        workflowId: "workflow-1",
        at: "2026-06-20T00:12:00.000Z",
        structuredCompletion,
        outcome: "success",
        confidence: 0.92,
      }),
      patch: {},
    });

    assert.equal(updated.status, "completed");
    assert.deepEqual(updated.structuredCompletion, structuredCompletion);
    assert.equal(updated.resume.classification, "not_interrupted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeRunLedger backfills workflow state from completion event data", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-complete-state-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    const workflowState = {
      name: "debug-workflow",
      objective: "Investigate a symptom",
      currentStepIndex: null,
      steps: [
        {
          index: 0,
          id: "inspect",
          action: "collect evidence",
          status: "completed",
        },
      ],
    };

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.92,
      event: buildRunLedgerWorkflowCompletedEvent({
        workflowId: "workflow-1",
        at: "2026-06-20T00:12:00.000Z",
        structuredCompletion: {
          outcome: "success",
          confidence: 0.92,
          validation: ["npm test passed"],
          openQuestions: [],
          learningCandidates: [],
        },
        outcome: "success",
        confidence: 0.92,
        data: { workflowState },
      }),
      patch: {},
    });

    assert.deepEqual(updated.workflow.state, workflowState);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeRunLedger persists completion policy from event data", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-complete-policy-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "failed",
      confidence: 0.7,
      event: buildRunLedgerWorkflowCompletedEvent({
        workflowId: "workflow-1",
        at: "2026-06-20T00:12:00.000Z",
        outcome: "failed",
        confidence: 0.7,
        structuredCompletion: {
          outcome: "failed",
          confidence: 0.7,
          validation: [],
          openQuestions: ["Need footer fix."],
          learningCandidates: [],
        },
        data: {
          strictViolation: true,
          strictViolationReason: "Missing required footer field(s): Closes.",
          qualityScore: 52,
          mutationCount: 3,
          postflightMissing: true,
          policyWarnings: ["postflight validation missing"],
        },
      }),
      patch: {},
    });

    assert.deepEqual(updated.policy, {
      strictViolation: true,
      strictViolationReason: "Missing required footer field(s): Closes.",
      qualityScore: 52,
      mutationCount: 3,
      postflightMissing: true,
      warnings: ["postflight validation missing"],
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.deepEqual(persisted.policy, updated.policy);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger backfills workflow state from latest event snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-state-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const checkpointState = {
      name: "debug-workflow",
      currentStepIndex: 0,
      steps: [{ index: 0, id: "inspect", action: "inspect", status: "active" }],
    };
    const completionState = {
      name: "debug-workflow",
      currentStepIndex: null,
      steps: [{ index: 0, id: "inspect", action: "inspect", status: "completed" }],
    };
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          buildRunLedgerCheckpointEvent({
            runId: "workflow-1",
            at: "2026-06-20T00:05:00.000Z",
            workflowState: checkpointState,
          }),
          buildRunLedgerWorkflowCompletedEvent({
            workflowId: "workflow-1",
            at: "2026-06-20T00:12:00.000Z",
            outcome: "success",
            confidence: 0.92,
            structuredCompletion: null,
            data: { workflowState: completionState },
          }),
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.workflow.state, completionState);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger backfills workflow state from interrupted event snapshot", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-interrupted-state-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const startedState = {
      name: "debug-workflow",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "inspect", action: "inspect", status: "active" },
        { index: 1, id: "validate", action: "validate", status: "pending" },
      ],
    };
    const interruptedState = {
      name: "debug-workflow",
      currentStepIndex: 1,
      steps: [
        { index: 0, id: "inspect", action: "inspect", status: "completed" },
        { index: 1, id: "validate", action: "validate", status: "active" },
      ],
    };
    await writeRunLedger(runFile, {
      ...buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          buildRunLedgerWorkflowStartedEvent({
            workflowId: "workflow-1",
            workflowType: "debug",
            at: "2026-06-20T00:00:00.000Z",
            workflowState: startedState,
          }),
          buildRunLedgerInterruptedEvent({
            eventId: "workflow-1:interrupted",
            at: "2026-06-20T00:10:00.000Z",
            reason: "operator stopped the run",
            workflowState: interruptedState,
          }),
        ],
      }),
      workflow: {
        type: "debug",
        input: "debug issue",
        flags: {},
      },
    });

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.workflow.state, interruptedState);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes tool event fields from nested metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-tool-metadata-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:tool:legacy",
            at: "2026-06-20T00:05:00.000Z",
            type: "tool_call",
            summary: "legacy event with nested metadata",
            data: {
              metadata: {
                name: "web.search_query",
                evidenceClass: "external",
                mutationClass: "none",
                sideEffectClass: "external",
                replaySafe: false,
                memoryRefreshRequirement: "not_required",
              },
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);
    const event = loaded?.events[0];

    assert.equal(event?.toolName, "web.search_query");
    assert.equal(event?.evidenceClass, "external");
    assert.equal(event?.sideEffectClass, "external");
    assert.equal(event?.replaySafe, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger drops invalid legacy tool metadata enum values", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-invalid-tool-metadata-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:tool:bad-metadata",
            at: "2026-06-20T00:05:00.000Z",
            type: "tool_call",
            summary: "legacy event with invalid metadata",
            evidenceClass: "remote",
            mutationClass: "database",
            sideEffectClass: "network",
            memoryRefreshRequirement: "sometimes",
            replaySafe: true,
            data: {
              metadata: {
                evidenceClass: "remote",
                mutationClass: "database",
                sideEffectClass: "network",
                memoryRefreshRequirement: "sometimes",
              },
            },
          },
        ],
      } as unknown as RunLedgerRecord),
    );

    const loaded = await readRunLedger(runFile);
    const event = loaded?.events[0];

    assert.equal(event?.evidenceClass, undefined);
    assert.equal(event?.mutationClass, undefined);
    assert.equal(event?.sideEffectClass, undefined);
    assert.equal(event?.memoryRefreshRequirement, undefined);
    assert.equal(event?.replaySafe, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes legacy tool event fields from registry metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-tool-registry-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:tool:legacy-web",
            at: "2026-06-20T00:05:00.000Z",
            type: "tool_call",
            summary: "legacy event with only a tool name",
            toolName: "web.search_query",
          },
          {
            id: "workflow-1:tool:legacy-bash",
            at: "2026-06-20T00:06:00.000Z",
            type: "tool_call",
            summary: "legacy shell event with missing command input",
            toolName: "bash",
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);
    const webEvent = loaded?.events[0];
    const bashEvent = loaded?.events[1];

    assert.equal(webEvent?.evidenceClass, "external");
    assert.equal(webEvent?.sideEffectClass, "external");
    assert.equal(webEvent?.replaySafe, false);
    assert.equal(bashEvent?.evidenceClass, "none");
    assert.equal(bashEvent?.sideEffectClass, "shell");
    assert.equal(bashEvent?.replaySafe, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger canonicalizes stale tool metadata from the registry", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-stale-tool-metadata-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      events: [
        {
          id: "workflow-1:tool:stale-web",
          at: "2026-06-20T00:05:00.000Z",
          type: "tool_call",
          summary: "legacy event with stale tool metadata",
          toolName: "web.search_query",
          evidenceClass: "local",
          sideEffectClass: "read_only",
          replaySafe: true,
          data: {
            metadata: {
              name: "web.search_query",
              evidenceClass: "local",
              mutationClass: "none",
              sideEffectClass: "read_only",
              replaySafe: true,
              memoryRefreshRequirement: "not_required",
            },
            input: { query: "current external facts" },
          },
        },
      ],
    });
    record.status = "resumable";
    record.resume = {
      classification: "resumable",
      reason: "stale metadata",
      unsafeEventIds: [],
    };
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);
    const event = loaded?.events[0];
    const metadata = event?.data?.metadata as { replaySafe?: boolean; sideEffectClass?: string } | undefined;

    assert.equal(event?.evidenceClass, "external");
    assert.equal(event?.sideEffectClass, "external");
    assert.equal(event?.replaySafe, false);
    assert.equal(metadata?.sideEffectClass, "external");
    assert.equal(metadata?.replaySafe, false);
    assert.equal(loaded?.resume.classification, "needs_operator_review");
    assert.deepEqual(loaded?.resume.unsafeEventIds, ["workflow-1:tool:stale-web"]);
    assert.deepEqual(loaded?.resume.unsafeEvents, [
      {
        id: "workflow-1:tool:stale-web",
        reason: "not explicitly replay-safe; external side effect",
        toolName: "web.search_query",
        sideEffectClass: "external",
        replaySafe: false,
        mutationClass: "none",
        memoryRefreshRequirement: "not_required",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger promotes typed tool metadata fields from legacy event metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-promote-tool-metadata-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:tool:legacy-write",
            at: "2026-06-20T00:05:00.000Z",
            type: "tool_call",
            summary: "legacy write event with nested metadata only",
            toolName: "write",
            data: {
              metadata: {
                name: "write",
                evidenceClass: "none",
                mutationClass: "filesystem",
                sideEffectClass: "mutation",
                replaySafe: false,
                memoryRefreshRequirement: "required_before_mutation",
                gateSatisfaction: {
                  countsTaskToolCall: true,
                  agesMemory: true,
                  satisfiesMemoryRead: false,
                  persistsMemory: false,
                },
              },
              input: { path: "extensions/runtime/run-ledger.ts" },
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);
    const event = loaded?.events[0];

    assert.equal(event?.evidenceClass, "none");
    assert.equal(event?.mutationClass, "filesystem");
    assert.equal(event?.sideEffectClass, "mutation");
    assert.equal(event?.replaySafe, false);
    assert.equal(event?.memoryRefreshRequirement, "required_before_mutation");
    assert.deepEqual(event?.gateSatisfaction, {
      countsTaskToolCall: true,
      agesMemory: true,
      satisfiesMemoryRead: false,
      persistsMemory: false,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes structured unsafe event review details", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-unsafe-details-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.resume = {
      classification: "needs_operator_review",
      reason: "operator review required",
      unsafeEventIds: ["workflow-1:unsafe", 42] as unknown as string[],
      unsafeEvents: [
        {
          id: " workflow-1:unsafe ",
          reason: " shell side effect ",
          toolName: " bash ",
          sideEffectClass: "shell",
          replaySafe: false,
          mutationClass: "shell",
          memoryRefreshRequirement: "required_before_mutation",
        },
        { id: "", reason: "drop me" },
        { id: "workflow-1:missing-reason" },
        {
          id: "workflow-1:invalid-metadata",
          reason: "bad typed metadata",
          sideEffectClass: "network",
          mutationClass: "database",
          memoryRefreshRequirement: "sometimes",
        },
      ] as unknown as typeof record.resume.unsafeEvents,
    };
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.resume.unsafeEventIds, ["workflow-1:unsafe"]);
    assert.deepEqual(loaded?.resume.unsafeEvents, [
      {
        id: "workflow-1:unsafe",
        reason: "shell side effect",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
        mutationClass: "shell",
        memoryRefreshRequirement: "required_before_mutation",
      },
      {
        id: "workflow-1:missing-reason",
        reason: "uncertain replay safety",
      },
      {
        id: "workflow-1:invalid-metadata",
        reason: "bad typed metadata",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes legacy skill event metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-skill-metadata-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:skill_loaded:Code Review",
            at: "2026-06-20T00:05:00.000Z",
            type: "skill_loaded",
            summary: "legacy skill event",
            data: {
              skill: {
                name: "Code Review",
                source: "learned",
                path: "/home/user/.pi/khala/skills/code-review/SKILL.md",
              },
              attemptedSources: ["packaged", "learned", "unknown", "packaged", 123],
              reason: " Workflow declared Code Review. ",
            },
          },
          {
            id: "workflow-1:skill_missing:bad-source",
            at: "2026-06-20T00:06:00.000Z",
            type: "skill_missing",
            summary: "legacy malformed skill event",
            data: {
              skill: {
                name: "Bad Source",
                source: "not-real",
              },
              attemptedSources: ["unknown", 123],
              reason: " ",
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);
    const skillLoaded = loaded?.events[0];
    const skillMissing = loaded?.events[1];

    assert.deepEqual(skillLoaded?.data?.skill, {
      name: "code-review",
      source: "learned",
      path: "/home/user/.pi/khala/skills/code-review/SKILL.md",
    });
    assert.deepEqual(skillLoaded?.data?.attemptedSources, ["packaged", "learned"]);
    assert.equal(skillLoaded?.data?.reason, "Workflow declared Code Review.");
    assert.deepEqual(skillMissing?.data?.skill, {
      name: "bad-source",
      source: "unknown",
      path: undefined,
    });
    assert.equal(Object.hasOwn(skillMissing?.data ?? {}, "attemptedSources"), false);
    assert.equal(Object.hasOwn(skillMissing?.data ?? {}, "reason"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes completion skill metadata arrays", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-completion-skills-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z",
            at: "2026-06-20T00:12:00.000Z",
            type: "workflow_completed",
            summary: "workflow completed",
            data: {
              loadedSkills: ["Code Review", "code-review", 123, "Python Developer", ""],
              skillMetadata: [
                {
                  name: "Code Review",
                  source: "packaged",
                  path: "skills/code-review/SKILL.md",
                  reason: "preserve extra fields",
                },
                {
                  name: "Python Developer",
                  source: "not-real",
                  path: "/home/user/.codex/skills/python-developer/SKILL.md",
                },
                { source: "user" },
              ],
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);
    const completion = loaded?.events[0];

    assert.deepEqual(completion?.data?.loadedSkills, [
      "code-review",
      "python-developer",
    ]);
    assert.deepEqual(completion?.data?.skillMetadata, [
      {
        name: "code-review",
        source: "packaged",
        path: "skills/code-review/SKILL.md",
        reason: "preserve extra fields",
      },
      {
        name: "python-developer",
        source: "unknown",
        path: "/home/user/.codex/skills/python-developer/SKILL.md",
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes workflow step snapshots on tool events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-tool-step-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "workflow-1:tool:read",
            at: "2026-06-20T00:01:00.000Z",
            type: "tool_call",
            summary: "read file",
            toolName: "read_file",
            replaySafe: true,
            data: {
              input: { path: "README.md" },
              workflowStep: {
                index: 1,
                id: " inspect ",
                action: " read_context ",
                status: " active ",
                totalSteps: 3,
                noisyExtra: "drop me",
              },
            },
          },
          {
            id: "workflow-1:tool:malformed-step",
            at: "2026-06-20T00:02:00.000Z",
            type: "tool_call",
            summary: "legacy malformed step",
            toolName: "read_file",
            replaySafe: true,
            data: {
              input: { path: "package.json" },
              workflowStep: {
                id: "",
                action: " ",
                nested: { not: "useful" },
              },
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.events[0].data?.workflowStep, {
      index: 1,
      id: "inspect",
      action: "read_context",
      status: "active",
      totalSteps: 3,
    });
    assert.equal(Object.hasOwn(loaded?.events[1].data ?? {}, "workflowStep"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger backfills structured completion from latest completion event", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-completion-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const olderCompletion = {
      outcome: "partial",
      confidence: 0.5,
      validation: [],
      openQuestions: ["Need final validation."],
      learningCandidates: [],
    };
    const latestCompletion = {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: [],
      learningCandidates: ["Keep completion events replayable."],
    };
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          buildRunLedgerWorkflowCompletedEvent({
            workflowId: "workflow-1",
            at: "2026-06-20T00:08:00.000Z",
            outcome: "partial",
            confidence: 0.5,
            structuredCompletion: olderCompletion,
          }),
          buildRunLedgerWorkflowCompletedEvent({
            workflowId: "workflow-1",
            at: "2026-06-20T00:12:00.000Z",
            outcome: "success",
            confidence: 0.92,
            structuredCompletion: latestCompletion,
          }),
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.structuredCompletion, latestCompletion);
    assert.equal(loaded?.outcome, "success");
    assert.equal(loaded?.confidence, 0.92);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes legacy structured completion fields", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-completion-normalize-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.structuredCompletion = {
      outcome: " success ",
      confidence: "92%",
      validation: [" npm test passed ", "", 42],
      openQuestions: "1. Need owner approval",
      learningCandidates: [
        "Keep checkpoint notes",
        "Keep checkpoint notes",
      ],
    };
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.structuredCompletion, {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: ["Need owner approval"],
      learningCandidates: ["Keep checkpoint notes"],
    });
    assert.equal(loaded?.outcome, "success");
    assert.equal(loaded?.confidence, 0.92);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger backfills completion policy from latest completion event", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-policy-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          buildRunLedgerWorkflowCompletedEvent({
            workflowId: "workflow-1",
            at: "2026-06-20T00:12:00.000Z",
            outcome: "failed",
            confidence: 0.7,
            structuredCompletion: {
              outcome: "failed",
              confidence: 0.7,
              validation: [],
              openQuestions: ["Need footer fix."],
              learningCandidates: [],
            },
            data: {
              strictViolation: true,
              strictViolationReason: "Missing required footer field(s): Closes.",
              qualityScore: 52,
              mutationCount: 3,
              postflightMissing: true,
              policyWarnings: ["postflight validation missing"],
            },
          }),
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.policy, {
      strictViolation: true,
      strictViolationReason: "Missing required footer field(s): Closes.",
      qualityScore: 52,
      mutationCount: 3,
      postflightMissing: true,
      warnings: ["postflight validation missing"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger classifies missing resume metadata from interrupted events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-resume-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      events: [
        buildRunLedgerCheckpointEvent({
          runId: "workflow-1",
          at: "2026-06-20T00:05:00.000Z",
        }),
        buildRunLedgerToolCallEvent({
          workflowId: "workflow-1",
          workflowMutationCount: 1,
          workflowToolCallCount: 1,
          toolName: "functions.exec_command",
          at: "2026-06-20T00:06:00.000Z",
          mutation: true,
          metadata: getToolMetadata({
            toolName: "functions.exec_command",
            input: { cmd: "touch changed.txt" },
          }),
          input: { cmd: "touch changed.txt" },
        }),
      ],
    });
    record.status = "resumable";
    delete (record as { resume?: unknown }).resume;
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.equal(loaded?.status, "needs_operator_review");
    assert.equal(loaded?.resume.classification, "needs_operator_review");
    assert.deepEqual(loaded?.resume.unsafeEventIds, [
      "workflow-1:tool:2026-06-20T00:06:00.000Z:functions.exec_command:1",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger classifies malformed resume metadata from interrupted events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-bad-resume-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      events: [
        buildRunLedgerCheckpointEvent({
          runId: "workflow-1",
          at: "2026-06-20T00:05:00.000Z",
        }),
        buildRunLedgerToolCallEvent({
          workflowId: "workflow-1",
          workflowMutationCount: 1,
          workflowToolCallCount: 1,
          toolName: "functions.exec_command",
          at: "2026-06-20T00:06:00.000Z",
          mutation: true,
          metadata: getToolMetadata({
            toolName: "functions.exec_command",
            input: { cmd: "touch changed.txt" },
          }),
          input: { cmd: "touch changed.txt" },
        }),
      ],
    });
    record.status = "resumable";
    record.resume = {
      classification: "resumable",
      reason: "stale metadata",
    } as unknown as typeof record.resume;
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.equal(loaded?.status, "needs_operator_review");
    assert.equal(loaded?.resume.classification, "needs_operator_review");
    assert.deepEqual(loaded?.resume.unsafeEventIds, [
      "workflow-1:tool:2026-06-20T00:06:00.000Z:functions.exec_command:1",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger sanitizes malformed unsafe event ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-unsafe-ids-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "needs_operator_review";
    record.resume = {
      classification: "needs_operator_review",
      reason: "Unsafe side effects were recorded after the latest checkpoint.",
      unsafeEventIds: ["workflow-1:unsafe", 123, null],
    } as unknown as typeof record.resume;
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.equal(loaded?.status, "needs_operator_review");
    assert.deepEqual(loaded?.resume.unsafeEventIds, ["workflow-1:unsafe"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger preserves missing resume review status conservatively", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-read-review-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      events: [
        buildRunLedgerCheckpointEvent({
          runId: "workflow-1",
          at: "2026-06-20T00:05:00.000Z",
        }),
      ],
    });
    record.status = "needs_operator_review";
    delete (record as { resume?: unknown }).resume;
    await writeRunLedger(runFile, record);

    const loaded = await readRunLedger(runFile);

    assert.equal(loaded?.status, "needs_operator_review");
    assert.equal(loaded?.resume.classification, "needs_operator_review");
    assert.equal(
      loaded?.resume.reason,
      "Run was previously marked as needing operator review.",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeRunLedger preserves existing structured completion when no replacement is provided", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-complete-preserve-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const structuredCompletion = {
      outcome: "success",
      confidence: 0.91,
      validation: ["npm test passed"],
      openQuestions: [],
      learningCandidates: ["Keep completion data durable."],
    };
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.structuredCompletion = structuredCompletion;
    await writeRunLedger(runFile, record);

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.92,
      event: {
        id: "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z",
        at: "2026-06-20T00:12:00.000Z",
        type: "workflow_completed",
        summary: "workflow completed",
        replaySafe: true,
      },
      patch: {},
    });

    assert.deepEqual(updated.structuredCompletion, structuredCompletion);
    assert.equal(updated.status, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeRunLedger backfills structured completion when caller passes null", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-complete-null-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    const structuredCompletion = {
      outcome: "success",
      confidence: 0.91,
      validation: ["focused suite passed"],
      openQuestions: [],
      learningCandidates: ["Keep event completion recoverable."],
    };
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "debug issue",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push({
      id: "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z",
      at: "2026-06-20T00:12:00.000Z",
      type: "workflow_completed",
      summary: "workflow completed",
      replaySafe: true,
      data: {
        structuredCompletion,
      },
    });
    await writeRunLedger(runFile, record);

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.91,
      event: {
        id: "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z:final",
        at: "2026-06-20T00:12:00.000Z",
        type: "workflow_completed",
        summary: "workflow completed",
        replaySafe: true,
        data: {
          structuredCompletion: null,
        },
      },
      patch: {},
    });

    assert.deepEqual(updated.structuredCompletion, structuredCompletion);
    assert.equal(updated.status, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workflow started ledger event is replay-safe workflow metadata", () => {
  const workflowState = {
    name: "debug-workflow",
    objective: "Investigate a symptom",
    currentStepIndex: 0,
    steps: [{ index: 0, id: "intake", action: "restate_problem", status: "active" }],
  };
  const event = buildRunLedgerWorkflowStartedEvent({
    workflowId: "workflow-1",
    workflowType: "debug",
    at: "2026-06-20T00:00:00.000Z",
    workflowState,
  });

  assert.deepEqual(event, {
    id: "workflow-1:workflow_started",
    at: "2026-06-20T00:00:00.000Z",
    type: "workflow_started",
    summary: "Workflow debug started.",
    evidenceClass: "local",
    sideEffectClass: "read_only",
    replaySafe: true,
    data: {
      workflowState,
    },
  });
});

test("readRunLedger backfills workflow state from workflow_started event", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-start-state-"));
  try {
    const runFile = path.join(tempDir, "start-state.json");
    const workflowState = {
      name: "debug-workflow",
      objective: "Investigate a symptom",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "intake", action: "restate_problem", status: "active" },
      ],
    };
    await writeRunLedger(runFile, {
      ...buildRunLedgerRecord({
        version: 7,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          buildRunLedgerWorkflowStartedEvent({
            workflowId: "debug-1",
            workflowType: "debug",
            at: "2026-06-20T00:00:00.000Z",
            workflowState,
          }),
        ],
      }),
      workflow: {
        type: "debug",
        input: "investigate failing test",
        flags: {},
      },
    });

    const record = await readRunLedger(runFile);
    assert.deepEqual(record?.workflow.state, workflowState);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readRunLedger normalizes workflow state snapshots from records and events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-state-normalize-"));
  try {
    const runFile = path.join(tempDir, "state-normalize.json");
    await writeFile(
      runFile,
      JSON.stringify({
        version: 1,
        id: "state-normalize",
        type: "debug",
        input: "debug issue",
        flags: {},
        status: "started",
        startedAt: "2026-06-20T00:00:00.000Z",
        workflow: {
          type: "debug",
          input: "debug issue",
          flags: {},
          state: {
            name: " Debug Workflow ",
            objective: " Inspect state snapshots ",
            currentStep: "validate",
            currentStepIndex: 99,
            steps: [
              { id: " inspect ", action: " collect evidence ", status: "active" },
              { id: "validate", action: " run tests ", status: "unknown" },
              "write summary",
              { id: " done ", action: " finish ", status: "completed" },
            ],
          },
        },
        events: [
          {
            id: "state-normalize:checkpoint:2026-06-20T00:05:00.000Z",
            at: "2026-06-20T00:05:00.000Z",
            type: "checkpoint",
            summary: "Checkpoint recorded.",
            replaySafe: true,
            data: {
              workflowState: {
                objective: " Checkpoint state ",
                currentStepIndex: 0,
                steps: [
                  { id: " checkpoint ", action: " verify ", status: "pending" },
                  { id: " next ", action: " continue ", status: "active" },
                ],
              },
            },
          },
        ],
      }),
    );

    const loaded = await readRunLedger(runFile);

    assert.deepEqual(loaded?.workflow.state, {
      name: "Debug Workflow",
      objective: "Inspect state snapshots",
      currentStepIndex: 1,
      steps: [
        { index: 0, id: "inspect", action: "collect evidence", status: "pending" },
        { index: 1, id: "validate", action: "run tests", status: "active" },
        { index: 2, id: "step-3", action: "write summary", status: "pending" },
        { index: 3, id: "done", action: "finish", status: "completed" },
      ],
    });
    assert.deepEqual(loaded?.events[0]?.data?.workflowState, {
      objective: "Checkpoint state",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "checkpoint", action: "verify", status: "active" },
        { index: 1, id: "next", action: "continue", status: "pending" },
      ],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interrupted ledger event is replay-safe operator metadata", () => {
  const workflowState = {
    currentStepIndex: 0,
    steps: [{ index: 0, id: "inspect", status: "active" }],
  };
  const event = buildRunLedgerInterruptedEvent({
    eventId: "workflow-1:interrupted",
    at: "2026-06-20T00:30:00.000Z",
    reason: "operator stopped the run",
    workflowState,
  });

  assert.deepEqual(event, {
    id: "workflow-1:interrupted",
    at: "2026-06-20T00:30:00.000Z",
    type: "interrupted",
    summary: "operator stopped the run",
    evidenceClass: "local",
    sideEffectClass: "read_only",
    replaySafe: true,
    data: {
      workflowState,
    },
  });
});

test("checkpoint ledger event records replay-safe recovery marker", () => {
  const event = buildRunLedgerCheckpointEvent({
    runId: "workflow-1",
    at: "2026-06-20T00:20:00.000Z",
    reason: "validated current state",
    workflowState: {
      objective: "Fix failing test",
      currentStepIndex: 1,
      steps: [
        { id: "inspect", status: "completed" },
        { id: "validate", status: "active" },
      ],
    },
  });

  assert.deepEqual(event, {
    id: "workflow-1:checkpoint:2026-06-20T00:20:00.000Z",
    at: "2026-06-20T00:20:00.000Z",
    type: "checkpoint",
    summary: "Checkpoint recorded: validated current state",
    evidenceClass: "local",
    sideEffectClass: "read_only",
    replaySafe: true,
    data: {
      reason: "validated current state",
      workflowState: {
        objective: "Fix failing test",
        currentStepIndex: 1,
        steps: [
          { id: "inspect", status: "completed" },
          { id: "validate", status: "active" },
        ],
      },
    },
  });
});

test("interrupted run with mutation after checkpoint needs operator review", () => {
  const classification = classifyInterruptedRun([
    {
      id: "run-1:checkpoint",
      at: "2026-06-20T00:01:00.000Z",
      type: "checkpoint",
      summary: "safe point",
      replaySafe: true,
    },
    {
      id: "run-1:mutation",
      at: "2026-06-20T00:02:00.000Z",
      type: "mutation",
      summary: "edited file",
      toolName: "apply_patch",
      sideEffectClass: "mutation",
      replaySafe: false,
    },
  ]);

  assert.equal(classification.classification, "needs_operator_review");
  assert.equal(
    classification.reason,
    "Run has uncertain mutation, shell, forge, external, or tool side effects after the latest checkpoint.",
  );
  assert.deepEqual(classification.unsafeEventIds, ["run-1:mutation"]);
});

test("interrupted run treats metadata-less mutation events as unsafe", () => {
  const classification = classifyInterruptedRun([
    {
      id: "run-1:mutation:legacy",
      at: "2026-06-20T00:02:00.000Z",
      type: "mutation",
      summary: "legacy mutation with missing metadata",
    },
  ]);

  assert.equal(classification.classification, "needs_operator_review");
  assert.deepEqual(classification.unsafeEventIds, ["run-1:mutation:legacy"]);
  assert.equal(
    classification.unsafeEvents?.[0]?.reason,
    "not explicitly replay-safe",
  );
});

test("markRunInterrupted persists conservative resume classification", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-ledger-"));
  try {
    const runFile = path.join(tempDir, "runs", "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "fix failure",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "debug-1:shell",
        at: "2026-06-20T00:01:00.000Z",
        type: "tool_call",
        summary: "ran shell",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
      },
    });

    const record = await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:02:00.000Z",
      eventId: "debug-1:interrupted",
      reason: "agent stopped",
    });

    assert.equal(record.status, "needs_operator_review");
    assert.equal(record.resume.classification, "needs_operator_review");
    assert.deepEqual(record.resume.unsafeEventIds, ["debug-1:shell"]);

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.status, "needs_operator_review");
    assert.equal(persisted.events.at(-1).type, "interrupted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEvent refreshes interrupted run classification after checkpoint", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-refresh-"));
  try {
    const runFile = path.join(tempDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        workflowState: {
          objective: "Debug issue",
          currentStepIndex: 0,
          steps: [
            { index: 0, id: "inspect", action: "read_logs", status: "active" },
            { index: 1, id: "validate", action: "run_tests", status: "pending" },
          ],
        },
      }),
    );
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "debug-1:shell",
        at: "2026-06-20T00:01:00.000Z",
        type: "tool_call",
        summary: "shell command",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
      },
    });
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:02:00.000Z",
      eventId: "debug-1:interrupted",
      reason: "stopped after shell",
    });

    await appendRunLedgerEvent({
      runFile,
      event: buildRunLedgerCheckpointEvent({
        runId: "debug-1",
        at: "2026-06-20T00:03:00.000Z",
        reason: "operator verified checkpoint",
        workflowState: {
          objective: "Debug issue",
          currentStepIndex: 1,
          steps: [
            { index: 0, id: "inspect", action: "read_logs", status: "completed" },
            { index: 1, id: "validate", action: "run_tests", status: "active" },
          ],
        },
      }),
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.status, "resumable");
    assert.equal(persisted.resume.classification, "resumable");
    assert.deepEqual(persisted.resume.unsafeEventIds, []);
    assert.equal(persisted.workflow.state.currentStepIndex, 1);
    assert.deepEqual(
      persisted.workflow.state.steps.map((step: { status: string }) => step.status),
      ["completed", "active"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEvent persists canonical registry metadata for raw tool events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-normalize-tool-"));
  try {
    const runFile = path.join(tempDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "inspect status",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const updated = await appendRunLedgerEvent({
      runFile,
      event: {
        id: "debug-1:tool:legacy",
        at: "2026-06-20T00:01:00.000Z",
        type: "tool_call",
        summary: "legacy command event",
        toolName: "functions.exec_command",
        evidenceClass: "none",
        sideEffectClass: "shell",
        replaySafe: false,
        data: {
          input: { cmd: "git status --short" },
          metadata: {
            name: "functions.exec_command",
            evidenceClass: "none",
            mutationClass: "shell",
            sideEffectClass: "shell",
            replaySafe: false,
            memoryRefreshRequirement: "required_before_mutation",
            gateSatisfaction: {
              countsTaskToolCall: true,
              agesMemory: true,
              satisfiesMemoryRead: false,
              persistsMemory: false,
            },
          },
        },
      },
    });

    const event = updated.events.at(-1);
    assert.equal(event?.toolName, "functions.exec_command");
    assert.equal(event?.evidenceClass, "local");
    assert.equal(event?.sideEffectClass, "read_only");
    assert.equal(event?.replaySafe, true);
    assert.equal(
      (event?.data?.metadata as { sideEffectClass?: string } | undefined)?.sideEffectClass,
      "read_only",
    );

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.at(-1).sideEffectClass, "read_only");
    assert.equal(persisted.events.at(-1).replaySafe, true);
    assert.equal(persisted.events.at(-1).data.metadata.evidenceClass, "local");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completeRunLedger normalizes structured completion before persistence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-normalize-complete-"));
  try {
    const runFile = path.join(tempDir, "workflow-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "workflow-1",
        type: "ship",
        input: "ship feature",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const updated = await completeRunLedger({
      runFile,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.92,
      event: buildRunLedgerWorkflowCompletedEvent({
        workflowId: "workflow-1",
        at: "2026-06-20T00:12:00.000Z",
        outcome: "success",
        confidence: 0.92,
        structuredCompletion: {
          outcome: " success ",
          confidence: "92%",
          validation: "- npm test passed\n- npm test passed\n2. smoke passed",
          openQuestions: ["  Should this become a skill?  ", ""],
          learningCandidates: [" Keep ledger writes canonical. ", "Keep ledger writes canonical."],
        },
      }),
      patch: {},
    });

    assert.deepEqual(updated.structuredCompletion, {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed", "smoke passed"],
      openQuestions: ["Should this become a skill?"],
      learningCandidates: ["Keep ledger writes canonical."],
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.deepEqual(persisted.structuredCompletion, updated.structuredCompletion);
    assert.deepEqual(
      persisted.events.at(-1).data.structuredCompletion,
      updated.structuredCompletion,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEvent preserves workflow state for checkpoints without snapshots", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-checkpoint-no-state-"));
  try {
    const runFile = path.join(tempDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        workflowState: {
          objective: "Debug issue",
          currentStepIndex: 0,
          steps: [
            { index: 0, id: "inspect", action: "read_logs", status: "active" },
          ],
        },
      }),
    );

    await appendRunLedgerEvent({
      runFile,
      event: buildRunLedgerCheckpointEvent({
        runId: "debug-1",
        at: "2026-06-20T00:03:00.000Z",
        reason: "operator verified checkpoint",
      }),
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.workflow.state.currentStepIndex, 0);
    assert.deepEqual(
      persisted.workflow.state.steps.map((step: { status: string }) => step.status),
      ["active"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEvent preserves completed recovery metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-completed-append-"));
  try {
    const runFile = path.join(tempDir, "complete-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "complete-1",
      type: "ship",
      input: "ship branch",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.resume = {
      classification: "not_interrupted",
      reason: "Run already completed.",
      unsafeEventIds: [],
    };
    await writeRunLedger(runFile, record);

    const updated = await appendRunLedgerEvent({
      runFile,
      event: {
        id: "complete-1:skill_loaded:code-review:2026-06-20T00:11:00.000Z",
        at: "2026-06-20T00:11:00.000Z",
        type: "skill_loaded",
        summary: "skill_loaded: code-review.",
        replaySafe: true,
      },
    });

    assert.equal(updated.status, "completed");
    assert.equal(updated.resume.classification, "not_interrupted");
    assert.equal(updated.resume.reason, "Run already completed.");
    assert.equal(updated.events.at(-1)?.type, "skill_loaded");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run ledger persists skill_used_without_load events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-ledger-skill-"));
  try {
    const runFile = path.join(tempDir, "runs", "review-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "review-1",
        type: "review",
        input: "review current diff",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "review-1:skill_used_without_load:code-review",
        at: "2026-06-20T00:01:00.000Z",
        type: "skill_used_without_load",
        summary: "skill_used_without_load: code-review.",
        replaySafe: true,
        data: {
          skill: { name: "code-review", source: "unknown" },
          reason: "assistant claimed skill use without loading it",
        },
      },
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.at(-1).type, "skill_used_without_load");
    assert.equal(persisted.events.at(-1).data.skill.name, "code-review");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interrupted run with non-mutation side effects after checkpoint needs operator review", () => {
  for (const sideEffectClass of ["shell", "external", "tool_side_effect", "unknown"] as const) {
    const result = classifyInterruptedRun([
      {
        id: `${sideEffectClass}:start`,
        at: "2026-06-20T00:00:00.000Z",
        type: "workflow_started",
        summary: "Workflow started.",
      },
      {
        id: `${sideEffectClass}:checkpoint`,
        at: "2026-06-20T00:01:00.000Z",
        type: "checkpoint",
        summary: "Checkpoint recorded.",
      },
      {
        id: `${sideEffectClass}:effect`,
        at: "2026-06-20T00:02:00.000Z",
        type: "tool_call",
        summary: "Side effect recorded.",
        sideEffectClass,
        replaySafe: true,
      },
    ]);

    assert.equal(result.classification, "needs_operator_review");
    assert.deepEqual(result.unsafeEventIds, [`${sideEffectClass}:effect`]);
  }
});
