import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  OUTAGE_RETRY_DELAYS_MS,
  SupervisionOutageCoordinator,
  UpstreamRefPoller,
  parseLsRemoteOutput,
  validatePersistedExecutorSession,
  mandatoryStopExecution,
  revisionDependents,
} from "../dist/src/khala-supervision-recovery.js";
import { appendArchiveRecord, getArchivePath, listArchiveRecords } from "../dist/src/khala-archive.js";
import { listCoordinationRecords } from "../dist/src/khala-archive-projections.js";
import { directRevisionDependents, recordUpstreamRevision } from "../dist/src/khala-coordination.js";
import { failExecutionAndCloseInterventions } from "../dist/src/khala-supervision-recovery.js";
import { SupervisionController } from "../dist/src/khala-supervision.js";
import { isPendingRecoveryLaunchEligible, startFreshSameMissionExecution } from "../dist/src/khala-conclave.js";
import { EXECUTION_SCHEMA_VERSION } from "../dist/src/khala-model.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function configureRecoveryTest(root) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "khala.json"), JSON.stringify({
    conclaveModel: "test/model",
    conclaveMaxCostUsdPerTurn: 1,
    executorModel: "test/model",
    executorMaxCostUsdPerTurn: 1,
    archiveRoot: join(root, "archive"),
    worktreeRoot: join(root, "worktrees"),
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
}

function failedRecoveryFixture(root) {
  const now = new Date().toISOString();
  const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
  const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
  const failedExecution = { executionId: "failed", workId: "work", executorName: "failed", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "pending", status: "failed", startedAt: now };
  appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
  appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: failedExecution.executionId, payload: failedExecution });
  return { now, assignment, mission, failedExecution };
}

function base(id, head = HEAD_A) {
  return {
    kind: "upstream-execution",
    workId: `upstream-${id}`,
    missionId: `mission-${id}`,
    executionId: `execution-${id}`,
    remote: "origin",
    branch: "feature/upstream",
    headCommit: head,
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) { const timer = { callback, delay, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; },
    setInterval() { return { active: true }; },
    clearInterval(timer) { timer.active = false; },
    async fire(delay) {
      for (const timer of timers.filter((candidate) => candidate.active && candidate.delay === delay)) {
        timer.active = false;
        await timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

test("Supervision recovery parses only one exact ls-remote line and distinguishes missing refs", () => {
  assert.equal(parseLsRemoteOutput("", "feature/upstream"), null);
  assert.equal(parseLsRemoteOutput("\n", "feature/upstream"), null);
  assert.equal(parseLsRemoteOutput(`${HEAD_A}\trefs/heads/feature/upstream\n`, "feature/upstream"), HEAD_A);
  assert.throws(() => parseLsRemoteOutput(`${HEAD_A}\trefs/heads/feature/upstream\nextra\n`, "feature/upstream"), /ambiguous/);
  assert.throws(() => parseLsRemoteOutput(`${HEAD_A.slice(0, 39)}\trefs/heads/feature/upstream\n`, "feature/upstream"), /invalid/);
  assert.throws(() => parseLsRemoteOutput(`${HEAD_A}\trefs/heads/other\n`, "feature/upstream"), /invalid/);
});

test("upstream polling shares one in-flight query, polls immediately, and records one changed revision", async () => {
  const first = base("one");
  const second = { ...base("two"), remote: "origin", branch: "feature/upstream" };
  let output = `${HEAD_A}\trefs/heads/feature/upstream\n`;
  let calls = 0;
  let release;
  const query = new Promise((resolve) => { release = resolve; });
  const recorded = [];
  const poller = new UpstreamRefPoller({
    projectPath: "/project",
    getBases: () => [first, second],
    exec: async () => {
      calls += 1;
      if (calls === 1) return query;
      return output;
    },
    recordRevision: (input) => recorded.push(input),
    isVerifiedMerged: () => false,
  });
  const pending = poller.pollNow();
  await Promise.resolve();
  assert.equal(calls, 1);
  release(`${HEAD_A}\trefs/heads/feature/upstream\n`);
  await pending;
  output = `${HEAD_B}\trefs/heads/feature/upstream\n`;
  const changed = await poller.pollNow();
  assert.equal(calls, 2);
  assert.deepEqual(changed.map((item) => item.status), ["changed", "changed"]);
  assert.equal(recorded.length, 2);
  poller.dispose();
});

test("scoped polling receives its exact outcome while a global poll is in flight", async () => {
  const first = base("one");
  const second = { ...base("two"), remote: "origin", branch: "feature/upstream" };
  let calls = 0;
  let release;
  const query = new Promise((resolve) => { release = resolve; });
  const poller = new UpstreamRefPoller({
    projectPath: "/project",
    getBases: () => [first, second],
    exec: async () => { calls += 1; return query; },
    isVerifiedMerged: () => false,
  });
  const global = poller.pollNow();
  const scoped = poller.pollNow({ base: second, remote: second.remote, branch: second.branch });
  await Promise.resolve();
  assert.equal(calls, 1);
  release(`${HEAD_A}\trefs/heads/feature/upstream\n`);
  const [globalOutcomes, scopedOutcomes] = await Promise.all([global, scoped]);
  assert.equal(globalOutcomes.length, 2);
  assert.equal(scopedOutcomes.length, 1);
  assert.equal(scopedOutcomes[0].base.executionId, second.executionId);
  poller.dispose();
});

test("concurrent global and scoped polls run one base transaction per base", async () => {
  const first = base("one");
  const second = { ...base("two"), remote: "origin", branch: "feature/upstream" };
  let calls = 0;
  let release;
  const query = new Promise((resolve) => { release = resolve; });
  const recorded = [];
  const successes = [];
  const poller = new UpstreamRefPoller({
    projectPath: "/project",
    getBases: () => [first, second],
    exec: async () => {
      calls += 1;
      if (calls === 1) return query;
      return `${HEAD_B}\trefs/heads/feature/upstream\n`;
    },
    recordRevision: (input) => recorded.push(input.supersededBase.executionId),
    onSuccess: (base) => successes.push(base.executionId),
    isVerifiedMerged: () => false,
  });
  const global = poller.pollNow();
  const scoped = poller.pollNow({ base: second, remote: second.remote, branch: second.branch });
  await Promise.resolve();
  assert.equal(calls, 1);
  release(`${HEAD_B}\trefs/heads/feature/upstream\n`);
  const [globalOutcomes, scopedOutcomes] = await Promise.all([global, scoped]);
  assert.equal(globalOutcomes.length, 2);
  assert.deepEqual(globalOutcomes.map((item) => item.status), ["changed", "changed"]);
  assert.equal(scopedOutcomes.length, 1);
  assert.equal(scopedOutcomes[0].status, "changed");
  assert.equal(scopedOutcomes[0].base.executionId, second.executionId);
  assert.deepEqual(recorded.sort(), ["execution-one", "execution-two"]);
  assert.deepEqual(successes.sort(), ["execution-one", "execution-two"]);
  poller.dispose();
});

test("scoped outage retry treats a now-merged inactive base as terminal success", async () => {
  const upstream = base("merged");
  let succeeded = 0;
  const poller = new UpstreamRefPoller({
    projectPath: "/project",
    getBases: () => [],
    exec: async () => { throw new Error("merged refs must not be polled"); },
    isVerifiedMerged: (candidate) => candidate.executionId === upstream.executionId,
    onSuccess: () => { succeeded += 1; },
  });
  const outcomes = await poller.pollNow({ base: upstream, remote: upstream.remote, branch: upstream.branch });
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["merged"]);
  assert.equal(succeeded, 1);
  poller.dispose();
});

test("failed revision recording retries the same evidence before advancing observation", async () => {
  const candidate = base("recording");
  let attempts = 0;
  const evidence = [];
  const poller = new UpstreamRefPoller({
    projectPath: "/project",
    getBases: () => [candidate],
    exec: async () => `${HEAD_B}\trefs/heads/feature/upstream\n`,
    stopDependent: () => undefined,
    isVerifiedMerged: () => false,
    recordRevision: (input) => {
      evidence.push(input.evidence);
      attempts += 1;
      if (attempts === 1) throw new Error("Archive transaction failed");
    },
    onFailure: () => undefined,
  });
  assert.equal((await poller.pollNow())[0].status, "failed");
  assert.equal((await poller.pollNow())[0].status, "changed");
  assert.deepEqual(evidence, [evidence[0], evidence[1]]);
  assert.deepEqual(evidence[0], evidence[1]);
  poller.dispose();
});

test("outage retries use exact bounded delays, close successfully, and preserve the durable fence", async () => {
  const timers = fakeTimers();
  const entries = [];
  let checks = 0;
  const outage = new SupervisionOutageCoordinator({
    projectPath: "/project",
    session: { getEntries: () => entries, appendCustomEntry: (type, data) => { entries.push({ type, customType: type, data }); return "entry"; } },
    timers,
    clock: () => 0,
    onRetry: async () => { checks += 1; return checks === 1; },
    onFailSafe: () => { throw new Error("fail-safe must not run after success"); },
  });
  const open = await outage.fail({ kind: "poll", workIds: ["work"], missionIds: ["mission"], executionIds: ["execution"], error: "temporary" });
  assert.equal(open.failedCheckCount, 0);
  assert.equal(open.checks.length, 0);
  assert.equal(timers.timers.at(-1).delay, OUTAGE_RETRY_DELAYS_MS[0]);
  await timers.fire(OUTAGE_RETRY_DELAYS_MS[0]);
  assert.equal(checks, 1);
  assert.equal(entries.filter((entry) => entry.data?.checks?.some((check) => check.result === "succeeded")).length, 1);
  assert.deepEqual(outage.getOpen(), []);
  assert.equal(entries.at(-1).data.state, "closed");
  outage.dispose();
});

test("third failed retry invokes fixed fail-safe without a model decision", async () => {
  const timers = fakeTimers();
  const entries = [];
  let retries = 0;
  let stopped;
  const outage = new SupervisionOutageCoordinator({
    projectPath: "/project",
    session: { getEntries: () => entries, appendCustomEntry: (type, data) => { entries.push({ type, customType: type, data }); return "entry"; } },
    timers,
    clock: () => 0,
    onRetry: async () => { retries += 1; return false; },
    onFailSafe: (record) => { stopped = record.executionIds; },
  });
  await outage.fail({ kind: "conclave-model", workIds: ["work"], missionIds: ["mission"], executionIds: ["execution"], error: "down" });
  await timers.fire(30_000);
  await timers.fire(60_000);
  await timers.fire(90_000);
  assert.equal(retries, 3);
  assert.deepEqual(stopped, ["execution"]);
  outage.dispose();
});

test("outage checkpoints remain absolute across restart and fail-safe is terminal", async () => {
  let now = 0;
  const entries = [];
  const timers = [];
  const timerApi = {
    setTimeout(callback, delay) { const timer = { callback, delay, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; },
    setInterval() { return { active: true }; },
    clearInterval(timer) { timer.active = false; },
  };
  const fireAt = async (delay, timestamp) => {
    now = timestamp;
    const timer = timers.find((candidate) => candidate.active && candidate.delay === delay);
    assert.ok(timer);
    timer.active = false;
    await timer.callback();
    await Promise.resolve();
  };
  let retries = 0;
  let failSafeCalls = 0;
  const options = {
    projectPath: "/project",
    session: { getEntries: () => entries, appendCustomEntry: (type, data) => { entries.push({ type: "custom", customType: type, data }); return "entry"; } },
    timers: timerApi,
    clock: () => now,
    onRetry: async () => { retries += 1; return false; },
    onFailSafe: () => { failSafeCalls += 1; },
  };
  const first = new SupervisionOutageCoordinator(options);
  const opened = await first.fail({ kind: "poll", workIds: ["work"], missionIds: ["mission"], executionIds: ["execution"], error: "down" });
  assert.equal(opened.deadlineAt, new Date(90_000).toISOString());
  assert.equal(timers.at(-1).delay, 30_000);
  first.dispose();
  now = 35_000;
  const restarted = new SupervisionOutageCoordinator(options);
  await restarted.recover();
  assert.equal(timers.at(-1).delay, 0);
  await fireAt(0, 35_000);
  assert.equal(retries, 1);
  assert.equal(timers.at(-1).delay, 25_000);
  await fireAt(25_000, 60_000);
  assert.equal(retries, 2);
  assert.equal(timers.at(-1).delay, 30_000);
  await fireAt(30_000, 90_000);
  assert.equal(retries, 3);
  assert.equal(failSafeCalls, 1);
  await restarted.fail({ kind: "poll", workIds: ["work"], missionIds: ["mission"], executionIds: ["execution"], error: "duplicate" });
  assert.equal(failSafeCalls, 1);
  assert.deepEqual(restarted.getOpen(), []);
  restarted.dispose();
});

test("poll outage scopes do not close unrelated work", async () => {
  const timers = fakeTimers();
  const baseOne = base("one");
  const baseTwo = { ...base("two"), branch: "feature/other" };
  const outage = new SupervisionOutageCoordinator({
    projectPath: "/project",
    session: { getEntries: () => [], appendCustomEntry: () => "entry" },
    timers,
    clock: () => 0,
    onRetry: async () => false,
    onFailSafe: () => undefined,
  });
  const one = await outage.fail({ kind: "poll", workIds: ["dependent-one"], missionIds: ["mission-one"], executionIds: ["execution-one"], error: "one", scope: { base: baseOne, remote: baseOne.remote, branch: baseOne.branch } });
  await outage.fail({ kind: "poll", workIds: ["dependent-two"], missionIds: ["mission-two"], executionIds: ["execution-two"], error: "two", scope: { base: baseTwo, remote: baseTwo.remote, branch: baseTwo.branch } });
  await outage.close(one.outageId);
  assert.deepEqual(outage.getOpen().map((record) => record.executionIds), [["execution-two"]]);
  outage.dispose();
});

test("mandatory stop validates one new blocked Signal against a pre-handoff baseline", async () => {
  const calls = [];
  let entries = [];
  const signalIds = ["historical-blocked"];
  let observedBaseline;
  const runtime = {
    setStopPending() { calls.push("barrier"); },
    async sendAbort() { calls.push("abort"); },
    async waitForSettled() { calls.push("settled"); },
    async sendStopHandoff(message) { calls.push("handoff"); signalIds.push("new-blocked"); entries = [{ id: "stop-entry", message: { role: "user", content: message } }]; },
    async getEntries() { return { entries }; },
  };
  const marked = await mandatoryStopExecution(runtime, {
    marker: "\\u0000KHALA_MANDATORY_STOP:execution:",
    message: "Stop and report.",
    getBaselineSignalIds: () => signalIds.slice(0, 1),
    validatePostSettlement: async (baseline) => { observedBaseline = baseline; return signalIds.filter((signalId) => !baseline.includes(signalId)).length === 1; },
  });
  assert.deepEqual(calls, ["barrier", "abort", "settled", "handoff", "settled"]);
  assert.deepEqual(observedBaseline, ["historical-blocked"]);
  assert.deepEqual(marked, ["stop-entry"]);
});

test("mandatory stop rejects duplicate new blocked Signals", async () => {
  const signalIds = ["historical-blocked"];
  const runtime = {
    setStopPending() {},
    async sendAbort() {},
    async waitForSettled() {},
    async sendStopHandoff() { signalIds.push("new-blocked-1", "new-blocked-2"); },
    async getEntries() { return { entries: [{ id: "stop-entry", message: { role: "user", content: "\\u0000KHALA_MANDATORY_STOP:execution:" } }] }; },
  };
  await assert.rejects(
    () => mandatoryStopExecution(runtime, {
      marker: "\\u0000KHALA_MANDATORY_STOP:execution:",
      message: "Stop and report.",
      getBaselineSignalIds: () => signalIds.slice(0, 1),
      validatePostSettlement: async (baseline) => signalIds.filter((signalId) => !baseline.includes(signalId)).length === 1,
    }),
    /exactly one current blocked Signal/,
  );
});

test("mandatory non-model stop has one bounded handoff and no Intervention", async () => {
  const calls = [];
  let entries = [];
  const runtime = {
    setStopPending() { calls.push("barrier"); },
    async sendAbort() { calls.push("abort"); },
    async waitForSettled() { calls.push("settled"); },
    async sendStopHandoff(message) { calls.push("handoff"); entries = [{ id: "stop-entry", message: { role: "user", content: message } }]; },
    async getEntries() { return { entries }; },
  };
  const marked = await mandatoryStopExecution(runtime, {
    marker: "\\u0000KHALA_MANDATORY_STOP:execution:",
    message: "Stop and report.",
    validatePostSettlement: async () => true,
  });
  assert.deepEqual(calls, ["barrier", "abort", "settled", "handoff", "settled"]);
  assert.deepEqual(marked, ["stop-entry"]);
});

test("direct and transitive revision traversal follows published dependent identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-transitive-"));
  try {
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const add = (workId, missionId, executionId, upstreamBase) => {
      appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId: `mandate-${workId}`, workId, revision: 1, sourceSubmissionRecordId: `submission-${workId}`, terms: assignment, admittedByParticipantId: "conclave", admittedAt: new Date().toISOString() } });
      appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId: `mandate-${workId}`, assignment, assignedParticipantId: `participant-${executionId}`, createdAt: new Date().toISOString() } });
      appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId, executionId, payload: { executionId, workId, executorName: executionId, kind: "executor", participantId: `participant-${executionId}`, purpose: { kind: "mission", missionId }, missionId, projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: `session-${executionId}`, sessionPath: join(root, `${executionId}.jsonl`), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, ...(upstreamBase === undefined ? {} : { upstreamBase }), status: "running", startedAt: new Date().toISOString() } });
    };
    const a = { kind: "upstream-execution", workId: "a", missionId: "mission-a", executionId: "execution-a", remote: "origin", branch: "feature/a", headCommit: HEAD_A };
    const b = { kind: "upstream-execution", workId: "b", missionId: "mission-b", executionId: "execution-b", remote: "origin", branch: "feature/b", headCommit: HEAD_B };
    add("a", "mission-a", "execution-a");
    add("b", "mission-b", "execution-b", a);
    add("c", "mission-c", "execution-c", b);
    const dependents = revisionDependents(root, false, a);
    assert.deepEqual(dependents.map((dependent) => dependent.workId), ["b", "c"]);

    const decision = {
      coordinationId: "coordination-a-b",
      actionId: "decision-a-b",
      phase: "decision",
      relation: "dependency",
      workId: "b",
      missionId: "mission-b",
      executionId: "execution-b",
      selectedWorkId: "a",
      selectedMissionId: "mission-a",
      selectedExecutionId: "execution-a",
      relatedWorkId: "a",
      relatedMissionId: "mission-a",
      relatedExecutionId: "execution-a",
      upstreamWorkId: "a",
      upstreamMissionId: "mission-a",
      upstreamExecutionId: "execution-a",
      remote: "origin",
      branch: "feature/a",
      reason: "A is the exact upstream base for B.",
    };
    const release = {
      ...decision,
      actionId: "release-a-b",
      phase: "release",
      upstreamHead: HEAD_A,
      releasedExecutionId: "execution-b",
      remoteObservation: { remote: "origin", branch: "feature/a", headCommit: HEAD_A, observedAt: new Date().toISOString() },
    };
    const resolution = {
      ...release,
      actionId: "resolution-a-b",
      phase: "resolution",
      resolution: "released",
    };
    for (const payload of [decision, release, resolution]) {
      appendArchiveRecord(root, { schemaVersion: 2, type: "coordination", workId: "b", executionId: "execution-b", payload });
    }
    const direct = directRevisionDependents(root, a);
    const revisionInput = {
      projectPath: root,
      supersededBase: a,
      replacementHead: "d".repeat(40),
      evidence: { remote: "origin", branch: "feature/a", headCommit: "d".repeat(40), observedAt: new Date().toISOString() },
      directDependents: direct,
      closeRuntime: async () => {},
    };
    const result = await recordUpstreamRevision(revisionInput);
    assert.equal(result.coordinationIds.length, 2);
    const invalidations = listCoordinationRecords(root).filter(
      (record) => result.coordinationIds.includes(record.coordinationId) && record.phase === "invalidation",
    );
    assert.equal(invalidations.length, 2);
    const directInvalidation = invalidations.find((record) => record.workId === "b");
    const transitiveInvalidation = invalidations.find((record) => record.workId === "c");
    assert.equal(directInvalidation.replacementHead, "d".repeat(40));
    assert.equal(directInvalidation.remoteObservation.headCommit, "d".repeat(40));
    assert.equal("replacementHead" in transitiveInvalidation, false);
    assert.equal("remoteObservation" in transitiveInvalidation, false);
    assert.equal(transitiveInvalidation.causedByCoordinationId, directInvalidation.coordinationId);
    const recordCount = listArchiveRecords(root).length;
    const replay = await recordUpstreamRevision(revisionInput);
    assert.deepEqual(replay.coordinationIds, result.coordinationIds);
    assert.equal(listArchiveRecords(root).length, recordCount);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted Executor session validation rejects missing, corrupt, and mismatched sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-session-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: root }) + "\n");
    validatePersistedExecutorSession({ sessionId: "session-1", sessionPath }, sessionPath);
    const physicalSessionPath = join(realpathSync(root), "session.jsonl");
    validatePersistedExecutorSession({ sessionId: "session-1", sessionPath: physicalSessionPath }, sessionPath);
    writeFileSync(sessionPath, "not-json\n");
    assert.throws(() => validatePersistedExecutorSession({ sessionId: "session-1", sessionPath }), /corrupt/);
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: root }) + "\n");
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, cwd: root }) + "\n");
    assert.throws(() => validatePersistedExecutorSession({ sessionId: "session-1", sessionPath }), /identity/);
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "session-2", cwd: root }) + "\n");
    assert.throws(() => validatePersistedExecutorSession({ sessionId: "session-1", sessionPath }), /identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema v2 running Executions without Pi identity fail recovery without invalidating the Archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-legacy-execution-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now } });
    const archivePath = getArchivePath(root);
    const legacyExecution = {
      executionId: "execution",
      workId: "work",
      executorName: "Legacy Executor",
      kind: "executor",
      participantId: "executor",
      purpose: { kind: "mission", missionId: "mission" },
      missionId: "mission",
      projectPath: root,
      sandboxPath: root,
      launcher: "zellij",
      status: "running",
      startedAt: now,
    };
    writeFileSync(
      archivePath,
      `${readFileSync(archivePath, "utf8")}${JSON.stringify({ recordId: "legacy-execution", schemaVersion: 2, type: "execution", projectPath: root, workId: "work", executionId: "execution", recordedAt: now, payload: legacyExecution })}\n`,
    );
    const sessionManager = SessionManager.inMemory(root);
    const recoveryFailures = [];
    let recoveryAttempts = 0;
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} },
      conclaveParticipantId: "conclave",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
      recoverExecutor: async () => {
        recoveryAttempts += 1;
        throw new Error("legacy execution must not be recovered");
      },
      onExecutorRecoveryFailure: async (_execution, _mission, error) => {
        recoveryFailures.push(error.message);
      },
    });

    await controller.recover();

    const executions = listArchiveRecords(root).filter((record) => record.type === "execution");
    assert.deepEqual(executions.map((record) => record.payload.status), ["running", "failed"]);
    assert.equal(executions[0].schemaVersion, 2);
    assert.equal(executions[1].schemaVersion, EXECUTION_SCHEMA_VERSION);
    assert.equal(recoveryAttempts, 0);
    assert.deepEqual(recoveryFailures, ["Executor has no persisted Pi session binding."]);
    controller.dispose();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed recovery uses the final state of one historical Executor stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-failed-history-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    const sessionPath = join(root, "persisted.jsonl");
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "persisted-session", cwd: root }) + "\n");
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    const execution = { executionId: "execution", workId: "work", executorName: "Executor", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "persisted-session", sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, startedAt: now };
    for (const status of ["starting", "running", "failed"]) {
      appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { ...execution, status } });
    }
    const sessionManager = SessionManager.inMemory(root);
    const persistedRecoveryAttempts = [];
    const freshRecoveryRequests = [];
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} },
      conclaveParticipantId: "conclave",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
      recoverExecutor: async () => {
        persistedRecoveryAttempts.push("persisted");
        throw new Error("the persisted-session recovery path must not run for a failed Executor");
      },
      onExecutorRecoveryFailure: async (failedExecution) => {
        freshRecoveryRequests.push({ executionId: failedExecution.executionId, status: failedExecution.status });
      },
    });

    await controller.recover();

    assert.deepEqual(persistedRecoveryAttempts, []);
    assert.deepEqual(freshRecoveryRequests, [{ executionId: "execution", status: "failed" }]);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").length, 3);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Executor recovery revalidates the Archive after upstream polling mutates state", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-poll-race-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    const execution = { executionId: "execution", workId: "work", executorName: "Executor", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: execution.executionId, payload: execution });
    const sessionManager = SessionManager.inMemory(root);
    let persistedRecoveryAttempts = 0;
    let freshRecoveryRequests = 0;
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} },
      conclaveParticipantId: "conclave",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
      upstreamPoller: {
        async start() {
          appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: execution.executionId, payload: { ...execution, status: "finished" } });
        },
        dispose() {},
      },
      recoverExecutor: async () => {
        persistedRecoveryAttempts += 1;
        return { async getEntries() { return { entries: [], leafId: null }; } };
      },
      onExecutorRecoveryFailure: async () => { freshRecoveryRequests += 1; },
    });

    await controller.recover();

    assert.equal(persistedRecoveryAttempts, 0);
    assert.equal(freshRecoveryRequests, 0);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending fresh recovery expires when a successor Mission supersedes its failed Executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-pending-stale-"));
  try {
    const { now, assignment, mission, failedExecution } = failedRecoveryFixture(root);
    const pending = { workId: failedExecution.workId, missionId: mission.missionId, executionId: failedExecution.executionId };
    assert.equal(isPendingRecoveryLaunchEligible(root, false, pending), true);
    const retryVerdict = {
      workId: "work",
      executionId: "failed",
      signalId: "signal",
      missionId: "mission",
      governingMandateId: "mandate",
      issuedByParticipantId: "conclave",
      decision: "retry",
      reason: "Retry.",
      verdictId: "retry-verdict",
      issuedAt: now,
      retryHandoff: { failedCriteria: ["A"], completedWork: ["B"], requiredChanges: ["C"], nonGoals: ["D"], validation: ["E"] },
      successorAssignment: assignment,
    };
    appendArchiveRecord(root, { schemaVersion: 2, type: "verdict", workId: "work", executionId: "failed", payload: retryVerdict });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: { ...mission, missionId: "successor", predecessorMissionId: mission.missionId, causedByVerdictId: retryVerdict.verdictId, createdAt: new Date(Date.now() + 1).toISOString() } });
    assert.equal(isPendingRecoveryLaunchEligible(root, false, pending), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successor Mission replacement blocks stale fresh recovery registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-successor-race-"));
  const restoreConfig = configureRecoveryTest(root);
  try {
    const { now, assignment, mission, failedExecution } = failedRecoveryFixture(root);
    const retryVerdict = {
      workId: "work",
      executionId: "failed",
      signalId: "signal",
      missionId: "mission",
      governingMandateId: "mandate",
      issuedByParticipantId: "conclave",
      decision: "retry",
      reason: "Retry.",
      verdictId: "retry-verdict",
      issuedAt: now,
      retryHandoff: { failedCriteria: ["A"], completedWork: ["B"], requiredChanges: ["C"], nonGoals: ["D"], validation: ["E"] },
      successorAssignment: assignment,
    };
    const successor = { ...mission, missionId: "successor", predecessorMissionId: mission.missionId, causedByVerdictId: retryVerdict.verdictId, createdAt: new Date(Date.now() + 1).toISOString() };
    appendArchiveRecord(root, { schemaVersion: 2, type: "verdict", workId: "work", executionId: "failed", payload: retryVerdict });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: successor });
    const before = listArchiveRecords(root).filter((record) => record.type === "execution").length;
    const registered = [];
    const result = await startFreshSameMissionExecution({
      projectPath: root,
      projectTrusted: false,
      failedExecution,
      mission,
      executorModel: "test/model",
      executorSystemPrompt: "test prompt",
      supervision: { registerExecution: (...args) => registered.push(args) },
      isSupervisionAvailable: () => true,
    });
    assert.equal(result, false);
    assert.deepEqual(registered, []);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").length, before);
  } finally {
    restoreConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer terminal Executor history blocks stale fresh recovery registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-terminal-race-"));
  const restoreConfig = configureRecoveryTest(root);
  try {
    const { mission, failedExecution } = failedRecoveryFixture(root);
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: failedExecution.executionId, payload: { ...failedExecution, status: "finished" } });
    const before = listArchiveRecords(root).filter((record) => record.type === "execution").length;
    const registered = [];
    const result = await startFreshSameMissionExecution({
      projectPath: root,
      projectTrusted: false,
      failedExecution,
      mission,
      executorModel: "test/model",
      executorSystemPrompt: "test prompt",
      supervision: { registerExecution: (...args) => registered.push(args) },
      isSupervisionAvailable: () => true,
    });
    assert.equal(result, false);
    assert.deepEqual(registered, []);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").length, before);
  } finally {
    restoreConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("newer finished Executor blocks recovery of an older failed Executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-failed-finished-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "failed-old", payload: { executionId: "failed-old", workId: "work", executorName: "failed-old", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "pending", status: "failed", startedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "finished-new", payload: { executionId: "finished-new", workId: "work", executorName: "finished-new", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "pending", status: "finished", startedAt: now } });
    const sessionManager = SessionManager.inMemory(root);
    const persistedRecoveryAttempts = [];
    const freshRecoveryBootstraps = [];
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} },
      conclaveParticipantId: "conclave",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
      recoverExecutor: async () => {
        persistedRecoveryAttempts.push("persisted");
        return { async getEntries() { return { entries: [], leafId: null }; } };
      },
      onExecutorRecoveryFailure: async (execution) => { freshRecoveryBootstraps.push(execution.executionId); },
    });

    await controller.recover();

    assert.deepEqual(persistedRecoveryAttempts, []);
    assert.deepEqual(freshRecoveryBootstraps, []);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").length, 2);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Executor recovery is a no-op when the current Mission has an active Executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-failed-active-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "failed", payload: { executionId: "failed", workId: "work", executorName: "failed", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "pending", status: "failed", startedAt: now } });
    const sessionPath = join(root, "active.jsonl");
    writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "active-session", cwd: root }) + "\n");
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "active", payload: { executionId: "active", workId: "work", executorName: "active", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "active-session", sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now } });
    const sessionManager = SessionManager.inMemory(root);
    const recoveryFailures = [];
    let recoveryAttempts = 0;
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} },
      conclaveParticipantId: "conclave",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
      recoverExecutor: async () => {
        recoveryAttempts += 1;
        return { async getEntries() { return { entries: [], leafId: null }; } };
      },
      onExecutorRecoveryFailure: async (execution) => { recoveryFailures.push(execution.executionId); },
    });

    await controller.recover();

    assert.deepEqual(recoveryFailures, []);
    assert.equal(recoveryAttempts, 1);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").length, 2);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-loss closure records the exact failed Execution and closes outstanding Interventions", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-loss-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { executionId: "execution", workId: "work", executorName: "E", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "intervention", workId: "work", executionId: "execution", payload: { interventionId: "intervention", phase: "issuance", actionId: "issue", workId: "work", mandateId: "mandate", missionId: "mission", executionId: "execution", conclaveParticipantId: "conclave", executorParticipantId: "executor", piSessionId: "session", assessmentId: "assessment", failureSummary: "A specific runtime failure.", category: "other", missionTerm: "S", message: "Bounded", promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, mode: "correction", piEntryIds: ["entry"], sentAt: now, transportResult: "confirmed" } });
    const failedRecordId = await failExecutionAndCloseInterventions(root, "execution");
    assert.equal(typeof failedRecordId, "string");
    const records = listArchiveRecords(root);
    assert.equal(records.at(-2).type, "execution");
    assert.equal(records.at(-2).payload.status, "failed");
    assert.equal(records.at(-1).payload.outcome, "escalated");
    assert.equal(records.at(-1).payload.failedExecutionRecordId, failedRecordId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal agent_settled accepts each current evidence-bearing Signal without a handoff", async () => {
  for (const kind of ["progress", "blocked", "finished"]) {
    const root = mkdtempSync(join(tmpdir(), `khala-supervision-recovery-settlement-${kind}-`));
    try {
      const now = new Date().toISOString();
      const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
      appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
      const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
      appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
      const observedAt = new Date(Date.now() + 1).toISOString();
      appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { executionId: "execution", workId: "work", executorName: "E", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now, lastSignalAt: observedAt } });
      appendArchiveRecord(root, { schemaVersion: 2, type: "signal", workId: "work", executionId: "execution", payload: { signalId: `signal-${kind}`, workId: "work", executionId: "execution", executorName: "E", missionId: "mission", participantId: "executor", kind, summary: "Evidence", evidence: ["persisted"], observedAt } });
      const sessionManager = SessionManager.inMemory(root);
      const entries = [{ type: "message", id: "mission-prompt", timestamp: "2020-01-01T00:00:00.000Z", message: { role: "user", content: "Mission" } }];
      let prompts = 0;
      const runtime = {
        async getEntries() { return { entries, leafId: entries.at(-1).id }; },
        async sendPrompt() { prompts += 1; },
        async closeProcess() {},
      };
      const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} }, conclaveParticipantId: "conclave", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
      controller.registerExecution(mission, "execution", runtime);
      await controller.handleRuntimeEvent({ workId: "work", missionId: "mission", executionId: "execution" }, { type: "agent_settled" }, runtime);
      assert.equal(prompts, 0);
      assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").at(-1).payload.status, "running");
      controller.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("empty settlement handoff reservation confirms a persisted marker before the next settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-handoff-ack-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { executionId: "execution", workId: "work", executorName: "E", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now } });
    const sessionManager = SessionManager.inMemory(root);
    const marker = "\\u0000KHALA_SETTLEMENT:execution:1:";
    sessionManager.appendCustomEntry("khala-supervision-settlement-handoff", { workId: "work", missionId: "mission", executionId: "execution", attempt: 1, marker, baselineSignalIds: [], promptEntryId: "" });
    const entries = [{ type: "message", id: "persisted-handoff", timestamp: now, message: { role: "user", content: `${marker} recovery` } }];
    let sends = 0;
    const runtime = { async getEntries() { return { entries, leafId: entries.at(-1).id }; }, async sendPrompt() { sends += 1; }, async closeProcess() {} };
    const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} }, conclaveParticipantId: "conclave", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
    controller.registerExecution(mission, "execution", runtime);
    await controller.handleRuntimeEvent({ workId: "work", missionId: "mission", executionId: "execution" }, { type: "agent_settled" }, runtime);
    const handoffs = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "khala-supervision-settlement-handoff");
    assert.equal(sends, 0);
    assert.equal(handoffs.at(-1).data.promptEntryId, "persisted-handoff");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty settlement handoff reservation resends once when the marker is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-handoff-resend-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { executionId: "execution", workId: "work", executorName: "E", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now } });
    const sessionManager = SessionManager.inMemory(root);
    const marker = "\\u0000KHALA_SETTLEMENT:execution:1:";
    sessionManager.appendCustomEntry("khala-supervision-settlement-handoff", { workId: "work", missionId: "mission", executionId: "execution", attempt: 1, marker, baselineSignalIds: [], promptEntryId: "" });
    const entries = [];
    let sends = 0;
    const runtime = { async getEntries() { return { entries, leafId: entries.at(-1)?.id ?? null }; }, async sendPrompt(message) { sends += 1; entries.push({ type: "message", id: "resent-handoff", timestamp: now, message: { role: "user", content: message } }); }, async closeProcess() {} };
    const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session: { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} }, conclaveParticipantId: "conclave", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
    controller.registerExecution(mission, "execution", runtime);
    await controller.handleRuntimeEvent({ workId: "work", missionId: "mission", executionId: "execution" }, { type: "agent_settled" }, runtime);
    const handoffs = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "khala-supervision-settlement-handoff");
    assert.equal(sends, 1);
    assert.equal(handoffs.at(-1).data.promptEntryId, "resent-handoff");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Settlement is a lifecycle fence: the first event gets one bounded prompt;
// a second event fails the exact runtime without manufacturing a Signal.
test("normal agent_settled uses one bounded handoff, then fails without a second prompt or synthetic Signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-recovery-settlement-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "work", payload: { mandateId: "mandate", workId: "work", revision: 1, sourceSubmissionRecordId: "submission", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    const mission = { missionId: "mission", workId: "work", mandateId: "mandate", assignment, assignedParticipantId: "executor", createdAt: now };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "work", payload: mission });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "work", executionId: "execution", payload: { executionId: "execution", workId: "work", executorName: "E", kind: "executor", participantId: "executor", purpose: { kind: "mission", missionId: "mission" }, missionId: "mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session", sessionPath: join(root, "session.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: now } });
    const sessionManager = SessionManager.inMemory(root);
    const session = { sessionManager, subscribe: () => () => {}, async sendCustomMessage() {}, async waitForIdle() {} };
    const entries = [{ type: "message", id: "mission-prompt", timestamp: now, message: { role: "user", content: "Mission" } }];
    let prompts = 0;
    const runtime = {
      async getEntries() { return { entries, leafId: entries.at(-1).id }; },
      async sendPrompt(message) { prompts += 1; entries.push({ type: "message", id: `handoff-${prompts}`, timestamp: new Date().toISOString(), message: { role: "user", content: message } }); },
      async closeProcess() {},
    };
    const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session, conclaveParticipantId: "conclave", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
    controller.registerExecution(mission, "execution", runtime);
    await controller.handleRuntimeEvent({ workId: "work", missionId: "mission", executionId: "execution" }, { type: "agent_settled" }, runtime);
    assert.equal(prompts, 1);
    await controller.handleRuntimeEvent({ workId: "work", missionId: "mission", executionId: "execution" }, { type: "agent_settled" }, runtime);
    assert.equal(prompts, 1);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "signal").length, 0);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").at(-1).payload.status, "failed");
    assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "khala-supervision-critical-event").at(-1).data.kind, "same-Mission-recovery-needed");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the dependency graph excludes dependents whose Mission is superseded", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-graph-superseded-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const base = { kind: "upstream-execution", workId: "upstream-work", missionId: "upstream-mission", executionId: "upstream-execution", remote: "origin", branch: "feature/upstream", headCommit: HEAD_A };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "dependent-work", payload: { mandateId: "dependent-mandate", workId: "dependent-work", revision: 1, sourceSubmissionRecordId: "submission-dependent", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "dependent-work", payload: { missionId: "superseded-mission", workId: "dependent-work", mandateId: "dependent-mandate", assignment, assignedParticipantId: "participant-dependent", createdAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "dependent-work", payload: { missionId: "current-mission", workId: "dependent-work", mandateId: "dependent-mandate", predecessorMissionId: "superseded-mission", causedByVerdictId: "retry-verdict", assignment, assignedParticipantId: "participant-dependent", createdAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "signal", workId: "dependent-work", executionId: "dependent-execution", payload: { signalId: "signal-retry", workId: "dependent-work", executionId: "dependent-execution", executorName: "E", missionId: "superseded-mission", participantId: "participant-dependent", kind: "blocked", summary: "Blocked.", evidence: ["e"], observedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "verdict", workId: "dependent-work", executionId: "dependent-execution", payload: { workId: "dependent-work", executionId: "dependent-execution", signalId: "signal-retry", missionId: "superseded-mission", governingMandateId: "dependent-mandate", issuedByParticipantId: "conclave", decision: "retry", reason: "Retry.", verdictId: "retry-verdict", issuedAt: now, retryHandoff: { failedCriteria: ["A"], completedWork: ["B"], requiredChanges: ["C"], nonGoals: ["D"], validation: ["E"] }, successorAssignment: assignment } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "dependent-work", executionId: "dependent-execution", payload: { executionId: "dependent-execution", workId: "dependent-work", executorName: "dependent-execution", kind: "executor", participantId: "participant-dependent", purpose: { kind: "mission", missionId: "superseded-mission" }, missionId: "superseded-mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session-dependent", sessionPath: join(root, "dependent.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, upstreamBase: base, status: "running", startedAt: now } });
    const dependents = directRevisionDependents(root, base);
    assert.deepEqual(dependents, [], "a dependent on a superseded Mission must not be projected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the dependency graph isolates dependents by remote, branch, and head", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-graph-identity-"));
  try {
    const now = new Date().toISOString();
    const assignment = { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] };
    const base = { kind: "upstream-execution", workId: "upstream-work", missionId: "upstream-mission", executionId: "upstream-execution", remote: "origin", branch: "feature/upstream", headCommit: HEAD_A };
    appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId: "dependent-work", payload: { mandateId: "dependent-mandate", workId: "dependent-work", revision: 1, sourceSubmissionRecordId: "submission-dependent", terms: assignment, admittedByParticipantId: "conclave", admittedAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "dependent-work", payload: { missionId: "dependent-mission", workId: "dependent-work", mandateId: "dependent-mandate", assignment, assignedParticipantId: "participant-dependent", createdAt: now } });
    appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "dependent-work", executionId: "dependent-execution", payload: { executionId: "dependent-execution", workId: "dependent-work", executorName: "dependent-execution", kind: "executor", participantId: "participant-dependent", purpose: { kind: "mission", missionId: "dependent-mission" }, missionId: "dependent-mission", projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: "session-dependent", sessionPath: join(root, "dependent.jsonl"), promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, upstreamBase: { ...base, branch: "feature/other" }, status: "running", startedAt: now } });
    const dependents = directRevisionDependents(root, base);
    assert.deepEqual(dependents, [], "a dependent pinned to a different branch must not match the base");
    const decision = {
      coordinationId: "coordination-other",
      actionId: "decision-other",
      phase: "decision",
      relation: "dependency",
      workId: "dependent-work",
      missionId: "dependent-mission",
      executionId: "dependent-execution",
      selectedWorkId: "upstream-work",
      selectedMissionId: "upstream-mission",
      selectedExecutionId: "upstream-execution",
      relatedWorkId: "upstream-work",
      relatedMissionId: "upstream-mission",
      relatedExecutionId: "upstream-execution",
      upstreamWorkId: "upstream-work",
      upstreamMissionId: "upstream-mission",
      upstreamExecutionId: "upstream-execution",
      remote: "origin",
      branch: "feature/upstream",
      reason: "Exact upstream base.",
    };
    appendArchiveRecord(root, { schemaVersion: 2, type: "coordination", workId: "dependent-work", executionId: "dependent-execution", payload: decision });
    appendArchiveRecord(root, { schemaVersion: 2, type: "coordination", workId: "dependent-work", executionId: "dependent-execution", payload: { ...decision, actionId: "release-other", phase: "release", upstreamHead: HEAD_B, releasedExecutionId: "dependent-execution", remoteObservation: { remote: "origin", branch: "feature/upstream", headCommit: HEAD_B, observedAt: now } } });
    const afterRelease = directRevisionDependents(root, base);
    assert.deepEqual(afterRelease, [], "a coordination pinned to a different upstream head must not match the base");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
