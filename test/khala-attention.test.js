import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildKhalaAttention } from "../dist/src/khala-attention.js";
import { renderKhalaAttentionSummary, showKhalaAttention } from "../dist/src/khala-attention-ui.js";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
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
	return {
		cwd: projectPath,
		mode: "tui",
		isProjectTrusted: () => false,
		ui,
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
	assert.match(lines[1], /^Review requested: Test Work — .*pull\/42/);
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

runTest("exhausted Conclave submission recovery marks the Work stopped", (projectPath) => {
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
	// The Work is already stopped through exhaustion, so the failed wake must
	// not also offer duplicate /khala-recreate guidance.
	assert.equal(summary.recovery, undefined);
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
	assert.match(renderKhalaAttentionSummary(summary), /different Executor model/);
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
	assert.match(renderKhalaAttentionSummary(summary), /\/khala-recreate/);
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
		assert.deepEqual(selectCalls[0].options, ["Inspect Observer pane (read-only): Observer One"]);
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

runTest("the interactive selector lists actions first and the Observer option last", async () => {
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
				return "Inspect Observer pane (read-only): Observer Two";
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
			"Review requested: Test Work",
			"Inspect Observer pane (read-only): Observer Two",
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
		assert.match(notifications[0].message, /is ready for review/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
