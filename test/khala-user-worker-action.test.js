import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
import { appendUserWorkerActionOutcome, appendUserWorkerActionRequest, executeUserWorkerAction } from "../dist/src/khala-user-worker-action.js";
import { writeExecutorRecord } from "../dist/src/khala-executor-registry.js";

const NOW = "2026-01-01T00:00:00.000Z";

function work(title = "Test Work") {
	return {
		title,
		objective: "Exercise worker recovery.",
		context: "Sufficient context.",
		scope: "The current project.",
		acceptanceCriteria: ["The behavior is preserved."],
		constraints: [],
		plan: ["Implement the behavior."],
		validation: ["Run the test."],
	};
}

function append(projectPath, type, workId, payload, executionId) {
	return appendArchiveRecord(
		projectPath,
		{ type, workId, ...(executionId === undefined ? {} : { executionId }), payload },
		false,
	);
}

function execution(projectPath) {
	return {
		executionId: "execution-1",
		workId: "work-1",
		executorName: "Executor One",
		kind: "executor",
		participantId: "executor-1",
		purpose: { kind: "mission", missionId: "mission-1" },
		missionId: "mission-1",
		projectPath,
		sandboxPath: join(projectPath, "sandbox"),
		launcher: "headless-rpc",
		piSessionId: "session-1",
		sessionPath: join(projectPath, "session.jsonl"),
		promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
		status: "running",
		startedAt: NOW,
	};
}

function mission() {
	return {
		missionId: "mission-1",
		workId: "work-1",
		mandateId: "mandate-1",
		assignment: work("Mission Work"),
		assignedParticipantId: "executor-1",
		createdAt: NOW,
	};
}

test("User Worker action requests deduplicate and outcomes remain append-only", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-worker-action-records-"));
	try {
		const input = {
			actionId: "worker-action-1",
			kind: "continue-current-mission",
			conditionId: "condition-1",
			workId: "work-1",
			expectedMissionId: "mission-1",
			expectedExecutionId: "execution-1",
		};
		const first = appendUserWorkerActionRequest(root, input);
		const replay = appendUserWorkerActionRequest(root, input);
		assert.equal(first.created, true);
		assert.equal(replay.created, false);
		assert.equal(replay.requestRecordId, first.requestRecordId);

		const completed = appendUserWorkerActionOutcome(root, {
			actionId: input.actionId,
			status: "rejected",
			reason: "The Mission changed.",
		});
		assert.equal(completed.outcome.status, "rejected");
		assert.equal(completed.outcome.requestRecordId, first.requestRecordId);
		assert.equal(appendUserWorkerActionRequest(root, input).outcome.reason, "The Mission changed.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Continue starts one replacement for the same Mission and replays its outcome", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-worker-action-continue-"));
	try {
		append(root, "mission", "work-1", mission());
		writeExecutorRecord({ ...execution(root), status: "failed" });
		let starts = 0;
		const input = {
			actionId: "worker-action-continue-1",
			kind: "continue-current-mission",
			conditionId: "condition-continue-1",
			workId: "work-1",
			expectedMissionId: "mission-1",
			expectedExecutionId: "execution-1",
			projectPath: root,
			projectTrusted: false,
			services: {
				getRuntime: async () => undefined,
				continueMission: async () => {
					starts += 1;
					return {
						status: "started",
						missionId: "mission-1",
						executionId: "replacement-1",
						predecessorExecutionId: "execution-1",
					};
				},
				failExecution: async () => {},
			},
		};
		const first = await executeUserWorkerAction(input);
		const replay = await executeUserWorkerAction(input);
		assert.equal(first.status, "started");
		assert.equal(replay.status, "already-active");
		assert.equal(starts, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Try current worker again sends one identified continuation without replaying prior text", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-worker-action-try-"));
	try {
		append(root, "mission", "work-1", mission());
		writeExecutorRecord(execution(root));
		const prompts = [];
		const runtime = {
			async probeRuntime() {
				return { kind: "idle", executionId: "execution-1", sessionId: "session-1" };
			},
			async sendPrompt(message) {
				prompts.push(message);
			},
			async getEntries() {
				return {
					entries: [{ message: { role: "user", content: prompts.at(-1) } }],
				};
			},
		};
		const result = await executeUserWorkerAction({
			actionId: "worker-action-try-1",
			kind: "try-current-execution",
			conditionId: "condition-try-1",
			workId: "work-1",
			expectedMissionId: "mission-1",
			expectedExecutionId: "execution-1",
			projectPath: root,
			projectTrusted: false,
			services: {
				getRuntime: async () => runtime,
				continueMission: async () => ({ status: "stale", reason: "not used" }),
				failExecution: async () => {},
			},
		});
		assert.equal(result.status, "sent");
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /worker-action-try-1/);
		assert.doesNotMatch(prompts[0], /previous model request|last prompt/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
