import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readRunLedger } from "../../extensions/runtime/run-ledger.ts";

test("readRunLedger preserves optional source work context", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-runtime-run-source-"));
  try {
    const runFile = path.join(runLedgerDir, "source.json");
    await writeFile(
      runFile,
      JSON.stringify(
        {
          id: "source-runtime-1",
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

    const record = await readRunLedger(runFile);

    assert.equal(record?.source?.issue, 196);
    assert.equal(record?.source?.pr, 194);
    assert.equal(record?.source?.url, "https://github.com/pesap/agents/issues/196");
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
