import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { updateExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { deterministicActionId, deterministicAssessmentId, SupervisionController } from "../dist/src/khala-supervision.js";
import {
  COORDINATE_PARAMETERS,
  mandatoryStopPrompt,
  registerKhalaSupervisionTools,
  recordCoordination,
  recordInterventionOutcome,
  steerExecution,
  supervisionMarker,
} from "../dist/src/khala-supervision-tools.js";

const NOW = new Date().toISOString();

function fakePi() {
  const tools = [];
  return {
    tools,
    registerTool(tool) {
      tools.push(tool);
    },
  };
}

test("Supervision control registers the five dedicated Conclave control tools", () => {
  const pi = fakePi();
  registerKhalaSupervisionTools(pi, { isDedicatedConclaveSession: () => true });
  assert.deepEqual(toolsByName(pi), [
    "khala_apply_user_priority",
    "khala_coordinate_work",
    "khala_dispose_user_priority",
    "khala_record_intervention_outcome",
    "khala_steer_execution",
  ]);
});

test("supervision markers and mandatory stop handoff remain bounded and prohibit changes", () => {
  const marker = supervisionMarker("action-1", "stop");
  assert.match(marker, /^\u0000KHALA_SUPERVISION:stop:action-1:$/);
  const prompt = mandatoryStopPrompt("peer conflict", "Report the exact conflict.");
  assert.match(prompt, /Do not modify, create, delete, or stage any files/);
  assert.match(prompt, /exactly one current blocked khala_signal/);
  assert.match(prompt, /peer conflict/);
});

test("correction waits for the marked persisted Pi User entry and replays idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-correction-"));
  try {
    const fixture = createFixture(root, "correction");
    const calls = [];
    let delivered = false;
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer(message) {
        calls.push(["steer", message]);
        if (!delivered) {
          delivered = true;
          fixture.entries.push({ type: "message", id: "target-entry", message: { role: "user", content: message } });
        }
      },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async sendPrompt() { throw new Error("not used"); },
      async sendAbort() { throw new Error("not used"); },
      async waitForSettled() { throw new Error("not used"); },
      setStopPending() {},
      async restartFromSession() {},
      async closeProcess() {},
    };
    const params = steerParams(fixture, "steer");
    const context = fixture.context;
    const first = await steerExecution(params, context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime, deliveryTimeoutMs: 100, pollIntervalMs: 1 });
    const second = await steerExecution(params, context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime, deliveryTimeoutMs: 100, pollIntervalMs: 1 });
    assert.equal(calls.length, 1);
    assert.equal(first.details.interventionId, second.details.interventionId);
    const actionEntries = context.sessionManager.getEntries().filter((entry) => entry.type === "custom" && (entry.customType === "khala-supervision-action-start" || entry.customType === "khala-supervision-action-complete"));
    assert.deepEqual(actionEntries.map((entry) => entry.customType), ["khala-supervision-action-start", "khala-supervision-action-complete"]);
    writeFileSync(fixture.sessionPath, `{"type":"session","version":3,"id":"${fixture.executionId}","cwd":"${root}"}\n${JSON.stringify({ type: "message", id: "target-entry", parentId: null, timestamp: NOW, message: { role: "user", content: "bounded correction" } })}\n${JSON.stringify({ type: "message", id: "observed-response", parentId: "target-entry", timestamp: NOW, message: { role: "assistant", content: "Correction applied." } })}\n`);
    const outcomeParams = {
      assessmentId: fixture.assessmentId,
      actionId: deterministicActionId(fixture.assessmentId, "intervention-outcome"),
      interventionId: first.details.interventionId,
      workId: fixture.workId,
      missionId: fixture.missionId,
      executionId: fixture.executionId,
      outcome: "resolved",
      reason: "The later Executor response confirms the bounded correction was applied.",
      observedEntryIds: ["observed-response"],
    };
    await assert.rejects(
      recordInterventionOutcome(
        { ...outcomeParams, observedEntryIds: ["target-entry"] },
        context,
        { isDedicatedConclaveSession: () => true },
      ),
      /later Executor response or tool-result/,
    );
    const closed = await recordInterventionOutcome(outcomeParams, context, { isDedicatedConclaveSession: () => true });
    const replay = await recordInterventionOutcome(outcomeParams, context, { isDedicatedConclaveSession: () => true });
    assert.equal(closed.details.outcome, "resolved");
    assert.equal(replay.details.outcome, "resolved");
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "intervention").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncertain correction delivery inspects before restarting and resends the same action once", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-uncertain-"));
  try {
    const fixture = createFixture(root, "uncertain");
    let sends = 0;
    let recoveries = 0;
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer(message) {
        sends += 1;
        if (sends === 2) fixture.entries.push({ type: "message", id: "recovered-entry", message: { role: "user", content: message } });
      },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async sendPrompt() { throw new Error("not used"); },
      async sendAbort() { throw new Error("not used"); },
      async waitForSettled() { throw new Error("not used"); },
      setStopPending() {},
      async stopForRecovery() { recoveries += 1; },
      async restartFromSession() { recoveries += 1; },
      async closeProcess() {},
    };
    const result = await steerExecution(steerParams(fixture, "steer"), fixture.context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime, deliveryTimeoutMs: 5, pollIntervalMs: 1 });
    assert.match(result.content[0].text, /recovered-entry/);
    assert.equal(sends, 2);
    assert.equal(recoveries, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop sets the barrier, aborts, waits for settlement, and fences the one handoff prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-stop-"));
  try {
    const fixture = createFixture(root, "stop");
    const calls = [];
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer() { throw new Error("not used"); },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async sendAbort() { calls.push("abort"); },
      async waitForSettled() { calls.push("settled"); },
      setStopPending() { calls.push("barrier"); },
      async sendStopHandoff(message) {
        calls.push("prompt");
        fixture.entries.push({ type: "message", id: "stop-entry", message: { role: "user", content: message } });
      },
      async restartFromSession() {},
      async closeProcess() {},
    };
    const params = steerParams(fixture, "stop");
    const result = await steerExecution(params, fixture.context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime, deliveryTimeoutMs: 100, pollIntervalMs: 1 });
    assert.deepEqual(calls, ["barrier", "abort", "settled", "prompt"]);
    assert.match(result.content[0].text, /persisted Pi entries stop-entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reservation revalidation tolerates a benign post-delivery Execution record", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-reservation-race-"));
  try {
    const fixture = createFixture(root, "reservation-race");
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer(message) {
        fixture.entries.push({ type: "message", id: "reservation-entry", message: { role: "user", content: message } });
        updateExecutorRecord(root, fixture.executionId, { lastSignalAt: new Date().toISOString() });
      },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async sendPrompt() { throw new Error("not used"); },
      async sendAbort() { throw new Error("not used"); },
      async waitForSettled() { throw new Error("not used"); },
      setStopPending() {},
      async restartFromSession() {},
      async closeProcess() {},
    };
    const result = await steerExecution(steerParams(fixture, "steer"), fixture.context, {
      isDedicatedConclaveSession: () => true,
      getRuntime: () => runtime,
      deliveryTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.equal(result.details.delivery.persisted, true);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "intervention").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fast stop settlement consumes pre-issuance Signals against the handoff baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-fast-stop-"));
  try {
    const fixture = createFixture(root, "fast-stop");
    appendSignal(root, fixture, "signal-before-handoff", "progress");
    const listeners = [];
    const conclaveSession = {
      sessionManager: fixture.context.sessionManager,
      messages: [],
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async sendCustomMessage(message) { fixture.context.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
      async waitForIdle() {},
    };
    const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session: conclaveSession, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
    const mission = { missionId: fixture.missionId, workId: fixture.workId, mandateId: "mandate-fast-stop", assignment: fixture.assignment, assignedParticipantId: `executor:${fixture.executionId}`, createdAt: NOW };
    const identity = { workId: fixture.workId, missionId: fixture.missionId, executionId: fixture.executionId };
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer() { throw new Error("not used"); },
      async sendAbort() {},
      async waitForSettled() {},
      setStopPending() {},
      getStopHandoffSettlementObservation() { return { target: 1, observed: true }; },
      async sendStopHandoff(message) {
        appendSignal(root, fixture, "signal-after-baseline-before-issuance", "blocked");
        fixture.entries.push({ type: "message", id: "fast-stop-entry", message: { role: "user", content: message } });
        await controller.handleRuntimeEvent(identity, { type: "agent_settled" }, runtime);
      },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async closeProcess() { throw new Error("must not close a valid stop"); },
    };
    controller.registerExecution(mission, fixture.executionId, runtime);
    const result = await steerExecution(steerParams(fixture, "stop"), fixture.context, {
      isDedicatedConclaveSession: () => true,
      getRuntime: () => runtime,
      registerStopHandoffExpectation: (_context, expectation) => controller.registerStopHandoffExpectation(expectation),
      deliveryTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.match(result.content[0].text, /fast-stop-entry/);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "signal").length, 2);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "execution").at(-1).payload.status, "running");
    assert.equal(fixture.context.sessionManager.getEntries().some((entry) => entry.customType === "khala-supervision-critical-event"), false);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop mode rejects ordinary scope drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-stop-category-"));
  try {
    const fixture = createFixture(root, "stop-category");
    const runtime = { async sendSteer() { throw new Error("must not transport"); } };
    await assert.rejects(
      () => steerExecution({ ...steerParams(fixture, "stop"), category: "scope" }, fixture.context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime }),
      /Stop mode is permitted only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function appendSignal(root, fixture, signalId, kind) {
  appendArchiveRecord(root, {
    schemaVersion: 2,
    type: "signal",
    workId: fixture.workId,
    executionId: fixture.executionId,
    payload: {
      signalId,
      workId: fixture.workId,
      executionId: fixture.executionId,
      executorName: "Fixture",
      missionId: fixture.missionId,
      participantId: `executor:${fixture.executionId}`,
      kind,
      summary: "The stop handoff is being reported.",
      evidence: ["fixture"],
      observedAt: NOW,
    },
  });
}

test("peer-conflict Coordination records current Mission identities before either side has an Execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-peer-conflict-prelaunch-"));
  try {
    const assignment = {
      title: "Peer-conflict fixture",
      objective: "Compare concurrent Work",
      context: "Controlled fixture",
      scope: "Only the assigned fixture",
      acceptanceCriteria: ["The fixture is validated"],
      constraints: ["Do not change the fixture contract"],
      plan: ["Run the fixture"],
      validation: ["Inspect the persisted result"],
    };
    appendMissionOnly(root, "primary", assignment);
    appendMissionOnly(root, "related", assignment);
    const decision = {
      actionId: "coordinate-peer-conflict-prelaunch",
      coordinationId: "coordination-peer-conflict-prelaunch",
      phase: "decision",
      relation: "peer-conflict",
      workId: "work-primary",
      missionId: "mission-primary",
      relatedWorkId: "work-related",
      relatedMissionId: "mission-related",
      selectedWorkId: "work-primary",
      selectedMissionId: "mission-primary",
      reason: "Both current Missions modify the same contract and neither side has launched.",
    };
    const result = await recordCoordination(
      decision,
      {
        cwd: root,
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "khala-conclave", data: {} }],
          getSessionFile: () => join(root, "conclave-session.jsonl"),
        },
        isProjectTrusted: () => false,
      },
      { isDedicatedConclaveSession: () => true },
    );
    assert.equal(result.details.relation, "peer-conflict");
    assert.equal(result.details.executionId, undefined);
    assert.equal(result.details.relatedExecutionId, undefined);
    assert.equal(result.details.selectedExecutionId, undefined);
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer-conflict Coordination rejects an omitted related active Execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-peer-conflict-related-required-"));
  try {
    const fixture = createFixture(root, "related-required");
    appendSide(root, "related-required-side", fixture.assignment);
    await assert.rejects(
      () => recordCoordination({
        actionId: "coordinate-peer-conflict-related-required",
        coordinationId: "coordination-peer-conflict-related-required",
        phase: "decision",
        relation: "peer-conflict",
        workId: fixture.workId,
        missionId: fixture.missionId,
        executionId: fixture.executionId,
        relatedWorkId: "work-related-required-side",
        relatedMissionId: "mission-related-required-side",
        selectedWorkId: fixture.workId,
        selectedMissionId: fixture.missionId,
        reason: "Both active Missions overlap.",
      }, fixture.context, { isDedicatedConclaveSession: () => true }),
      /related active Execution identity/,
    );
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer-conflict Coordination accepts and persists the exact related active Execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-peer-conflict-related-exact-"));
  try {
    const fixture = createFixture(root, "related-exact");
    appendSide(root, "related-exact-side", fixture.assignment);
    const result = await recordCoordination({
      actionId: "coordinate-peer-conflict-related-exact",
      coordinationId: "coordination-peer-conflict-related-exact",
      phase: "decision",
      relation: "peer-conflict",
      workId: fixture.workId,
      missionId: fixture.missionId,
      executionId: fixture.executionId,
      relatedWorkId: "work-related-exact-side",
      relatedMissionId: "mission-related-exact-side",
      relatedExecutionId: "execution-related-exact-side",
      selectedWorkId: fixture.workId,
      selectedMissionId: fixture.missionId,
      selectedExecutionId: fixture.executionId,
      reason: "Both active Missions overlap.",
    }, fixture.context, { isDedicatedConclaveSession: () => true });
    assert.equal(result.details.relatedExecutionId, "execution-related-exact-side");
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer-conflict Coordination rejects stale failed or finished related Execution identities", async () => {
  for (const status of ["failed", "finished"]) {
    const root = mkdtempSync(join(tmpdir(), `khala-supervision-controls-peer-conflict-related-${status}-`));
    try {
      const fixture = createFixture(root, `related-stale-primary-${status}`);
      appendSide(root, `related-stale-${status}`, fixture.assignment);
      const relatedExecutionId = `execution-related-stale-${status}`;
      updateExecutorRecord(root, relatedExecutionId, { status });
      await assert.rejects(
        () => recordCoordination({
          actionId: `coordinate-peer-conflict-related-stale-${status}`,
          coordinationId: `coordination-peer-conflict-related-stale-${status}`,
          phase: "decision",
          relation: "peer-conflict",
          workId: fixture.workId,
          missionId: fixture.missionId,
          executionId: fixture.executionId,
          relatedWorkId: `work-related-stale-${status}`,
          relatedMissionId: `mission-related-stale-${status}`,
          relatedExecutionId,
          selectedWorkId: fixture.workId,
          selectedMissionId: fixture.missionId,
          selectedExecutionId: fixture.executionId,
          reason: `The related Mission is ${status} and has no active Execution.`,
        }, fixture.context, { isDedicatedConclaveSession: () => true }),
        /must omit the related Execution identity/,
      );
      assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("peer-conflict Coordination rejects an omitted primary active Execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-peer-conflict-primary-required-"));
  try {
    const fixture = createFixture(root, "primary-required");
    appendSide(root, "primary-required-side", fixture.assignment);
    await assert.rejects(
      () => recordCoordination({
        actionId: "coordinate-peer-conflict-primary-required",
        coordinationId: "coordination-peer-conflict-primary-required",
        phase: "decision",
        relation: "peer-conflict",
        workId: fixture.workId,
        missionId: fixture.missionId,
        relatedWorkId: "work-primary-required-side",
        relatedMissionId: "mission-primary-required-side",
        relatedExecutionId: "execution-primary-required-side",
        selectedWorkId: fixture.workId,
        selectedMissionId: fixture.missionId,
        reason: "Both active Missions overlap.",
      }, fixture.context, { isDedicatedConclaveSession: () => true }),
      /primary active Execution identity/,
    );
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer-conflict Coordination rejects a stale finished primary Execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-peer-conflict-primary-stale-"));
  try {
    const fixture = createFixture(root, "primary-stale");
    appendSide(root, "primary-stale-related", fixture.assignment);
    updateExecutorRecord(root, fixture.executionId, { status: "finished" });
    await assert.rejects(
      () => recordCoordination({
        actionId: "coordinate-peer-conflict-primary-stale",
        coordinationId: "coordination-peer-conflict-primary-stale",
        phase: "decision",
        relation: "peer-conflict",
        workId: fixture.workId,
        missionId: fixture.missionId,
        executionId: fixture.executionId,
        relatedWorkId: "work-primary-stale-related",
        relatedMissionId: "mission-primary-stale-related",
        selectedWorkId: fixture.workId,
        selectedMissionId: fixture.missionId,
        reason: "The primary Mission finished and has no active Execution.",
      }, fixture.context, { isDedicatedConclaveSession: () => true }),
      /not a current starting or running Executor/,
    );
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency Coordination still requires the selected upstream Execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-dependency-execution-"));
  try {
    const fixture = createFixture(root, "dependency-missing");
    appendSide(root, "related", fixture.assignment);
    await assert.rejects(
      () => recordCoordination({
        actionId: "coordinate-dependency-missing-execution",
        coordinationId: "coordination-dependency-missing-execution",
        phase: "decision",
        relation: "dependency",
        workId: fixture.workId,
        missionId: fixture.missionId,
        executionId: fixture.executionId,
        relatedWorkId: "work-related",
        relatedMissionId: "mission-related",
        selectedWorkId: "work-related",
        selectedMissionId: "mission-related",
        reason: "The primary Work must wait for the related Work.",
        remote: "origin",
        branch: "feature/related",
      }, fixture.context, { isDedicatedConclaveSession: () => true }),
      /selected upstream Execution/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency Coordination records exact upstream identity through the decision-only schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-coordinate-"));
  try {
    assert.equal(COORDINATE_PARAMETERS.properties.phase.const, "decision");
    assert.equal("userEntryId" in COORDINATE_PARAMETERS.properties, false);
    assert.equal("priorityId" in COORDINATE_PARAMETERS.properties, false);
    assert.equal(COORDINATE_PARAMETERS.required.includes("relatedExecutionId"), false);

    const fixture = createFixture(root, "primary");
    appendSide(root, "related", fixture.assignment);
    const decision = {
      assessmentId: fixture.assessmentId,
      actionId: deterministicActionId(fixture.assessmentId, "coordinate"),
      coordinationId: "coordination-supervision-controls",
      phase: "decision",
      relation: "dependency",
      workId: fixture.workId,
      missionId: fixture.missionId,
      executionId: fixture.executionId,
      relatedWorkId: "work-related",
      relatedMissionId: "mission-related",
      relatedExecutionId: "execution-related",
      selectedWorkId: "work-related",
      selectedMissionId: "mission-related",
      selectedExecutionId: "execution-related",
      reason: "The primary Work must publish before the dependent Work starts.",
      remote: "origin",
      branch: "feature/related",
    };
    const first = await recordCoordination(decision, fixture.context, { isDedicatedConclaveSession: () => true });
    assert.equal(first.details.upstreamWorkId, "work-related");
    assert.equal(listArchiveRecords(root).filter((record) => record.type === "coordination").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop settlement failure marks the latest Execution and records its exact failed record ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-stop-failure-"));
  try {
    const fixture = createFixture(root, "stop-failure");
    const listeners = [];
    const conclaveSession = {
      sessionManager: fixture.context.sessionManager,
      messages: [],
      subscribe(listener) { listeners.push(listener); return () => {}; },
      async sendCustomMessage(message) { fixture.context.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
      async waitForIdle() {},
    };
    const controller = new SupervisionController({ projectPath: root, projectTrusted: false, session: conclaveSession, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
    const mission = { missionId: fixture.missionId, workId: fixture.workId, mandateId: "mandate-stop-failure", assignment: fixture.assignment, assignedParticipantId: `executor:${fixture.executionId}`, createdAt: NOW };
    const calls = [];
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer() { throw new Error("not used"); },
      async sendAbort() { calls.push("abort"); },
      async waitForSettled() { calls.push("settled"); },
      setStopPending() { calls.push("barrier"); },
      async sendStopHandoff(message) { calls.push("handoff"); fixture.entries.push({ type: "message", id: "handoff-entry", message: { role: "user", content: message } }); },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async closeProcess() { calls.push("close"); },
    };
    controller.registerExecution(mission, fixture.executionId, runtime);
    const result = await steerExecution(steerParams(fixture, "stop"), fixture.context, {
      isDedicatedConclaveSession: () => true,
      getRuntime: () => runtime,
      registerStopHandoffExpectation: (_context, expectation) => controller.registerStopHandoffExpectation(expectation),
      deliveryTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.match(result.content[0].text, /persisted Pi entries handoff-entry/);
    await controller.handleRuntimeEvent({ workId: fixture.workId, missionId: fixture.missionId, executionId: fixture.executionId }, { type: "agent_settled" }, runtime);
    const records = listArchiveRecords(root);
    const executionRecords = records.filter((record) => record.type === "execution" && record.executionId === fixture.executionId);
    const latestExecution = executionRecords.at(-1);
    const critical = fixture.context.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "khala-supervision-critical-event");
    assert.equal(latestExecution.payload.status, "failed");
    assert.equal(critical.data.failedExecutionRecordId, latestExecution.recordId);
    assert.equal(records.filter((record) => record.type === "signal").length, 0);
    assert.deepEqual(calls, ["barrier", "abort", "settled", "handoff", "close"]);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("steering rejects authority-changing mutation language while retaining canonical term checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-controls-mutation-"));
  try {
    const fixture = createFixture(root, "mutation");
    const runtime = {
      sessionPath: fixture.sessionPath,
      async sendSteer() { throw new Error("must not transport mutation"); },
      async getEntries() { return { entries: fixture.entries, leafId: fixture.entries.at(-1)?.id ?? null }; },
      async sendStopHandoff() { throw new Error("not used"); },
      async sendAbort() { throw new Error("not used"); },
      async waitForSettled() { throw new Error("not used"); },
      setStopPending() {},
      async restartFromSession() {},
      async closeProcess() {},
    };
    for (const phrase of ["the constraint no longer applies", "disregard the acceptance criterion", "this constraint is optional", "use a different deliverable instead of the scope", "substitute the acceptance", "redefine the deliverable"]) {
      await assert.rejects(
        () => steerExecution({ ...steerParams(fixture, "steer"), reason: phrase }, fixture.context, { isDedicatedConclaveSession: () => true, getRuntime: () => runtime }),
        /cannot mutate Mission/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervision control authorization fails closed before inspecting untrusted parameters", async () => {
  const params = {
    assessmentId: "assessment-1",
    actionId: "action-1",
    workId: "work-1",
    missionId: "mission-1",
    executionId: "execution-1",
    mode: "correction",
    category: "scope",
    missionTerm: "scope",
    reason: "return to the assigned scope",
    message: "Continue only within the assigned scope.",
    triggeringExecutorEntryIds: ["entry-1"],
  };
  const context = {
    cwd: "/tmp/supervision-controls-authorization",
    sessionManager: {},
    isProjectTrusted: () => false,
  };
  await assert.rejects(
    () => steerExecution(params, context, { isDedicatedConclaveSession: () => false }),
    /Only the dedicated project Conclave/,
  );
});

function toolsByName(pi) {
  return pi.tools.map((tool) => tool.name).sort();
}

function steerParams(fixture, actionKind) {
  return {
    assessmentId: fixture.assessmentId,
    actionId: deterministicActionId(fixture.assessmentId, actionKind),
    workId: fixture.workId,
    missionId: fixture.missionId,
    executionId: fixture.executionId,
    mode: actionKind === "stop" ? "stop" : "correction",
    category: actionKind === "stop" ? "dependency" : "scope",
    missionTerm: fixture.assignment.scope,
    reason: "return to the assigned scope after observed drift",
    message: "Continue only within the assigned scope.",
    triggeringExecutorEntryIds: [fixture.sourceEntryId],
  };
}


function appendMissionOnly(root, suffix, assignment) {
  const workId = `work-${suffix}`;
  const missionId = `mission-${suffix}`;
  const mandateId = `mandate-${suffix}`;
  const participantId = `executor:execution-${suffix}`;
  appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId, workId, revision: 1, sourceSubmissionRecordId: `submission-${suffix}`, terms: assignment, admittedByParticipantId: "conclave:test", admittedAt: NOW } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId, assignment, assignedParticipantId: participantId, createdAt: NOW } });
}

function appendSide(root, suffix, assignment) {
  const workId = `work-${suffix}`;
  const missionId = `mission-${suffix}`;
  const executionId = `execution-${suffix}`;
  const mandateId = `mandate-${suffix}`;
  const participantId = `executor:${executionId}`;
  const sessionPath = join(root, `${executionId}.jsonl`);
  writeFileSync(sessionPath, `{"type":"session","version":3,"id":"${executionId}","cwd":"${root}"}\n`);
  appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId, workId, revision: 1, sourceSubmissionRecordId: `submission-${suffix}`, terms: assignment, admittedByParticipantId: "conclave:test", admittedAt: NOW } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId, assignment, assignedParticipantId: participantId, createdAt: NOW } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId, executionId, payload: { executionId, workId, executorName: "Fixture", kind: "executor", participantId, purpose: { kind: "mission", missionId }, missionId, projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: `pi-${suffix}`, sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: NOW } });
}

function createFixture(root, suffix) {
  const workId = `work-${suffix}`;
  const missionId = `mission-${suffix}`;
  const executionId = `execution-${suffix}`;
  const mandateId = `mandate-${suffix}`;
  const participantId = `executor:${executionId}`;
  const assignment = {
    title: "Supervision control fixture",
    objective: "Validate supervision",
    context: "Controlled fixture",
    scope: "Only the assigned fixture",
    acceptanceCriteria: ["The fixture is validated"],
    constraints: ["Do not change the fixture contract"],
    plan: ["Run the fixture"],
    validation: ["Inspect the persisted result"],
  };
  const sessionPath = join(root, "executor-session.jsonl");
  writeFileSync(sessionPath, `{"type":"session","version":3,"id":"${executionId}","cwd":"${root}"}\n`);
  appendArchiveRecord(root, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId, workId, revision: 1, sourceSubmissionRecordId: `submission-${suffix}`, terms: assignment, admittedByParticipantId: "conclave:test", admittedAt: NOW } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId, assignment, assignedParticipantId: participantId, createdAt: NOW } });
  appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId, executionId, payload: { executionId, workId, executorName: "Fixture", kind: "executor", participantId, purpose: { kind: "mission", missionId }, missionId, projectPath: root, sandboxPath: root, launcher: "headless-rpc", piSessionId: `pi-${suffix}`, sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: NOW } });
  const sessionManager = SessionManager.create(root);
  sessionManager.appendCustomEntry("khala-conclave", { projectPath: root });
  const sourceEntryId = "executor-source-1";
  const assessmentId = deterministicAssessmentId(executionId, sourceEntryId, sourceEntryId);
  sessionManager.appendCustomEntry("khala-supervision-assessment-start", { assessmentId, workId, missionId, executionId, firstSourceEntryId: sourceEntryId, lastSourceEntryId: sourceEntryId, sourceEntryIds: [sourceEntryId], actionIdNamespace: `action:${assessmentId}:`, actionIdPattern: "action-<sha256(assessmentId\\u0000actionKind\\u0000ordinal)>" });
  const entries = [];
  return { root, workId, missionId, executionId, assignment, sessionPath, sourceEntryId, assessmentId, entries, context: { cwd: root, sessionManager, isProjectTrusted: () => false } };
}
