import assert from "node:assert/strict";
import test from "node:test";
import { projectExecutionMonitor } from "../dist/src/khala-supervision-projection.js";
import { renderExecutionDetails } from "../dist/src/khala-session-list.js";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const NOW = "2026-01-01T00:00:00.000Z";
const assignment = {
  title: "Monitor fixture",
  objective: "Show bounded monitor facts",
  context: "Controlled fixture",
  scope: "Only the fixture",
  acceptanceCriteria: ["The monitor is factual"],
  constraints: ["Do not invent evidence"],
  plan: ["Read the fixture"],
  validation: ["Run the monitor test"],
};

function execution(status = "running") {
  return {
    executionId: "execution-1",
    workId: "dependent-work",
    executorName: "Executor",
    kind: "executor",
    participantId: "executor-1",
    purpose: { kind: "mission", missionId: "dependent-mission" },
    missionId: "dependent-mission",
    projectPath: "/project",
    sandboxPath: "/sandbox",
    launcher: "headless-rpc",
    piSessionId: "pi-1",
    sessionPath: "/session.jsonl",
    promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
    upstreamBase: {
      kind: "upstream-execution",
      workId: "upstream-work",
      missionId: "upstream-mission",
      executionId: "upstream-execution",
      remote: "origin",
      branch: "feature/upstream",
      headCommit: HEAD,
    },
    status,
    startedAt: NOW,
  };
}

function mission() {
  return {
    missionId: "dependent-mission",
    workId: "dependent-work",
    mandateId: "mandate-1",
    assignment,
    assignedParticipantId: "executor-1",
    createdAt: NOW,
  };
}

function custom(customType, data, id = customType) {
  return { type: "custom", id, parentId: null, timestamp: NOW, customType, data };
}

function coordination(phase = "invalidation") {
  return {
    coordinationId: "coordination-1",
    actionId: `coordination-${phase}`,
    phase,
    relation: "dependency",
    workId: "dependent-work",
    missionId: "dependent-mission",
    executionId: "execution-1",
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
    upstreamHead: HEAD,
    replacementHead: "b".repeat(40),
    affectedDependents: [{ workId: "dependent-work", missionId: "dependent-mission", executionId: "execution-1", supersededHead: HEAD }],
    remoteObservation: { remote: "origin", branch: "feature/upstream", headCommit: "b".repeat(40), observedAt: NOW },
    reason: "The upstream Work changed; this dependent must be rerun.",
  };
}

function monitor(overrides = {}) {
  return projectExecutionMonitor({
    execution: { ...execution(), ...overrides },
    runtimeAvailable: true,
    workTitle: "Monitor fixture",
    missions: [mission()],
    signals: [],
    archiveRecords: [],
    conclaveEntries: [],
    config: {
      conclaveModel: "provider/conclave",
      executorModel: "provider/executor",
      conclaveMaxCostUsdPerTurn: 0.25,
      executorMaxCostUsdPerTurn: 1,
    },
  });
}

test("Supervision monitor projects headless and supervision state independently, with exact stale base evidence", () => {
  const projected = projectExecutionMonitor({
    execution: execution(),
    runtimeAvailable: true,
    workTitle: "Monitor fixture",
    missions: [mission()],
    signals: [],
    archiveRecords: [{ recordId: "coordination-record", schemaVersion: 2, type: "coordination", projectPath: "/project", workId: "dependent-work", recordedAt: NOW, payload: coordination() }],
    conclaveEntries: [],
    config: { conclaveModel: "provider/conclave", executorModel: "provider/executor", conclaveMaxCostUsdPerTurn: 0.25, executorMaxCostUsdPerTurn: 1 },
  });
  assert.equal(projected.runtimeState, "running");
  assert.equal(projected.supervisionState, "connected");
  assert.equal(projected.upstream.stale, true);
  assert.equal(projected.upstream.headCommit, HEAD);
  assert.equal(projected.coordination.requiredUpstreamCommit, HEAD);
});

test("Supervision monitor does not present an orphaned persisted Execution as running or connected", () => {
  const projected = projectExecutionMonitor({
    ...monitorInput("running"),
    runtimeAvailable: false,
  });

  assert.equal(projected.runtimeState, "unavailable");
  assert.equal(projected.supervisionState, "unavailable");
  const text = renderExecutionDetails(
    { identity: "execution-1", executionMonitor: projected },
    80,
    { fg: (_color, value) => value },
  ).join("\n");
  assert.match(text, /Runtime: headless unavailable/);
  assert.doesNotMatch(text, /Runtime: headless running/);
  assert.doesNotMatch(text, /Supervision: connected/);
});

test("Supervision monitor keeps grace unavailable, failed steer failed, and settlement incomplete", () => {
  const unavailable = projectExecutionMonitor({
    execution: execution(),
    runtimeAvailable: true,
    workTitle: "Monitor fixture",
    missions: [mission()],
    signals: [],
    archiveRecords: [],
    conclaveEntries: [custom("khala-supervision-outage", { outageId: "outage-1", kind: "conclave-model", state: "open", failedCheckCount: 0, deadlineAt: "2026-01-01T00:01:30.000Z", executionIds: ["execution-1"], workIds: ["dependent-work"] })],
    config: { conclaveModel: "provider/conclave", executorModel: "provider/executor", conclaveMaxCostUsdPerTurn: 0.25, executorMaxCostUsdPerTurn: 1 },
  });
  assert.equal(unavailable.supervisionState, "unavailable");
  assert.equal(unavailable.grace.failedCheckCount, 0);
  assert.equal(unavailable.grace.deadlineAt, "2026-01-01T00:01:30.000Z");

  const runtimeFailure = projectExecutionMonitor({
    ...monitorInput("failed"),
    conclaveEntries: [custom("khala-supervision-critical-event", { executionId: "execution-1", reason: "The Executor RPC process exited." })],
  });
  assert.equal(runtimeFailure.runtimeState, "failed");
  assert.match(runtimeFailure.latestSignificantAction.details.join(" "), /RPC process exited/);

  const failedSteer = projectExecutionMonitor({
    ...monitorInput("running"),
    conclaveEntries: [custom("khala-supervision-action-start", { actionId: "failed-steer", actionKind: "steer", mode: "correction", target: { executionId: "execution-1" } })],
  });
  assert.equal(failedSteer.steer.status, "failed");
  assert.equal(failedSteer.latestSignificantAction.kind, "failure");

  const settled = projectExecutionMonitor({ ...monitorInput("finished") });
  assert.equal(settled.supervisionState, "settled");
  assert.equal(settled.incomplete, true);
});

test("Supervision monitor exposes models, thresholds, unavailable pricing, and persistent overrun", () => {
  const projected = projectExecutionMonitor({
    ...monitorInput("running"),
    conclaveEntries: [
      custom("khala-supervision-budget", { actor: "executor", executionId: "execution-1", thresholdUsd: 1, availability: "unavailable", overrun: true }),
      custom("khala-supervision-budget", { actor: "conclave", executionId: "execution-1", thresholdUsd: 0, costUsd: 0, overrun: false }),
    ],
  });
  assert.equal(projected.models.conclave, "provider/conclave");
  assert.equal(projected.thresholds.executorUsd, 1);
  assert.equal(projected.latestTurnCost.executor.costUsd, undefined);
  assert.equal(projected.latestTurnCost.executor.overrun, true);
  assert.equal(projected.latestSignificantAction.summary, "Advisory executor budget overrun; work continues.");
});

test("Supervision monitor rendering stays plain and narrow while retaining full base evidence and action facts", () => {
  const projected = monitor({});
  const session = { identity: "execution-1", executionMonitor: projected };
  const theme = { fg: (_color, text) => text };
  for (const width of [20, 40]) {
    const lines = renderExecutionDetails(session, width, theme);
    assert.ok(lines.every((line) => [...line].length <= width));
  }
  const text = renderExecutionDetails({ identity: "execution-1", executionMonitor: monitor({}) }, 40, theme).join("\n");
  assert.match(text, /abcdef0123456789abcdef0123456789abcdef01/);
  assert.match(text, /provider\/conclave/);
  assert.match(text, /unavailable/);

  const coordinationText = renderExecutionDetails(
    {
      identity: "execution-1",
      executionMonitor: projectExecutionMonitor({
        ...monitorInput("running"),
        archiveRecords: [{ recordId: "coordination-record", schemaVersion: 2, type: "coordination", projectPath: "/project", workId: "dependent-work", recordedAt: NOW, payload: coordination("decision") }],
      }),
    },
    40,
    theme,
  ).join("\n");
  assert.match(coordinationText, /Override by speaking in the Conclave\s+session/);
  assert.match(coordinationText, /Required upstream commit/);
});

function monitorInput(status) {
  return {
    execution: execution(status),
    runtimeAvailable: true,
    workTitle: "Monitor fixture",
    missions: [mission()],
    signals: [],
    archiveRecords: [],
    conclaveEntries: [],
    config: { conclaveModel: "provider/conclave", executorModel: "provider/executor", conclaveMaxCostUsdPerTurn: 0.25, executorMaxCostUsdPerTurn: 1 },
  };
}
