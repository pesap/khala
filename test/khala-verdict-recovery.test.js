import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { listPullRequestRecords } from "../dist/src/khala-archive-projections.js";
import { createExecutorRecord, readExecutorRecord, writeExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { appendPullRequestRecord } from "../dist/src/khala-review.js";
import { materializeReviewRequestedSuccessor, recoverTerminalExecutionStates } from "../dist/src/khala-verdict-recovery.js";

test("terminal recovery tolerates Finish history that predates Pull Request evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-legacy-finish-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const now = new Date().toISOString();
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "legacy-execution",
				workId: "legacy-work",
				executorName: "Legacy Executor",
				kind: "executor",
				participantId: "executor:legacy-execution",
				purpose: { kind: "mission", missionId: "legacy-mission" },
				missionId: "legacy-mission",
				projectPath,
				sandboxPath: join(root, "sandbox"),
				launcher: "headless-rpc",
				piSessionId: "legacy-pi-session",
				sessionPath: join(root, "legacy-executor.jsonl"),
				promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
			}),
		);
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "verdict",
			workId: "legacy-work",
			executionId: "legacy-execution",
			payload: {
				workId: "legacy-work",
				executionId: "legacy-execution",
				signalId: "legacy-finished-signal",
				missionId: "legacy-mission",
				governingMandateId: "legacy-mandate",
				issuedByParticipantId: "conclave:legacy",
				decision: "finish",
				reason: "The historical execution completed.",
				verdictId: "legacy-finish-verdict",
				issuedAt: now,
			},
		});

		assert.doesNotThrow(() => recoverTerminalExecutionStates(projectPath, false));
		assert.equal(readExecutorRecord(projectPath, "legacy-execution")?.status, "finished");
		assert.deepEqual(listPullRequestRecords(projectPath), []);

		appendPullRequestRecord(
			projectPath,
			{
				pullRequestId: "legacy-pull-request",
				workId: "legacy-work",
				missionId: "legacy-mission",
				executionId: "legacy-execution",
				status: "draft",
				url: "https://github.com/example/repo/pull/1",
				remoteConfirmedAt: now,
				changedFiles: [],
				diffSummary: "",
				validationResults: [],
				reviewFeedback: [],
				unresolvedGaps: [],
				recordedAt: now,
			},
			false,
		);
		recoverTerminalExecutionStates(projectPath, false);
		assert.equal(listPullRequestRecords(projectPath).at(-1)?.status, "reviewable");
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("a changes-requested review materializes an appendable v2 retry Verdict and successor Mission", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-retry-successor-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const now = new Date().toISOString();
		const terms = {
			title: "Retry Work",
			objective: "Verify the retry contract.",
			context: "Retry context.",
			scope: "Focused scope.",
			acceptanceCriteria: ["The focused test passes."],
			constraints: [],
			plan: ["Apply the required changes."],
			validation: ["Run the focused test."],
		};
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mandate",
			workId: "retry-work",
			payload: {
				mandateId: "retry-mandate",
				workId: "retry-work",
				revision: 1,
				sourceSubmissionRecordId: "submission-record",
				terms,
				admittedByParticipantId: "conclave:test",
				admittedAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: "retry-work",
			payload: {
				missionId: "retry-mission",
				workId: "retry-work",
				mandateId: "retry-mandate",
				assignment: terms,
				assignedParticipantId: "executor:retry-mission",
				createdAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "signal",
			workId: "retry-work",
			executionId: "retry-execution",
			payload: {
				signalId: "retry-finish-signal",
				workId: "retry-work",
				executionId: "retry-execution",
				executorName: "Retry Executor",
				missionId: "retry-mission",
				participantId: "executor:retry-mission",
				kind: "finished",
				summary: "Finished.",
				evidence: ["validation passed"],
				observedAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "verdict",
			workId: "retry-work",
			executionId: "retry-execution",
			payload: {
				workId: "retry-work",
				executionId: "retry-execution",
				signalId: "retry-finish-signal",
				missionId: "retry-mission",
				governingMandateId: "retry-mandate",
				issuedByParticipantId: "conclave:test",
				decision: "finish",
				reason: "Finished.",
				verdictId: "retry-finish-verdict",
				issuedAt: now,
			},
		});
		appendPullRequestRecord(projectPath, {
			pullRequestId: "retry-pr",
			workId: "retry-work",
			missionId: "retry-mission",
			executionId: "retry-execution",
			status: "changes-requested",
			url: "https://github.com/example/repo/pull/2",
			remoteConfirmedAt: now,
			changedFiles: ["src/a.ts"],
			diffSummary: "Change.",
			validationResults: [],
			reviewFeedback: ["Add the focused test."],
			unresolvedGaps: [],
			recordedAt: now,
		});

		assert.equal(materializeReviewRequestedSuccessor(projectPath, false, "retry-work"), true);
		const records = listArchiveRecords(projectPath);
		const retryVerdicts = records.filter((record) => record.type === "verdict" && record.payload.decision === "retry");
		assert.equal(retryVerdicts.length, 1);
		assert.ok(retryVerdicts[0].payload.retryHandoff);
		assert.ok(retryVerdicts[0].payload.successorAssignment);
		assert.deepEqual(retryVerdicts[0].payload.successorAssignment, terms);
		assert.equal(records.filter((record) => record.type === "mission").length, 2);
		// The materialized records must satisfy the strict v2 replay validation.
		assert.doesNotThrow(() => listArchiveRecords(projectPath));
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
