import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appendRunLedgerEvent, readRunLedger } from "../../extensions/runtime/run-ledger.ts";

const local = {
  worktreePath: "/tmp/worktrunk.khala",
  capsulePath: "/home/user/.pi/khala/github.com/pesap/agents/issue-196",
  ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl",
};

test("readRunLedger preserves optional local artifact context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-local-"));
  const ledgerPath = path.join(dir, "local.json");

  try {
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          workflowId: "local-read-1",
          status: "interrupted",
          startedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            name: "workon",
          },
          input: {
            issue: "196",
          },
          local,
          events: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const record = await readRunLedger(ledgerPath);

    assert.equal(record?.local?.worktreePath, "/tmp/worktrunk.khala");
    assert.equal(record?.local?.capsulePath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196");
    assert.equal(record?.local?.ledgerPath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendRunLedgerEvent preserves optional local artifact context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-local-"));
  const ledgerPath = path.join(dir, "local-append.json");

  try {
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          workflowId: "local-append-1",
          status: "interrupted",
          startedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            name: "workon",
          },
          input: {
            issue: "196",
          },
          local,
          events: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    await appendRunLedgerEvent({
      runFile: ledgerPath,
      event: {
        id: "local-append-1:checkpoint:2026-06-20T00:01:00.000Z",
        at: "2026-06-20T00:01:00.000Z",
        type: "checkpoint",
        summary: "Captured local run context.",
        replaySafe: true,
        data: {
          summary: "Captured local run context.",
        },
      },
    });

    const record = await readRunLedger(ledgerPath);

    assert.equal(record?.local?.worktreePath, "/tmp/worktrunk.khala");
    assert.equal(record?.local?.capsulePath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196");
    assert.equal(record?.local?.ledgerPath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
