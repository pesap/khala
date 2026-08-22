import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildKhalaAttention, resolveKhalaAttention } from "../dist/src/khala-attention.js";
import { renderKhalaAttentionSummary, showKhalaAttention } from "../dist/src/khala-attention-ui.js";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
import { appendAttentionDismissal } from "../dist/src/khala-user-worker-action.js";
import { recordUserExecutorModelRecovery } from "../dist/src/khala-model-recovery.js";
import { writeExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { appendPullRequestRecord } from "../dist/src/khala-review.js";

const NOW = "2026-01-01T00:00:00.000Z";
const RECOVERY_LEASE_MS = 60_000;

function work(title) {
	return {
		title,
		objective: "Exercise the requested Khala behavior.",
		context: "The Work has enough context for Conclave review.",
		scope: "The current project.",
		acceptanceCriteria: ["The observable behavior is preserved."],
		constraints: [],
		plan: ["Exercise the behavior."],
		validation: ["Inspect the result."],
	};
}

function submission(projectPath, workId, status, overrides = {}) {
	return {
		workId,
		projectPath,
		status,
		work: work(overrides.title ?? "Test Work"),
		archivePath: join(projectPath, "archive.jsonl"),
		...(overrides.rejectionReason === undefined ? {} : { rejectionReason: overrides.rejectionReason }),
		...(status === "admitted" ? { mandateId: `mandate-${workId}` } : {}),
	};
}

function execution(projectPath, id, startedAt, status, overrides = {}) {
	const isObserver = overrides.kind === "observer";
	return {
		executionId: id,
		workId: overrides.workId ?? "work-1",
		executorName: overrides.executorName ?? `Executor ${id}`,
		kind: overrides.kind ?? "executor",
		participantId: `executor-${id}`,
		purpose: isObserver
			? { kind: "observation", submissionRecordId: `submission-${id}` }
			: { kind: "mission", missionId: overrides.missionId ?? "mission-1" },
		...(isObserver ? {} : { missionId: overrides.missionId ?? "mission-1" }),
		projectPath,
		sandboxPath: overrides.sandboxPath ?? join(projectPath, "sandbox"),
		launcher: overrides.launcher ?? "headless-rpc",
		piSessionId: overrides.piSessionId ?? `${id}-session`,
		sessionPath: overrides.sessionPath ?? join(projectPath, `${id}.jsonl`),
		promptIdentity: overrides.promptIdentity ?? { packageVersion: "test", promptSha256: "a".repeat(64) },
		...(overrides.target === undefined ? {} : { target: overrides.target }),
		...(overrides.failureCategory === undefined ? {} : { failureCategory: overrides.failureCategory }),
		...(overrides.failureMessage === undefined ? {} : { failureMessage: overrides.failureMessage }),
		status,
		startedAt,
	};
}

function mission(workId, missionId) {
	return {
		missionId,
		workId,
		mandateId: "mandate-1",
		assignment: work("Mission work"),
		assignedParticipantId: "executor-1",
		createdAt: NOW,
	};
}

function verdict(workId, missionId, executionId, decision, reason) {
	return {
		workId,
		executionId,
		signalId: "signal-1",
		missionId,
		governingMandateId: "mandate-1",
		issuedByParticipantId: "conclave-1",
		decision,
		reason,
		verdictId: `verdict-${executionId}`,
		issuedAt: NOW,
	};
}

function retryVerdict(workId, missionId, executionId) {
	return {
		...verdict(workId, missionId, executionId, "retry", "The first attempt is retryable."),
		retryHandoff: {
			failedCriteria: ["The first attempt must be redone."],
			completedWork: ["The first attempt ran."],
			requiredChanges: ["Run the corrected plan."],
			nonGoals: ["Do not change the contract."],
			validation: ["Read durable records."],
		},
		successorAssignment: work("Successor work"),
	};
}

function successorMission(workId, predecessorMissionId, causedByVerdictId) {
	return {
		missionId: "mission-2",
		workId,
		mandateId: "mandate-1",
		predecessorMissionId,
		causedByVerdictId,
		assignment: work("Successor work"),
		assignedParticipantId: "executor-1",
		createdAt: NOW,
	};
}

function pullRequest(executionId, status, overrides = {}) {
	return {
		pullRequestId: `pr-${executionId}`,
		workId: overrides.workId ?? "work-1",
		missionId: overrides.missionId ?? "mission-1",
		executionId,
		status,
		url: `https://github.com/example/repo/pull/${overrides.number ?? 1}`,
		remoteConfirmedAt: NOW,
		changedFiles: [],
		diffSummary: "fixture",
		validationResults: [],
		reviewFeedback: [],
		unresolvedGaps: [],
		recordedAt: NOW,
	};
}

function workOutcome(workId) {
	return {
		outcomeId: `outcome-${workId}`,
		workId,
		mandateId: "mandate-1",
		missionId: "mission-1",
		executionId: "execution-1",
		pullRequestId: "pr-1",
		finalHeadCommit: "a".repeat(40),
		mergeCommit: "b".repeat(40),
		changedFiles: [],
		diffSummary: "",
		validationResults: [],
		reviewFeedback: [],
		unresolvedGaps: [],
		acceptingActor: "user",
		acceptedAt: NOW,
	};
}

function append(projectPath, type, workId, payload, executionId) {
	return appendArchiveRecord(
		projectPath,
		{ type, workId, ...(executionId === undefined ? {} : { executionId }), payload },
		false,
	);
}

function contextFor(projectPath, ui) {
	const theme = ui.theme ?? { fg: (_color, text) => text };
	return {
		cwd: projectPath,
		mode: "tui",
		isProjectTrusted: () => false,
		ui: { ...ui, theme },
	};
}

function runTest(name, fn) {
	test(name, async () => {
		const root = mkdtempSync(join(tmpdir(), `khala-attention-${name.replaceAll(" ", "-")}-`));
		const projectPath = join(root, "project");
		try {
			await fn(projectPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

runTest("Archive accepts User Executor model recovery records", (projectPath) => {
	append(projectPath, "user-model-recovery", "work-1", {
		requestId: "request-1",
		role: "executor",
		model: "provider/model",
		workId: "work-1",
		missionId: "mission-1",
		predecessorExecutionId: "execution-1",
		status: "selected",
		requestedAt: NOW,
	});
});

runTest("working summary reports active Work and no user action", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
	append(projectPath, "submission", "work-2", submission(projectPath, "work-2", "admitted"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.equal(summary.activeWorkCount, 2);
	assert.deepEqual(summary.reviewRequested, []);
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.recovery, undefined);
	const text = renderKhalaAttentionSummary(summary);
	assert.match(text, /2 active Work submissions/);
	assert.match(text, /No user action required/);
});

runTest("review requested is reported first and draft Pull Requests stay hidden", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "submission", "work-2", submission(projectPath, "work-2", "admitted"));
	append(projectPath, "mission", "work-2", mission("work-2", "mission-1"));
	append(
		projectPath,
		"verdict",
		"work-2",
		verdict("work-2", "mission-1", "execution-2", "finish", "Handoff ready."),
		"execution-2",
	);
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "draft"), false);
	appendPullRequestRecord(
		projectPath,
		pullRequest("execution-2", "reviewable", { number: 42, workId: "work-2" }),
		false,
	);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.reviewRequested.length, 1);
	assert.equal(summary.reviewRequested[0].workId, "work-2");
	assert.match(summary.reviewRequested[0].detail, /pull\/42/);
	assert.equal(summary.stoppedWork.length, 0);
	const text = renderKhalaAttentionSummary(summary);
	const lines = text.split("\n");
	assert.equal(lines[0], "Khala — action required");
	assert.equal(lines[1], "#42  Test Work  [review]");
	assert.doesNotMatch(text, /draft/);
});

runTest("stopped Work derives from rejected submissions and rejected Missions", (projectPath) => {
	append(projectPath, "submission", "rejected-work", submission(projectPath, "rejected-work", "rejected", {
		rejectionReason: "Out of scope.",
	}));
	append(projectPath, "submission", "mission-work", submission(projectPath, "mission-work", "admitted"));
	append(projectPath, "mission", "mission-work", mission("mission-work", "mission-rejected"));
	append(
		projectPath,
		"verdict",
		"mission-work",
		verdict("mission-work", "mission-rejected", "execution-3", "reject", "Invalid plan."),
		"execution-3",
	);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.deepEqual(
		summary.stoppedWork.map((item) => item.workId),
		["rejected-work", "mission-work"],
	);
	assert.match(summary.stoppedWork[0].detail, /Out of scope/);
	assert.match(summary.stoppedWork[1].detail, /Invalid plan/);
	const text = renderKhalaAttentionSummary(summary);
	assert.match(text, /Rejected: Out of scope/);
	assert.match(text, /Rejected: Invalid plan/);
});

runTest("a lone failed Execution with no successor stays hidden", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.activeWorkCount, 1);
	assert.doesNotMatch(renderKhalaAttentionSummary(summary), /failed|Stopped/);
});

runTest("retryable Execution failures with a successor are hidden", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	writeExecutorRecord(execution(projectPath, "failed-execution", NOW, "failed"), false);
	writeExecutorRecord(execution(projectPath, "successor-execution", "2026-01-01T00:01:00.000Z", "running"), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.activeWorkCount, 1);
});

runTest("a failed current Mission offers same-Mission continuation", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "draft", { number: 7 }), false);
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.work.length, 1);
	assert.equal(summary.work[0].title, "Test Work");
	assert.equal(summary.work[0].missionId, "mission-1");
	assert.equal(summary.work[0].pullRequestReference, "#7");
	assert.deepEqual(summary.work[0].actions, ["continue-current-mission", "view-attempts", "dismiss"]);
	assert.match(summary.work[0].summary, /same|current Mission|failed/i);
});

runTest("an active Coordination hold explains and blocks failed-Mission recovery", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "submission", "upstream-work", submission(projectPath, "upstream-work", "admitted", { title: "Upstream Work" }));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	append(projectPath, "coordination", "work-1", {
		coordinationId: "coordination-1",
		actionId: "action-1",
		phase: "decision",
		relation: "dependency",
		workId: "work-1",
		missionId: "mission-1",
		selectedWorkId: "upstream-work",
		selectedMissionId: "upstream-mission",
		relatedWorkId: "upstream-work",
		relatedMissionId: "upstream-mission",
		upstreamWorkId: "upstream-work",
		upstreamMissionId: "upstream-mission",
		upstreamExecutionId: "upstream-execution",
		relatedExecutionId: "upstream-execution",
		selectedExecutionId: "upstream-execution",
		remote: "origin",
		branch: "feature/upstream",
		reason: "Dependency order requires the upstream Work first.",
	});
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.work.length, 1);
	assert.equal(
		summary.work[0].summary,
		"The current Mission is held for upstream Work Upstream Work; recovery is blocked",
	);
	assert.deepEqual(summary.work[0].actions, ["view-attempts", "dismiss"]);
	assert.match(renderKhalaAttentionSummary(summary), /\[held\]/);
	assert.doesNotMatch(renderKhalaAttentionSummary(summary), /Continue with a new worker/);

	const selectCalls = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : undefined;
		},
		notify() {},
	};
	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(
		selectCalls[1].title,
		"Test Work  [held]\nMission       mission-1\nReason        The current Mission is held for upstream Work Upstream Work; recovery is blocked",
	);
});

runTest("dismissing a Work condition removes only that current condition", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);

	const before = buildKhalaAttention(projectPath, false);
	assert.equal(before.work.length, 1);
	appendAttentionDismissal(projectPath, { conditionId: before.work[0].conditionId, workId: "work-1", kind: "work" });

	const after = buildKhalaAttention(projectPath, false);
	assert.equal(after.condition, "working");
	assert.deepEqual(after.work, []);
	assert.equal(after.activeWorkCount, 1);
});

runTest("a current replacement clears an older model recovery condition", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(
		execution(projectPath, "failed-execution", NOW, "failed", {
			failureCategory: "model-unavailable",
			failureMessage: "The provider quota is exhausted.",
		}),
		false,
	);
	writeExecutorRecord(
		execution(projectPath, "replacement-execution", "2026-01-01T00:01:00.000Z", "running"),
		false,
	);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.equal(summary.work.length, 0);
	assert.equal(summary.recovery, undefined);
});

runTest("runtime probing exposes only an idle current worker", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "running"), false);

	const idle = await resolveKhalaAttention(projectPath, false, async () => ({
		kind: "idle",
		executionId: "execution-1",
		sessionId: "session-1",
	}));
	assert.equal(idle.work.length, 1);
	assert.ok(idle.work[0].actions.includes("try-current-execution"));

	const busy = await resolveKhalaAttention(projectPath, false, async () => ({
		kind: "busy",
		executionId: "execution-1",
		sessionId: "session-1",
	}));
	assert.deepEqual(busy.work, []);
});

runTest("Backspace at an empty mission filter returns to the caller", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	let customCalls = 0;
	const theme = {
		fg: (_color, text) => text,
		bold: (text) => text,
		italic: (text) => text,
	};
	const ui = {
		theme,
		custom(factory) {
			customCalls += 1;
			return new Promise((resolve) => {
				const component = factory(
					{ requestRender() {} },
					theme,
					{
						matches(data, keybinding) {
							return data === "backspace" && keybinding === "tui.editor.deleteCharBackward";
						},
						getKeys() {
							return ["backspace"];
						},
					},
					resolve,
				);
				component.handleInput("backspace");
			});
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(customCalls, 1);
});

runTest("a reviewable Pull Request is suppressed once the Work has an accepted Outcome", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable"), false);
	append(projectPath, "work-outcome", "work-1", workOutcome("work-1"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 0);
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.activeWorkCount, 0);
	assert.equal(summary.condition, "working");
});

runTest("a Work Outcome takes precedence over rejected stopped evidence", (projectPath) => {
	append(projectPath, "submission", "rejected-work", submission(projectPath, "rejected-work", "rejected", {
		rejectionReason: "Out of scope.",
	}));
	append(projectPath, "submission", "mission-work", submission(projectPath, "mission-work", "admitted"));
	append(projectPath, "mission", "mission-work", mission("mission-work", "mission-rejected"));
	append(
		projectPath,
		"verdict",
		"mission-work",
		verdict("mission-work", "mission-rejected", "execution-3", "reject", "Invalid plan."),
		"execution-3",
	);
	append(projectPath, "work-outcome", "rejected-work", workOutcome("rejected-work"));
	append(projectPath, "work-outcome", "mission-work", workOutcome("mission-work"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.activeWorkCount, 0);
	assert.equal(summary.condition, "working");
});

runTest("a reviewable Pull Request requires a finished Mission", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable"), false);

	let summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.deepEqual(summary.reviewRequested, []);
	assert.equal(summary.activeWorkCount, 1);

	append(
		projectPath,
		"verdict",
		"work-1",
		verdict("work-1", "mission-1", "execution-1", "finish", "Handoff ready."),
		"execution-1",
	);
	summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.reviewRequested.length, 1);
	assert.equal(summary.reviewRequested[0].workId, "work-1");
});

runTest("a newer non-reviewable Pull Request suppresses an older reviewable one", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	append(
		projectPath,
		"verdict",
		"work-1",
		verdict("work-1", "mission-1", "execution-1", "finish", "Handoff ready."),
		"execution-1",
	);
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable", { number: 1 }), false);
	appendPullRequestRecord(projectPath, pullRequest("execution-2", "closed", { number: 2 }), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 0);
	assert.equal(summary.condition, "working");
});

runTest("a later update to a superseded Mission's PR cannot suppress the current review", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable", { number: 1 }), false);
	append(projectPath, "verdict", "work-1", retryVerdict("work-1", "mission-1", "execution-1"), "execution-1");
	append(projectPath, "mission", "work-1", successorMission("work-1", "mission-1", "verdict-execution-1"));
	append(
		projectPath,
		"verdict",
		"work-1",
		verdict("work-1", "mission-2", "execution-2", "finish", "Handoff ready."),
		"execution-2",
	);
	appendPullRequestRecord(
		projectPath,
		pullRequest("execution-2", "reviewable", { number: 2, missionId: "mission-2" }),
		false,
	);
	// The old Mission's PR receives a later closed record; it must not suppress
	// the current finished Mission's review action.
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "closed", { number: 1 }), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 1);
	assert.equal(summary.reviewRequested[0].workId, "work-1");
	assert.match(summary.reviewRequested[0].detail, /pull\/2/);
	assert.equal(summary.condition, "action-required");
});

runTest("a superseded Mission's old reviewable Pull Request is suppressed", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable"), false);
	append(projectPath, "verdict", "work-1", retryVerdict("work-1", "mission-1", "execution-1"), "execution-1");
	append(projectPath, "mission", "work-1", successorMission("work-1", "mission-1", "verdict-execution-1"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 0);
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.condition, "working");
});

runTest("a reviewable Pull Request from a rejected Mission is suppressed", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	append(
		projectPath,
		"verdict",
		"work-1",
		verdict("work-1", "mission-1", "execution-1", "reject", "Invalid plan."),
		"execution-1",
	);
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable"), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 0);
	assert.equal(summary.stoppedWork.length, 1);
	assert.equal(summary.stoppedWork[0].workId, "work-1");
	assert.equal(summary.condition, "action-required");
});

runTest("at most one review action is projected per Work", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	append(
		projectPath,
		"verdict",
		"work-1",
		verdict("work-1", "mission-1", "execution-1", "finish", "Handoff ready."),
		"execution-1",
	);
	appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable", { number: 1 }), false);
	appendPullRequestRecord(projectPath, pullRequest("execution-2", "reviewable", { number: 2 }), false);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.reviewRequested.length, 1);
	assert.match(summary.reviewRequested[0].detail, /pull\/2/);
});

runTest("exhausted Conclave submission recovery marks the Work stopped", async (projectPath) => {
	const submissionRecord = append(
		projectPath,
		"submission",
		"exhausted-work",
		submission(projectPath, "exhausted-work", "queued"),
	);
	const now = new Date().toISOString();
	const lease = new Date(Date.now() + RECOVERY_LEASE_MS).toISOString();
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-1",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "claimed",
		attempt: 1,
		maxAttempts: 2,
		ownerId: "owner-1",
		claimedAt: now,
		leaseExpiresAt: lease,
	});
	append(projectPath, "conclave-wake", "exhausted-work", {
		wakeId: "recovery-1",
		workId: "exhausted-work",
		status: "failed",
		attemptedAt: now,
		failure: "The configured Conclave runtime failed.",
		recovery: "recreate",
	});
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-2",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "claimed",
		attempt: 2,
		maxAttempts: 2,
		ownerId: "owner-1",
		claimedAt: now,
		leaseExpiresAt: lease,
	});
	append(projectPath, "conclave-wake", "exhausted-work", {
		wakeId: "recovery-2",
		workId: "exhausted-work",
		status: "failed",
		attemptedAt: now,
		failure: "The configured Conclave runtime failed again.",
		recovery: "recreate",
	});
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-3",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "exhausted",
		attempt: 2,
		maxAttempts: 2,
		exhaustedAt: now,
		reason: "Automatic Conclave recovery exhausted its durable retry limit.",
	});

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.stoppedWork.length, 1);
	assert.equal(summary.stoppedWork[0].workId, "exhausted-work");
	assert.match(summary.stoppedWork[0].detail, /recovery for this Work was exhausted/);
	assert.match(renderKhalaAttentionSummary(summary), /Test Work  \[stalled\]/);
	assert.deepEqual(summary.work[0].actions, ["recover-conclave", "view-attempts", "dismiss"]);
	// The failed wake remains suppressed as a duplicate project condition, while
	// the stopped Work keeps the explicit Conclave recovery action.
	assert.equal(summary.recovery, undefined);

	const selectCalls = [];
	let recoveryCalls = 0;
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : "Recover Conclave";
		},
		notify() {},
	};
	await showKhalaAttention(contextFor(projectPath, ui), undefined, undefined, () => {
		recoveryCalls += 1;
	});
	assert.deepEqual(selectCalls[1].options, ["Recover Conclave", "View attempts", "Dismiss"]);
	assert.equal(recoveryCalls, 1);
});

runTest("a Work Outcome takes precedence over historical exhausted recovery", (projectPath) => {
	const submissionRecord = append(
		projectPath,
		"submission",
		"exhausted-work",
		submission(projectPath, "exhausted-work", "admitted"),
	);
	const now = new Date().toISOString();
	const lease = new Date(Date.now() + RECOVERY_LEASE_MS).toISOString();
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-1",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "claimed",
		attempt: 1,
		maxAttempts: 2,
		ownerId: "owner-1",
		claimedAt: now,
		leaseExpiresAt: lease,
	});
	append(projectPath, "conclave-wake", "exhausted-work", {
		wakeId: "recovery-1",
		workId: "exhausted-work",
		status: "failed",
		attemptedAt: now,
		failure: "The configured Conclave runtime failed.",
		recovery: "recreate",
	});
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-2",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "claimed",
		attempt: 2,
		maxAttempts: 2,
		ownerId: "owner-1",
		claimedAt: now,
		leaseExpiresAt: lease,
	});
	append(projectPath, "conclave-wake", "exhausted-work", {
		wakeId: "recovery-2",
		workId: "exhausted-work",
		status: "failed",
		attemptedAt: now,
		failure: "The configured Conclave runtime failed again.",
		recovery: "recreate",
	});
	append(projectPath, "conclave-recovery", "exhausted-work", {
		recoveryId: "recovery-3",
		workId: "exhausted-work",
		submissionRecordId: submissionRecord.recordId,
		status: "exhausted",
		attempt: 2,
		maxAttempts: 2,
		exhaustedAt: now,
		reason: "Automatic Conclave recovery exhausted its durable retry limit.",
	});
	append(projectPath, "work-outcome", "exhausted-work", workOutcome("exhausted-work"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.deepEqual(summary.stoppedWork, []);
	assert.equal(summary.activeWorkCount, 0);
	assert.equal(summary.condition, "working");
});

runTest("model-unavailable Executor surfaces scoped model recovery", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(
		execution(projectPath, "execution-1", NOW, "failed", {
			failureCategory: "model-unavailable",
			failureMessage: "429 quota exceeded",
			missionId: "mission-1",
		}),
		false,
	);

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.recovery?.kind, "executor-model");
	assert.equal(summary.recovery?.workId, "work-1");
	assert.equal(summary.recovery?.missionId, "mission-1");
	assert.ok(summary.work[0].actions.includes("select-model"));
	assert.match(renderKhalaAttentionSummary(summary), /select another model/);
});

runTest("model recovery validates against the active selector model list", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	const failedExecution = execution(projectPath, "execution-1", NOW, "failed", {
		failureCategory: "model-unavailable",
		failureMessage: "The configured model is unavailable.",
	});
	writeExecutorRecord(failedExecution, false);

	const record = recordUserExecutorModelRecovery({
		projectPath,
		pending: { execution: failedExecution, mission: mission("work-1", "mission-1") },
		model: "custom-provider/custom-model",
		availableModels: ["custom-provider/custom-model"],
	});
	assert.equal(record.model, "custom-provider/custom-model");
});

runTest("legacy Executor records retain model recovery selection", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(
		execution(projectPath, "execution-1", NOW, "failed", {
			failureCategory: "model-unavailable",
			failureMessage: "429 quota exceeded",
		}),
		false,
	);
	const legacy = execution(projectPath, "execution-1", NOW, "failed", {
		failureCategory: "model-unavailable",
		failureMessage: "429 quota exceeded",
	});
	delete legacy.purpose;
	legacy.model = "provider/unavailable";
	writeExecutorRecord(legacy, false);
	const selectCalls = [];
	const ui = {
		modelRegistry: {
			getAvailable: () => [
				{ provider: "provider", id: "replacement-model" },
				{ provider: "provider", id: "another-model" },
			],
		},
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : undefined;
		},
		notify() {},
	};

	await showKhalaAttention({ ...contextFor(projectPath, ui), modelRegistry: ui.modelRegistry }, undefined);
	assert.deepEqual(selectCalls[1].options, ["Select another model", "View attempts", "Dismiss"]);
});

runTest("failed Conclave wakes surface recovery attention", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
	append(projectPath, "conclave-wake", "work-1", {
		wakeId: "wake-1",
		workId: "work-1",
		status: "failed",
		attemptedAt: NOW,
		failure: "The configured Conclave runtime failed.",
		recovery: "recreate",
	});

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "action-required");
	assert.equal(summary.recovery?.kind, "recreate");
	assert.match(renderKhalaAttentionSummary(summary), /\/khala-recover/);
});

runTest("accepted Work is not counted as active", (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "submission", "work-2", submission(projectPath, "work-2", "admitted"));
	append(projectPath, "work-outcome", "work-1", workOutcome("work-1"));

	const summary = buildKhalaAttention(projectPath, false);
	assert.equal(summary.condition, "working");
	assert.equal(summary.activeWorkCount, 1);
});

runTest("running Observers are secondary read-only options without internal labels", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-observer-"));
	const projectPath = join(root, "project");
	try {
		append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
		writeExecutorRecord(
			execution(projectPath, "observer-1", NOW, "running", {
				kind: "observer",
				launcher: "tmux",
				target: "observer-pane",
				executorName: "Observer One",
			}),
			false,
		);
		writeExecutorRecord(execution(projectPath, "execution-1", NOW, "running"), false);

		const summary = buildKhalaAttention(projectPath, false);
		assert.equal(summary.condition, "working");
		const text = renderKhalaAttentionSummary(summary);
		assert.doesNotMatch(text, /headless|supervision|unavailable|recovering|Participant|Executor/);

		const selectCalls = [];
		const notifications = [];
		const ui = {
			async select(title, options) {
				selectCalls.push({ title, options });
				return undefined;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		};
		await showKhalaAttention(contextFor(projectPath, ui), undefined);
		assert.equal(selectCalls.length, 1);
		assert.equal(selectCalls[0].title, "Khala — no user action required");
		assert.deepEqual(selectCalls[0].options, ["Inspect Observer pane: Observer One  [available]"]);
		assert.deepEqual(notifications, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

runTest("a stale running Observer record followed by a failed record offers no inspection", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-observer-stale-"));
	const projectPath = join(root, "project");
	try {
		append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
		const observer = {
			kind: "observer",
			launcher: "tmux",
			target: "observer-pane",
			executorName: "Observer One",
		};
		writeExecutorRecord(execution(projectPath, "observer-1", NOW, "running", observer), false);
		writeExecutorRecord(
			execution(projectPath, "observer-1", "2026-01-01T00:01:00.000Z", "failed", observer),
			false,
		);
		const selectCalls = [];
		const notifications = [];
		const ui = {
			async select(title, options) {
				selectCalls.push({ title, options });
				return undefined;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		};
		await showKhalaAttention(contextFor(projectPath, ui), undefined);
		assert.equal(selectCalls.length, 0);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /No user action required/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

runTest("the interactive selector lists Work options before the Observer option", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-selector-"));
	const projectPath = join(root, "project");
	try {
		append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
		append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
		append(
			projectPath,
			"verdict",
			"work-1",
			verdict("work-1", "mission-1", "execution-1", "finish", "Handoff ready."),
			"execution-1",
		);
		appendPullRequestRecord(projectPath, pullRequest("execution-1", "reviewable"), false);
		writeExecutorRecord(
			execution(projectPath, "observer-1", NOW, "running", {
				kind: "observer",
				launcher: "zellij",
				target: "observer-pane",
				executorName: "Observer Two",
			}),
			false,
		);
		const selectCalls = [];
		const notifications = [];
		const ui = {
			async select(title, options) {
				selectCalls.push({ title, options });
				return "Inspect Observer pane: Observer Two  [available]";
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		};
		let viewed = null;
		await showKhalaAttention(contextFor(projectPath, ui), async (launcher, target) => {
			viewed = { launcher, target };
		});
		assert.equal(selectCalls.length, 1);
		assert.equal(selectCalls[0].title, "Khala — action required");
		assert.deepEqual(selectCalls[0].options, [
			"#1  Test Work  [review]",
			"Inspect Observer pane: Observer Two  [available]",
		]);
		assert.deepEqual(viewed, { launcher: "zellij", target: "observer-pane" });
		assert.deepEqual(notifications, []);

		const detailUi = {
			async select(_title, options) {
				return options[0];
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		};
		await showKhalaAttention(contextFor(projectPath, detailUi), undefined);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		assert.match(notifications[0].message, /github\.com\/example\/repo\/pull/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

runTest("attention selector dims its lowercase status tag", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	let options;
	const ui = {
		theme: { fg: (color, text) => (color === "dim" ? `<dim>${text}</dim>` : text) },
		async select(_title, candidates) {
			options = candidates;
			return undefined;
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.deepEqual(options, ["Test Work  <dim>[failed]</dim>"]);
});

runTest("duplicate attention labels dispatch the selected Work", async (projectPath) => {
	for (const [workId, missionId, executionId] of [
		["work-1", "mission-1", "execution-1"],
		["work-2", "mission-2", "execution-2"],
	]) {
		append(projectPath, "submission", workId, submission(projectPath, workId, "admitted"));
		append(projectPath, "mission", workId, mission(workId, missionId));
		writeExecutorRecord(
			execution(projectPath, executionId, NOW, "failed", { workId, missionId }),
			false,
		);
	}
	const selectCalls = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[1] : "Dismiss";
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.deepEqual(selectCalls[0].options, ["Test Work  [failed]", "Test Work  [failed] (2)"]);
	assert.equal(selectCalls[1].title.startsWith("Test Work  [failed]"), true);
	assert.deepEqual(buildKhalaAttention(projectPath, false).work.map((item) => item.workId), ["work-1"]);
});

runTest("View attempts opens a selectable attempt detail", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(
		execution(projectPath, "execution-1", NOW, "failed", {
			executorName: "Urun-mswezw8j",
			failureMessage: "The worker exited with code 137.",
		}),
		false,
	);
	writeExecutorRecord(
		execution(projectPath, "execution-2", "2026-01-01T00:01:00.000Z", "failed", {
			executorName: "Rohana-mszmync3",
			failureCategory: "model-unavailable",
			failureMessage: "The provider returned an invalid response.",
		}),
		false,
	);
	let customCalls = 0;
	const ui = {
		theme: {
			fg(color, text) {
				return color === "muted" ? `<muted>${text}</muted>` : color === "accent" ? `<accent>${text}</accent>` : color === "dim" ? `<dim>${text}</dim>` : text;
			},
			bold(text) {
				return text;
			},
			italic(text) {
				return text;
			},
		},
		async custom(factory) {
			customCalls += 1;
			return new Promise((resolve) => {
				const component = factory(
					{ requestRender() {} },
					ui.theme,
					{
						matches(data, keybinding) {
							return (
								(data === "enter" && keybinding === "tui.select.confirm") ||
								(data === "down" && keybinding === "tui.select.down") ||
								(data === "backspace" && keybinding === "tui.editor.deleteCharBackward")
							);
						},
						getKeys(keybinding) {
							return [keybinding];
						},
					},
					resolve,
				);
				if (customCalls === 3) {
					const rows = component
						.render(200)
						.filter((line) => line.includes("execution error") || line.includes("model unavailable"));
					assert.equal(rows.length, 2);
					const plainRows = rows.map((row) => row.replaceAll(/<\/?[^>]+>/gu, ""));
					assert.equal(plainRows[0].indexOf("[execution error]"), plainRows[1].indexOf("[model unavailable]"));
					assert.doesNotMatch(plainRows[0], /Attempt/);
					component.handleInput("down");
					component.handleInput("enter");
				} else if (customCalls === 4) {
					const detail = component.render(200).join("\n");
					assert.match(detail, /Attempt\s+2/);
					assert.match(detail, /Execution\s+execution-2/);
					assert.match(detail, /Failure type\s+model unavailable/);
					assert.match(detail, /Failure\s+The provider returned an invalid response\./);
					assert.match(detail, /Launcher\s+headless-rpc/);
					component.handleInput("backspace");
				} else if (customCalls === 1 || customCalls === 2) {
					component.handleInput("enter");
				} else {
					component.handleInput("backspace");
				}
			});
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(customCalls, 7);
});

runTest("Work selection opens one Archive-backed worker action", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	const selectCalls = [];
	const notifications = [];
	const requests = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			if (selectCalls.length === 1) return selectCalls[0].options[0];
			return "Continue with a new worker";
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	};
	await showKhalaAttention(contextFor(projectPath, ui), undefined, {
		async executeWorkerAction(_projectPath, request) {
			requests.push(request);
			return {
				status: "started",
				actionId: request.actionId,
				missionId: "mission-1",
				executionId: "replacement-1",
				predecessorExecutionId: "execution-1",
			};
		},
		async probeExecutionRuntime() {
			return { kind: "unknown", executionId: "unused", reason: "unused" };
		},
	});
	assert.deepEqual(selectCalls[0].options, ["Test Work  [failed]"]);
	assert.deepEqual(selectCalls[1].options, ["Continue with a new worker", "View attempts", "Dismiss"]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].expectedMissionId, "mission-1");
	assert.equal(requests[0].expectedExecutionId, "execution-1");
	assert.equal(notifications[0].message, "A new worker was started for the current Mission.");
	assert.equal(notifications[0].level, "info");
});

runTest("worker action notifications summarize long Coordination diagnostics", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	const notifications = [];
	const longReason =
		"The new Mission owns the shared Archive-read, recovery, launch, and Work-tool seams whose failures prevent reliable current-main reconciliation. Hold it while this single integration Mission repairs those shared lifecycle contracts.";
	const ui = {
		async select(_title, options) {
			return options[0];
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	};
	await showKhalaAttention(contextFor(projectPath, ui), undefined, {
		async executeWorkerAction(_projectPath, request) {
			return { status: "held", actionId: request.actionId, missionId: "mission-1", reason: longReason };
		},
		async probeExecutionRuntime() {
			return { kind: "unknown", executionId: "unused", reason: "unused" };
		},
	});
	assert.deepEqual(notifications, [
		{ message: "The current Mission is currently held; no worker was started.", level: "warning" },
	]);
	assert.doesNotMatch(notifications[0].message, /shared Archive-read/);
});

runTest("worker action exceptions hide already-formatted diagnostics", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	const notifications = [];
	const longReason =
		"The new Mission owns the shared Archive-read, recovery, launch, and Work-tool seams whose failures prevent reliable current-main reconciliation.";
	const ui = {
		async select(_title, options) {
			return options[0];
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	};
	await showKhalaAttention(contextFor(projectPath, ui), undefined, {
		async executeWorkerAction(_projectPath, request) {
			throw new Error(`Khala could not apply the action: ${longReason}`);
		},
		async probeExecutionRuntime() {
			return { kind: "unknown", executionId: "unused", reason: "unused" };
		},
	});
	assert.deepEqual(notifications, [{ message: "Khala could not apply the action.", level: "error" }]);
});

runTest("Escape from a Work action menu returns to the top-level attention list", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	const selectCalls = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : undefined;
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(selectCalls.length, 3);
	assert.equal(selectCalls[0].title, "Khala — action required");
	assert.equal(
		selectCalls[1].title,
		"Test Work  [failed]\nMission       mission-1\nStatus        The current worker failed; the Mission can continue",
	);
	assert.equal(selectCalls[2].title, "Khala — action required");
});

runTest("Back from a Work action menu returns to the top-level attention list", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "admitted"));
	append(projectPath, "mission", "work-1", mission("work-1", "mission-1"));
	writeExecutorRecord(execution(projectPath, "execution-1", NOW, "failed"), false);
	const selectCalls = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : undefined;
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(selectCalls.length, 3);
	assert.equal(selectCalls[1].options.at(-1), "Dismiss");
	assert.equal(selectCalls[2].title, "Khala — action required");
});

runTest("Back from a project recovery menu returns to the top-level attention list", async (projectPath) => {
	append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
	append(projectPath, "conclave-wake", "work-1", {
		wakeId: "wake-1",
		workId: "work-1",
		status: "failed",
		attemptedAt: NOW,
		failure: "The configured Conclave runtime failed.",
		recovery: "recreate",
	});
	const selectCalls = [];
	const ui = {
		async select(title, options) {
			selectCalls.push({ title, options });
			return selectCalls.length === 1 ? options[0] : undefined;
		},
		notify() {},
	};

	await showKhalaAttention(contextFor(projectPath, ui), undefined);
	assert.equal(selectCalls.length, 3);
	assert.equal(selectCalls[1].options.at(-1), "Dismiss");
	assert.equal(selectCalls[2].title, "Khala — action required");
});

runTest("non-interactive mode notifies the summary without a selector", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-print-"));
	const projectPath = join(root, "project");
	try {
		append(projectPath, "submission", "work-1", submission(projectPath, "work-1", "queued"));
		const notifications = [];
		const ui = {
			async select() {
				throw new Error("select must not run in print mode");
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		};
		const context = { ...contextFor(projectPath, ui), mode: "print" };
		await showKhalaAttention(context, undefined);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		assert.match(notifications[0].message, /No user action required/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
