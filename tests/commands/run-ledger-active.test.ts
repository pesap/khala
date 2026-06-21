import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLedgerCommandHandlers } from "../../extensions/commands/run-ledger.ts";

test("run-list active shows unfinished local runs", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-active-"));
  try {
    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: {} as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => {
        messages.push(message);
      },
    });

    await writeFile(
      path.join(runLedgerDir, "active-1.json"),
      JSON.stringify(
        {
          id: "active-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: { id: "workon", type: "workon", state: { currentStep: "implement" } },
          input: "continue local-first harness work",
          events: [],
          resume: {
            classification: "resumable",
            reason: "No unsafe events recorded.",
            unsafeEventIds: [],
            recommendedAction: "Resume from the latest checkpoint.",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(runLedgerDir, "completed-1.json"),
      JSON.stringify(
        {
          id: "completed-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          finishedAt: "2026-06-20T00:05:00.000Z",
          workflow: { id: "workon", type: "workon", state: { currentStep: "done" } },
          input: "finished local-first harness work",
          events: [],
          resume: {
            classification: "resumable",
            reason: "Run completed.",
            unsafeEventIds: [],
            recommendedAction: "No resume needed.",
          },
        },
        null,
        2,
      ),
    );

    await handlers.runList("active", {} as never);

    assert.match(messages[0] ?? "", /matching "active"/);
    assert.match(messages[0] ?? "", /active-1/);
    assert.match(messages[0] ?? "", /next_action=/);
    assert.doesNotMatch(messages[0] ?? "", /completed-1/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});

test("run-list needs_operator_review shows review-gated runs", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-review-"));
  try {
    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: {} as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => {
        messages.push(message);
      },
    });

    await writeFile(
      path.join(runLedgerDir, "review-1.json"),
      JSON.stringify(
        {
          id: "review-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "needs_operator_review",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: { id: "workon", type: "workon", state: { currentStep: "review" } },
          input: "resume after uncertain mutation",
          events: [],
          resume: {
            classification: "needs_operator_review",
            reason: "Run contains an unsafe mutation event.",
            unsafeEventIds: ["review-1:mutation:2026-06-20T00:01:00.000Z"],
            recommendedAction: "Review the mutation before resuming.",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(runLedgerDir, "resumable-1.json"),
      JSON.stringify(
        {
          id: "resumable-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: { id: "workon", type: "workon", state: { currentStep: "implement" } },
          input: "safe resume candidate",
          events: [],
          resume: {
            classification: "resumable",
            reason: "No unsafe events recorded.",
            unsafeEventIds: [],
            recommendedAction: "Resume from the latest checkpoint.",
          },
        },
        null,
        2,
      ),
    );

    await handlers.runList("needs_operator_review", {} as never);

    assert.match(messages[0] ?? "", /matching "needs_operator_review"/);
    assert.match(messages[0] ?? "", /review-1/);
    assert.match(messages[0] ?? "", /next_action=/);
    assert.doesNotMatch(messages[0] ?? "", /resumable-1/);

    messages.length = 0;
    await handlers.runList("resumable", {} as never);

    assert.match(messages[0] ?? "", /matching "resumable"/);
    assert.match(messages[0] ?? "", /resumable-1/);
    assert.doesNotMatch(messages[0] ?? "", /review-1/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
