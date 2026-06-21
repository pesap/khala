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
    assert.doesNotMatch(messages[0] ?? "", /completed-1/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
