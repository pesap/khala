import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { AUTOMATIC_RECOVERY_MAX_ATTEMPTS } from "../dist/src/khala-conclave-storage.js";
import { recoverPendingSubmissions } from "../dist/src/khala-conclave.js";
import {
  CONCLAVE_RECOVERY_CLAIM_LEASE_MS,
  isConclaveRecoveryRecord,
  validateArchiveReplay,
} from "../dist/src/khala-model.js";

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

test("an active recovery renews its durable lease while the wake is running", async () => {
  await withFixture("khala-conclave-recovery-renewal-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "renewed-work", projectPath, work });
    let releaseWake;
    const wakeGate = new Promise((resolve) => {
      releaseWake = resolve;
    });
    let wakeCount = 0;
    const first = recoverPendingSubmissions({
      projectPath,
      projectTrusted: false,
      storage,
      ownerId: "first-process:nonce",
      leaseRenewalIntervalMs: 5,
      wake: async () => {
        wakeCount += 1;
        await wakeGate;
      },
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (recoveryRecords(projectPath).some((record) => record.payload.status === "renewed")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await recoverPendingSubmissions({
      projectPath,
      projectTrusted: false,
      storage: createFileConclaveStorage(),
      ownerId: "second-process:nonce",
      wake: async () => {
        wakeCount += 1;
      },
    });
    releaseWake();
    await first;

    assert.equal(wakeCount, 1);
    assert.ok(recoveryRecords(projectPath).some((record) => record.payload.status === "renewed"));
    assert.equal(wakeRecords(projectPath).length, 1);
  });
});

test("recovery claims reject malformed or unbounded lease timestamps", () => {
  const base = {
    recoveryId: "recovery-lease",
    workId: "lease-work",
    submissionRecordId: "submission-lease",
    status: "claimed",
    attempt: 1,
    maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
    ownerId: "process:nonce",
    claimedAt: new Date().toISOString(),
  };
  assert.equal(isConclaveRecoveryRecord({ ...base, leaseExpiresAt: "not-a-timestamp" }), false);
  assert.equal(
    isConclaveRecoveryRecord({
      ...base,
      leaseExpiresAt: new Date(Date.parse(base.claimedAt) + CONCLAVE_RECOVERY_CLAIM_LEASE_MS * 2).toISOString(),
    }),
    false,
  );
});

test("Archive replay rejects future claims and non-extending renewals", async () => {
  await withFixture("khala-conclave-recovery-chronology-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "chronology-work", projectPath, work });
    const submissionRecord = listArchiveRecords(projectPath).at(-1);
    const futureClaimedAt = new Date(Date.now() + 3_600_000);
    assert.throws(
      () =>
        appendArchiveRecord(projectPath, {
          schemaVersion: 2,
          type: "conclave-recovery",
          workId: "chronology-work",
          payload: {
            recoveryId: "future-recovery",
            workId: "chronology-work",
            submissionRecordId: submissionRecord.recordId,
            status: "claimed",
            attempt: 1,
            maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
            ownerId: "future-process:nonce",
            claimedAt: futureClaimedAt.toISOString(),
            leaseExpiresAt: new Date(
              futureClaimedAt.getTime() + CONCLAVE_RECOVERY_CLAIM_LEASE_MS,
            ).toISOString(),
          },
        }),
      /invalid attempt sequence/,
    );

    const claim = storage.claimSubmissionRecovery(projectPath, "chronology-work", "current-process:nonce");
    const renewedAt = new Date();
    assert.throws(
      () =>
        appendArchiveRecord(projectPath, {
          schemaVersion: 2,
          type: "conclave-recovery",
          workId: "chronology-work",
          payload: {
            recoveryId: claim.recovery.recoveryId,
            workId: "chronology-work",
            submissionRecordId: claim.recovery.submissionRecordId,
            status: "renewed",
            attempt: claim.recovery.attempt,
            maxAttempts: claim.recovery.maxAttempts,
            ownerId: claim.recovery.ownerId,
            renewedAt: renewedAt.toISOString(),
            leaseExpiresAt: new Date(renewedAt.getTime() + 30_000).toISOString(),
          },
        }),
      /invalid lease renewal/,
    );
  });
});

test("Archive replay rejects overlapping claims, active exhaustion, and late renewal", async () => {
  await withFixture("khala-conclave-recovery-replay-order-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "replay-order-work", projectPath, work });
    const first = storage.claimSubmissionRecovery(projectPath, "replay-order-work", "first-owner:nonce");
    const attemptedAt = new Date().toISOString();
    assert.throws(
      () =>
        appendArchiveRecord(projectPath, {
          schemaVersion: 2,
          type: "conclave-recovery",
          workId: "replay-order-work",
          payload: {
            ...first.recovery,
            recoveryId: "overlapping-claim",
            attempt: 2,
            ownerId: "second-owner:nonce",
            claimedAt: attemptedAt,
            leaseExpiresAt: new Date(Date.parse(attemptedAt) + CONCLAVE_RECOVERY_CLAIM_LEASE_MS).toISOString(),
          },
        }),
      /invalid attempt sequence/,
    );

    assert.equal(
      storage.completeSubmissionRecovery(projectPath, first, {
        status: "failed",
        attemptedAt,
        failure: "first wake failed",
        recovery: "recreate",
      }),
      true,
    );
    const second = storage.claimSubmissionRecovery(projectPath, "replay-order-work", "second-owner:nonce");
    assert.equal(
      storage.completeSubmissionRecovery(projectPath, second, {
        status: "failed",
        attemptedAt: new Date().toISOString(),
        failure: "second wake failed",
        recovery: "recreate",
      }),
      true,
    );
    const third = storage.claimSubmissionRecovery(projectPath, "replay-order-work", "third-owner:nonce");
    assert.throws(
      () =>
        appendArchiveRecord(projectPath, {
          schemaVersion: 2,
          type: "conclave-recovery",
          workId: "replay-order-work",
          payload: {
            recoveryId: "premature-exhaustion",
            workId: "replay-order-work",
            submissionRecordId: third.recovery.submissionRecordId,
            status: "exhausted",
            attempt: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
            maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
            exhaustedAt: new Date().toISOString(),
            reason: "premature",
          },
        }),
      /exhausted before its retry limit/,
    );

    const submission = listArchiveRecords(projectPath)[0];
    const claimRecordedAt = new Date(Date.parse(submission.recordedAt) + 1_000);
    const leaseExpiresAt = new Date(claimRecordedAt.getTime() + CONCLAVE_RECOVERY_CLAIM_LEASE_MS);
    const lateRenewalRecordedAt = new Date(leaseExpiresAt.getTime() + 1);
    const lateRenewedAt = new Date(leaseExpiresAt.getTime() - 1_000);
    const claimPayload = {
      recoveryId: "late-renewal-claim",
      workId: "replay-order-work",
      submissionRecordId: submission.recordId,
      status: "claimed",
      attempt: 1,
      maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
      ownerId: "late-owner:nonce",
      claimedAt: claimRecordedAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
    assert.throws(
      () =>
        validateArchiveReplay([
          submission,
          {
            recordId: "late-claim-record",
            schemaVersion: 2,
            type: "conclave-recovery",
            projectPath: submission.projectPath,
            workId: "replay-order-work",
            recordedAt: claimRecordedAt.toISOString(),
            payload: claimPayload,
          },
          {
            recordId: "late-renewal-record",
            schemaVersion: 2,
            type: "conclave-recovery",
            projectPath: submission.projectPath,
            workId: "replay-order-work",
            recordedAt: lateRenewalRecordedAt.toISOString(),
            payload: {
              ...claimPayload,
              status: "renewed",
              renewedAt: lateRenewedAt.toISOString(),
              claimedAt: undefined,
              leaseExpiresAt: new Date(lateRenewedAt.getTime() + CONCLAVE_RECOVERY_CLAIM_LEASE_MS).toISOString(),
            },
          },
        ]),
      /invalid lease renewal/,
    );
  });
});

test("a process restart advances an expired durable lease without trusting a reused PID", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await withFixture("khala-conclave-recovery-crash-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "crashed-work", projectPath, work });
    const abandonedClaim = storage.claimSubmissionRecovery(
      projectPath,
      "crashed-work",
      `${process.pid}:prior-process-nonce`,
    );
    context.mock.timers.tick(CONCLAVE_RECOVERY_CLAIM_LEASE_MS * 2);
    let wakes = 0;
    assert.equal(storage.renewSubmissionRecovery(projectPath, abandonedClaim), false);
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
    assert.notEqual(recoveryRecords(projectPath)[1].payload.ownerId, `${process.pid}:prior-process-nonce`);
    assert.equal(wakeRecords(projectPath)[0].payload.wakeId, recoveryRecords(projectPath)[1].payload.recoveryId);
  });
});

test("recovery retries a transient outcome persistence failure without repeating the wake", async () => {
  await withFixture("khala-conclave-recovery-completion-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "completion-work", projectPath, work });
    let completionAttempts = 0;
    let wakeCount = 0;
    const faultInjectingStorage = {
      ...storage,
      completeSubmissionRecovery(...args) {
        completionAttempts += 1;
        if (completionAttempts <= 4) {
          throw new Error("transient Archive write failure");
        }
        return storage.completeSubmissionRecovery(...args);
      },
    };

    await recover(projectPath, faultInjectingStorage, async () => {
      wakeCount += 1;
    });
    await recover(projectPath, faultInjectingStorage, async () => {
      wakeCount += 1;
    });

    assert.equal(completionAttempts, 5);
    assert.equal(wakeCount, 1);
    assert.equal(wakeRecords(projectPath).length, 1);
    assert.equal(wakeRecords(projectPath)[0].payload.status, "woken");
  });
});

test("completion reconciliation stops promptly when coordinator disposal aborts persistent retries", async () => {
  await withFixture("khala-conclave-recovery-disposal-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "disposal-work", projectPath, work });
    let completionAttempts = 0;
    const unavailableStorage = {
      ...storage,
      completeSubmissionRecovery() {
        completionAttempts += 1;
        throw new Error("persistent Archive failure");
      },
    };
    const controller = new AbortController();
    const recovery = recoverPendingSubmissions({
      projectPath,
      projectTrusted: false,
      storage: unavailableStorage,
      signal: controller.signal,
      wake: async () => {},
    });
    for (let attempt = 0; attempt < 100 && completionAttempts === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    await Promise.race([
      recovery,
      new Promise((_, reject) => setTimeout(() => reject(new Error("recovery disposal did not settle")), 100)),
    ]);

    assert.equal(completionAttempts, 1);
    assert.equal(wakeRecords(projectPath).length, 0);
  });
});

test("a fenced stale claim settles instead of retrying completion forever", async () => {
  await withFixture("khala-conclave-recovery-stale-", async ({ projectPath, storage }) => {
    storage.submit({ workId: "stale-work", projectPath, work });
    let completionAttempts = 0;
    const staleStorage = {
      ...storage,
      renewSubmissionRecovery() {
        return false;
      },
      completeSubmissionRecovery() {
        completionAttempts += 1;
        return false;
      },
    };
    let wakeCount = 0;

    await recoverPendingSubmissions({
      projectPath,
      projectTrusted: false,
      storage: staleStorage,
      leaseRenewalIntervalMs: 1,
      wake: async () => {
        wakeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    assert.equal(wakeCount, 1);
    assert.equal(completionAttempts, 1);
    assert.equal(wakeRecords(projectPath).length, 0);
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
