import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLedgerCommandHandlers } from "../../extensions/commands/run-ledger.ts";

test("run-list surfaces source work context from run input", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-source-"));
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
      path.join(runLedgerDir, "source-1.json"),
      JSON.stringify(
        {
          id: "source-1",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            id: "workon",
            type: "workon",
            state: { currentStep: "implement", completedSteps: ["scout"] },
          },
          input: "complete paused Khala harness goal",
          source: {
            issue: 196,
            pr: 194,
            url: "https://github.com/pesap/agents/issues/196",
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

    assert.match(messages[0] ?? "", /source-1/);
    assert.match(messages[0] ?? "", /issue=196/);
    assert.match(messages[0] ?? "", /pr=194/);
    assert.match(messages[0] ?? "", /source=https:\/\/github\.com\/pesap\/agents\/issues\/196/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});

test("run-show surfaces source work context from run metadata", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-source-"));
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
      path.join(runLedgerDir, "source-2.json"),
      JSON.stringify(
        {
          id: "source-2",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            id: "workon",
            type: "workon",
            state: { currentStep: "implement", completedSteps: ["scout"] },
          },
          input: "complete paused Khala harness goal",
          source: {
            issue: 196,
            pr: 194,
            url: "https://github.com/pesap/agents/issues/196",
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

    await handlers.runShow("source-2", {} as never);

    assert.match(messages[0] ?? "", /Run source-2/);
    assert.match(messages[0] ?? "", /Source: issue=196 pr=194 source=https:\/\/github\.com\/pesap\/agents\/issues\/196/);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
