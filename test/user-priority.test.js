import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { deterministicActionId } from "../dist/src/khala-supervision.js";
import { supervisionMarker } from "../dist/src/khala-supervision-tools.js";
import { registerKhalaSupervisionTools } from "../dist/src/khala-supervision-tools.js";
import { submitUserPriority } from "../dist/src/khala-user-priority.js";
import {
	isUserPriorityApplied,
	pendingUserPriorities,
	readUserPriority,
} from "../dist/src/khala-archive-projections.js";
import {
	CONCLAVE_BASE_TOOL_ALLOWLIST,
	CONCLAVE_TOOL_ALLOWLIST,
	createConclaveCoordinator,
	schedulePendingUserPriorityWakes,
} from "../dist/src/khala-conclave.js";
import { readExecutorRecord, updateExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { isUserPriorityRecord } from "../dist/src/khala-model.js";
import createExtension from "../dist/src/index.js";

const NOW = new Date().toISOString();

function createPiStub(commands, tools = new Map(), flags = new Map(), hooks = {}) {
	const activeTools = new Set(hooks.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	return {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag() {},
		registerShortcut() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
			activeTools.add(tool.name);
		},
		on(name, handler) {
			hooks.events?.set(name, handler);
		},
		getFlag() {},
		appendEntry() {},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools.clear();
			for (const name of names) {
				activeTools.add(name);
			}
		},
	};
}

const assignment = {
	title: "Priority fixture",
	objective: "Validate priority",
	context: "Controlled",
	scope: "Only the fixture",
	acceptanceCriteria: ["validated"],
	constraints: ["no change"],
	plan: ["run"],
	validation: ["inspect"],
};

function appendSide(projectPath, suffix, workId) {
	const missionId = `mission-${suffix}`;
	const executionId = `execution-${suffix}`;
	const sessionPath = join(projectPath, `session-${suffix}.jsonl`);
	mkdirSync(projectPath, { recursive: true });
	writeFileSync(sessionPath, `{"type":"session","version":3,"id":"${executionId}"}\n`);
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId: `mandate-${suffix}`, workId, revision: 1, sourceSubmissionRecordId: `submission-${suffix}`, terms: assignment, admittedByParticipantId: "conclave:test", admittedAt: NOW } }, false);
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId: `mandate-${suffix}`, assignment, assignedParticipantId: `executor:${executionId}`, createdAt: NOW } }, false);
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "execution", workId, executionId, payload: { executionId, workId, executorName: "Fixture", kind: "executor", participantId: `executor:${executionId}`, purpose: { kind: "mission", missionId }, missionId, projectPath, sandboxPath: projectPath, launcher: "headless-rpc", piSessionId: `pi-${suffix}`, sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: NOW } }, false);
	return { workId, missionId, executionId };
}

function appendPrelaunchSide(projectPath, suffix, workId) {
	const missionId = `mission-${suffix}`;
	const mandateId = `mandate-${suffix}`;
	mkdirSync(projectPath, { recursive: true });
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mandate", workId, payload: { mandateId, workId, revision: 1, sourceSubmissionRecordId: `submission-${suffix}`, terms: assignment, admittedByParticipantId: "conclave:test", admittedAt: NOW } }, false);
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mission", workId, payload: { missionId, workId, mandateId, assignment, assignedParticipantId: `executor:execution-${suffix}`, createdAt: NOW } }, false);
	return { workId, missionId, executionId: `execution-${suffix}` };
}

function appendActiveExecution(projectPath, side) {
	const sessionPath = join(projectPath, `${side.executionId}.jsonl`);
	writeFileSync(sessionPath, `{"type":"session","version":3,"id":"${side.executionId}"}\n`);
	appendArchiveRecord(projectPath, { schemaVersion: 2, type: "execution", workId: side.workId, executionId: side.executionId, payload: { executionId: side.executionId, workId: side.workId, executorName: "Fixture", kind: "executor", participantId: `executor:${side.executionId}`, purpose: { kind: "mission", missionId: side.missionId }, missionId: side.missionId, projectPath, sandboxPath: projectPath, launcher: "headless-rpc", piSessionId: `pi-${side.executionId}`, sessionPath, promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) }, status: "running", startedAt: NOW } }, false);
	return side;
}

function appendPrelaunchDecisionCoordination(projectPath, coordinationId, a, b) {
	appendArchiveRecord(projectPath, {
		schemaVersion: 2,
		type: "coordination",
		workId: a.workId,
		payload: {
			coordinationId,
			actionId: `action-${coordinationId}`,
			phase: "decision",
			relation: "peer-conflict",
			workId: a.workId,
			missionId: a.missionId,
			selectedWorkId: a.workId,
			selectedMissionId: a.missionId,
			relatedWorkId: b.workId,
			relatedMissionId: b.missionId,
			reason: "Both current Missions overlap before either side launches.",
		},
	}, false);
}

function appendDecisionCoordination(projectPath, coordinationId, a, b) {
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion: 2,
			type: "coordination",
			workId: a.workId,
			executionId: a.executionId,
			payload: {
				coordinationId,
				actionId: `action-${coordinationId}`,
				phase: "decision",
				relation: "peer-conflict",
				workId: a.workId,
				missionId: a.missionId,
				executionId: a.executionId,
				selectedWorkId: a.workId,
				selectedMissionId: a.missionId,
				selectedExecutionId: a.executionId,
				relatedWorkId: b.workId,
				relatedMissionId: b.missionId,
				relatedExecutionId: b.executionId,
				reason: "Both current Missions overlap.",
			},
		},
		false,
	);
}

function appendPriorityOverride(projectPath, a, b, priority) {
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion: 2,
			type: "coordination",
			workId: a.workId,
			executionId: a.executionId,
			payload: {
				coordinationId: priority.coordinationId,
				actionId: priority.actionId,
				phase: "override",
				relation: "peer-conflict",
				workId: a.workId,
				missionId: a.missionId,
				executionId: a.executionId,
				relatedWorkId: b.workId,
				relatedMissionId: b.missionId,
				relatedExecutionId: b.executionId,
				selectedWorkId: a.workId,
				selectedMissionId: a.missionId,
				selectedExecutionId: a.executionId,
				reason: priority.reason,
				userEntryId: priority.provenance.entryId,
				priorityId: priority.priorityId,
			},
		},
		false,
	);
}

function appendPriorityEnforcement(projectPath, a, b, priority, phase, baselineSignalIds, evidence = {}) {
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion: 2,
			type: "user-priority-enforcement",
			workId: a.workId,
			payload: {
				priorityId: priority.priorityId,
				coordinationId: priority.coordinationId,
				workId: a.workId,
				selectedWorkId: a.workId,
				relatedWorkId: b.workId,
				losingWorkId: b.workId,
				losingMissionId: b.missionId,
				losingExecutionId: b.executionId,
				actionId: priority.stopActionId,
				marker: supervisionMarker(priority.stopActionId, "stop"),
				phase,
				baselineSignalIds,
				...evidence,
			},
		},
		false,
	);
}

function userEntry(id, content) {
	return { id, type: "message", parentId: null, timestamp: NOW, message: { role: "user", content } };
}

function assistantEntry(id, parentId, toolCallId) {
	return { id, type: "message", parentId, timestamp: NOW, message: { role: "assistant", content: toolCallId === undefined ? [] : [{ type: "toolCall", id: toolCallId, name: "khala_prioritize_work", arguments: {} }] } };
}

function userContext(projectPath, entries) {
	return {
		cwd: projectPath,
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "user-session-1" },
	};
}

function conclaveContext(projectPath) {
	return {
		cwd: projectPath,
		isProjectTrusted: () => false,
		sessionManager: {
			getBranch: () => [
				{ id: "c", type: "custom", customType: "khala-conclave", data: {} },
				{ id: "r", type: "custom", customType: "khala-role", data: { role: "conclave" } },
			],
			getEntries: () => [],
			getSessionId: () => "conclave-session",
			getSessionFile: () => join(projectPath, "conclave.jsonl"),
		},
	};
}

function supervisionTools() {
	const tools = new Map();
	registerKhalaSupervisionTools({ registerTool: (tool) => tools.set(tool.name, tool) }, { isDedicatedConclaveSession: () => true });
	return tools;
}

function runTest(name, fn) {
	test(name, async () => {
		const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
		const root = mkdtempSync(join(tmpdir(), `user-priority-${safeName}-`));
		const projectPath = join(root, "project");
		try {
			await fn(projectPath, root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

runTest("extension registers the User tool and no direct Conclave-session hooks", () => {
	const events = new Map();
	const tools = new Map();
	createExtension(createPiStub(new Map(), tools, new Map(), { events }));
	assert.equal(tools.has("khala_prioritize_work"), true);
	assert.equal(tools.has("khala_apply_user_priority"), true);
	assert.equal(tools.has("khala_dispose_user_priority"), true);
	assert.equal(events.has("input"), false);
	assert.equal(events.has("context"), false);
	assert.equal(events.has("agent_settled"), false);
});

runTest("priority tools are dedicated-Conclave only, never the base, User, Executor, Observer, or Preserver", () => {
	assert.ok(CONCLAVE_TOOL_ALLOWLIST.includes("khala_apply_user_priority"));
	assert.ok(CONCLAVE_TOOL_ALLOWLIST.includes("khala_dispose_user_priority"));
	assert.equal(CONCLAVE_BASE_TOOL_ALLOWLIST.includes("khala_apply_user_priority"), false);
	assert.equal(CONCLAVE_BASE_TOOL_ALLOWLIST.includes("khala_dispose_user_priority"), false);
	const runRole = (marker) => {
		const activeTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		const events = new Map();
		createExtension({
			registerCommand() {},
			registerFlag() {},
			registerShortcut() {},
			registerTool(tool) {
				activeTools.add(tool.name);
			},
			on(name, handler) {
				events.set(name, handler);
			},
			getFlag() {},
			appendEntry() {},
			getActiveTools: () => [...activeTools],
			setActiveTools(names) {
				activeTools.clear();
				for (const name of names) {
					activeTools.add(name);
				}
			},
		});
		events.get("session_start")({}, {
			cwd: "/tmp",
			sessionManager: {
				getBranch: () => [marker],
				getSessionFile: () => "/tmp/s.jsonl",
				getSessionName: () => "s",
			},
			ui: { setStatus() {}, theme: { fg: () => "" } },
		});
		return activeTools;
	};
	const dedicated = runRole({ id: "c", type: "custom", customType: "khala-conclave", data: {} });
	assert.ok(dedicated.has("khala_apply_user_priority"));
	assert.ok(dedicated.has("khala_dispose_user_priority"));
	for (const marker of [
		{ id: "r", type: "custom", customType: "khala-role", data: { role: "conclave" } },
		{ id: "e", type: "custom", customType: "khala-executor", data: {} },
		{ id: "o", type: "custom", customType: "khala-observer", data: {} },
		{ id: "p", type: "custom", customType: "khala-role", data: { role: "preserver" } },
	]) {
		const active = runRole(marker);
		assert.equal(active.has("khala_apply_user_priority"), false, marker.customType);
		assert.equal(active.has("khala_dispose_user_priority"), false, marker.customType);
	}
});

runTest("khala_prioritize_work binds the causal User turn across a multi-tool turn", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const userMsg = userEntry("user-1", "Prioritize A");
	const assistantA = assistantEntry("assistant-a", "user-1");
	const toolResult = { id: "toolresult-a", type: "message", parentId: "assistant-a", timestamp: NOW, message: { role: "toolResult", toolCallId: "tool-a", content: [] } };
	const assistantB = assistantEntry("assistant-b", "toolresult-a", "tool-b");
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userMsg, assistantA, toolResult, assistantB]), { wakeUserPriority: async () => {} }, "tool-b");
	const record = readUserPriority(projectPath, result.details.priorityId, false);
	assert.equal(record.provenance.entryId, "user-1");
	assert.equal(record.provenance.sessionId, "user-session-1");
	assert.match(record.provenance.contentSha256, /^[a-f0-9]{64}$/);
	assert.equal(record.coordinationId, "coord-ab");
	assert.equal(result.details.status, "pending");
});

runTest("a custom-message-triggered turn with an older User entry in history is rejected", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const userMsg = userEntry("user-old", "An older prompt");
	const customMsg = { id: "custom-1", type: "custom_message", parentId: "user-old", timestamp: NOW, customType: "khala-supervision-assessment-input", content: "assess", display: false };
	const assistantC = assistantEntry("assistant-c", "custom-1", "tool-c");
	await assert.rejects(
		() => submitUserPriority({ selectedWorkId: "work-a", reason: "x" }, userContext(projectPath, [userMsg, customMsg, assistantC]), { wakeUserPriority: async () => {} }, "tool-c"),
		/normal persisted User turn/,
	);
	// Missing and ambiguous tool calls fail closed.
	await assert.rejects(
		() => submitUserPriority({ selectedWorkId: "work-a", reason: "x" }, userContext(projectPath, [userMsg, customMsg, assistantC]), { wakeUserPriority: async () => {} }, "tool-missing"),
		/could not find the persisted tool call/,
	);
});

runTest("priorityId covers both Work identities so one turn may prioritize the same selected Work in two conflicts", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	const c = appendSide(projectPath, "c", "work-c");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	appendDecisionCoordination(projectPath, "coord-ac", a, c);
	// One causal User entry and two assistant tool calls on the same branch.
	const userMsg = userEntry("u1", "Prioritize A over both peers");
	const assistant1 = assistantEntry("a1", "u1", "t1");
	const toolResult = { id: "tr1", type: "message", parentId: "a1", timestamp: NOW, message: { role: "toolResult", toolCallId: "t1", content: [] } };
	const assistant2 = assistantEntry("a2", "tr1", "t2");
	const context = userContext(projectPath, [userMsg, assistant1, toolResult, assistant2]);
	const first = await submitUserPriority({ selectedWorkId: "work-a", relatedWorkId: "work-b", reason: "A over B" }, context, { wakeUserPriority: async () => {} }, "t1");
	const second = await submitUserPriority({ selectedWorkId: "work-a", relatedWorkId: "work-c", reason: "A over C" }, context, { wakeUserPriority: async () => {} }, "t2");
	assert.equal(readUserPriority(projectPath, first.details.priorityId, false).provenance.entryId, "u1");
	assert.equal(readUserPriority(projectPath, second.details.priorityId, false).provenance.entryId, "u1");
	assert.notEqual(first.details.priorityId, second.details.priorityId);
});

runTest("the model rejects malformed User Priority records at the boundary", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const record = readUserPriority(projectPath, result.details.priorityId, false);
	assert.equal(isUserPriorityRecord(record), true);
	assert.equal(isUserPriorityRecord({ ...record, priorityId: "priority-short" }), false);
	assert.equal(isUserPriorityRecord({ ...record, reason: "   " }), false);
	assert.equal(isUserPriorityRecord({ ...record, coordinationId: undefined }), false);
});

runTest("a User Priority resolves a newly active losing Execution from a prelaunch decision", async (projectPath) => {
	const a = appendPrelaunchSide(projectPath, "prelaunch-a", "work-prelaunch-a");
	const b = appendPrelaunchSide(projectPath, "prelaunch-b", "work-prelaunch-b");
	appendPrelaunchDecisionCoordination(projectPath, "coord-prelaunch-active-loser", a, b);
	const result = await submitUserPriority({ selectedWorkId: a.workId, reason: "A over B" }, userContext(projectPath, [userEntry("u-prelaunch", "ab"), assistantEntry("a-prelaunch", "u-prelaunch", "t-prelaunch")]), { wakeUserPriority: async () => {} }, "t-prelaunch");
	appendActiveExecution(projectPath, b);
	const runtime = stopRuntime();
	const tools = new Map();
	registerKhalaSupervisionTools(
		{ registerTool: (tool) => tools.set(tool.name, tool) },
		{ isDedicatedConclaveSession: () => true, getRuntime: (executionId) => (executionId === b.executionId ? runtime : undefined) },
	);
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, conclaveContext(projectPath));
	assert.equal(applied.details.relatedExecutionId, b.executionId);
	assert.equal(runtime.received.length, 1);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "intervention").length, 1);
});

runTest("a decision-bound primary Execution turnover makes a pending priority stale before append", async (projectPath) => {
	const a = appendSide(projectPath, "turnover-a", "work-turnover-a");
	const b = appendSide(projectPath, "turnover-b", "work-turnover-b");
	appendDecisionCoordination(projectPath, "coord-turnover", a, b);
	const result = await submitUserPriority(
		{ selectedWorkId: a.workId, reason: "A over B" },
		userContext(projectPath, [userEntry("u-turnover", "ab"), assistantEntry("a-turnover", "u-turnover", "t-turnover")]),
		{ wakeUserPriority: async () => {} },
		"t-turnover",
	);
	await updateExecutorRecord(projectPath, a.executionId, { status: "finished" });
	appendActiveExecution(projectPath, { ...a, executionId: "execution-turnover-a-successor" });
	const tools = supervisionTools();
	await assert.rejects(
		() => tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, conclaveContext(projectPath)),
		/no longer matches|stale/,
	);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "coordination").length, 1);
});

runTest("a decision-bound disappeared related Execution makes a pending priority stale before append", async (projectPath) => {
	const a = appendSide(projectPath, "disappeared-a", "work-disappeared-a");
	const b = appendSide(projectPath, "disappeared-b", "work-disappeared-b");
	appendDecisionCoordination(projectPath, "coord-disappeared", a, b);
	const result = await submitUserPriority(
		{ selectedWorkId: a.workId, reason: "A over B" },
		userContext(projectPath, [userEntry("u-disappeared", "ab"), assistantEntry("a-disappeared", "u-disappeared", "t-disappeared")]),
		{ wakeUserPriority: async () => {} },
		"t-disappeared",
	);
	await updateExecutorRecord(projectPath, b.executionId, { status: "finished" });
	const tools = supervisionTools();
	await assert.rejects(
		() => tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, conclaveContext(projectPath)),
		/no longer matches|stale/,
	);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "coordination").length, 1);
});

runTest("a prelaunch User Priority with no active losing Execution keeps the no-stop enforcement path", async (projectPath) => {
	const a = appendPrelaunchSide(projectPath, "prelaunch-no-active-a", "work-prelaunch-no-active-a");
	const b = appendPrelaunchSide(projectPath, "prelaunch-no-active-b", "work-prelaunch-no-active-b");
	appendPrelaunchDecisionCoordination(projectPath, "coord-prelaunch-no-active", a, b);
	const result = await submitUserPriority({ selectedWorkId: a.workId, reason: "A over B" }, userContext(projectPath, [userEntry("u-no-active", "ab"), assistantEntry("a-no-active", "u-no-active", "t-no-active")]), { wakeUserPriority: async () => {} }, "t-no-active");
	const tools = supervisionTools();
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, conclaveContext(projectPath));
	assert.equal(applied.details.relatedExecutionId, undefined);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "intervention").length, 0);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "user-priority-enforcement").at(-1).payload.phase, "enforced");
});

runTest("a true wake/apply applies the pending priority as a Coordination override without an assessment", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const tools = supervisionTools();
	const context = conclaveContext(projectPath);
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(applied.details.priorityId, result.details.priorityId);
	assert.equal(applied.details.userEntryId, "u1");
	assert.equal(applied.details.actionId, deterministicActionId(result.details.priorityId, "coordinate-override"));
	assert.equal(isUserPriorityApplied(projectPath, result.details.priorityId, false), true);
	assert.equal(pendingUserPriorities(projectPath, false).length, 0);
	// Exact replay returns the existing override; a forged second apply is rejected by replay validation.
	const replay = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(replay.details.actionId, applied.details.actionId);
	assert.throws(() => appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: a.workId, executionId: a.executionId, payload: { ...applied.details, actionId: "action-forged" } }, false), /invalid or already-applied User Priority/);
});

runTest("a stale pending priority cannot be applied and is durably ignored", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-stale", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion: 2,
			type: "coordination",
			workId: a.workId,
			executionId: a.executionId,
			payload: {
				coordinationId: "coord-stale",
				actionId: "action-resolution",
				phase: "resolution",
				relation: "peer-conflict",
				workId: a.workId,
				missionId: a.missionId,
				executionId: a.executionId,
				selectedWorkId: a.workId,
				selectedMissionId: a.missionId,
				relatedWorkId: b.workId,
				relatedMissionId: b.missionId,
				relatedExecutionId: b.executionId,
				selectedExecutionId: a.executionId,
				reason: "terminal",
				resolution: "terminal-failure",
				resolutionEvidenceRecordId: "evidence-1",
			},
		},
		false,
	);
	const tools = supervisionTools();
	const context = conclaveContext(projectPath);
	await assert.rejects(() => tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context), /no longer matches/);
	const disposed = await tools.get("khala_dispose_user_priority").execute("t", { priorityId: result.details.priorityId, reason: "The coordination resolved before consumption." }, undefined, undefined, context);
	assert.equal(disposed.details.status, "ignored");
	assert.equal(pendingUserPriorities(projectPath, false).length, 0);
	const replay = await tools.get("khala_dispose_user_priority").execute("t", { priorityId: result.details.priorityId, reason: "The coordination resolved before consumption." }, undefined, undefined, context);
	assert.equal(replay.details.ignoredAt, disposed.details.ignoredAt);
});

runTest("startup resume schedules every pending unapplied priority and skips applied or ignored ones", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const appliedResult = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	await supervisionTools().get("khala_apply_user_priority").execute("t", { priorityId: appliedResult.details.priorityId }, undefined, undefined, conclaveContext(projectPath));
	const pendingResult = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B again" }, userContext(projectPath, [userEntry("u2", "ab2"), assistantEntry("a2", "u2", "t2")]), { wakeUserPriority: async () => {} }, "t2");
	const scheduled = [];
	schedulePendingUserPriorityWakes(new Set(), projectPath, false, (priorityId) => scheduled.push(priorityId));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(scheduled.includes(pendingResult.details.priorityId));
	assert.equal(scheduled.includes(appliedResult.details.priorityId), false);
});

function stopRuntime() {
	const received = [];
	return {
		received,
		async sendSteer() {},
		setStopPending() {},
		async sendAbort() {},
		async waitForSettled() {},
		async sendStopHandoff(marked) {
			received.push(marked);
		},
		async getEntries() {
			const last = received.at(-1);
			return {
				entries: last === undefined ? [] : [{ type: "message", id: "marked-1", message: { role: "user", content: last } }],
				leafId: "marked-1",
			};
		},
		getStopHandoffSettlementObservation: () => ({ observed: true, target: 1 }),
		async restartFromSession() {},
		async closeProcess() {},
	};
}

runTest("apply stops the non-selected side once and replay issues no second stop", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const runtime = stopRuntime();
	const expectations = [];
	const tools = new Map();
	registerKhalaSupervisionTools(
		{ registerTool: (tool) => tools.set(tool.name, tool) },
		{
			isDedicatedConclaveSession: () => true,
			getRuntime: (executionId) => (executionId === b.executionId ? runtime : undefined),
			registerStopHandoffExpectation: async (_context, expectation) => {
				expectations.push(expectation);
			},
		},
	);
	const context = conclaveContext(projectPath);
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(applied.details.userEntryId, "u1");
	// The lower-priority side (work-b, the non-selected side) received exactly one stop handoff.
	assert.equal(runtime.received.length, 1);
	assert.match(runtime.received[0], /stop:/);
	assert.ok(runtime.received[0].includes(result.details.priorityId));
	assert.equal(expectations.length, 1);
	assert.equal(expectations[0].executionId, b.executionId);
	assert.equal(expectations[0].assessmentId, result.details.priorityId);
	const interventions = listArchiveRecords(projectPath, false).filter((record) => record.type === "intervention");
	assert.equal(interventions.length, 1);
	assert.equal(interventions[0].payload.mode, "stop");
	assert.equal(interventions[0].payload.actionId, deterministicActionId(result.details.priorityId, "stop"));
	// Exact replay returns the existing override without issuing a second stop.
	const replay = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(replay.details.actionId, applied.details.actionId);
	assert.equal(runtime.received.length, 1);
	assert.equal(expectations.length, 1);
});

runTest("apply stops the selected side when it is the related side, and fails a running Execution with no runtime", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	// User prioritizes the related side (work-b), so the lower side is the primary (work-a).
	const result = await submitUserPriority({ selectedWorkId: "work-b", relatedWorkId: "work-a", reason: "B over A" }, userContext(projectPath, [userEntry("u1", "ba"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const tools = new Map();
	registerKhalaSupervisionTools(
		{ registerTool: (tool) => tools.set(tool.name, tool) },
		{ isDedicatedConclaveSession: () => true },
	);
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, conclaveContext(projectPath));
	assert.equal(applied.details.selectedWorkId, "work-b");
	// No runtime for work-a and it is running: it is failed and its interventions closed, like the existing coordination stop path.
	assert.equal(readExecutorRecord(projectPath, a.executionId, false).status, "failed");
	assert.equal(readExecutorRecord(projectPath, b.executionId, false).status, "running");
});

runTest("a replay reconciles a persisted stop handoff without sending a second stop", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const stopActionId = deterministicActionId(result.details.priorityId, "stop");
	const marker = supervisionMarker(stopActionId, "stop");
	const runtime = {
		isStopPending: true,
		received: [],
		async sendStopHandoff() { throw new Error("replay must not send a second stop"); },
		async sendAbort() { throw new Error("replay must not abort again"); },
		async waitForSettled() {},
		setStopPending() { throw new Error("replay must not set the stop barrier again"); },
		async getEntries() {
			return { entries: [{ type: "message", id: "persisted-stop", message: { role: "user", content: `${marker} persisted` } }], leafId: "persisted-stop" };
		},
		async closeProcess() {},
	};
	const expectations = [];
	const tools = new Map();
	registerKhalaSupervisionTools(
		{ registerTool: (tool) => tools.set(tool.name, tool) },
		{
			isDedicatedConclaveSession: () => true,
			getRuntime: (executionId) => (executionId === b.executionId ? runtime : undefined),
			registerStopHandoffExpectation: async (_context, expectation) => expectations.push(expectation),
		},
	);
	const context = conclaveContext(projectPath);
	const applied = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(applied.details.priorityId, result.details.priorityId);
	assert.equal(runtime.received.length, 0);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "intervention").length, 1);
	appendArchiveRecord(projectPath, {
		schemaVersion: 2,
		type: "signal",
		workId: b.workId,
		executionId: b.executionId,
		payload: {
			signalId: "priority-blocked",
			workId: b.workId,
			executionId: b.executionId,
			executorName: "Fixture",
			missionId: b.missionId,
			participantId: `executor:${b.executionId}`,
			kind: "blocked",
			summary: "The lower-priority execution stopped.",
			evidence: ["priority handoff"],
			observedAt: NOW,
		},
	}, false);
	const replay = await tools.get("khala_apply_user_priority").execute("t", { priorityId: result.details.priorityId }, undefined, undefined, context);
	assert.equal(replay.details.actionId, applied.details.actionId);
	assert.equal(runtime.received.length, 0);
	assert.equal(expectations.length, 1);
	assert.equal(pendingUserPriorities(projectPath, false).length, 0);
	assert.equal(listArchiveRecords(projectPath, false).filter((record) => record.type === "intervention").length, 1);
});

runTest("priority wake retries a transient immediate wake failure without restart", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	let attempts = 0;
	const coordinator = createConclaveCoordinator(
		join(process.cwd(), "dist", "src", "index.js"),
		undefined,
		async () => {},
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient Conclave wake failure");
		},
	);
	await coordinator.wakeUserPriority(projectPath, result.details.priorityId, a.workId, false);
	assert.equal(attempts, 2);
	await coordinator.dispose();
});

runTest("startup resume on the real coordinator schedules pending priorities only", async (projectPath, root) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const appliedResult = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	await supervisionTools().get("khala_apply_user_priority").execute("t", { priorityId: appliedResult.details.priorityId }, undefined, undefined, conclaveContext(projectPath));
	const pendingResult = await submitUserPriority({ selectedWorkId: "work-a", reason: "A over B again" }, userContext(projectPath, [userEntry("u2", "ab2"), assistantEntry("a2", "u2", "t2")]), { wakeUserPriority: async () => {} }, "t2");
	const woken = [];
	const coordinator = createConclaveCoordinator(
		join(process.cwd(), "dist", "src", "index.js"),
		undefined,
		async () => {},
		async (_projectPath, priorityId) => {
			woken.push(priorityId);
		},
	);
	coordinator.resume(projectPath, false);
	await new Promise((resolve) => setTimeout(resolve, 25));
	await coordinator.dispose();
	assert.ok(woken.includes(pendingResult.details.priorityId));
	assert.equal(woken.includes(appliedResult.details.priorityId), false);
});

runTest("archive replay rejects forged selected side, forged action, and mutated ignored evidence", async (projectPath) => {
	const a = appendSide(projectPath, "a", "work-a");
	const b = appendSide(projectPath, "b", "work-b");
	appendDecisionCoordination(projectPath, "coord-ab", a, b);
	const result = await submitUserPriority({ selectedWorkId: "work-a", relatedWorkId: "work-b", reason: "A over B" }, userContext(projectPath, [userEntry("u1", "ab"), assistantEntry("a1", "u1", "t1")]), { wakeUserPriority: async () => {} }, "t1");
	const record = readUserPriority(projectPath, result.details.priorityId, false);
	// Forged selected side: a structurally valid override selects work-b instead of the authorized work-a.
	assert.throws(
		() =>
			appendArchiveRecord(
				projectPath,
				{
					schemaVersion: 2,
					type: "coordination",
					workId: a.workId,
					executionId: a.executionId,
					payload: {
						coordinationId: "coord-ab",
						actionId: record.actionId,
						phase: "override",
						relation: "peer-conflict",
						workId: a.workId,
						missionId: a.missionId,
						executionId: a.executionId,
						relatedWorkId: b.workId,
						relatedMissionId: b.missionId,
						relatedExecutionId: b.executionId,
						selectedWorkId: b.workId,
						selectedMissionId: b.missionId,
						selectedExecutionId: b.executionId,
						reason: "forged",
						userEntryId: "u1",
						priorityId: record.priorityId,
					},
				},
				false,
			),
		/invalid or already-applied User Priority/,
	);
	// Forged action: the override must use the recorded deterministic action.
	assert.throws(
		() =>
			appendArchiveRecord(
				projectPath,
				{
					schemaVersion: 2,
					type: "coordination",
					workId: a.workId,
					executionId: a.executionId,
					payload: {
						coordinationId: "coord-ab",
						actionId: `action-${"f".repeat(64)}`,
						phase: "override",
						relation: "peer-conflict",
						workId: a.workId,
						missionId: a.missionId,
						executionId: a.executionId,
						relatedWorkId: b.workId,
						relatedMissionId: b.missionId,
						relatedExecutionId: b.executionId,
						selectedWorkId: "work-a",
						selectedMissionId: a.missionId,
						selectedExecutionId: a.executionId,
						reason: "forged",
						userEntryId: "u1",
						priorityId: record.priorityId,
					},
				},
				false,
			),
		/invalid or already-applied User Priority/,
	);
	// Mutated ignored evidence: the ignored phase must retain every immutable field.
	assert.throws(
		() =>
			appendArchiveRecord(
				projectPath,
				{
					schemaVersion: 2,
					type: "user-priority",
					workId: a.workId,
					payload: { ...record, reason: "mutated", status: "ignored", ignoredAt: NOW, ignoredReason: "stale" },
				},
				false,
			),
		/invalid phase sequence/,
	);
});

runTest("archive replay freezes the baseline Signal snapshot across enforcement phases", async (_projectPath, root) => {
	const mutations = {
		added: ["baseline-a", "baseline-b", "baseline-c"],
		removed: ["baseline-a"],
		reordered: ["baseline-b", "baseline-a"],
		substituted: ["baseline-a", "baseline-other"],
	};
	for (const [label, mutatedBaseline] of Object.entries(mutations)) {
		const projectPath = join(root, label);
		const a = appendSide(projectPath, `${label}-a`, `work-${label}-a`);
		const b = appendSide(projectPath, `${label}-b`, `work-${label}-b`);
		appendDecisionCoordination(projectPath, `coord-${label}`, a, b);
		const result = await submitUserPriority(
			{ selectedWorkId: a.workId, relatedWorkId: b.workId, reason: `A over B (${label})` },
			userContext(projectPath, [userEntry(`user-${label}`, "Prioritize A"), assistantEntry(`assistant-${label}`, `user-${label}`, `tool-${label}`)]),
			{ wakeUserPriority: async () => {} },
			`tool-${label}`,
		);
		const priority = readUserPriority(projectPath, result.details.priorityId, false);
		appendPriorityOverride(projectPath, a, b, priority);
		appendPriorityEnforcement(projectPath, a, b, priority, "prepared", []);
		appendPriorityEnforcement(projectPath, a, b, priority, "baseline", ["baseline-a", "baseline-b"]);
		assert.throws(
			() => appendPriorityEnforcement(projectPath, a, b, priority, "handoff", mutatedBaseline, { stopEntryIds: ["stop-entry"] }),
			/invalid phase sequence/,
			label,
		);
	}
});
