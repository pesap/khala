import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import {
  activeCoordinationHolds,
  projectCoordinations,
  readCurrentMission,
} from "../dist/src/khala-archive-projections.js";
import {
  invalidateCoordination,
  materializeCoordinationSuccessor,
  releaseCoordination,
  resolveCoordination,
  resolveTerminalUpstreamCoordinations,
} from "../dist/src/khala-coordination.js";
import { CONCLAVE_TOOL_ALLOWLIST } from "../dist/src/khala-conclave.js";
import { registerKhalaWork } from "../dist/src/khala-work.js";
import { createGitWorktreeProvider } from "../dist/src/vcs-git-worktree.js";

const NOW = new Date().toISOString();
const assignment = {
  title: "Coordination fixture",
  objective: "Validate concurrent Work scheduling",
  context: "Controlled fixture",
  scope: "Only the fixture contract",
  acceptanceCriteria: ["The coordination behavior is validated"],
  constraints: ["Do not change unrelated Work"],
  plan: ["Read the structured records"],
  validation: ["Inspect the Archive"],
};

function mission(root, workId, missionId, participant = `executor:${missionId}`) {
  appendArchiveRecord(root, {
    schemaVersion: 2,
    type: "mandate",
    workId,
    payload: {
      mandateId: `mandate-${workId}`,
      workId,
      revision: 1,
      sourceSubmissionRecordId: `submission-${workId}`,
      terms: assignment,
      admittedByParticipantId: "conclave:test",
      admittedAt: NOW,
    },
  });
  appendArchiveRecord(root, {
    schemaVersion: 2,
    type: "mission",
    workId,
    payload: {
      missionId,
      workId,
      mandateId: `mandate-${workId}`,
      assignment,
      assignedParticipantId: participant,
      createdAt: NOW,
    },
  });
}

function decision(root, overrides = {}) {
  const payload = {
    coordinationId: "coordination-1",
    actionId: "decision-1",
    phase: "decision",
    relation: "dependency",
    workId: "downstream",
    missionId: "downstream-mission",
    selectedWorkId: "upstream",
    selectedMissionId: "upstream-mission",
    relatedWorkId: "upstream",
    relatedMissionId: "upstream-mission",
    upstreamWorkId: "upstream",
    upstreamMissionId: "upstream-mission",
    upstreamExecutionId: "upstream-execution",
    relatedExecutionId: "upstream-execution",
    selectedExecutionId: "upstream-execution",
    remote: "origin",
    branch: "feature/upstream",
    reason: "Dependency order, observed progress, User urgency, and expected stopped-work waste favor upstream.",
    ...overrides,
  };
  appendArchiveRecord(root, { schemaVersion: 2, type: "coordination", workId: payload.workId, payload });
  return payload;
}

test("Conclave supervision allowlist is exact and has no standalone materialize tool", () => {
  assert.deepEqual(CONCLAVE_TOOL_ALLOWLIST, [
    "khala_read_archive",
    "khala_admit_work",
    "khala_launch_observer",
    "khala_launch_execution",
    "khala_verdict",
    "khala_record_work_outcome",
    "khala_steer_execution",
    "khala_coordinate_work",
    "khala_record_intervention_outcome",
    "khala_apply_user_priority",
    "khala_dispose_user_priority",
  ]);
  assert.equal(CONCLAVE_TOOL_ALLOWLIST.includes("khala_materialize_mission"), false);
});

test("existing launch tool materializes a Mission without creating an Execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-prelaunch-"));
  try {
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "mandate",
      workId: "downstream",
      payload: {
        mandateId: "mandate-downstream",
        workId: "downstream",
        revision: 1,
        sourceSubmissionRecordId: "submission-downstream",
        terms: assignment,
        admittedByParticipantId: "conclave:test",
        admittedAt: NOW,
      },
    });
    const tools = new Map();
    registerKhalaWork(
      {
        registerCommand() {},
        registerTool(tool) { tools.set(tool.name, tool); },
      },
      {
        workTemplate: "",
        executorSystemPrompt: "",
        createExecutorStarter: () => { throw new Error("materialization must not start an Executor"); },
        isDedicatedConclaveSession: () => true,
        submitWork: async () => ({ archivePath: "" }),
        getSubmission: () => ({
          recordId: "submission-downstream",
          submission: { workId: "downstream", projectPath: root, status: "admitted", work: assignment, archivePath: "", mandateId: "mandate-downstream" },
        }),
        getPendingSubmission: () => undefined,
        claimSubmission: () => false,
        markSubmissionQueued: () => {},
        markSubmissionLaunched: () => {},
      },
    );
    const result = await tools.get("khala_launch_execution").execute(
      "call-1",
      { workId: "downstream", mode: "materialize" },
      null,
      null,
      {
        cwd: root,
        isProjectTrusted: () => false,
        sessionManager: { getEntries: () => [], getBranch: () => [{ type: "custom", customType: "khala-conclave" }] },
      },
    );
    assert.equal(result.details.status, "materialized");
    assert.equal(listArchiveRecords(root).some((record) => record.type === "execution"), false);
    const current = readCurrentMission(root, "downstream", false);
    assert.equal(current?.mission.missionId, result.details.missionId);
    mission(root, "upstream", "upstream-mission");
    decision(root, { missionId: result.details.missionId, workId: "downstream" });
    assert.deepEqual(activeCoordinationHolds(root).map((hold) => [hold.workId, hold.missionId]), [["downstream", result.details.missionId]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal upstream rejection resolves every active dependency hold", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-terminal-"));
  try {
    mission(root, "downstream", "downstream-mission");
    mission(root, "upstream", "upstream-mission");
    decision(root);
    const verdict = appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "verdict",
      workId: "upstream",
      executionId: "upstream-execution",
      payload: {
        verdictId: "reject-upstream",
        workId: "upstream",
        missionId: "upstream-mission",
        executionId: "upstream-execution",
        signalId: "signal-upstream-reject",
        governingMandateId: "mandate-upstream",
        issuedByParticipantId: "conclave:test",
        decision: "reject",
        reason: "The upstream attempt cannot publish the required dependency.",
        issuedAt: NOW,
      },
    });
    const resolved = resolveTerminalUpstreamCoordinations(root, "upstream-execution", verdict.recordId);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolution, "terminal-failure");
    assert.deepEqual(activeCoordinationHolds(root), []);
    assert.deepEqual(resolveTerminalUpstreamCoordinations(root, "upstream-execution", verdict.recordId), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent Work has no Coordination record and semantic candidates are not path guesses", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-independent-"));
  try {
    mission(root, "one", "mission-one");
    mission(root, "two", "mission-two");
    assert.deepEqual(projectCoordinations(root), []);
    assert.deepEqual(activeCoordinationHolds(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release requires Finish, remote publication, and exact head, then launch resolution is ordered", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-release-"));
  try {
    mission(root, "downstream", "downstream-mission");
    mission(root, "upstream", "upstream-mission");
    const upstreamExecutionId = "upstream-execution";
    const head = "a".repeat(40);
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "execution",
      workId: "upstream",
      executionId: upstreamExecutionId,
      payload: {
        executionId: upstreamExecutionId,
        workId: "upstream",
        executorName: "Upstream",
        kind: "executor",
        participantId: "executor:upstream-mission",
        purpose: { kind: "mission", missionId: "upstream-mission" },
        missionId: "upstream-mission",
        projectPath: root,
        sandboxPath: root,
        launcher: "headless-rpc",
        piSessionId: "pi-upstream",
        sessionPath: join(root, "upstream.jsonl"),
        promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
        status: "finished",
        startedAt: NOW,
      },
    });
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "verdict",
      workId: "upstream",
      executionId: upstreamExecutionId,
      payload: {
        workId: "upstream",
        executionId: upstreamExecutionId,
        signalId: "signal-upstream",
        missionId: "upstream-mission",
        governingMandateId: "mandate-upstream",
        issuedByParticipantId: "conclave:test",
        decision: "finish",
        reason: "Published and ready for review.",
        verdictId: "verdict-upstream",
        issuedAt: NOW,
      },
    });
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "pull-request",
      workId: "upstream",
      executionId: upstreamExecutionId,
      payload: {
        pullRequestId: "pr-upstream",
        workId: "upstream",
        missionId: "upstream-mission",
        executionId: upstreamExecutionId,
        status: "reviewable",
        sourceBranch: "feature/upstream",
        headCommit: head,
        remoteConfirmedAt: NOW,
        changedFiles: [],
        diffSummary: "Published",
        validationResults: [],
        reviewFeedback: [],
        unresolvedGaps: [],
        recordedAt: NOW,
      },
    });
    decision(root, { upstreamExecutionId, relatedExecutionId: upstreamExecutionId });
    assert.throws(
      () => releaseCoordination({ projectPath: root, coordinationId: "coordination-1", actionId: "release-bad", evidence: { remote: "origin", branch: "feature/upstream", headCommit: head, verifiedHeadCommit: "b".repeat(40), observedAt: NOW } }),
      /exact verified/,
    );
    const release = releaseCoordination({ projectPath: root, coordinationId: "coordination-1", actionId: "release-1", evidence: { remote: "origin", branch: "feature/upstream", headCommit: head, verifiedHeadCommit: head, observedAt: NOW } });
    assert.equal(release.phase, "release");
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "execution",
      workId: "downstream",
      executionId: "downstream-execution",
      payload: {
        executionId: "downstream-execution",
        workId: "downstream",
        executorName: "Downstream",
        kind: "executor",
        participantId: "executor:downstream-mission",
        purpose: { kind: "mission", missionId: "downstream-mission" },
        missionId: "downstream-mission",
        projectPath: root,
        sandboxPath: root,
        launcher: "headless-rpc",
        piSessionId: "pi-downstream",
        sessionPath: join(root, "downstream.jsonl"),
        promptIdentity: { packageVersion: "test", promptSha256: "b".repeat(64) },
        upstreamBase: { kind: "upstream-execution", workId: "upstream", missionId: "upstream-mission", executionId: upstreamExecutionId, remote: "origin", branch: "feature/upstream", headCommit: head },
        status: "running",
        startedAt: NOW,
      },
    });
    const resolved = resolveCoordination({ projectPath: root, coordinationId: "coordination-1", actionId: "resolution-1", releasedExecutionId: "downstream-execution" });
    assert.equal(resolved.phase, "resolution");
    assert.equal(projectCoordinations(root)[0].resolved, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidation preserves the superseded base and creates a causal successor for finished stacked Work", () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-invalidation-"));
  try {
    mission(root, "downstream", "downstream-mission");
    mission(root, "upstream", "upstream-mission");
    const oldHead = "a".repeat(40);
    decision(root, { upstreamExecutionId: "upstream-execution", relatedExecutionId: "upstream-execution" });
    appendArchiveRecord(root, {
      schemaVersion: 2,
      type: "verdict",
      workId: "downstream",
      executionId: "downstream-execution",
      payload: {
        workId: "downstream",
        executionId: "downstream-execution",
        signalId: "signal-downstream",
        missionId: "downstream-mission",
        governingMandateId: "mandate-downstream",
        issuedByParticipantId: "conclave:test",
        decision: "finish",
        reason: "Stacked reviewable Work.",
        verdictId: "verdict-downstream",
        issuedAt: NOW,
      },
    });
    const invalidation = invalidateCoordination({
      projectPath: root,
      coordinationId: "coordination-1",
      actionId: "invalidation-1",
      supersededHead: oldHead,
      replacementHead: "b".repeat(40),
      affectedDependents: [{ workId: "downstream", missionId: "downstream-mission", supersededHead: oldHead }],
      evidence: { remote: "origin", branch: "feature/upstream", headCommit: "b".repeat(40), observedAt: NOW },
    });
    assert.equal(invalidation.phase, "invalidation");
    const successor = materializeCoordinationSuccessor(root, "downstream", "downstream-mission", "coordination-1");
    assert.equal(successor.causedByCoordinationId, "coordination-1");
    assert.equal(successor.predecessorMissionId, "downstream-mission");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git worktree provider verifies an exact upstream commit instead of the target branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-coordination-lifecycle-vcs-"));
  const worktrees = join(root, "worktrees");
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Khala Test"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: root, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["commit", "--allow-empty", "-m", "later"], { cwd: root, stdio: "ignore" });
    const provider = createGitWorktreeProvider(worktrees, "khala/");
    const sandbox = await provider.createSandbox({ projectPath: root, name: "dependent", baseBranch: "main", baseCommit: base });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: sandbox.path, encoding: "utf8" }).trim(), base);
    await provider.removeSandbox(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
