import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  buildRunLedgerWorkflowCompletedEvent,
  buildRunLedgerWorkflowStartedEvent,
  classifyInterruptedRun,
  completeRunLedger,
  getGlobalRunLedgerDir,
  markRunInterrupted,
  writeRunLedger,
} from "../../extensions/runtime/run-ledger.ts";
import { getToolMetadata } from "../../extensions/runtime/tool-registry.ts";
import { buildSkillRegistryEvent } from "../../extensions/runtime/skill-registry.ts";

test("global run ledger directory is under the global khala store", () => {
  assert.match(getGlobalRunLedgerDir(), /\/\.pi\/khala\/runs$/);
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
  assert.deepEqual(classification.unsafeEventIds, ["run-1:bash"]);
});

test("tool call ledger event snapshots typed registry metadata", () => {
  const metadata = getToolMetadata({ toolName: "web.search_query" });

  const event = buildRunLedgerToolCallEvent({
    workflowId: "workflow-1",
    workflowMutationCount: 2,
    toolName: "web.search_query",
    at: "2026-06-20T00:03:00.000Z",
    mutation: false,
    metadata,
    input: { q: "khala run ledger" },
  });

  assert.equal(event.id, "workflow-1:tool:2026-06-20T00:03:00.000Z:web.search_query:2");
  assert.equal(event.type, "tool_call");
  assert.equal(event.sideEffectClass, "external");
  assert.equal(event.replaySafe, false);
  assert.deepEqual(event.data?.metadata, metadata);
  assert.deepEqual(event.data?.input, { q: "khala run ledger" });

  const mutationEvent = buildRunLedgerToolCallEvent({
    workflowId: "workflow-1",
    workflowMutationCount: 3,
    toolName: "write",
    at: "2026-06-20T00:04:00.000Z",
    mutation: true,
    metadata: getToolMetadata({ toolName: "write" }),
  });

  assert.equal(mutationEvent.type, "mutation");
  assert.equal(mutationEvent.replaySafe, false);
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
    data: {
      recovery: {
        classification: "resumable",
        reason: "Interrupted without unsafe side effects.",
        recommendedAction:
          "Resume from the latest safe checkpoint and skip already recorded side effects.",
        unsafeEventIds: [],
      },
    },
    replaySafe: true,
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

  const event = buildRunLedgerWorkflowCompletedEvent({
    workflowId: "workflow-1",
    at: "2026-06-20T00:12:00.000Z",
    outcome: "success",
    confidence: 0.92,
    structuredCompletion,
    data: {
      postflightMissing: false,
      validation: structuredCompletion.validation,
      openQuestions: structuredCompletion.openQuestions,
      learningCandidates: structuredCompletion.learningCandidates,
    },
  });

  assert.equal(event.id, "workflow-1:workflow_completed:2026-06-20T00:12:00.000Z");
  assert.equal(event.type, "workflow_completed");
  assert.equal(event.replaySafe, true);
  assert.equal(event.data?.outcome, "success");
  assert.equal(event.data?.confidence, 0.92);
  assert.deepEqual(event.data?.structuredCompletion, structuredCompletion);
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
  const event = buildRunLedgerWorkflowStartedEvent({
    workflowId: "workflow-1",
    workflowType: "debug",
    at: "2026-06-20T00:00:00.000Z",
  });

  assert.deepEqual(event, {
    id: "workflow-1:workflow_started",
    at: "2026-06-20T00:00:00.000Z",
    type: "workflow_started",
    summary: "Workflow debug started.",
    replaySafe: true,
  });
});

test("interrupted ledger event is replay-safe operator metadata", () => {
  const event = buildRunLedgerInterruptedEvent({
    eventId: "workflow-1:interrupted",
    at: "2026-06-20T00:30:00.000Z",
    reason: "operator stopped the run",
  });

  assert.deepEqual(event, {
    id: "workflow-1:interrupted",
    at: "2026-06-20T00:30:00.000Z",
    type: "interrupted",
    summary: "operator stopped the run",
    replaySafe: true,
  });
});

test("checkpoint ledger event records replay-safe recovery marker", () => {
  const event = buildRunLedgerCheckpointEvent({
    runId: "workflow-1",
    at: "2026-06-20T00:20:00.000Z",
    reason: "validated current state",
  });

  assert.deepEqual(event, {
    id: "workflow-1:checkpoint:2026-06-20T00:20:00.000Z",
    at: "2026-06-20T00:20:00.000Z",
    type: "checkpoint",
    summary: "Checkpoint recorded: validated current state",
    replaySafe: true,
    data: {
      reason: "validated current state",
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
  assert.deepEqual(classification.unsafeEventIds, ["run-1:mutation"]);
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
      }),
    });

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.status, "resumable");
    assert.equal(persisted.resume.classification, "resumable");
    assert.deepEqual(persisted.resume.unsafeEventIds, []);
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
