import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import reviewExtension, {
	applyReviewState,
	createBranchSelectorItems,
	createCommitSelectorItems,
	filterReviewSelectorItems,
	getReviewState,
	repositoryFromPrReference,
	resolveReviewTarget,
	sortReviewBranches,
} from "../dist/extensions/pi-review/review.js";
import createExtension from "../dist/src/index.js";
import { appendArchiveRecord, getArchivePath, listArchiveRecords, withArchiveLock } from "../dist/src/khala-archive.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { readCurrentMission } from "../dist/src/khala-archive-projections.js";
import { createExecutorStarter } from "../dist/src/executor.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "../dist/src/khala-executor-registry.js";
import {
	appendPullRequestRecord,
	markPullRequestReviewable,
	recordReviewPreparation,
} from "../dist/src/khala-review.js";
import { registerKhalaLearning } from "../dist/src/khala-learning.js";
import { registerKhalaObserver } from "../dist/src/khala-observer.js";
import { registerKhalaWork } from "../dist/src/khala-work.js";

function createPiStub(commands, tools = new Map(), flags = new Map(), hooks = {}) {
	const hasExplicitActiveTools = hooks.activeTools !== undefined;
	const activeTools = new Set(hooks.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	return {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag() {},
		registerShortcut() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
			if (!hasExplicitActiveTools) {
				activeTools.add(tool.name);
			}
		},
		on(name, handler) {
			hooks.events?.set(name, handler);
		},
		getFlag(name) {
			return flags.get(name);
		},
		appendEntry(type, data) {
			hooks.appendEntry?.(type, data);
		},
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

test("reviewable Pull Requests require runtime-confirmed publication evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-confirmed-review-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		appendPullRequestRecord(
			projectPath,
			{
				pullRequestId: "user-supplied",
				workId: "work",
				missionId: "mission",
				executionId: "execution",
				status: "open",
				url: "https://github.com/example/repo/pull/999",
				changedFiles: [],
				diffSummary: "",
				validationResults: [],
				reviewFeedback: [],
				unresolvedGaps: [],
				recordedAt: new Date().toISOString(),
			},
			false,
		);
		assert.throws(
			() =>
				markPullRequestReviewable({
					projectPath,
					projectTrusted: false,
					workId: "work",
					missionId: "mission",
					executionId: "execution",
				}),
			/remotely confirmed Pull Request/,
		);
		const confirmed = recordReviewPreparation({
			projectPath,
			projectTrusted: false,
			workId: "confirmed-work",
			missionId: "confirmed-mission",
			executionId: "confirmed-execution",
			sourceBranch: "khala/confirmed",
			targetBranch: "main",
			planningCommit: "abc123",
			url: "https://github.com/example/repo/pull/1",
			number: 1,
		});
		assert.ok(confirmed.remoteConfirmedAt);
		const reviewable = markPullRequestReviewable({
			projectPath,
			projectTrusted: false,
			workId: confirmed.workId,
			missionId: confirmed.missionId,
			executionId: confirmed.executionId,
		});
		assert.equal(reviewable.status, "reviewable");
		appendPullRequestRecord(
			projectPath,
			{ ...reviewable, status: "closed", recordedAt: new Date().toISOString() },
			false,
		);
		assert.throws(
			() =>
				markPullRequestReviewable({
					projectPath,
					projectTrusted: false,
					workId: confirmed.workId,
					missionId: confirmed.missionId,
					executionId: confirmed.executionId,
				}),
			/active, remotely confirmed Pull Request/,
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("/khala shows a read-only attention summary without creating a Conclave session", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const commands = new Map();
		createExtension(createPiStub(commands));
		const notifications = [];
		const context = {
			cwd: projectPath,
			mode: "print",
			isProjectTrusted: () => false,
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
			},
		};

		await commands.get("khala").handler("", context);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "info");
		assert.match(notifications[0].message, /no active Work/);
		assert.match(notifications[0].message, /No user action required/);
		// The read-only summary must not create a Conclave session as a side effect.
		const [projectDirectory] = readdirSync(join(agentDir, "khala", "conclaves"));
		assert.equal(existsSync(join(agentDir, "khala", "conclaves", projectDirectory, "session.json")), false);

		appendArchiveRecord(projectPath, {
			type: "submission",
			workId: "work-1",
			payload: {
				workId: "work-1",
				projectPath,
				status: "queued",
				work: {
					title: "Improve the attention summary",
					objective: "Make active Work easier to scan.",
					context: "",
					scope: "Khala attention summary",
					acceptanceCriteria: ["Active work is visible."],
					constraints: [],
					plan: ["Render active work titles."],
					validation: ["Run the attention tests."],
				},
				archivePath: join(projectPath, "archive.jsonl"),
			},
		});
		notifications.length = 0;
		await commands.get("khala").handler("", context);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /1 active Work submission/);
		assert.doesNotMatch(notifications[0].message, /headless|supervision|unavailable|recovering|Executor/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Executor startup failures before RPC creation remove the sandbox", async () => {
	const sandbox = { path: "/tmp/khala-pre-rpc-sandbox", name: "pre-rpc", projectPath: "/tmp/khala-project" };
	let sandboxRemovals = 0;
	const starter = createExecutorStarter(
		{
			async createSandbox() {
				return sandbox;
			},
			async removeSandbox() {
				sandboxRemovals += 1;
			},
		},
		undefined,
		["pi"],
		"headless-rpc",
		"provider/executor",
	);
	await assert.rejects(
		starter({
			projectPath: sandbox.projectPath,
			workId: "work-pre-rpc",
			executionId: "execution-pre-rpc",
			name: "Pre-RPC failure",
			executorName: "Executor",
			mission: "",
			systemPrompt: "",
			kind: "executor",
			onSandboxCreated: () => { throw new Error("sandbox callback failed"); },
		}),
		/sandbox callback failed/,
	);
	assert.equal(sandboxRemovals, 1);
});

test("post-launch cleanup retries only resources whose cleanup failed", async () => {
	const sandbox = { path: "/tmp/khala-post-launch-sandbox", name: "post-launch", projectPath: "/tmp/khala-project" };
	let closeAttempts = 0;
	let sandboxRemovals = 0;
	const starter = createExecutorStarter(
		{
			async createSandbox() {
				return sandbox;
			},
			async removeSandbox() {
				sandboxRemovals += 1;
			},
		},
		{
			async launch() {
				return { id: "launched", sandbox, target: "owned-target" };
			},
			async focus() {},
			async close() {
				closeAttempts += 1;
				if (closeAttempts === 1) {
					throw new Error("close failed once");
				}
			},
		},
	);
	const launched = await starter({
		projectPath: sandbox.projectPath,
		workId: "work-cleanup",
		executionId: "execution-cleanup",
		name: "Cleanup test",
		executorName: "Cleanup Executor",
		mission: "",
		systemPrompt: "",
	});
	await assert.rejects(launched.cleanup(), /close failed once/);
	assert.equal(closeAttempts, 1);
	assert.equal(sandboxRemovals, 0);
	await launched.cleanup();
	assert.equal(closeAttempts, 2);
	assert.equal(sandboxRemovals, 1);
});

test("ownerless and malformed stale Archive locks are recovered", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-ownerless-lock-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const archivePath = getArchivePath(projectPath);
		const lockPath = join(dirname(archivePath), "archive.lock");
		for (const owner of [undefined, "invalid-owner\n"]) {
			mkdirSync(lockPath, { recursive: true });
			if (owner !== undefined) {
				writeFileSync(join(lockPath, "owner"), owner);
			}
			const old = new Date(Date.now() - 60_000);
			utimesSync(lockPath, old, old);
			assert.equal(withArchiveLock(projectPath, false, () => "recovered"), "recovered");
			assert.equal(existsSync(lockPath), false);
		}
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-review pure selector helpers preserve target policy", () => {
	assert.deepEqual(sortReviewBranches(["feature", "main", "current"], "current", "main"), ["main", "feature"]);
	assert.deepEqual(createBranchSelectorItems(["main"], "main")[0].description, "(default)");
	assert.equal(createCommitSelectorItems([{ sha: "123456789", title: "Fix" }])[0].label, "1234567 Fix");
	assert.equal(filterReviewSelectorItems(createBranchSelectorItems(["main", "feature"], "main"), "feat").length, 1);
	assert.equal(repositoryFromPrReference("https://github.com/pesap/khala/pull/1"), "pesap/khala");
	assert.equal(repositoryFromPrReference("https://github.com/other/project/pull/1"), "other/project");
});

test("pi-review fetches a missing authoritative Pull Request base before comparison", async () => {
	const calls = [];
	let baseAvailable = false;
	const pi = {
		async exec(command, args) {
			calls.push([command, args]);
			if (args[0] === "fetch") {
				baseAvailable = true;
				return { code: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "rev-parse" && args[2] === "base-sha^{commit}") {
				return baseAvailable
					? { code: 0, stdout: "base-sha\n", stderr: "" }
					: { code: 128, stdout: "", stderr: "missing" };
			}
			if (args[0] === "rev-parse" && args[2] === "head-sha^{commit}") {
				return { code: 0, stdout: "head-sha\n", stderr: "" };
			}
			if (args[0] === "merge-base") {
				return { code: 0, stdout: "merge-base-sha\n", stderr: "" };
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	};
	const resolved = await resolveReviewTarget(pi, process.cwd(), {
		type: "pullRequest",
		reference: "1",
		prNumber: 1,
		baseBranch: "main",
		baseSha: "base-sha",
		headSha: "head-sha",
		title: "Review",
	});
	assert.equal(resolved.mergeBaseSha, "merge-base-sha");
	assert.ok(calls.some(([, args]) => args.join(" ") === "fetch --no-tags origin refs/heads/main"));
});

test("Mandate, immutable Mission, retry successor, and Finish fences form one lifecycle", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-mission-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			conclaveModel: "provider/conclave",
			conclaveMaxCostUsdPerTurn: 0.25,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 1,
		}),
	);
	try {
		const storage = createFileConclaveStorage();
		const work = {
			title: "Mission test",
			objective: "Exercise Mission lifecycle.",
			context: "Known context.",
			scope: "Temporary project.",
			acceptanceCriteria: ["The successor finishes."],
			constraints: [],
			plan: ["Run the lifecycle."],
			validation: ["Read durable records."],
		};
		storage.submit({ workId: "mission-work", projectPath, work });
		const tools = new Map();
		let starts = 0;
		const dependencies = {
			workTemplate: "template",
			executorSystemPrompt: "executor prompt",
			isDedicatedConclaveSession: () => true,
			submitWork: async (request) => storage.submit(request),
			getSubmission: storage.getSubmission,
			getPendingSubmission: storage.getPendingSubmission,
			claimSubmission: storage.claimSubmission,
			markSubmissionQueued: storage.markSubmissionQueued,
			markSubmissionLaunched: storage.markSubmissionLaunched,
			createExecutorStarter: () => async (request) => {
				starts += 1;
				const sandbox = { path: join(root, `sandbox-${starts}`), name: `sandbox-${starts}` };
				request.onSandboxCreated?.(sandbox, "test");
				request.onReviewPrepared?.({
					sourceBranch: `khala/test-${starts}`,
					targetBranch: "main",
					planningCommit: `planning-${starts}`,
					url: `https://github.com/test/khala/pull/${starts}`,
					number: starts,
				}, sandbox);
				assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "mission").length, starts === 1 ? 1 : 2);
				assert.match(request.mission, /Mandate:/);
				updateExecutorRecord(
					projectPath,
					request.executionId,
					{ piSessionId: `pi-${starts}`, sessionPath: join(root, `session-${starts}.jsonl`) },
				);
				return { id: `session-${starts}`, sandbox };
			},
		};
		registerKhalaWork(createPiStub(new Map(), tools), dependencies);
		const conclaveContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-conclave", data: {} }];
				},
				getSessionFile() {
					return join(root, "conclave.jsonl");
				},
			},
		};
		await tools.get("khala_admit_work").execute("admit", { workId: "mission-work" }, null, null, conclaveContext);
		const launch = await tools.get("khala_launch_execution").execute("launch", { workId: "mission-work" }, null, null, conclaveContext);
		assert.equal(launch.details.status, "launched");
		const firstMission = readCurrentMission(projectPath, "mission-work").mission;
		const firstExecution = readExecutorRecord(projectPath, launch.details.executionId);
		assert.equal(firstExecution.purpose.missionId, firstMission.missionId);
		assert.equal(firstExecution.participantId, firstMission.assignedParticipantId);
		assert.match(firstExecution.status, /running/);
		const duplicate = await tools.get("khala_launch_execution").execute("duplicate", { workId: "mission-work" }, null, null, conclaveContext);
		assert.equal(duplicate.details.executionId, launch.details.executionId);
		assert.equal(starts, 1);

		const runtimeTools = new Map();
		createExtension(createPiStub(new Map(), runtimeTools));
		const executorContext = {
			cwd: firstExecution.sandboxPath,
			sessionManager: {
				getBranch() {
					return [
						{ type: "custom", customType: "khala-role", data: { role: "executor" } },
						{ type: "custom", customType: "khala-executor", data: { workId: "mission-work", executionId: firstExecution.executionId, executorName: firstExecution.executorName, projectPath, missionId: firstMission.missionId, participantId: firstExecution.participantId } },
					];
				},
				getSessionFile() {
					return firstExecution.sessionPath;
				},
			},
		};
		const signal = await runtimeTools.get("khala_signal").execute("signal", { kind: "blocked", summary: "Retry is required.", evidence: ["test evidence"] }, null, null, executorContext);
		const successorAssignment = { ...work, plan: ["Run the corrected lifecycle."] };
		assert.throws(
			() =>
				runtimeTools.get("khala_verdict").execute("unstated-constraint", {
					workId: "mission-work",
					executionId: firstExecution.executionId,
					signalId: signal.details.signalId,
					decision: "retry",
					reason: "The successor finishes acceptance criterion passed, but the Executor violated the immutable constraint: Do not commit changes.",
					retryHandoff: {
						failedCriteria: ["The first execution must be retried."],
						completedWork: ["The first execution lifecycle was recorded."],
						requiredChanges: ["Run the corrected lifecycle."],
						nonGoals: ["Do not change the lifecycle contract."],
						validation: ["Read durable records."],
					},
					successorAssignment,
				}, null, null, conclaveContext),
			/absent Mission constraint/,
		);
		const retry = await runtimeTools.get("khala_verdict").execute("retry", { workId: "mission-work", executionId: firstExecution.executionId, signalId: signal.details.signalId, decision: "retry", reason: "The successor finishes criterion requires a retry.", retryHandoff: { failedCriteria: ["The first execution must be retried."], completedWork: ["The first execution lifecycle was recorded."], requiredChanges: ["Run the corrected lifecycle."], nonGoals: ["Do not change the lifecycle contract."], validation: ["Read durable records."] }, successorAssignment }, null, null, conclaveContext);
		assert.equal(retry.details.missionId, firstMission.missionId);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "mission").length, 2);
		assert.equal(readCurrentMission(projectPath, "mission-work").mission.predecessorMissionId, firstMission.missionId);
		assert.equal(readCurrentMission(projectPath, "mission-work").mission.mandateId, firstMission.mandateId);
		assert.equal(readExecutorRecord(projectPath, firstExecution.executionId).status, "failed");

		const secondLaunch = await tools.get("khala_launch_execution").execute("launch-successor", { workId: "mission-work" }, null, null, conclaveContext);
		assert.equal(secondLaunch.details.status, "launched");
		assert.equal(starts, 2);
		const secondMission = readCurrentMission(projectPath, "mission-work").mission;
		const secondExecution = readExecutorRecord(projectPath, secondLaunch.details.executionId);
		const secondExecutorContext = {
			cwd: secondExecution.sandboxPath,
			sessionManager: {
				getBranch() {
					return [
						{ type: "custom", customType: "khala-role", data: { role: "executor" } },
						{ type: "custom", customType: "khala-executor", data: { workId: "mission-work", executionId: secondExecution.executionId, executorName: secondExecution.executorName, projectPath, missionId: secondMission.missionId, participantId: secondExecution.participantId } },
					];
				},
				getSessionFile() {
					return secondExecution.sessionPath;
				},
			},
		};
		const finishedSignal = await runtimeTools.get("khala_signal").execute("finished-signal", { kind: "finished", summary: "The successor passed.", evidence: ["validation passed"] }, null, null, secondExecutorContext);
		assert.throws(
			() =>
				runtimeTools.get("khala_verdict").execute("unstated-finish-constraint", {
					workId: "mission-work",
					executionId: secondExecution.executionId,
					signalId: finishedSignal.details.signalId,
					decision: "reject",
					reason: "The immutable constraint Do not commit changes was violated.",
				}, null, null, conclaveContext),
			/durable Mission or Mandate term/,
		);
		await runtimeTools.get("khala_verdict").execute("finish", { workId: "mission-work", executionId: secondExecution.executionId, signalId: finishedSignal.details.signalId, decision: "finish", reason: "THE SUCCESSOR FINISHES! ACCEPTANCE CRITERION PASSED." }, null, null, conclaveContext);
		assert.equal(readCurrentMission(projectPath, "mission-work").state, "finished");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Observer review executions remain submission-scoped and recover their queue claim", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-observer-lifecycle-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const storage = createFileConclaveStorage();
		storage.submit({
			workId: "observer-work",
			projectPath,
			work: {
				title: "Observer test",
				objective: "Gather context.",
				context: "",
				scope: "Temporary project.",
				acceptanceCriteria: ["Learning is recorded."],
				constraints: [],
				plan: ["Inspect files."],
				validation: ["Cite sources."],
			},
		});
		const tools = new Map();
		let starterCalls = 0;
		registerKhalaObserver(createPiStub(new Map(), tools), {
			observerSystemPrompt: "observer prompt",
			isDedicatedConclaveSession: (context) =>
				context.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "khala-conclave"),
			getSubmission: storage.getSubmission,
			getPendingSubmission: storage.getPendingSubmission,
			markSubmissionReviewing: storage.markSubmissionReviewing,
			markSubmissionQueued: storage.markSubmissionQueued,
			createObserverStarter: () => async (request) => {
				starterCalls += 1;
				assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "reviewing");
				request.onSandboxCreated?.({ path: join(root, "observer-sandbox"), name: "observer-sandbox" }, "tmux");
				return {
					id: "observer-session",
					target: "observer-target",
					sandbox: { path: join(root, "observer-sandbox"), name: "observer-sandbox" },
				};
			},
		});
		const userContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-role", data: { role: "user" } }];
				},
				getSessionFile() {
					return join(root, "user.jsonl");
				},
			},
		};
		const archiveRecordCountBeforeUserLaunch = listArchiveRecords(projectPath).length;
		await assert.rejects(
			tools.get("khala_launch_observer").execute("observer", { workId: "observer-work" }, null, null, userContext),
			/Only the dedicated project Conclave may launch an Observer/,
		);
		assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "queued");
		assert.equal(listExecutorRecords(projectPath).length, 0);
		assert.equal(listArchiveRecords(projectPath).length, archiveRecordCountBeforeUserLaunch);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "learning").length, 0);

		const conclaveContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-conclave", data: {} }];
				},
				getSessionFile() {
					return join(root, "conclave.jsonl");
				},
			},
		};
		const result = await tools.get("khala_launch_observer").execute("observer", { workId: "observer-work" }, null, null, conclaveContext);
		assert.equal(result.details.workId, "observer-work");
		assert.equal(starterCalls, 1);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "mission").length, 0);
		const observer = listExecutorRecords(projectPath).find((execution) => execution.kind === "observer");
		assert.equal(observer.purpose.kind, "observation");
		assert.equal(observer.missionId, undefined);
		assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "reviewing");
		const learningTools = new Map();
		let closedTarget;
		registerKhalaLearning(
			createPiStub(new Map(), learningTools),
			async () => {
				throw new Error("wake unavailable");
			},
			async (launcher, target) => {
				closedTarget = `${launcher}:${target}`;
			},
		);
		const observerContext = {
			cwd: observer.sandboxPath,
			sessionManager: {
				getBranch() {
					return [
						{ type: "custom", customType: "khala-role", data: { role: "observer" } },
						{
							type: "custom",
							customType: "khala-observer",
							data: {
								workId: observer.workId,
								executionId: observer.executionId,
								observerName: observer.executorName,
								projectPath,
							},
						},
					];
				},
				getSessionFile() {
					return undefined;
				},
			},
		};
		await assert.rejects(
			learningTools.get("khala_record_learning").execute(
				"learning",
				{
					workId: observer.workId,
					executionId: observer.executionId,
					topic: "Repository context",
					summary: "The relevant context was found.",
					evidence: ["README describes the behavior."],
					sourcePaths: ["README.md"],
				},
				null,
				null,
				observerContext,
			),
			/wake unavailable/,
		);
		assert.equal(closedTarget, "tmux:observer-target");
		assert.equal(readExecutorRecord(projectPath, observer.executionId).status, "finished");
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "learning").length, 1);
		storage.markSubmissionQueued(projectPath, "observer-work", observer.executionId);
		assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "queued");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Observer launch without a closeable pane target fails and requeues the submission", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-observer-targetless-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const storage = createFileConclaveStorage();
		storage.submit({
			workId: "observer-work",
			projectPath,
			work: {
				title: "Observer test",
				objective: "Gather context.",
				context: "",
				scope: "Temporary project.",
				acceptanceCriteria: ["Learning is recorded."],
				constraints: [],
				plan: ["Inspect files."],
				validation: ["Cite sources."],
			},
		});
		const tools = new Map();
		let cleanedUp = false;
		registerKhalaObserver(createPiStub(new Map(), tools), {
			observerSystemPrompt: "observer prompt",
			isDedicatedConclaveSession: (context) =>
				context.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "khala-conclave"),
			getSubmission: storage.getSubmission,
			getPendingSubmission: storage.getPendingSubmission,
			markSubmissionReviewing: storage.markSubmissionReviewing,
			markSubmissionQueued: storage.markSubmissionQueued,
			createObserverStarter: () => async (request) => {
				request.onSandboxCreated?.({ path: join(root, "observer-sandbox"), name: "observer-sandbox" }, "tmux");
				return {
					id: "observer-session",
					sandbox: { path: join(root, "observer-sandbox"), name: "observer-sandbox" },
					cleanup: async () => {
						cleanedUp = true;
					},
				};
			},
		});
		const conclaveContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-conclave", data: {} }];
				},
				getSessionFile() {
					return join(root, "conclave.jsonl");
				},
			},
		};
		await assert.rejects(
			tools.get("khala_launch_observer").execute("observer", { workId: "observer-work" }, null, null, conclaveContext),
			/closeable pane target/,
		);
		assert.equal(cleanedUp, true);
		assert.equal(listExecutorRecords(projectPath).filter((execution) => execution.kind === "observer")[0].status, "failed");
		assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "queued");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("the root-registered Observer marker binds khala_record_learning end to end", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-observer-marker-contract-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const sandboxPath = join(root, "sandbox");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeExecutorRecord(
			createExecutorRecord(
				{
					executionId: "observer-execution",
					workId: "observer-work",
					executorName: "Adun",
					kind: "observer",
					participantId: "observer:observer-execution",
					purpose: { kind: "observation", submissionRecordId: "observer-submission-record" },
					projectPath,
					sandboxPath,
					launcher: "tmux",
					target: "session:observer-window",
				},
				"running",
			),
		);
		const branch = [];
		const events = new Map();
		const flags = new Map([
			["khala-work-id", "observer-work"],
			["khala-execution-id", "observer-execution"],
			["khala-project-path", projectPath],
			["khala-agent-kind", "observer"],
		]);
		const pi = createPiStub(new Map(), new Map(), flags, {
			events,
			appendEntry(type, data) {
				branch.push({ type: "custom", customType: type, data });
			},
		});
		createExtension(pi);
		events.get("session_start")({}, {
			cwd: sandboxPath,
			isProjectTrusted: () => false,
			sessionManager: {
				getBranch: () => branch,
				getEntries: () => branch,
				getSessionFile: () => undefined,
				getSessionName: () => "Adun",
			},
			ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
		});
		const rootMarker = branch.find((entry) => entry.customType === "khala-observer");
		assert.ok(rootMarker);
		assert.equal(rootMarker.data.observerName, "Adun");
		assert.equal("executorName" in rootMarker.data, false);

		const learningTools = new Map();
		let woken = false;
		registerKhalaLearning(
			createPiStub(new Map(), learningTools),
			async (path, learning) => {
				woken = true;
				assert.equal(path, projectPath);
				assert.equal(learning.observerName, "Adun");
			},
			async () => {},
		);
		const observerContext = {
			cwd: sandboxPath,
			sessionManager: {
				getBranch() {
					return branch;
				},
				getSessionFile() {
					return undefined;
				},
			},
		};
		await learningTools.get("khala_record_learning").execute(
			"learning",
			{
				workId: "observer-work",
				executionId: "observer-execution",
				topic: "Repository context",
				summary: "The relevant context was found.",
				evidence: ["README describes the behavior."],
				sourcePaths: ["README.md"],
			},
			null,
			null,
			observerContext,
		);
		assert.equal(woken, true);
		assert.equal(readExecutorRecord(projectPath, "observer-execution").status, "finished");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-review state is one explicit active/inactive representation with strict cutover", () => {
	const branch = (records) => ({
		cwd: "/tmp",
		sessionManager: {
			getBranch: () => records,
		},
		ui: {
			setWidget() {},
		},
	});
	const activeRecord = { type: "custom", customType: "review-session", data: { active: true, originId: "leaf-1" } };
	assert.deepEqual(getReviewState(branch([activeRecord])), { active: true, originId: "leaf-1" });

	const activeWithCheckout = {
		type: "custom",
		customType: "review-session",
		data: {
			active: true,
			originId: "leaf-1",
			checkout: { originalBranch: "main", originalHead: "a".repeat(40), originalStatus: "clean", reviewBranch: "pr-branch", reviewHead: "b".repeat(40) },
		},
	};
	assert.deepEqual(getReviewState(branch([activeWithCheckout])), {
		active: true,
		originId: "leaf-1",
		checkout: { originalBranch: "main", originalHead: "a".repeat(40), originalStatus: "clean", reviewBranch: "pr-branch", reviewHead: "b".repeat(40) },
	});

	assert.deepEqual(getReviewState(branch([{ type: "custom", customType: "review-session", data: { active: false } }])), {
		active: false,
	});

	// Strict cutover: an active record without an originId is not a valid review state.
	assert.equal(
		getReviewState(branch([{ type: "custom", customType: "review-session", data: { active: true } }])),
		undefined,
	);
	assert.equal(
		getReviewState(branch([{ type: "custom", customType: "review-session", data: { active: true, originId: "" } }])),
		undefined,
	);
	// The latest valid record wins; malformed records are ignored.
	assert.deepEqual(
		getReviewState(branch([{ type: "custom", customType: "review-session", data: { active: false } }, activeRecord])),
		{ active: true, originId: "leaf-1" },
	);
});

test("pi-review state application drives the widget and origin from one mirror", () => {
	const widgets = [];
	const context = {
		cwd: "/tmp",
		hasUI: true,
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "review-session", data: { active: true, originId: "leaf-2" } }],
		},
		ui: {
			setWidget(name, widget) {
				widgets.push({ name, widget });
			},
		},
	};
	applyReviewState(context);
	assert.equal(widgets.length, 1);
	assert.equal(widgets[0].name, "review");
	assert.ok(widgets[0].widget);

	const cleared = [];
	applyReviewState({
		cwd: "/tmp",
		hasUI: true,
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "review-session", data: { active: true } }],
		},
		ui: {
			setWidget(name, widget) {
				cleared.push({ name, widget });
			},
		},
	});
	assert.deepEqual(cleared, [{ name: "review", widget: undefined }]);
});

test("pi-review PR flow persists one active state and ends deterministically", async () => {
	const baseSha = "a".repeat(40);
	const headSha = "b".repeat(40);
	const entries = [];
	const appended = [];
	const notices = [];
	const widgets = [];
	const sentMessages = [];
	const exec = async (command, args) => {
		const joined = args.join(" ");
		if (command === "gh" && joined === "--version") return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
		if (command === "gh" && joined === "auth status") return { code: 0, stdout: "authenticated\n", stderr: "" };
		if (command === "gh" && joined.startsWith("pr view 42 --json")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					number: 42,
					baseRefName: "main",
					baseRefOid: baseSha,
					baseRepository: { nameWithOwner: "example/repo" },
					title: "Review",
					headRefName: "head-branch",
					headRefOid: headSha,
				}),
				stderr: "",
			};
		}
		if (command === "gh" && joined === "repo view --json nameWithOwner --jq .nameWithOwner") {
			return { code: 0, stdout: "example/repo\n", stderr: "" };
		}
		if (command === "gh" && joined === "pr checkout 42") return { code: 0, stdout: "", stderr: "" };
		if (command === "git" && joined === "rev-parse --git-dir") return { code: 0, stdout: "/tmp/.git\n", stderr: "" };
		if (command === "git" && joined === "status --porcelain --untracked-files=all") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "git" && joined === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
		if (command === "git" && joined === "rev-parse HEAD") return { code: 0, stdout: `${headSha}\n`, stderr: "" };
		if (command === "git" && joined.startsWith("fetch --no-tags origin refs/heads/")) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "git" && joined.startsWith("rev-parse --verify ")) {
			return { code: 0, stdout: `${args[2].replace("^{commit}", "")}\n`, stderr: "" };
		}
		if (command === "git" && joined.startsWith("merge-base ")) return { code: 0, stdout: "merge-base-sha\n", stderr: "" };
		if (command === "git" && joined.startsWith("switch ")) return { code: 0, stdout: "", stderr: "" };
		throw new Error(`Unexpected command: ${command} ${joined}`);
	};
	const commands = new Map();
	const pi = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on() {},
		exec,
		appendEntry(type, data) {
			appended.push({ type, data });
		},
		sendUserMessage(message) {
			sentMessages.push(message);
		},
	};
	reviewExtension(pi);
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		isProjectTrusted: () => false,
		sessionManager: {
			getLeafId: () => "leaf-1",
			getEntries: () => entries,
			getBranch: () => [],
		},
		ui: {
			notify(message, type) {
				notices.push({ message, type });
			},
			confirm: async () => true,
			select: async () => "Return only",
			setWidget(name, widget) {
				widgets.push({ name, widget });
			},
			setEditorText() {},
		},
		navigateTree: async () => ({ cancelled: false }),
	};

	// Reset the module mirror left by earlier state tests.
	applyReviewState({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: "review-session", data: { active: false } }] } });

	await commands.get("review").handler("pr 42", ctx);

	const stateRecords = appended.filter((entry) => entry.type === "review-session");
	assert.equal(stateRecords.length, 1, "one persisted review-state record");
	assert.equal(stateRecords[0].data.active, true);
	assert.equal(stateRecords[0].data.originId, "leaf-1");
	assert.ok(stateRecords[0].data.checkout, "the PR checkout is persisted with the active state");
	assert.equal(stateRecords[0].data.checkout.originalBranch, "main");
	assert.ok(sentMessages.length === 1);
	assert.ok(notices.some((notice) => /Starting review: PR #42/.test(notice.message)));
	assert.ok(widgets.some((widget) => widget.name === "review" && widget.widget !== undefined));

	// End the review: checkout restored, state cleared, no empty-origin record ever persisted.
	await commands.get("end-review").handler("", ctx);
	const finalRecord = appended.filter((entry) => entry.type === "review-session").at(-1);
	assert.deepEqual(finalRecord.data, { active: false });
	assert.equal(
		appended.some((entry) => entry.type === "review-session" && entry.data.active === true && !entry.data.originId),
		false,
		"no active record without an originId may be persisted",
	);
	assert.equal(widgets.at(-1).widget, undefined, "the widget is cleared after end-review");
	assert.ok(notices.some((notice) => notice.message === "Review complete! Returned to original position."));
});

test("pi-review PR resolution failure clears the checkout and leaks no state", async () => {
	const baseSha = "a".repeat(40);
	const headSha = "b".repeat(40);
	const mismatchSha = "c".repeat(40);
	const entries = [];
	const appended = [];
	const notices = [];
	const widgets = [];
	let headCalls = 0;
	const execCalls = [];
	const exec = async (command, args) => {
		const joined = args.join(" ");
		execCalls.push([command, ...args]);
		if (command === "gh" && joined === "--version") return { code: 0, stdout: "gh version 2.0.0\n", stderr: "" };
		if (command === "gh" && joined === "auth status") return { code: 0, stdout: "authenticated\n", stderr: "" };
		if (command === "gh" && joined.startsWith("pr view 42 --json")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					number: 42,
					baseRefName: "main",
					baseRefOid: baseSha,
					baseRepository: { nameWithOwner: "example/repo" },
					title: "Review",
					headRefName: "head-branch",
					headRefOid: headSha,
				}),
				stderr: "",
			};
		}
		if (command === "gh" && joined === "repo view --json nameWithOwner --jq .nameWithOwner") {
			return { code: 0, stdout: "example/repo\n", stderr: "" };
		}
		if (command === "gh" && joined === "pr checkout 42") return { code: 0, stdout: "", stderr: "" };
		if (command === "git" && joined === "rev-parse --git-dir") return { code: 0, stdout: "/tmp/.git\n", stderr: "" };
		if (command === "git" && joined === "status --porcelain --untracked-files=all") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "git" && joined === "branch --show-current") return { code: 0, stdout: "main\n", stderr: "" };
		if (command === "git" && joined === "rev-parse HEAD") {
			headCalls += 1;
			return { code: 0, stdout: `${headCalls === 1 ? headSha : mismatchSha}\n`, stderr: "" };
		}
		if (command === "git" && joined === "symbolic-ref refs/remotes/origin/HEAD --short") {
			return { code: 0, stdout: "origin/main\n", stderr: "" };
		}
		if (command === "git" && joined.startsWith("switch ")) return { code: 0, stdout: "", stderr: "" };
		throw new Error(`Unexpected command: ${command} ${joined}`);
	};
	const commands = new Map();
	const pi = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on() {},
		exec,
		appendEntry(type, data) {
			appended.push({ type, data });
		},
		sendUserMessage() {},
	};
	reviewExtension(pi);
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		isProjectTrusted: () => false,
		sessionManager: {
			getLeafId: () => "leaf-1",
			getEntries: () => entries,
			getBranch: () => [],
		},
		ui: {
			notify(message, type) {
				notices.push({ message, type });
			},
			confirm: async () => true,
			select: async () => undefined,
			setWidget(name, widget) {
				widgets.push({ name, widget });
			},
			setEditorText() {},
			custom: async (factory) => {
				const theme = { fg: (_color, text) => text, bold: (text) => text };
				factory({ requestRender() {} }, theme, {}, () => {});
				return null;
			},
		},
		navigateTree: async () => ({ cancelled: false }),
	};

	applyReviewState({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: "review-session", data: { active: false } }] } });

	// The checked-out PR head mismatches GitHub: resolution fails, checkout is restored, selector cancelled.
	await commands.get("review").handler("pr 42", ctx);
	assert.equal(appended.filter((entry) => entry.type === "review-session").length, 0, "no state record on failure");
	assert.ok(execCalls.some((call) => call[0] === "git" && call[1] === "switch" && call[2] === "main"));
	assert.ok(notices.some((notice) => /does not match GitHub head/.test(notice.message)));
	assert.ok(
		notices.some((notice) => notice.message === "Review cancelled"),
		"the selector stub must cancel deterministically and settle the handler",
	);

	// A later fresh review must not inherit the failed PR's checkout.
	await commands.get("review").handler("uncommitted", ctx);
	const stateRecords = appended.filter((entry) => entry.type === "review-session");
	assert.equal(stateRecords.length, 1);
	assert.equal(stateRecords[0].data.active, true);
	assert.equal(stateRecords[0].data.originId, "leaf-1");
	assert.equal("checkout" in stateRecords[0].data, false, "the failed PR checkout must not leak into a later review");
	assert.equal(widgets.filter((widget) => widget.widget !== undefined).length, 1);
	assert.equal(
		appended.some(
			(entry) => entry.type === "review-session" && entry.data.active === true && !entry.data.originId,
		),
		false,
		"every persisted active state must carry a non-empty originId",
	);
});
