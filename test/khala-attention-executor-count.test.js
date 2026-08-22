import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { showKhalaAttention } from "../dist/src/khala-attention-ui.js";
import { appendArchiveRecord } from "../dist/src/khala-archive.js";
import { writeExecutorRecord } from "../dist/src/khala-executor-registry.js";

const NOW = "2026-01-01T00:00:00.000Z";
const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
};
const keys = {
	matches(data, keybinding) {
		return (
			(data === "enter" && keybinding === "tui.select.confirm") ||
			(data === "escape" && keybinding === "tui.select.cancel")
		);
	},
	getKeys(keybinding) {
		return [keybinding];
	},
};

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

function setupMission(projectPath, title, submissionStatus = "admitted") {
	const submission = append(projectPath, "submission", "work-1", {
		workId: "work-1",
		projectPath,
		status: submissionStatus,
		work: work(title),
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
	return submission;
}

function controller(liveExecutions, probeRuntime) {
	return {
		hasLiveExecutionRuntime(_projectPath, executionId) {
			return liveExecutions.has(executionId);
		},
		async probeExecutionRuntime(_projectPath, executionId) {
			return probeRuntime(executionId);
		},
		async executeWorkerAction() {
			throw new Error("No worker action should be executed while selecting.");
		},
	};
}

function context(projectPath, onCustom) {
	let customCount = 0;
	const ui = {
		theme,
		async custom(factory) {
			return new Promise((resolve) => {
				customCount += 1;
				const component = factory({ requestRender() {} }, theme, keys, resolve);
				onCustom(component, customCount);
			});
		},
		notify() {},
	};
	return { cwd: projectPath, mode: "tui", ui, isProjectTrusted: () => false };
}

async function runAttention(projectPath, runtimeController, onCustom) {
	await showKhalaAttention(context(projectPath, onCustom), undefined, runtimeController);
}

function cleanup(root) {
	rmSync(root, { recursive: true, force: true });
}

test("a live-but-idle runtime shows idle status without a running badge", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-idle-runtime-"));
	const projectPath = join(root, "project");
	try {
		setupMission(projectPath, "Test Work");
		writeExecutorRecord(execution(projectPath, "execution-1", "running"), false);
		let selectorRender;
		let menuRender;
		await runAttention(
			projectPath,
			controller(new Set(["execution-1"]), (executionId) => ({
				kind: "idle",
				executionId,
				sessionId: `${executionId}-session`,
			})),
			(component, count) => {
				if (count === 1) {
					selectorRender = component.render(200).join("\n");
					component.handleInput?.("enter");
				} else if (count === 2) {
					menuRender = component.render(200).join("\n");
					component.handleInput?.("escape");
				} else {
					component.handleInput?.("escape");
				}
			},
		);
		assert.match(selectorRender, /Test Work\s+\[idle\]/u);
		assert.match(menuRender, /Test Work\s+\[idle\]/u);
		assert.match(menuRender, /Status\s+Current worker is available; the current attempt can continue/u);
		assert.doesNotMatch(selectorRender, /\[\d+ running\]|Executor(?:s)? running/u);
		assert.doesNotMatch(menuRender, /\[\d+ running\]|Executor(?:s)? running/u);
	} finally {
		cleanup(root);
	}
});

test("a runtime that becomes unreachable between selector and menu keeps the unreachable projection", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-runtime-transition-"));
	const projectPath = join(root, "project");
	try {
		setupMission(projectPath, "Runtime transition Work");
		writeExecutorRecord(execution(projectPath, "execution-1", "running"), false);
		let probeCount = 0;
		let selectorRender;
		let menuRender;
		await runAttention(
			projectPath,
			controller(new Set(), (executionId) => {
				probeCount += 1;
				return probeCount === 1
					? { kind: "idle", executionId, sessionId: `${executionId}-session` }
					: { kind: "unreachable", executionId, reason: "The runtime exited." };
			}),
			(component, count) => {
				if (count === 1) {
					selectorRender = component.render(200).join("\n");
					component.handleInput?.("enter");
				} else if (count === 2) {
					menuRender = component.render(200).join("\n");
					component.handleInput?.("escape");
				} else {
					component.handleInput?.("escape");
				}
			},
		);
		assert.match(selectorRender, /Runtime transition Work\s+\[idle\]/u);
		assert.match(menuRender, /Runtime transition Work\s+\[unreachable\]/u);
		assert.match(menuRender, /Status\s+Current worker could not be reached; the Mission can continue/u);
		assert.match(menuRender, /Continue with a new worker/u);
		assert.doesNotMatch(menuRender, /Recover Conclave/u);
		assert.doesNotMatch(menuRender, /\[\d+ running\]|Executor(?:s)? running/u);
	} finally {
		cleanup(root);
	}
});

test("an orphaned exhausted recovery condition offers Recover Conclave but live liveness hides it", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-recovery-action-"));
	const projectPath = join(root, "project");
	try {
		const submission = setupMission(projectPath, "Recovery Work", "queued");
		const now = new Date().toISOString();
		const lease = new Date(Date.now() + 60_000).toISOString();
		for (const attempt of [1, 2]) {
			append(projectPath, "conclave-recovery", "work-1", {
				recoveryId: `recovery-${attempt}`,
				workId: "work-1",
				submissionRecordId: submission.recordId,
				status: "claimed",
				attempt,
				maxAttempts: 2,
				ownerId: "owner-1",
				claimedAt: now,
				leaseExpiresAt: lease,
			});
			append(projectPath, "conclave-wake", "work-1", {
				wakeId: `recovery-${attempt}`,
				workId: "work-1",
				status: "failed",
				attemptedAt: now,
				failure: `Recovery attempt ${attempt} failed.`,
				recovery: "recreate",
			});
		}
		append(projectPath, "conclave-recovery", "work-1", {
			recoveryId: "recovery-3",
			workId: "work-1",
			submissionRecordId: submission.recordId,
			status: "exhausted",
			attempt: 2,
			maxAttempts: 2,
			exhaustedAt: now,
			reason: "Automatic Conclave recovery exhausted its durable retry limit.",
		});
		writeExecutorRecord(execution(projectPath, "execution-1", "running"), false);

		let orphanedMenu;
		await runAttention(
			projectPath,
			controller(new Set(), (executionId) => ({
				kind: "unreachable",
				executionId,
				reason: "The runtime exited.",
			})),
			(component, count) => {
				if (count === 1) {
					assert.match(component.render(200).join("\n"), /Recovery Work\s+\[stalled\]/u);
					component.handleInput?.("enter");
				} else if (count === 2) {
					orphanedMenu = component.render(200).join("\n");
					component.handleInput?.("escape");
				} else {
					component.handleInput?.("escape");
				}
			},
		);
		assert.match(orphanedMenu, /Recovery Work\s+\[stalled\]/u);
		assert.match(orphanedMenu, /Recover Conclave/u);
		assert.doesNotMatch(orphanedMenu, /\[\d+ running\]|Executor(?:s)? running/u);

		let liveMenu;
		await runAttention(
			projectPath,
			controller(new Set(["execution-1"]), (executionId) => ({
				kind: "idle",
				executionId,
				sessionId: `${executionId}-session`,
			})),
			(component, count) => {
				if (count === 1) {
					component.handleInput?.("enter");
				} else if (count === 2) {
					liveMenu = component.render(200).join("\n");
					component.handleInput?.("escape");
				} else {
					component.handleInput?.("escape");
				}
			},
		);
		assert.match(liveMenu, /Recovery Work\s+\[stalled\]/u);
		assert.doesNotMatch(liveMenu, /Recover Conclave/u);
	} finally {
		cleanup(root);
	}
});

test("a live stale runtime from a finished Mission does not replace review", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-attention-review-status-"));
	const projectPath = join(root, "project");
	try {
		setupMission(projectPath, "Review Work");
		append(
			projectPath,
			"verdict",
			"work-1",
			{
				verdictId: "verdict-1",
				workId: "work-1",
				executionId: "execution-1",
				signalId: "signal-1",
				missionId: "mission-1",
				governingMandateId: "mandate-1",
				issuedByParticipantId: "conclave-1",
				decision: "finish",
				reason: "Ready for review.",
				issuedAt: NOW,
			},
			"execution-1",
		);
		append(
			projectPath,
			"pull-request",
			"work-1",
			{
				pullRequestId: "pull-request-1",
				workId: "work-1",
				missionId: "mission-1",
				executionId: "execution-1",
				status: "reviewable",
				url: "https://github.com/example/repo/pull/1",
				remoteConfirmedAt: NOW,
				changedFiles: [],
				diffSummary: "Ready for review.",
				validationResults: [],
				reviewFeedback: [],
				unresolvedGaps: [],
				recordedAt: NOW,
			},
			"execution-1",
		);
		writeExecutorRecord(execution(projectPath, "execution-1", "running"), false);

		let selectorRender;
		let menuRender;
		await runAttention(
			projectPath,
			controller(new Set(["execution-1"]), (executionId) => ({
				kind: "idle",
				executionId,
				sessionId: `${executionId}-session`,
			})),
			(component, count) => {
				if (count === 1) {
					selectorRender = component.render(200).join("\n");
					component.handleInput?.("enter");
				} else if (count === 2) {
					menuRender = component.render(200).join("\n");
					component.handleInput?.("escape");
				} else {
					component.handleInput?.("escape");
				}
			},
		);
		assert.match(selectorRender, /Review Work\s+\[review\]/u);
		assert.match(menuRender, /Status\s+Ready for your review/u);
		assert.doesNotMatch(menuRender, /\[idle\]|\[unreachable\]|Recover Conclave|\[\d+ running\]/u);
	} finally {
		cleanup(root);
	}
});
