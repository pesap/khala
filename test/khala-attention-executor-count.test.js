import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { showKhalaAttention } from "../dist/src/khala-attention-ui.js";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
import { writeExecutorRecord } from "../dist/src/khala-executor-registry.js";

const NOW = "2026-01-01T00:00:00.000Z";

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

function append(projectPath, type, workId, payload, executionId) {
	return appendArchiveRecord(
		projectPath,
		{ type, workId, ...(executionId === undefined ? {} : { executionId }), payload },
		false,
	);
}

function execution(projectPath, executionId, status, missionId = "mission-1") {
	return {
		executionId,
		workId: "work-1",
		executorName: executionId,
		kind: "executor",
		participantId: `participant-${executionId}`,
		purpose: { kind: "mission", missionId },
		missionId,
		projectPath,
		sandboxPath: join(projectPath, "sandbox"),
		launcher: "headless-rpc",
		piSessionId: `${executionId}-session`,
		sessionPath: join(projectPath, `${executionId}.jsonl`),
		promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
		status,
		startedAt: NOW,
	};
}

test("mission selector refreshes its plain-text running Executor count", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-executor-count-"));
	const projectPath = join(root, "project");
	try {
		append(projectPath, "submission", "work-1", {
			workId: "work-1",
			projectPath,
			status: "admitted",
			work: work("Test Work"),
			archivePath: join(projectPath, "archive.jsonl"),
			mandateId: "mandate-1",
		});
		append(projectPath, "mission", "work-1", {
			missionId: "mission-1",
			workId: "work-1",
			mandateId: "mandate-1",
			assignment: work("Mission work"),
			assignedParticipantId: "executor-1",
			createdAt: NOW,
		});
		writeExecutorRecord(execution(projectPath, "running-1", "running"), false);
		writeExecutorRecord(execution(projectPath, "running-2", "running"), false);
		writeExecutorRecord(
			{
				...execution(projectPath, "observer-1", "running"),
				kind: "observer",
				purpose: { kind: "observation", submissionRecordId: "submission-1" },
				missionId: undefined,
			},
			false,
		);
		writeExecutorRecord(execution(projectPath, "failed-1", "failed"), false);

		const theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
			italic: (text) => text,
		};
		let initialRender;
		let refreshedRender;
		let requestRenders = 0;
		const ui = {
			theme,
			async custom(factory) {
				return new Promise((resolve) => {
					const component = factory(
						{ requestRender() { requestRenders += 1; } },
						theme,
						{
							matches(data, keybinding) {
								return data === "escape" && keybinding === "tui.select.cancel";
							},
							getKeys(keybinding) {
								return [keybinding];
							},
						},
						resolve,
					);
					initialRender = component.render(200).join("\n");
					setTimeout(() => {
						writeExecutorRecord(execution(projectPath, "running-1", "failed"), false);
					}, 50);
					const refreshDeadline = Date.now() + 2_500;
					const checkRefresh = () => {
						refreshedRender = component.render(200).join("\n");
						if (/\[1 running\]/u.test(refreshedRender) || Date.now() >= refreshDeadline) {
							component.handleInput?.("escape");
							return;
						}
						setTimeout(checkRefresh, 50);
					};
					setTimeout(checkRefresh, 75);
				});
			},
			notify() {},
		};

		await showKhalaAttention(
			{
				cwd: projectPath,
				mode: "tui",
				ui,
				isProjectTrusted: () => false,
			},
			undefined,
		);
		assert.match(initialRender, /Test Work  \[2 running\]/u);
		assert.doesNotMatch(initialRender, /Test Work  \[failed\]/u);
		assert.match(refreshedRender, /Test Work  \[1 running\]/u);
		const requestRendersAfterClose = requestRenders;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		assert.equal(requestRenders, requestRendersAfterClose);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a running Executor replaces exhausted recovery status in the Work menu", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-running-status-"));
	const projectPath = join(root, "project");
	try {
		const submissionRecord = append(projectPath, "submission", "work-1", {
			workId: "work-1",
			projectPath,
			status: "admitted",
			work: work("Make Oracle review output useful and robust"),
			archivePath: join(projectPath, "archive.jsonl"),
			mandateId: "mandate-1",
		});
		append(projectPath, "mission", "work-1", {
			missionId: "mission-1",
			workId: "work-1",
			mandateId: "mandate-1",
			assignment: work("Mission work"),
			assignedParticipantId: "executor-1",
			createdAt: NOW,
		});
		const recoveryNow = new Date().toISOString();
		const recoveryLease = new Date(Date.now() + 60_000).toISOString();
		append(projectPath, "conclave-recovery", "work-1", {
			recoveryId: "recovery-1",
			workId: "work-1",
			submissionRecordId: submissionRecord.recordId,
			status: "claimed",
			attempt: 1,
			maxAttempts: 1,
			ownerId: "owner-1",
			claimedAt: recoveryNow,
			leaseExpiresAt: recoveryLease,
		});
		append(projectPath, "conclave-wake", "work-1", {
			wakeId: "recovery-1",
			workId: "work-1",
			status: "failed",
			attemptedAt: recoveryNow,
			failure: "Automatic Conclave recovery failed.",
			recovery: "recreate",
		});
		append(projectPath, "conclave-recovery", "work-1", {
			recoveryId: "recovery-2",
			workId: "work-1",
			submissionRecordId: submissionRecord.recordId,
			status: "exhausted",
			attempt: 1,
			maxAttempts: 1,
			exhaustedAt: recoveryNow,
			reason: "Automatic Conclave submission recovery was exhausted.",
		});
		writeExecutorRecord(execution(projectPath, "running-1", "running"), false);

		const theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
			italic: (text) => text,
		};
		let customCalls = 0;
		let detailRender;
		const ui = {
			theme,
			async custom(factory) {
				customCalls += 1;
				return new Promise((resolve) => {
					const component = factory(
						{ requestRender() {} },
						theme,
						{
							matches(data, keybinding) {
								return (
									(data === "enter" && keybinding === "tui.select.confirm") ||
									(data === "escape" && keybinding === "tui.select.cancel")
								);
							},
							getKeys(keybinding) {
								return [keybinding];
							},
						},
						resolve,
					);
					if (customCalls === 1) {
						assert.match(component.render(200).join("\n"), /\[1 running\]/u);
						component.handleInput?.("enter");
					} else if (customCalls === 2) {
						detailRender = component.render(200).join("\n");
						component.handleInput?.("escape");
					} else {
						component.handleInput?.("escape");
					}
				});
			},
			notify() {},
		};

		await showKhalaAttention(
			{
				cwd: projectPath,
				mode: "tui",
				ui,
				isProjectTrusted: () => false,
			},
			undefined,
		);
		assert.match(detailRender, /Make Oracle review output useful and robust  \[1 running\]/u);
		assert.match(detailRender, /Status        1 Executor running/u);
		assert.doesNotMatch(detailRender, /\[stalled\]|recovery was exhausted|Recover Conclave/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
