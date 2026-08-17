import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { AUTOMATIC_RECOVERY_MAX_ATTEMPTS } from "../dist/src/khala-conclave-storage.js";
import { recoverPendingSubmissions } from "../dist/src/khala-conclave.js";

const work = {
  title: "Recovery fixture",
  objective: "Recover one eligible lifecycle transition.",
  context: "The fixture has sufficient context.",
  scope: "Only lifecycle recovery.",
  acceptanceCriteria: ["Recovery remains bounded and deduplicated."],
  constraints: [],
  plan: ["Read durable lifecycle records."],
  validation: ["Inspect recovery attempts."],
};

function recoveryRecords(projectPath) {
  return listArchiveRecords(projectPath).filter((record) => record.type === "conclave-recovery");
}

function wakeRecords(projectPath) {
  return listArchiveRecords(projectPath).filter((record) => record.type === "conclave-wake");
}

async function withFixture(prefix, run) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const projectPath = join(root, "project");
  try {
    await run({ projectPath, storage: createFileConclaveStorage() });
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

async function recover(projectPath, storage, wake) {
  await recoverPendingSubmissions({
    projectPath,
    projectTrusted: false,
    storage,
    wake,
  });
}

function admitWithMission(storage, projectPath, workId, withExecution) {
  storage.submit({ workId, projectPath, work });
  const submissionRecord = listArchiveRecords(projectPath).at(-1);
  const mandateId = `mandate-${workId}`;
  const missionId = `mission-${workId}`;
  appendArchiveRecord(projectPath, {
    schemaVersion: 2,
    type: "mandate",
    workId,
    payload: {
      mandateId,
      workId,
      revision: 1,
      sourceSubmissionRecordId: submissionRecord.recordId,
      terms: work,
      admittedByParticipantId: "conclave:test",
      admittedAt: new Date().toISOString(),
    },
  });
  assert.equal(storage.admitSubmission(projectPath, workId, mandateId), true);
  appendArchiveRecord(projectPath, {
    schemaVersion: 2,
    type: "mission",
    workId,
    payload: {
      missionId,
      workId,
      mandateId,
      assignment: work,
      assignedParticipantId: `executor:${missionId}`,
      createdAt: new Date().toISOString(),
    },
  });
  if (withExecution) {
    appendArchiveRecord(projectPath, {
      type: "execution",
      workId,
      executionId: `execution-${workId}`,
      payload: {
        executionId: `execution-${workId}`,
        workId,
        executorName: "Recovery Executor",
        kind: "executor",
        participantId: `executor:${missionId}`,
        purpose: { kind: "mission", missionId },
        missionId,
        projectPath,
        sandboxPath: join(projectPath, "sandbox"),
        launcher: "headless-rpc",
        piSessionId: `session-${workId}`,
        sessionPath: join(projectPath, `${workId}.jsonl`),
        promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
        status: "running",
        startedAt: new Date().toISOString(),
      },
    });
  }
}

test("queued Work without a completed decision receives one automatic recovery wake", async () => {
  await withFixture("khala-conclave-recovery-queued-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "queued-work", projectPath, work });
    const woken = [];

    await recover(projectPath, storage, async (submission) => {
      woken.push(submission.workId);
    });

    assert.deepEqual(woken, ["queued-work"]);
    assert.deepEqual(recoveryRecords(projectPath).map((record) => record.payload.status), ["claimed"]);
    assert.deepEqual(wakeRecords(projectPath).map((record) => record.payload.status), ["woken"]);
  });
});

test("admitted Work with a current Execution or completed Conclave decision is not recovered", async () => {
  await withFixture("khala-conclave-recovery-admitted-", async ({ projectPath, storage }) => {
    admitWithMission(storage, projectPath, "executing-work", true);
    admitWithMission(storage, projectPath, "decided-work", false);
    appendArchiveRecord(projectPath, {
      schemaVersion: 2,
      type: "conclave-wake",
      workId: "decided-work",
      payload: {
        wakeId: "completed-launch-decision",
        workId: "decided-work",
        status: "woken",
        attemptedAt: new Date().toISOString(),
      },
    });
    let wakes = 0;

    await recover(projectPath, storage, async () => {
      wakes += 1;
    });

    assert.equal(wakes, 0);
    assert.deepEqual(recoveryRecords(projectPath), []);
  });
});

test("concurrent recovery initiators enqueue one wake for the same transition", async () => {
  await withFixture("khala-conclave-recovery-concurrent-", async ({ projectPath }) => {
    createFileConclaveStorage().submit({ workId: "concurrent-work", projectPath, work });
    let wakeCount = 0;
    let releaseWake;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const wakeGate = new Promise((resolve) => {
      releaseWake = resolve;
    });
    const wake = async () => {
      wakeCount += 1;
      markStarted();
      await wakeGate;
    };

    const first = recover(projectPath, createFileConclaveStorage(), wake);
    await started;
    const second = recover(projectPath, createFileConclaveStorage(), wake);
    await Promise.resolve();
    releaseWake();
    await Promise.all([first, second]);

    assert.equal(wakeCount, 1);
    assert.equal(recoveryRecords(projectPath).filter((record) => record.payload.status === "claimed").length, 1);
    assert.equal(wakeRecords(projectPath).length, 1);
  });
});

test("a process restart advances an abandoned durable claim without resetting its attempt count", async () => {
  await withFixture("khala-conclave-recovery-crash-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "crashed-work", projectPath, work });
    const abandoned = storage.claimSubmissionRecovery(projectPath, "crashed-work", 2_147_483_647);
    assert.equal(abandoned.recovery.attempt, 1);
    let wakes = 0;

    await recover(projectPath, createFileConclaveStorage(), async () => {
      wakes += 1;
    });

    assert.equal(wakes, 1);
    assert.deepEqual(
      recoveryRecords(projectPath)
        .filter((record) => record.payload.status === "claimed")
        .map((record) => record.payload.attempt),
      [1, 2],
    );
    assert.equal(wakeRecords(projectPath)[0].payload.wakeId, recoveryRecords(projectPath)[1].payload.recoveryId);
  });
});

test("automatic recovery exhaustion is durable across storage and process restarts", async () => {
  await withFixture("khala-conclave-recovery-exhausted-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "exhausted-work", projectPath, work });
    let wakeCount = 0;
    const failWake = async () => {
      wakeCount += 1;
      throw new Error("Conclave remains unavailable.");
    };

    for (let attempt = 0; attempt < AUTOMATIC_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      await recover(projectPath, createFileConclaveStorage(), failWake);
    }
    await recover(projectPath, createFileConclaveStorage(), failWake);

    assert.equal(wakeCount, AUTOMATIC_RECOVERY_MAX_ATTEMPTS);
    assert.deepEqual(
      recoveryRecords(projectPath)
        .filter((record) => record.payload.status === "claimed")
        .map((record) => record.payload.attempt),
      [1, 2, 3],
    );
    assert.equal(recoveryRecords(projectPath).filter((record) => record.payload.status === "exhausted").length, 1);
    assert.equal(wakeRecords(projectPath).filter((record) => record.payload.status === "failed").length, 3);
  });
});
