import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunLedgerEvent } from "../../extensions/runtime/run-ledger.ts";
import {
  appendRunLedgerEvent,
  completeRunLedger,
  markRunInterrupted,
  readRunLedger,
} from "../../extensions/runtime/run-ledger.ts";

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

test("completeRunLedger preserves optional local artifact context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-local-"));
  const ledgerPath = path.join(dir, "local-complete.json");

  try {
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          workflowId: "local-complete-1",
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

    const completionEvent: RunLedgerEvent = {
      id: "local-complete-1:workflow_completed:2026-06-20T00:12:00.000Z",
      at: "2026-06-20T00:12:00.000Z",
      type: "workflow_completed",
      summary: "workflow completed",
      replaySafe: true,
    };

    const record = await completeRunLedger({
      runFile: ledgerPath,
      finishedAt: "2026-06-20T00:12:00.000Z",
      outcome: "success",
      confidence: 0.92,
      event: completionEvent,
      patch: {},
    });

    assert.equal(record.local?.worktreePath, "/tmp/worktrunk.khala");
    assert.equal(record.local?.capsulePath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196");
    assert.equal(record.local?.ledgerPath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markRunInterrupted preserves optional local artifact context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-local-"));
  const ledgerPath = path.join(dir, "local-interrupted.json");

  try {
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          workflowId: "local-interrupted-1",
          status: "active",
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

    const record = await markRunInterrupted({
      runFile: ledgerPath,
      at: "2026-06-20T00:02:00.000Z",
      eventId: "local-interrupted-1:interrupted",
      reason: "operator paused the run",
    });

    assert.equal(record.local?.worktreePath, "/tmp/worktrunk.khala");
    assert.equal(record.local?.capsulePath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196");
    assert.equal(record.local?.ledgerPath, "/home/user/.pi/khala/github.com/pesap/agents/issue-196/ledger.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
