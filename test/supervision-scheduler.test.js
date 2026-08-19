import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  SUPERVISION_ENTRY_TYPES,
  SupervisionController,
  SupervisionScheduler,
  computeTurnCost,
  createTurnDelta,
  deltasFromExecutorEntries,
  deterministicActionId,
  deterministicAssessmentId,
  formatAssessmentPrompt,
  hideAlignedAssessmentResponse,
  readCompletedCursors,
  getSupervisionController,
  registerSupervisionController,
  unregisterSupervisionController,
} from "../dist/src/khala-supervision.js";

function assistant(text, usage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function delta(executionId, sourceId, text = sourceId) {
  return createTurnDelta({
    workId: `work-${executionId}`,
    missionId: `mission-${executionId}`,
    executionId,
    message: assistant(text),
    toolResults: [],
    sourceEntryIds: [sourceId],
  });
}

function mission(executionId) {
  return {
    missionId: `mission-${executionId}`,
    workId: `work-${executionId}`,
    mandateId: `mandate-${executionId}`,
    assignment: {
      title: "Test Mission",
      objective: "Exercise supervision",
      context: "Controlled context",
      scope: "Only this test",
      acceptanceCriteria: ["The exact delta is assessed"],
      constraints: ["Do not mix Executions"],
      plan: ["Run the test"],
      validation: ["Read the result"],
    },
    assignedParticipantId: `executor:${executionId}`,
    createdAt: new Date().toISOString(),
  };
}

function fakeSession() {
  const sessionManager = SessionManager.inMemory("/tmp/khala-supervision-test");
  const messages = [];
  const calls = [];
  const listeners = [];
  return {
    sessionManager,
    messages,
    calls,
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    async sendCustomMessage(message, options) {
      calls.push({ message, options });
      sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      if (options?.triggerTurn) {
        const response = { ...assistant("aligned") };
        messages.push(response);
        for (const listener of listeners) listener({ type: "agent_settled" });
      }
      messages.push({ role: "custom", ...message, timestamp: Date.now() });
    },
    async waitForIdle() {},
  };
}

test("critical supervision tasks run before fair bounded Executor batches", () => {
  const scheduler = new SupervisionScheduler();
  const order = [];
  scheduler.enqueueNormal(delta("a", "a1"));
  scheduler.enqueueNormal(delta("a", "a2"));
  scheduler.enqueueNormal(delta("b", "b1"));
  scheduler.enqueueCritical({ kind: "critical", reason: "budget", run: async () => order.push("critical") });
  assert.equal(scheduler.next().kind, "critical");
  const first = scheduler.next();
  assert.deepEqual(first.deltas.map((item) => item.lastSourceEntryId), ["a1", "a2"]);
  const second = scheduler.next();
  assert.deepEqual(second.deltas.map((item) => item.lastSourceEntryId), ["b1"]);
});

test("critical supervision failures enter outage recovery and retain the task for retry", async () => {
  const session = fakeSession();
  let sends = 0;
  const failures = [];
  session.sendCustomMessage = async () => {
    sends += 1;
    if (sends === 1) throw new Error("critical model failure");
  };
  const controller = new SupervisionController({
    projectPath: "/tmp/khala-critical-outage",
    projectTrusted: false,
    session,
    conclaveParticipantId: "conclave:test",
    conclaveMaxCostUsdPerTurn: 1,
    executorMaxCostUsdPerTurn: 1,
    onModelFailure: (identity, error) => failures.push({ identity, error: error.message }),
  });
  controller.handleRuntimeFailure(
    { workId: "work-critical", missionId: "mission-critical", executionId: "execution-critical" },
    new Error("runtime loss"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(failures.length, 1);
  assert.equal(sends, 1);
  controller.resumeAfterOutage();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 2);
  controller.dispose();
});

test("normal Executor supervision preserves a bounded redacted runtime diagnostic", async () => {
  const session = fakeSession();
  const controller = new SupervisionController({
    projectPath: "/tmp/khala-normal-runtime-diagnostic",
    projectTrusted: false,
    session,
    conclaveParticipantId: "conclave:test",
    conclaveMaxCostUsdPerTurn: 1,
    executorMaxCostUsdPerTurn: 1,
  });
  controller.handleRuntimeFailure(
    { workId: "work-normal", missionId: "mission-normal", executionId: "execution-normal" },
    new Error(`runtime failure {"dbPassword":"NORMAL_SECRET"} ${"x".repeat(10_000)}`),
  );
  for (let attempt = 0; attempt < 100 && session.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const diagnostic = session.calls.map((call) => JSON.stringify(call.message.content)).join("\\n");
  assert.match(diagnostic, /Executor RPC failure/);
  assert.doesNotMatch(diagnostic, /NORMAL_SECRET/);
  assert.ok(diagnostic.length <= 5000);
  controller.dispose();
});

test("turn deltas preserve ordered tool calls/results and stable deterministic IDs", () => {
  const message = { ...assistant("call"), content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }] };
  const result = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: Date.now() };
  const value = createTurnDelta({ workId: "w", missionId: "m", executionId: "e", message, toolResults: [result], sourceEntryIds: ["entry-1", "entry-2"] });
  assert.deepEqual(value.messages, [message, result]);
  assert.deepEqual(value.toolCalls, [{ id: "call-1", name: "read", arguments: { path: "x" } }]);
  assert.deepEqual(value.toolResults, [result]);
  assert.equal(value.firstSourceEntryId, "entry-1");
  assert.equal(value.lastSourceEntryId, "entry-2");
  const assessmentId = deterministicAssessmentId("e", "entry-1", "entry-2");
  assert.equal(assessmentId, deterministicAssessmentId("e", "entry-1", "entry-2"));
  assert.equal(deterministicActionId(assessmentId, "steer"), deterministicActionId(assessmentId, "steer"));
  assert.notEqual(deterministicActionId(assessmentId, "steer"), deterministicActionId(assessmentId, "stop"));
});

test("assessment prompts and persisted inputs use deterministic bounded diagnostic projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "khala-supervision-payload-bounds-"));
  try {
    const hugeDiagnostic = `failure-prefix-${"x".repeat(200_000)}-failure-tail`;
    const currentMission = {
      ...mission("bounded"),
      assignment: { ...mission("bounded").assignment, context: hugeDiagnostic },
    };
    const deltas = Array.from({ length: 8 }, (_, index) => {
      const toolResult = {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "bash",
        content: [{ type: "text", text: hugeDiagnostic }],
        isError: true,
        timestamp: Date.parse(`2026-01-01T00:00:0${index}.000Z`),
      };
      return createTurnDelta({
        workId: currentMission.workId,
        missionId: currentMission.missionId,
        executionId: "bounded",
        turnIndex: index,
        message: { ...assistant(hugeDiagnostic), timestamp: toolResult.timestamp },
        toolResults: [toolResult],
        sourceEntryIds: [`user-${index}`, `assistant-${index}`, `tool-${index}`],
      });
    });
    const assessmentInput = {
      assessmentId: deterministicAssessmentId("bounded", "user-0", "tool-7"),
      conclaveParticipantId: "conclave:test",
      mission: currentMission,
      deltas,
      priorInterventions: Array.from({ length: 50 }, (_, index) => ({
        interventionId: `intervention-${index}`,
        executionId: "bounded",
        phase: "issuance",
        status: "open",
        sentAt: `2026-01-01T00:01:${String(index).padStart(2, "0")}.000Z`,
        failureSummary: hugeDiagnostic,
      })),
      currentCoordination: [{ coordinationId: "coordination-1", phase: "decision", status: "active", reason: hugeDiagnostic }],
      coordinationHolds: [{ workId: currentMission.workId, missionId: currentMission.missionId, relation: "dependency", reason: hugeDiagnostic }],
      userPriorities: [{
        priorityId: `priority-${"a".repeat(64)}`,
        selectedWorkId: currentMission.workId,
        relatedWorkId: "work-related",
        status: "pending",
      }],
      effectiveCostThreshold: 1,
      candidateMissions: Array.from({ length: 50 }, (_, index) => ({
        mission: { ...currentMission, missionId: `candidate-${index}`, createdAt: `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z` },
        activity: [{ executionId: `candidate-execution-${index}`, status: "running", startedAt: "2026-01-02T00:00:00.000Z" }],
      })),
    };

    const firstPrompt = formatAssessmentPrompt(assessmentInput);
    const repeatedPrompt = formatAssessmentPrompt(assessmentInput);
    assert.equal(repeatedPrompt, firstPrompt);
    assert.ok(Buffer.byteLength(firstPrompt, "utf8") <= 28_000);
    assert.match(firstPrompt, /"assessmentId":"assessment-/);
    assert.match(firstPrompt, /"workId":"work-bounded"/);
    assert.match(firstPrompt, /"missionId":"mission-bounded"/);
    assert.match(firstPrompt, /"executionId":"bounded"/);
    assert.match(firstPrompt, /"userPriorities":\[/);
    assert.match(firstPrompt, /"toolName":"bash"/);
    assert.match(firstPrompt, /"isError":true/);
    assert.match(firstPrompt, /"timestamp":1767225600000/);
    assert.match(firstPrompt, /failure-prefix/);
    assert.match(firstPrompt, /"truncated":true/);
    assert.doesNotMatch(firstPrompt, /failure-tail/);

    const oversizedSourceEntryId = `source-${"s".repeat(200)}`;
    const oversizedIdentityDelta = createTurnDelta({
      workId: currentMission.workId,
      missionId: currentMission.missionId,
      executionId: "bounded",
      message: assistant("bounded"),
      toolResults: [],
      sourceEntryIds: [oversizedSourceEntryId],
    });
    assert.throws(
      () => formatAssessmentPrompt({ ...assessmentInput, deltas: [oversizedIdentityDelta] }),
      /source entry ID exceeds its 160-byte identity limit/,
    );

    const session = fakeSession();
    const controller = new SupervisionController({
      projectPath: root,
      projectTrusted: false,
      session,
      conclaveParticipantId: "conclave:test",
      conclaveMaxCostUsdPerTurn: 1,
      executorMaxCostUsdPerTurn: 1,
    });
    controller.registerExecution(currentMission, "bounded");
    const runtime = {
      getEntries: async () => ({
        entries: [
          { type: "message", id: "runtime-user", message: { role: "user", content: "inspect", timestamp: 1 } },
          { type: "message", id: "runtime-assistant", message: deltas[0].messages[0] },
          { type: "message", id: "runtime-tool", message: deltas[0].toolResults[0] },
        ],
        leafId: "runtime-tool",
      }),
    };
    await controller.handleRuntimeEvent(
      { workId: currentMission.workId, missionId: currentMission.missionId, executionId: "bounded" },
      { type: "turn_end", message: deltas[0].messages[0], toolResults: deltas[0].toolResults },
      runtime,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const call = session.calls.find((candidate) => candidate.message.customType === SUPERVISION_ENTRY_TYPES.assessmentInput);
    assert.ok(call);
    assert.ok(Buffer.byteLength(JSON.stringify(call.message), "utf8") <= 36_000);
    const persisted = session.sessionManager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === SUPERVISION_ENTRY_TYPES.assessmentInput);
    assert.ok(persisted);
    assert.ok(Buffer.byteLength(JSON.stringify(persisted), "utf8") <= 40_000);
    assert.equal(persisted.details.workId, currentMission.workId);
    assert.equal(persisted.details.missionId, currentMission.missionId);
    assert.equal(persisted.details.executionId, "bounded");
    assert.equal("sourceEntryIds" in persisted.details, false);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart cursor advances only from completed assessment entries and catch-up retains turn order", () => {
  const sessionManager = SessionManager.inMemory("/tmp/khala-supervision-cursor");
  const start = { assessmentId: "assessment-a", workId: "w", missionId: "m", executionId: "e", firstSourceEntryId: "entry-1", lastSourceEntryId: "entry-2", sourceEntryIds: ["entry-1", "entry-2"], actionIdNamespace: "action:assessment-a:", actionIdPattern: "action-<sha256(assessmentId\\u0000actionKind\\u0000ordinal)>" };
  sessionManager.appendCustomEntry(SUPERVISION_ENTRY_TYPES.assessmentStart, start);
  assert.deepEqual(readCompletedCursors(sessionManager.getEntries()), new Map());
  sessionManager.appendCustomEntry(SUPERVISION_ENTRY_TYPES.assessmentComplete, start);
  assert.deepEqual(readCompletedCursors(sessionManager.getEntries()), new Map([["e", "entry-2"]]));
  const entries = [
    { type: "message", id: "u1", message: { role: "user", content: "one", timestamp: 1 } },
    { type: "message", id: "a1", message: assistant("one") },
    { type: "message", id: "t1", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [], isError: false, timestamp: 2 } },
    { type: "message", id: "u2", message: { role: "user", content: "two", timestamp: 3 } },
    { type: "message", id: "a2", message: assistant("two") },
  ];
  const deltas = deltasFromExecutorEntries({ workId: "w", missionId: "m", executionId: "e", entries });
  assert.deepEqual(deltas.map((item) => item.sourceEntryIds), [["u1", "a1", "t1"], ["u2", "a2"]]);
});

test("hidden aligned response uses Pi custom-message metadata and cost remains unavailable or visibly over threshold", () => {
  const previous = { type: "custom_message", id: "input", parentId: null, timestamp: "now", customType: SUPERVISION_ENTRY_TYPES.assessmentInput, display: false, content: "assessment", details: { kind: "assessment-input", assessmentId: "a" } };
  const hidden = hideAlignedAssessmentResponse(assistant("aligned"), previous);
  assert.equal(hidden.role, "custom");
  assert.equal(hidden.display, false);
  assert.equal(hidden.details.assessmentId, "a");
  assert.equal(computeTurnCost(undefined), undefined);
  assert.equal(computeTurnCost(assistant("x").usage), undefined);
  assert.equal(computeTurnCost({ ...assistant("x").usage, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }), 2);
});

test("controller recovers an incomplete exact range before queuing later turns", async () => {
  const session = fakeSession();
  const controller = new SupervisionController({ projectPath: "/tmp/khala-supervision-recovery", projectTrusted: false, session, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  const currentMission = mission("recovery");
  const start = {
    assessmentId: deterministicAssessmentId("recovery", "u1", "a1"),
    workId: currentMission.workId,
    missionId: currentMission.missionId,
    executionId: "recovery",
    firstSourceEntryId: "u1",
    lastSourceEntryId: "a1",
    sourceEntryIds: ["u1", "a1"],
    actionIdNamespace: `action:${deterministicAssessmentId("recovery", "u1", "a1")}:`,
    actionIdPattern: "action-<sha256(assessmentId\\u0000actionKind\\u0000ordinal)>",
  };
  session.sessionManager.appendCustomEntry(SUPERVISION_ENTRY_TYPES.assessmentStart, start);
  const entries = [
    { type: "message", id: "u1", message: { role: "user", content: "one", timestamp: 1 } },
    { type: "message", id: "a1", message: assistant("one") },
    { type: "message", id: "u2", message: { role: "user", content: "two", timestamp: 2 } },
    { type: "message", id: "a2", message: assistant("two") },
  ];
  controller.registerExecution(currentMission, "recovery", { getEntries: async () => ({ entries, leafId: "a2" }) });
  await controller.recover();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const starts = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUPERVISION_ENTRY_TYPES.assessmentStart);
  assert.deepEqual(starts.map((entry) => entry.data.sourceEntryIds), [["u1", "a1"], ["u2", "a2"]]);
  assert.equal(starts[0].data.assessmentId, start.assessmentId);
  controller.dispose();
});

test("trust-scoped supervision registries never cross project trust domains", () => {
  const project = "/tmp/khala-supervision-trust";
  const untrusted = new SupervisionController({ projectPath: project, projectTrusted: false, session: fakeSession(), conclaveParticipantId: "u", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  const trusted = new SupervisionController({ projectPath: project, projectTrusted: true, session: fakeSession(), conclaveParticipantId: "t", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  registerSupervisionController(project, false, untrusted);
  registerSupervisionController(project, true, trusted);
  assert.equal(getSupervisionController(project, false), untrusted);
  assert.equal(getSupervisionController(project, true), trusted);
  unregisterSupervisionController(project, false);
  assert.equal(getSupervisionController(project, false), undefined);
  assert.equal(getSupervisionController(project, true), trusted);
  trusted.dispose();
});

test("concurrent turn_end events preserve native order and partition later entries", async () => {
  const session = fakeSession();
  const controller = new SupervisionController({ projectPath: "/tmp/khala-supervision-order", projectTrusted: false, session, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  const currentMission = mission("order");
  controller.registerExecution(currentMission, "order");
  const firstMessage = assistant("one");
  const secondMessage = assistant("two");
  const firstEntries = [
    { type: "message", id: "u1", message: { role: "user", content: "one", timestamp: 1 } },
    { type: "message", id: "a1", message: firstMessage },
    { type: "message", id: "u2", message: { role: "user", content: "two", timestamp: 2 } },
    { type: "message", id: "a2", message: secondMessage },
  ];
  const runtime = {
    getEntries: async (since) => ({ entries: since === "a1" ? firstEntries.slice(2) : firstEntries, leafId: "a2" }),
  };
  await Promise.all([
    controller.handleRuntimeEvent({ workId: currentMission.workId, missionId: currentMission.missionId, executionId: "order" }, { type: "turn_end", message: firstMessage, toolResults: [] }, runtime),
    controller.handleRuntimeEvent({ workId: currentMission.workId, missionId: currentMission.missionId, executionId: "order" }, { type: "turn_end", message: secondMessage, toolResults: [] }, runtime),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const starts = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUPERVISION_ENTRY_TYPES.assessmentStart);
  assert.deepEqual(starts.map((entry) => entry.data.sourceEntryIds), [["u1", "a1"], ["u2", "a2"]]);
  controller.dispose();
});

test("read-only assessment responses stay hidden while significant actions stay visible", () => {
  const previous = { type: "custom_message", id: "input", parentId: null, timestamp: "now", customType: SUPERVISION_ENTRY_TYPES.assessmentInput, display: false, content: "assessment", details: { kind: "assessment-input", assessmentId: "a" } };
  const read = { ...assistant("read"), content: [{ type: "toolCall", id: "r", name: "khala_read_archive", arguments: {} }] };
  const action = { ...assistant("act"), content: [{ type: "toolCall", id: "s", name: "khala_steer_execution", arguments: {} }] };
  assert.equal(hideAlignedAssessmentResponse(read, previous).display, false);
  assert.equal(hideAlignedAssessmentResponse(action, previous), undefined);
});

test("turn cost includes nested tool-result usage without inventing unavailable pricing", () => {
  const base = { ...assistant("x").usage, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 1.5 } };
  const tool = { role: "toolResult", toolCallId: "c", toolName: "read", content: [], isError: false, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } } };
  assert.equal(computeTurnCost(base, [tool]), 1.75);
  assert.equal(computeTurnCost({ ...base, cost: { ...base.cost, total: 0 } }, [tool]), undefined);
});

test("compaction rehydrates registered Mission context", async () => {
  const session = fakeSession();
  const controller = new SupervisionController({ projectPath: "/tmp/khala-supervision-compaction", projectTrusted: false, session, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  const currentMission = mission("compaction");
  controller.registerExecution(currentMission, "compaction");
  session.emit({ type: "compaction_end", aborted: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(session.calls.some((call) => call.message.customType === "khala-supervision-context"));
  controller.dispose();
});

test("controller writes one start and one complete for a single exact Executor turn", async () => {
  const session = fakeSession();
  const controller = new SupervisionController({ projectPath: "/tmp/khala-supervision-controller", projectTrusted: false, session, conclaveParticipantId: "conclave:test", conclaveMaxCostUsdPerTurn: 1, executorMaxCostUsdPerTurn: 1 });
  const currentMission = mission("e");
  controller.registerExecution(currentMission, "e");
  const turnMessage = assistant("turn");
  const runtime = { getEntries: async () => ({ entries: [{ type: "message", id: "entry-1", message: turnMessage }], leafId: "entry-1" }) };
  await controller.handleRuntimeEvent({ workId: "work-e", missionId: "mission-e", executionId: "e" }, { type: "turn_end", turnIndex: 0, message: turnMessage, toolResults: [] }, runtime);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const starts = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUPERVISION_ENTRY_TYPES.assessmentStart);
  const completes = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUPERVISION_ENTRY_TYPES.assessmentComplete);
  assert.equal(starts.length, 1);
  assert.equal(completes.length, 1);
  assert.equal(starts[0].data.assessmentId, completes[0].data.assessmentId);
  controller.dispose();
});
