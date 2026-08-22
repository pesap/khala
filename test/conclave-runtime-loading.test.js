import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createExtension from "../dist/src/index.js";
import { appendArchiveRecord, listArchiveRecords } from "../dist/src/khala-archive.js";
import { createConclaveCoordinator } from "../dist/src/khala-conclave.js";
import { getConclaveDirectory } from "../dist/src/khala-conclave-directory.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { AUTOMATIC_RECOVERY_MAX_ATTEMPTS } from "../dist/src/khala-conclave-storage.js";
import {
	CONCLAVE_MODEL_SESSION_MAX_BYTES,
	CONCLAVE_MODEL_SESSION_MAX_IDLE_MS,
} from "../dist/src/khala-conclave-session-storage.js";

function createPiStub(events) {
	const activeTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	return {
		registerCommand() {},
		registerFlag() {},
		registerShortcut() {},
		registerTool(tool) {
			activeTools.add(tool.name);
		},
		on(name, handler) {
			events.set(name, handler);
		},
		getFlag() {
			return undefined;
		},
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

function readConclaveMapping(projectPath) {
	const mappingPath = join(getConclaveDirectory(projectPath), "session.json");
	return JSON.parse(readFileSync(mappingPath, "utf8"));
}

function readMappedSessionPath(projectPath) {
	return readConclaveMapping(projectPath).sessionPath;
}

function waitForChildMessage(child, expectedType) {
	return new Promise((resolve, reject) => {
		const onExit = (code) => {
			child.off("message", onMessage);
			reject(new Error(`Conclave session worker exited with code ${code} before ${expectedType}.`));
		};
		const onMessage = (message) => {
			if (message?.type === "error") {
				child.off("exit", onExit);
				reject(new Error(message.message));
				return;
			}
			if (message?.type === expectedType) {
				child.off("exit", onExit);
				child.off("message", onMessage);
				resolve(message);
			}
		};
		child.on("exit", onExit);
		child.on("message", onMessage);
	});
}

test("oversized Conclave model sessions rotate at the byte threshold without changing the Archive", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-size-rotation-"));
	const projectPath = join(root, "project");
	const userSessionPath = join(root, "user.jsonl");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const storage = createFileConclaveStorage();
		storage.submit({
			workId: "rotation-work",
			projectPath,
			work: {
				title: "Model-session rotation",
				objective: "Bound Conclave model-session loading.",
				context: "Archive authority must remain unchanged.",
				scope: "Conclave model-session storage.",
				acceptanceCriteria: ["Oversized model sessions rotate before opening."],
				constraints: [],
				plan: ["Create a fresh bounded model session."],
				validation: ["Compare Archive bytes and reopen the mapping."],
			},
		});
		const initial = storage.loadConclaveSession(projectPath, userSessionPath);
		const initialSessionPath = initial.getSessionFile();
		assert.equal(typeof initialSessionPath, "string");
		truncateSync(initialSessionPath, CONCLAVE_MODEL_SESSION_MAX_BYTES - 1);
		assert.equal(storage.loadConclaveSession(projectPath).getSessionFile(), initialSessionPath);
		truncateSync(initialSessionPath, CONCLAVE_MODEL_SESSION_MAX_BYTES);
		const archivePath = join(getConclaveDirectory(projectPath), "archive.jsonl");
		const archiveBefore = readFileSync(archivePath);

		const rotated = storage.loadConclaveSession(projectPath);
		const rotatedSessionPath = rotated.getSessionFile();
		assert.equal(typeof rotatedSessionPath, "string");
		assert.notEqual(rotatedSessionPath, initialSessionPath);
		assert.equal(statSync(initialSessionPath).size, CONCLAVE_MODEL_SESSION_MAX_BYTES);
		assert.ok(statSync(rotatedSessionPath).size < 4096);
		assert.deepEqual(
			rotated.getEntries().map((entry) => entry.type),
			["custom", "session_info"],
		);
		assert.deepEqual(rotated.buildSessionContext().messages, []);
		assert.deepEqual(readFileSync(archivePath), archiveBefore);
		assert.deepEqual(readConclaveMapping(projectPath), {
			sessionPath: rotatedSessionPath,
			userSessionPath,
		});

		const reopened = createFileConclaveStorage().loadConclaveSession(projectPath);
		assert.equal(reopened.getSessionFile(), rotatedSessionPath);
		assert.equal(reopened.getEntries().length, 2);
		assert.deepEqual(reopened.buildSessionContext().messages, []);
		assert.deepEqual(readFileSync(archivePath), archiveBefore);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent Conclave rotation callers reopen one durably mapped model session", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-concurrent-rotation-"));
	const projectPath = join(root, "project");
	const userSessionPath = join(root, "user.jsonl");
	const releasePath = join(root, "release-lock");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const children = [];
	try {
		const storage = createFileConclaveStorage();
		const initial = storage.loadConclaveSession(projectPath, userSessionPath);
		const initialSessionPath = initial.getSessionFile();
		assert.equal(typeof initialSessionPath, "string");
		truncateSync(initialSessionPath, CONCLAVE_MODEL_SESSION_MAX_BYTES);

		const workerPath = fileURLToPath(new URL("./fixtures/conclave-session-worker.js", import.meta.url));
		const holder = fork(workerPath, ["hold", projectPath, releasePath], { silent: true });
		children.push(holder);
		await waitForChildMessage(holder, "locked");

		const loaders = [
			fork(workerPath, ["load", projectPath, userSessionPath], { silent: true }),
			fork(workerPath, ["load", projectPath, userSessionPath], { silent: true }),
		];
		children.push(...loaders);
		await Promise.all(loaders.map((child) => waitForChildMessage(child, "ready")));
		const loaded = loaders.map((child) => waitForChildMessage(child, "loaded"));
		for (const child of loaders) {
			child.send("start");
		}
		writeFileSync(releasePath, "release", "utf8");

		const results = await Promise.all(loaded);
		assert.equal(results[0].sessionPath, results[1].sessionPath);
		assert.notEqual(results[0].sessionPath, initialSessionPath);
		assert.deepEqual(readConclaveMapping(projectPath), {
			sessionPath: results[0].sessionPath,
			userSessionPath,
		});
	} finally {
		for (const child of children) {
			if (child.exitCode === null) {
				child.kill();
			}
		}
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("idle Conclave model sessions rotate after the age threshold", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-age-rotation-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const storage = createFileConclaveStorage();
		const initial = storage.loadConclaveSession(projectPath);
		const initialSessionPath = initial.getSessionFile();
		assert.equal(typeof initialSessionPath, "string");
		const staleTime = new Date(Date.now() - CONCLAVE_MODEL_SESSION_MAX_IDLE_MS - 1000);
		utimesSync(initialSessionPath, staleTime, staleTime);

		const rotated = storage.loadConclaveSession(projectPath);
		assert.notEqual(rotated.getSessionFile(), initialSessionPath);
		assert.equal(rotated.getEntries().length, 2);
		assert.equal(readMappedSessionPath(projectPath), rotated.getSessionFile());
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("background Conclave recovery yields before storage access and contains scheduling errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-background-error-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let recoveryReads = 0;
	const fileStorage = createFileConclaveStorage();
	const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
		...fileStorage,
		getRecoverableSubmissions() {
			recoveryReads += 1;
			throw new Error("instrumented recovery read failure");
		},
	});
	try {
		coordinator.resume(projectPath);
		assert.equal(recoveryReads, 0);
		await Promise.resolve();
		assert.equal(recoveryReads, 0);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(recoveryReads, 1);
	} finally {
		await coordinator.dispose();
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("exhausted submission recovery still bootstraps supervision for a failed current Executor", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-failed-bootstrap-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let sessionLoads = 0;
	try {
		const work = {
			title: "Failed bootstrap",
			objective: "Recover the failed Executor.",
			context: "The Executor failed before Pi RPC startup.",
			scope: "Recovery bootstrap.",
			acceptanceCriteria: ["Supervision initializes."],
			constraints: [],
			plan: ["Recover the current Mission."],
			validation: ["Inspect the new Executor attempt."],
		};
		const storage = createFileConclaveStorage();
		storage.submit({ workId: "failed-bootstrap", projectPath, work });
		for (let attempt = 0; attempt < AUTOMATIC_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
			const claim = storage.claimSubmissionRecovery(projectPath, "failed-bootstrap", `test-owner-${attempt}`);
			assert.ok(claim);
			storage.completeSubmissionRecovery(projectPath, claim, {
				status: "failed",
				attemptedAt: new Date().toISOString(),
				failure: "Conclave unavailable.",
				recovery: "recreate",
			});
		}
		const now = new Date().toISOString();
		const submission = listArchiveRecords(projectPath).find((record) => record.type === "submission");
		assert.ok(submission);
		const assignment = { ...work };
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mandate",
			workId: "failed-bootstrap",
			payload: {
				mandateId: "mandate-failed-bootstrap",
				workId: "failed-bootstrap",
				revision: 1,
				sourceSubmissionRecordId: submission.recordId,
				terms: assignment,
				admittedByParticipantId: "conclave:test",
				admittedAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: "failed-bootstrap",
			payload: {
				missionId: "mission-failed-bootstrap",
				workId: "failed-bootstrap",
				mandateId: "mandate-failed-bootstrap",
				assignment,
				assignedParticipantId: "executor:failed-bootstrap",
				createdAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "execution",
			workId: "failed-bootstrap",
			executionId: "failed-execution",
			payload: {
				executionId: "failed-execution",
				workId: "failed-bootstrap",
				executorName: "Failed Executor",
				kind: "executor",
				participantId: "executor:failed-bootstrap",
				purpose: { kind: "mission", missionId: "mission-failed-bootstrap" },
				missionId: "mission-failed-bootstrap",
				projectPath,
				sandboxPath: projectPath,
				launcher: "pending",
				status: "failed",
				startedAt: now,
			},
		});
		const fileStorage = createFileConclaveStorage();
		const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
			...fileStorage,
			loadConclaveSession(...args) {
				sessionLoads += 1;
				return fileStorage.loadConclaveSession(...args);
			},
		});
		coordinator.resume(projectPath);
		assert.equal(sessionLoads, 0);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionLoads, 1);
		await coordinator.dispose();
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup bootstraps supervision for a current running Executor", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-running-bootstrap-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let sessionLoads = 0;
	try {
		const work = {
			title: "Running bootstrap",
			objective: "Resume the active Executor.",
			context: "The previous Conclave process exited.",
			scope: "Recovery bootstrap.",
			acceptanceCriteria: ["Supervision initializes for the active attempt."],
			constraints: [],
			plan: ["Recover the current Mission."],
			validation: ["Inspect the persisted Execution."],
		};
		const storage = createFileConclaveStorage();
		storage.submit({ workId: "running-bootstrap", projectPath, work });
		const submission = listArchiveRecords(projectPath).find((record) => record.type === "submission");
		assert.ok(submission);
		const now = new Date().toISOString();
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mandate",
			workId: "running-bootstrap",
			payload: {
				mandateId: "mandate-running-bootstrap",
				workId: "running-bootstrap",
				revision: 1,
				sourceSubmissionRecordId: submission.recordId,
				terms: work,
				admittedByParticipantId: "conclave:test",
				admittedAt: now,
			},
		});
		assert.equal(storage.admitSubmission(projectPath, "running-bootstrap", "mandate-running-bootstrap"), true);
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: "running-bootstrap",
			payload: {
				missionId: "mission-running-bootstrap",
				workId: "running-bootstrap",
				mandateId: "mandate-running-bootstrap",
				assignment: work,
				assignedParticipantId: "executor:running-bootstrap",
				createdAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "execution",
			workId: "running-bootstrap",
			executionId: "running-execution",
			payload: {
				executionId: "running-execution",
				workId: "running-bootstrap",
				executorName: "Running Executor",
				kind: "executor",
				participantId: "executor:running-bootstrap",
				purpose: { kind: "mission", missionId: "mission-running-bootstrap" },
				missionId: "mission-running-bootstrap",
				projectPath,
				sandboxPath: projectPath,
				launcher: "headless-rpc",
				piSessionId: "running-session",
				sessionPath: join(projectPath, "running-session.jsonl"),
				promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
				status: "running",
				startedAt: now,
			},
		});
		const fileStorage = createFileConclaveStorage();
		const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
			...fileStorage,
			loadConclaveSession(...args) {
				sessionLoads += 1;
				return fileStorage.loadConclaveSession(...args);
			},
		});
		coordinator.resume(projectPath);
		assert.equal(sessionLoads, 0);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionLoads, 1);
		await coordinator.dispose();
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup ignores an active Executor without a current Mission", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-orphaned-bootstrap-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let sessionLoads = 0;
	try {
		const now = new Date().toISOString();
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "execution",
			workId: "orphaned-work",
			executionId: "orphaned-execution",
			payload: {
				executionId: "orphaned-execution",
				workId: "orphaned-work",
				executorName: "Orphaned Executor",
				kind: "executor",
				participantId: "executor:orphaned",
				purpose: { kind: "mission", missionId: "orphaned-mission" },
				missionId: "orphaned-mission",
				projectPath,
				sandboxPath: projectPath,
				launcher: "headless-rpc",
				piSessionId: "orphaned-session",
				sessionPath: join(projectPath, "orphaned-session.jsonl"),
				promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
				status: "running",
				startedAt: now,
			},
		});
		const fileStorage = createFileConclaveStorage();
		const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
			...fileStorage,
			loadConclaveSession(...args) {
				sessionLoads += 1;
				return fileStorage.loadConclaveSession(...args);
			},
		});
		coordinator.resume(projectPath);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionLoads, 0);
		await coordinator.dispose();
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup continues queued submission recovery when active supervision bootstrap fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-bootstrap-failure-"));
	const projectPath = join(root, "project");
	let coordinator;
	try {
		const work = {
			title: "Queued recovery",
			objective: "Keep queued recovery independent from active supervision.",
			context: "An active Executor cannot start its Conclave runtime.",
			scope: "Coordinator startup.",
			acceptanceCriteria: ["The queued Work records its recovery failure."],
			constraints: [],
			plan: ["Resume the queued Work."],
			validation: ["Inspect the recovery wake."],
		};
		const storage = createFileConclaveStorage();
		storage.submit({ workId: "queued-work", projectPath, work });
		const now = new Date().toISOString();
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: "active-work",
			payload: {
				missionId: "active-mission",
				workId: "active-work",
				mandateId: "active-mandate",
				assignment: work,
				assignedParticipantId: "executor:active",
				createdAt: now,
			},
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "execution",
			workId: "active-work",
			executionId: "active-execution",
			payload: {
				executionId: "active-execution",
				workId: "active-work",
				executorName: "Active Executor",
				kind: "executor",
				participantId: "executor:active",
				purpose: { kind: "mission", missionId: "active-mission" },
				missionId: "active-mission",
				projectPath,
				sandboxPath: projectPath,
				launcher: "headless-rpc",
				piSessionId: "active-session",
				sessionPath: join(projectPath, "active-session.jsonl"),
				promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
				status: "running",
				startedAt: now,
			},
		});
		coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
			...storage,
			loadConclaveSession() {
				throw new Error("Active supervision bootstrap is unavailable.");
			},
		});
		coordinator.resume(projectPath);
		let wake;
		for (let attempt = 0; attempt < 10 && wake === undefined; attempt += 1) {
			await new Promise((resolve) => setImmediate(resolve));
			wake = listArchiveRecords(projectPath).find(
				(record) => record.type === "conclave-wake" && record.workId === "queued-work",
			);
		}
		assert.equal(wake?.payload.status, "failed");
	} finally {
		await coordinator?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup continues queued submission recovery when supervision candidate discovery fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-candidate-discovery-failure-"));
	const projectPath = join(root, "project");
	let coordinator;
	try {
		const work = {
			title: "Queued recovery",
			objective: "Keep queued recovery independent from invalid unrelated history.",
			context: "Mission projection cannot read a duplicate unrelated Mission.",
			scope: "Coordinator startup.",
			acceptanceCriteria: ["The queued Work records its recovery failure."],
			constraints: [],
			plan: ["Resume the queued Work."],
			validation: ["Inspect the recovery wake."],
		};
		const storage = createFileConclaveStorage();
		storage.submit({ workId: "queued-work", projectPath, work });
		const malformedMission = {
			missionId: "duplicate-mission",
			workId: "unrelated-work",
			mandateId: "unrelated-mandate",
			assignment: work,
			assignedParticipantId: "executor:unrelated",
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: malformedMission.workId,
			payload: malformedMission,
		});
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "mission",
			workId: malformedMission.workId,
			payload: malformedMission,
		});
		coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), {
			...storage,
			loadConclaveSession() {
				throw new Error("Conclave runtime is unavailable.");
			},
		});
		coordinator.resume(projectPath);
		let wake;
		for (let attempt = 0; attempt < 10 && wake === undefined; attempt += 1) {
			await new Promise((resolve) => setImmediate(resolve));
			wake = listArchiveRecords(projectPath).find(
				(record) => record.type === "conclave-wake" && record.workId === "queued-work",
			);
		}
		assert.equal(wake?.payload.status, "failed");
	} finally {
		await coordinator?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("ordinary session_start defers oversized Conclave model-session initialization past its first yield", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-startup-yield-"));
	const projectPath = join(root, "project");
	const userSessionPath = join(root, "user.jsonl");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const events = new Map();
	try {
		const storage = createFileConclaveStorage();
		storage.submit({
			workId: "startup-work",
			projectPath,
			work: {
				title: "Startup loading",
				objective: "Keep ordinary Pi startup responsive.",
				context: "The Conclave model session is intentionally oversized.",
				scope: "Conclave startup only.",
				acceptanceCriteria: ["Heavy model-session loading starts after startup yields."],
				constraints: [],
				plan: ["Resume pending Work in the background."],
				validation: ["Observe the mapped model session."],
			},
		});
		const modelSession = storage.loadConclaveSession(projectPath, userSessionPath);
		const originalSessionPath = modelSession.getSessionFile();
		assert.equal(typeof originalSessionPath, "string");
		truncateSync(originalSessionPath, CONCLAVE_MODEL_SESSION_MAX_BYTES + 1);

		createExtension(createPiStub(events));
		const context = {
			cwd: projectPath,
			mode: "print",
			isProjectTrusted: () => false,
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getSessionFile: () => userSessionPath,
				getSessionName: () => undefined,
			},
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
			},
		};

		events.get("session_start")({}, context);
		assert.equal(readMappedSessionPath(projectPath), originalSessionPath);
		await Promise.resolve();
		assert.equal(readMappedSessionPath(projectPath), originalSessionPath);

		await new Promise((resolve) => setImmediate(resolve));
		assert.notEqual(readMappedSessionPath(projectPath), originalSessionPath);
	} finally {
		await events.get("session_shutdown")?.();
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});
