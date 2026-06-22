import { strict as assert } from "node:assert";
import test from "node:test";

import {
  buildRunLedgerRecord,
  type RunLedgerRecord,
  summarizeRunRecovery,
} from "../../extensions/runtime/run-ledger.ts";

function recordWith(
  overrides: Partial<RunLedgerRecord>,
): RunLedgerRecord {
  const base: RunLedgerRecord = {
    version: 1,
    id: "workflow-1",
    type: "debug",
    input: "debug the failure",
    flags: {
      hasMutation: true,
      hasExternalSideEffect: true,
      hasUnsafeReplay: true,
    },
    cwd: "/repo",
    repo: "pesap/agents",
    status: "interrupted",
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:02:00.000Z",
    workflow: {
      type: "debug",
      input: "debug the failure",
      flags: {
        hasMutation: true,
        hasExternalSideEffect: true,
        hasUnsafeReplay: true,
      },
    },
    resume: {
      classification: "needs_operator_review",
      reason: "Unsafe side effects were recorded after the latest checkpoint.",
      unsafeEventIds: [
        "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
      ],
    },
    events: [],
  };
  return { ...base, ...overrides };
}

test("summarizeRunRecovery gives conservative operator guidance for interrupted unsafe runs", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      events: [
        {
          id: "workflow-1:checkpoint:2026-06-21T00:01:00.000Z",
          type: "checkpoint",
          at: "2026-06-21T00:01:00.000Z",
          summary: "Checkpoint recorded.",
          data: {
            reason: "before shell mutation",
          },
          sideEffectClass: "read_only",
          replaySafe: true,
        },
        {
          id: "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
          type: "tool_call",
          at: "2026-06-21T00:02:00.000Z",
          summary: "Tool functions.exec_command recorded.",
          data: {},
          sideEffectClass: "shell",
          replaySafe: false,
        },
      ],
    }),
  );

  assert.equal(summary.classification, "needs_operator_review");
  assert.match(summary.recommendedAction, /Review unsafe events/);
  assert.equal(summary.latestCheckpoint?.reason, "before shell mutation");
  assert.deepEqual(summary.unsafeEventIds, [
    "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
  ]);
  assert.deepEqual(summary.unsafeEvents, [
    {
      id: "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
      reason: "not explicitly replay-safe; shell side effect",
      sideEffectClass: "shell",
      replaySafe: false,
    },
  ]);
});

test("summarizeRunRecovery reports latest resume attempt for active runs", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      status: "started",
      flags: {
        hasMutation: false,
        hasExternalSideEffect: false,
        hasUnsafeReplay: false,
      },
      resume: {
        classification: "not_interrupted",
        reason: "Run is still active.",
        unsafeEventIds: [],
      },
      events: [
        {
          id: "workflow-2:resume_attempted:2026-06-21T00:03:00.000Z",
          type: "resume_attempted",
          at: "2026-06-21T00:03:00.000Z",
          summary: "Resume attempted.",
          data: {
            recovery: {
              classification: "resumable",
              reason: "operator resumed after review",
              recommendedAction: "Resume from the latest safe checkpoint.",
              unsafeEventIds: [],
            },
          },
          sideEffectClass: "read_only",
          replaySafe: true,
        },
      ],
    }),
  );

  assert.equal(summary.latestResumeAttempt?.reason, "operator resumed after review");
  assert.match(summary.recommendedAction, /Continue the active run/);
});

test("summarizeRunRecovery derives legacy checkpoint reason from summary", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      events: [
        {
          id: "workflow-1:checkpoint:2026-06-21T00:01:00.000Z",
          type: "checkpoint",
          at: "2026-06-21T00:01:00.000Z",
          summary: "Checkpoint recorded: operator verified safe local state",
          replaySafe: true,
        },
      ],
    }),
  );

  assert.equal(
    summary.latestCheckpoint?.reason,
    "operator verified safe local state",
  );
});

test("summarizeRunRecovery does not claim a checkpoint exists for resumable runs without one", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      resume: {
        classification: "resumable",
        reason: "Only replay-safe events were recorded.",
        unsafeEventIds: [],
      },
      events: [
        {
          id: "workflow-1:workflow_started:2026-06-21T00:00:00.000Z",
          type: "workflow_started",
          at: "2026-06-21T00:00:00.000Z",
          summary: "Workflow started.",
          sideEffectClass: "read_only",
          replaySafe: true,
        },
      ],
    }),
  );

  assert.equal(summary.classification, "resumable");
  assert.match(summary.recommendedAction, /recorded workflow state/);
  assert.doesNotMatch(summary.recommendedAction, /latest safe checkpoint/);
  assert.equal(summary.latestCheckpoint, undefined);
});

test("summarizeRunRecovery treats default started runs as active work", () => {
  const summary = summarizeRunRecovery(
    buildRunLedgerRecord({
      version: 1,
      id: "workflow-active",
      type: "debug",
      input: "debug the failure",
      flags: {},
      startedAt: "2026-06-21T00:00:00.000Z",
    }),
  );

  assert.equal(summary.classification, "resumable");
  assert.match(summary.recommendedAction, /Continue the active run/);
});

test("summarizeRunRecovery recomputes malformed resume metadata from events", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      status: "resumable",
      resume: {
        classification: "resumable",
        reason: "stale metadata",
      } as unknown as RunLedgerRecord["resume"],
      events: [
        {
          id: "workflow-1:checkpoint:2026-06-21T00:01:00.000Z",
          type: "checkpoint",
          at: "2026-06-21T00:01:00.000Z",
          summary: "Checkpoint recorded.",
          replaySafe: true,
        },
        {
          id: "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
          type: "tool_call",
          at: "2026-06-21T00:02:00.000Z",
          summary: "Tool functions.exec_command recorded.",
          sideEffectClass: "shell",
          replaySafe: false,
        },
      ],
    }),
  );

  assert.equal(summary.classification, "needs_operator_review");
  assert.match(summary.reason, /uncertain mutation, shell, forge, external, or tool side effects/);
  assert.match(summary.recommendedAction, /Review unsafe events/);
  assert.deepEqual(summary.unsafeEventIds, [
    "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
  ]);
  assert.deepEqual(summary.unsafeEvents, [
    {
      id: "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
      reason: "not explicitly replay-safe; shell side effect",
      sideEffectClass: "shell",
      replaySafe: false,
    },
  ]);
});

test("summarizeRunRecovery filters malformed unsafe event ids", () => {
  const summary = summarizeRunRecovery(
    recordWith({
      resume: {
        classification: "needs_operator_review",
        reason: "Unsafe side effects were recorded after the latest checkpoint.",
        unsafeEventIds: [
          "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
          123,
          null,
        ],
      } as unknown as RunLedgerRecord["resume"],
    }),
  );

  assert.deepEqual(summary.unsafeEventIds, [
    "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
  ]);
  assert.deepEqual(summary.unsafeEvents, [
    {
      id: "workflow-1:tool:2026-06-21T00:02:00.000Z:functions.exec_command:1",
      reason: "unsafe event requires operator review",
    },
  ]);
});
