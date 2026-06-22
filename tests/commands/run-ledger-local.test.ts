import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLedgerCommandHandlers } from "../../extensions/commands/run-ledger.ts";

test("run commands surface local artifact context", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-local-"));
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
      path.join(runLedgerDir, "local-1.json"),
      JSON.stringify(
        {
          id: "local-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            id: "workon",
            type: "workon",
            state: { currentStep: "implement", completedSteps: ["scout"] },
          },
          input: "continue local-first harness work",
          local: {
            worktreePath: "/tmp/worktrunk.khala",
            capsulePath: "/home/user/.pi/khala/github.com/pesap/agents/capsule.md",
            ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/handoff.json",
          },
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

    await handlers.runList("", {} as never);

    assert.match(messages[0] ?? "", /local-1/);
    assert.match(messages[0] ?? "", /worktree=\/tmp\/worktrunk\.khala/);
    assert.match(messages[0] ?? "", /capsule=.*capsule\.md/);
    assert.match(messages[0] ?? "", /ledger=.*handoff\.json/);

    messages.length = 0;
    await handlers.runList("worktrunk.khala", {} as never);

    assert.match(messages[0] ?? "", /matching "worktrunk\.khala"/);
    assert.match(messages[0] ?? "", /local-1/);

    messages.length = 0;
    await handlers.runShow("local-1", {} as never);

    assert.match(messages[0] ?? "", /Local: worktree=\/tmp\/worktrunk\.khala/);
    assert.match(messages[0] ?? "", /capsule=.*capsule\.md/);
    assert.match(messages[0] ?? "", /ledger=.*handoff\.json/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
