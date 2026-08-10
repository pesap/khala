import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
import { listPullRequestRecords } from "../dist/src/khala-archive-projections.js";
import { createExecutorRecord, readExecutorRecord, writeExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { appendPullRequestRecord } from "../dist/src/khala-review.js";
import { recoverTerminalExecutionStates } from "../dist/src/khala-verdict-recovery.js";

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
