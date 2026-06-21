import { strict as assert } from "node:assert";
import test from "node:test";

import {
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
            reason: "operator resumed after review",
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
