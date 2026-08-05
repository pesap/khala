import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
	createBranchSelectorItems,
	createCommitSelectorItems,
	filterReviewSelectorItems,
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
import { KhalaSessionList } from "../dist/src/khala-session-list.js";
import { toggleKhalaPopup } from "../dist/src/khala-popup.js";
import { createSessionSource } from "../dist/src/khala-sessions.js";
import { registerKhalaWork } from "../dist/src/khala-work.js";

function createPiStub(commands, tools = new Map(), flags = new Map(), hooks = {}) {
	return {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag() {},
		registerShortcut() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
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

test("/khala creates and exposes a persisted project Conclave when absent", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const userSessionPath = join(root, "user.jsonl");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const commands = new Map();
		createExtension(createPiStub(commands));
		const notifications = [];
		const context = {
			cwd: projectPath,
			mode: "print",
			sessionManager: {
				getSessionFile() {
					return userSessionPath;
				},
				getBranch() {
					return [];
				},
			},
			ui: {
				notify(message) {
					notifications.push(message);
				},
			},
		};

		await commands.get("khala").handler("", context);

		assert.equal(notifications.length, 1);
		const [projectDirectory] = readdirSync(join(agentDir, "khala", "conclaves"));
		const mappingPath = join(agentDir, "khala", "conclaves", projectDirectory, "session.json");
		const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
		const { sessionPath } = mapping;
		assert.equal(typeof sessionPath, "string");
		assert.equal(mapping.userSessionPath, userSessionPath);
		const entries = readFileSync(sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(entries.some((entry) => entry.customType === "khala-conclave"));
		assert.ok(entries.some((entry) => entry.name === "Khala Conclave"));

		writeExecutorRecord(
			createExecutorRecord({
				executionId: "execution-1",
				workId: "work-1",
				executorName: "Artanis",
				projectPath,
				sandboxPath: join(root, "sandbox"),
				launcher: "tmux",
			}),
		);
		appendArchiveRecord(projectPath, {
			type: "submission",
			workId: "work-1",
			payload: {
				workId: "work-1",
				projectPath,
				status: "queued",
				work: {
					title: "Improve session roster",
					objective: "Make active sessions easier to scan.",
					context: "",
					scope: "Khala session list",
					acceptanceCriteria: ["Active work is visible."],
					constraints: [],
					plan: ["Render active work titles."],
					validation: ["Run the session tests."],
				},
				archivePath: join(root, "archive.jsonl"),
			},
		});

		const source = createSessionSource(
			{
				cwd: projectPath,
				sessionManager: {
					getSessionFile() {
						return sessionPath;
					},
				},
			},
			() => sessionPath,
			() => mapping.userSessionPath,
		);
		const sessions = source.getActiveSessions(sessionPath);
		const userSession = sessions.find((session) => session.id === "user");
		const conclaveSession = sessions.find((session) => session.id === "conclave");
		const executorSession = sessions.find((session) => session.id === "executor:execution-1");
		assert.equal(userSession?.sessionPath, userSessionPath);
		assert.equal(userSession?.isCurrent, false);
		assert.equal(userSession?.displayOnly, false);
		assert.equal(userSession?.action, "context switch");
		assert.equal(userSession?.sessionPathLabel, relative(projectPath, userSessionPath));
		assert.equal(conclaveSession?.sessionPath, sessionPath);
		assert.equal(conclaveSession?.isCurrent, true);
		assert.equal(conclaveSession?.displayOnly, false);
		assert.equal(conclaveSession?.state, "input");
		assert.equal(conclaveSession?.stateLabel, "Input Required");
		assert.equal(conclaveSession?.action, "context switch");
		assert.equal(executorSession?.displayOnly, true);
		assert.equal(executorSession?.sessionPath, "");
		assert.equal(executorSession?.sessionPathLabel, "separate Pi process");
		assert.equal(executorSession?.sandboxPath, join(root, "sandbox"));
		assert.equal(executorSession?.sandboxPathLabel, relative(projectPath, join(root, "sandbox")));
		assert.equal(executorSession?.state, "working");
		assert.equal(executorSession?.task, "Improve session roster");

		updateExecutorRecord(projectPath, "execution-1", { status: "failed" });
		const failedExecutor = source
			.getActiveSessions(sessionPath)
			.find((session) => session.id === "executor:execution-1");
		assert.equal(failedExecutor?.state, "failed");
		assert.equal(failedExecutor?.displayOnly, true);

		writeExecutorRecord(
			createExecutorRecord({
				executionId: "execution-2",
				workId: "work-1",
				executorName: "Fenix",
				projectPath,
				sandboxPath: join(root, "sandbox-2"),
				launcher: "tmux",
			}),
		);
		const successorSessions = source.getActiveSessions(sessionPath);
		assert.equal(successorSessions.some((session) => session.id === "executor:execution-1"), false);
		assert.equal(successorSessions.find((session) => session.id === "executor:execution-2")?.state, "working");

		updateExecutorRecord(projectPath, "execution-1", { status: "finished" });
		const finishedExecutor = source
			.getActiveSessions(sessionPath)
			.find((session) => session.id === "executor:execution-1");
		assert.equal(finishedExecutor, undefined);

		updateExecutorRecord(projectPath, "execution-2", { status: "finished" });
		const pullRequest = {
			pullRequestId: "pr-execution-2",
			workId: "work-1",
			missionId: "mission-2",
			executionId: "execution-2",
			status: "draft",
			url: "https://github.com/example/repo/pull/2",
			remoteConfirmedAt: new Date().toISOString(),
			changedFiles: [],
			diffSummary: "",
			validationResults: [],
			reviewFeedback: [],
			unresolvedGaps: [],
			recordedAt: new Date().toISOString(),
		};
		appendPullRequestRecord(projectPath, pullRequest, false);
		assert.ok(source.getActiveSessions(sessionPath).some((session) => session.id === "executor:execution-2"));
		appendPullRequestRecord(
			projectPath,
			{ ...pullRequest, status: "closed", recordedAt: new Date().toISOString() },
			false,
		);
		assert.equal(source.getActiveSessions(sessionPath).some((session) => session.id === "executor:execution-2"), false);

		const unavailableSource = createSessionSource(
			{
				cwd: projectPath,
				sessionManager: {
					getSessionFile() {
						return undefined;
					},
				},
			},
			() => sessionPath,
			() => undefined,
		);
		const unavailableUser = unavailableSource.getActiveSessions("").find((session) => session.id === "user");
		assert.equal(unavailableUser?.sessionPathLabel, "unavailable");
		assert.equal(unavailableUser?.isCurrent, false);
		const idleUserSource = createSessionSource(
			{
				cwd: projectPath,
				isIdle() {
					return true;
				},
				sessionManager: {
					getSessionFile() {
						return userSessionPath;
					},
				},
			},
			() => undefined,
			() => userSessionPath,
		);
		const idleUser = idleUserSource.getActiveSessions(userSessionPath).find((session) => session.id === "user");
		assert.equal(idleUser?.state, "input");

		const busyUserSource = createSessionSource(
			{
				cwd: projectPath,
				isIdle() {
					return false;
				},
				sessionManager: {
					getSessionFile() {
						return userSessionPath;
					},
				},
			},
			() => undefined,
			() => userSessionPath,
		);
		const busyUser = busyUserSource.getActiveSessions(userSessionPath).find((session) => session.id === "user");
		assert.equal(busyUser?.state, "working");
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

test("Executor failure transitions are terminal and retain first runtime evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-executor-failure-state-"));
	try {
		const execution = createExecutorRecord(
			{
				executionId: "failure-execution",
				workId: "failure-work",
				executorName: "Failure Executor",
				kind: "executor",
				participantId: "executor:failure",
				purpose: { kind: "mission", missionId: "failure-mission" },
				missionId: "failure-mission",
				projectPath: root,
				sandboxPath: root,
				launcher: "headless-rpc",
			},
			"starting",
		);
		writeExecutorRecord(execution);
		const failed = updateExecutorRecord(root, execution.executionId, {
			status: "failed",
			failure: "child exited during initialization",
		});
		assert.equal(failed?.failure, "child exited during initialization");
		const repeated = updateExecutorRecord(root, execution.executionId, {
			status: "failed",
			failure: "cleanup failed",
		});
		assert.equal(repeated?.failure, "child exited during initialization");
		assert.throws(
			() => updateExecutorRecord(root, execution.executionId, { status: "running" }),
			/cannot return to running/,
		);
		assert.equal(listExecutorRecords(root).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

test("KhalaSessionList renders one flat session list, scrolls, and blocks display-only confirmation", () => {
	const theme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return text;
		},
	};
	const makeSession = (id, displayOnly, isCurrent = false) => ({
		id,
		name: id,
		role: displayOnly ? "Executor" : "Conclave",
		state: displayOnly ? "working" : "input",
		stateLabel: "Active",
		action: displayOnly ? "display only" : "context switch",
		displayOnly,
		isCurrent,
		task: id === "user" ? "current project" : `Task ${id}`,
		...(id === "executor-1"
			? { latestSignal: { kind: "progress", summary: "checking fixtures", observedAt: "2026-01-01T00:00:00.000Z" } }
			: {}),
	});
	const sessions = [
		makeSession("user", false, true),
		makeSession("conclave", false),
		makeSession("executor-1", true),
		makeSession("executor-2", true),
		makeSession("executor-3", true),
	];
	const list = new KhalaSessionList(sessions, theme, getKeybindings());
	const selected = [];
	const confirmed = [];
	list.onSelectionChange = (session) => selected.push(session.id);
	list.onSelect = (session) => confirmed.push(session.id);

	const initialRender = list.render(80).join("\n");
	assert.doesNotMatch(initialRender, /CURRENT CONTEXT|AGENTS · DISPLAY ONLY/);
	assert.match(initialRender, /user/);
	assert.match(initialRender, /conclave/);
	assert.match(initialRender, /executor-1/);
	assert.match(initialRender, /progress/);
	assert.match(initialRender, /sessions 1-4\/5/);

	list.handleInput("\u001b[B");
	list.handleInput("\u001b[B");
	list.handleInput("\u001b[B");
	list.handleInput("\u001b[B");
	assert.equal(list.getSelectedSession()?.id, "executor-3");
	assert.match(list.render(80).join("\n"), /sessions 2-5\/5/);
	list.handleInput("\r");
	assert.deepEqual(confirmed, []);
	assert.deepEqual(selected, ["conclave", "executor-1", "executor-2", "executor-3"]);

	list.updateSessions([sessions[0], sessions[1], makeSession("executor-new", true)]);
	assert.equal(list.getSelectedSession()?.id, "user");
	list.updateSessions(sessions.slice(0, 2));
	assert.equal(list.getSelectedSession()?.id, "user");
	assert.doesNotMatch(list.render(80).join("\n"), /AGENTS/);
	assert.ok(list.render(20).every((line) => visibleWidth(line) <= 20));
});

test("Khala popup refreshes its session roster while open", async () => {
	const theme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return text;
		},
		bold(text) {
			return text;
		},
	};
	const userSession = {
		id: "user",
		name: "You",
		role: "User",
		state: "input",
		stateLabel: "Input Required",
		action: "context switch",
		displayOnly: false,
		isCurrent: true,
		task: "current project",
		skills: [],
		sessionPath: "/tmp/user.jsonl",
		sessionPathLabel: "../../user.jsonl",
	};
	const executorSession = {
		id: "executor:1",
		name: "Executor",
		role: "Executor",
		state: "working",
		stateLabel: "Active",
		action: "display only",
		displayOnly: true,
		isCurrent: false,
		task: "Work work-1",
		skills: ["signals"],
		sessionPath: "",
		sessionPathLabel: "separate Pi process",
		latestSignal: { kind: "progress", summary: "checking", observedAt: "2026-01-01T00:00:00.000Z" },
	};
	let sessions = [userSession];
	const defaultKeybindings = getKeybindings();
	const popupKeys = new Map([
		["tui.select.up", ["ctrl+p"]],
		["tui.select.down", ["ctrl+n"]],
		["tui.select.confirm", ["ctrl+o"]],
	]);
	const popupKeybindings = {
		matches(data, keybinding) {
			return defaultKeybindings.matches(data, keybinding);
		},
		getKeys(keybinding) {
			return popupKeys.get(keybinding) ?? defaultKeybindings.getKeys(keybinding);
		},
	};
	let component;
	let finish;
	let customOptions;
	const source = {
		getActiveSessions() {
			return sessions;
		},
	};
	const context = {
		mode: "tui",
		sessionManager: {
			getSessionFile() {
				return userSession.sessionPath;
			},
		},
		ui: {
			custom(factory, options) {
				customOptions = options;
				return new Promise((resolve) => {
					finish = resolve;
					component = factory({ requestRender() {} }, theme, popupKeybindings, finish);
				});
			},
		},
	};

	const popupPromise = toggleKhalaPopup(context, source);
	sessions = [userSession, executorSession];
	await new Promise((resolve) => setTimeout(resolve, 1100));
	const renderedPopup = component.render(80).join("\n");
	assert.doesNotMatch(renderedPopup, /CURRENT CONTEXT|AGENTS · DISPLAY ONLY/);
	assert.match(renderedPopup, /Executor/);
	assert.match(renderedPopup, /progress/);
	assert.match(renderedPopup, /ctrl\+o to switch context/);
	assert.match(renderedPopup, /ctrl\+p\/ctrl\+n select/);
	assert.match(renderedPopup, /ctrl\+o switch\/view/);
	assert.ok(component.render(20).every((line) => visibleWidth(line) <= 20));
	component.handleInput("\u001b");
	finish?.(null);
	await popupPromise;
	assert.equal(customOptions, undefined);
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
		const retry = await runtimeTools.get("khala_verdict").execute("retry", { workId: "mission-work", executionId: firstExecution.executionId, signalId: signal.details.signalId, decision: "retry", reason: "The first execution is intentionally retryable.", retryHandoff: { failedCriteria: ["The first execution must be retried."], completedWork: ["The first execution lifecycle was recorded."], requiredChanges: ["Run the corrected lifecycle."], nonGoals: ["Do not change the lifecycle contract."], validation: ["Read durable records."] }, successorAssignment }, null, null, conclaveContext);
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
		await runtimeTools.get("khala_verdict").execute("finish", { workId: "mission-work", executionId: secondExecution.executionId, signalId: finishedSignal.details.signalId, decision: "finish", reason: "Acceptance criteria passed." }, null, null, conclaveContext);
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
