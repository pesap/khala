import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRunLedgerEvent,
  buildRunLedgerRecord,
  readRunLedger,
} from "../../extensions/runtime/run-ledger.ts";

test("buildRunLedgerRecord normalizes source work context before persistence", () => {
  const record = buildRunLedgerRecord({
    version: 1,
    id: "source-runtime-build",
    type: "workon",
    input: "complete paused Khala harness goal",
    flags: {},
    startedAt: "2026-06-20T00:00:00.000Z",
    source: {
      issue: " 196 ",
      pr: 194,
      url: " https://github.com/pesap/agents/issues/196 ",
    },
  });

  assert.deepEqual(record.source, {
    issue: "196",
    pr: 194,
    url: "https://github.com/pesap/agents/issues/196",
  });
});

test("buildRunLedgerRecord omits empty source work context", () => {
  const record = buildRunLedgerRecord({
    version: 1,
    id: "source-runtime-empty-build",
    type: "workon",
    input: "complete paused Khala harness goal",
    flags: {},
    startedAt: "2026-06-20T00:00:00.000Z",
    source: {
      issue: "",
      pr: " ",
      url: "",
    },
  });

  assert.equal(record.source, undefined);
  assert.equal(Object.hasOwn(record, "source"), false);
});

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

test("readRunLedger normalizes legacy source work context aliases", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-runtime-run-source-"));
  try {
    const runFile = path.join(runLedgerDir, "source-legacy.json");
    await writeFile(
      runFile,
      JSON.stringify(
        {
          id: "source-runtime-legacy",
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
            issue_number: " 196 ",
            pullRequest: { number: 194, url: "https://github.com/pesap/agents/pull/194" },
            source_url: " https://github.com/pesap/agents/issues/196 ",
          },
          events: [],
        },
        null,
        2,
      ),
    );

    const record = await readRunLedger(runFile);

    assert.deepEqual(record?.source, {
      issue: "196",
      pr: 194,
      url: "https://github.com/pesap/agents/issues/196",
    });
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});

test("readRunLedger drops empty source work context", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-runtime-run-source-"));
  try {
    const runFile = path.join(runLedgerDir, "source-empty.json");
    await writeFile(
      runFile,
      JSON.stringify(
        {
          id: "source-runtime-empty",
          repo: "pesap/agents",
          cwd: "/repo/agents",
          status: "started",
          startedAt: "2026-06-20T00:00:00.000Z",
          workflow: {
            id: "workon",
            type: "workon",
          },
          input: "complete paused Khala harness goal",
          source: {
            issue: " ",
            sourcePr: Number.NaN,
            url: "",
          },
          events: [],
        },
        null,
        2,
      ),
    );

    const record = await readRunLedger(runFile);

    assert.equal(record?.source, undefined);
    assert.equal(Object.hasOwn(record ?? {}, "source"), false);
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});

test("appendRunLedgerEvent preserves optional source work context", async () => {
  const runLedgerDir = await mkdtemp(path.join(tmpdir(), "khala-runtime-run-source-"));
  try {
    const runFile = path.join(runLedgerDir, "source-append.json");
    await writeFile(
      runFile,
      JSON.stringify(
        {
          id: "source-runtime-append",
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

    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "source-runtime-append:checkpoint:2026-06-20T00:01:00.000Z",
        at: "2026-06-20T00:01:00.000Z",
        type: "checkpoint",
        summary: "Checkpoint after source metadata was recorded.",
        replaySafe: true,
      },
    });

    const record = await readRunLedger(runFile);

    assert.equal(record?.events.at(-1)?.type, "checkpoint");
    assert.equal(record?.source?.issue, 196);
    assert.equal(record?.source?.pr, 194);
    assert.equal(record?.source?.url, "https://github.com/pesap/agents/issues/196");
  } finally {
    await rm(runLedgerDir, { force: true, recursive: true });
  }
});
