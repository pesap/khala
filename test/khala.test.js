import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, initTheme } from "@earendil-works/pi-coding-agent";
import createExtension, { createExecutorViewHandler } from "../dist/src/index.js";
import { runKhalaDemo } from "../dist/src/khala-demo.js";
import { appendArchiveRecord, getArchivePath, listArchiveRecords } from "../dist/src/khala-archive.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { readCurrentMission, readMandate } from "../dist/src/khala-archive-projections.js";
import { enqueueConclaveWake } from "../dist/src/khala-conclave.js";
import { createExecutorStarter } from "../dist/src/executor.js";
import { createHerdrLauncher } from "../dist/src/launch-herdr.js";
import { createGitWorktreeProvider } from "../dist/src/vcs-git-worktree.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "../dist/src/khala-executor-registry.js";
import { canRecordPullRequestReview } from "../dist/src/khala-review.js";
import { KhalaSessionList } from "../dist/src/khala-session-list.js";
import { toggleKhalaPopup } from "../dist/src/khala-popup.js";
import { createSessionSource } from "../dist/src/khala-sessions.js";
import { listSignals, readSignal } from "../dist/src/khala-signal.js";
import { isSignal } from "../dist/src/khala-model.js";
import { registerKhalaObserver } from "../dist/src/khala-observer.js";
import { buildOracleArguments, registerKhalaOracle } from "../dist/src/khala-oracle.js";
import { registerKhalaWork } from "../dist/src/khala-work.js";
import { buildKhalaTriageTemplateInvocation, parseKhalaTriageArgs, registerKhalaTriage } from "../dist/src/khala-triage.js";

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

test("package lifecycle builds every declared extension and exposes Khala commands", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.scripts.prepare, "npm run clean && npm run build");
	assert.equal(manifest.dependencies.typescript, "5.9.3");
	assert.equal(manifest.devDependencies.typescript, undefined);
	assert.deepEqual(manifest.pi.extensions, [
		"./dist/src/index.js",
		"./dist/extensions/pi-review/review.js",
	]);
	assert.deepEqual(manifest.pi.prompts, ["./prompts"]);
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	for (const extensionPath of manifest.pi.extensions) {
		assert.ok(readFileSync(new URL(`../${extensionPath}`, import.meta.url)).length > 0);
	}
	for (const skillName of ["khala", "khala-executor"]) {
		assert.ok(readFileSync(new URL(`../skills/${skillName}/SKILL.md`, import.meta.url)).length > 0);
	}

	const commands = new Map();
	createExtension(createPiStub(commands));
	for (const command of ["khala", "khala-work", "khala-triage"]) {
		assert.ok(commands.has(command), `/${command} should be registered`);
	}
});

test("Pi discovers and loads the Khala triage prompt as a dynamic template resource", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-prompt-template-test-"));
	try {
		const events = new Map();
		createExtension(createPiStub(new Map(), new Map(), new Map(), { events }));
		const discovered = events.get("resources_discover")({ type: "resources_discover", cwd: root, reason: "startup" });
		assert.deepEqual(discovered.promptPaths, [join(process.cwd(), "templates", "khala-triage-prompt.md")]);

		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			additionalPromptTemplatePaths: discovered.promptPaths,
		});
		await loader.reload();
		const template = loader.getPrompts().prompts.find((prompt) => prompt.name === "khala-triage-prompt");
		assert.ok(template);
		assert.match(template.content, /\$\{1:-the issue or request identified in the current conversation\}/);
		assert.match(template.content, /\$\{2:-confirm\}/);
		assert.match(template.content, /\$\{@:3\}/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Users can communicate review feedback without gaining Conclave authority", () => {
	assert.equal(canRecordPullRequestReview(null), true);
	assert.equal(canRecordPullRequestReview("user"), true);
	assert.equal(canRecordPullRequestReview("executor"), false);
	assert.equal(canRecordPullRequestReview("conclave"), false);
});

test("launched Executor status uses the Executor name after marker registration", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-status-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const branch = [];
	const events = new Map();
	const statuses = [];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const flags = new Map([
			["khala-work-id", "status-work"],
			["khala-execution-id", "status-execution"],
			["khala-project-path", projectPath],
		]);
		const pi = createPiStub(new Map(), new Map(), flags, {
			events,
			appendEntry(type, data) {
				branch.push({ type: "custom", customType: type, data });
			},
		});
		createExtension(pi);
		const context = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return branch;
				},
				getSessionFile() {
					return undefined;
				},
				getSessionName() {
					return "Adun";
				},
			},
			ui: {
				theme: {
					fg(_color, text) {
						return text;
					},
				},
				setStatus(_id, status) {
					statuses.push(status);
				},
			},
		};

		events.get("session_start")({}, context);

		assert.equal(statuses.length, 1);
		assert.match(statuses[0], /khala ⁝ Adun/);
		assert.doesNotMatch(statuses[0], /user/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Khala Oracle runs a bounded fresh review and renders advisory output", async () => {
	const commands = new Map();
	const tools = new Map();
	let receivedCwd;
	let receivedPrompt;
	let receivedSignal;
	registerKhalaOracle(createPiStub(commands, tools), async (cwd, prompt, signal) => {
		receivedCwd = cwd;
		receivedPrompt = prompt;
		receivedSignal = signal;
		return {
			output: [
				"Findings:",
				"- Severity: major",
				"  Evidence: src/example.ts:10",
				"- Severity: minor",
				"Validation gaps:",
				"- Focused test is missing.",
				"Open questions:",
				"- none",
				"Verdict: revise",
			].join("\n"),
			model: "test-model",
			durationMs: 42,
		};
	});
	const oracle = tools.get("khala_oracle");
	const signal = new AbortController().signal;
	const result = await oracle.execute(
		"oracle",
		{ prompt: "  Review this bounded packet.  " },
		signal,
		null,
		{ cwd: "/tmp/project" },
	);
	assert.equal(receivedCwd, "/tmp/project");
	assert.equal(receivedPrompt, "Review this bounded packet.");
	assert.equal(receivedSignal, signal);
	assert.equal(result.details.verdict, "revise");
	assert.equal(result.details.majors, 1);
	assert.equal(result.details.minors, 1);
	assert.equal(result.details.validationGaps, 1);
	assert.deepEqual(buildOracleArguments("packet", "test-model").slice(0, 7), [
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--model",
		"test-model",
		"--thinking",
		"high",
	]);
	initTheme();
	const plainTheme = {
		fg(_color, text) {
			return text;
		},
		bold(text) {
			return text;
		},
	};
	const collapsed = oracle.renderResult(result, { expanded: false, isPartial: false }, plainTheme, {});
	assert.match(collapsed.render(120).join("\n"), /→ revise/);
	assert.match(collapsed.render(120).join("\n"), /1 major/);
	const expanded = oracle.renderResult(result, { expanded: true, isPartial: false }, plainTheme, {});
	assert.match(expanded.render(120).join("\n"), /Findings/);
	assert.match(expanded.render(120).join("\n"), /src\/example.ts:10/);
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
		assert.equal(failedExecutor, undefined);

		updateExecutorRecord(projectPath, "execution-1", { status: "finished" });
		const finishedExecutor = source
			.getActiveSessions(sessionPath)
			.find((session) => session.id === "executor:execution-1");
		assert.equal(finishedExecutor, undefined);

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

test("stale Executor pane targets are marked failed without exposing launcher errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-stale-pane-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "stale-execution",
				workId: "stale-work",
				executorName: "Zeratul",
				projectPath,
				sandboxPath: join(root, "sandbox"),
				launcher: "tmux",
				target: "dead-server:stale-pane",
			}),
		);
		const notifications = [];
		const handler = createExecutorViewHandler(
			{
				cwd: projectPath,
				ui: { notify(message) { notifications.push(message); } },
			},
			async () => {
				throw new Error("tmux server is gone");
			},
		);
		assert.ok(handler);
		await handler({
			id: "executor:stale-execution",
			name: "Zeratul",
			identity: "stale-execution",
			launcher: "tmux",
			target: "dead-server:stale-pane",
		});
		assert.equal(readExecutorRecord(projectPath, "stale-execution")?.status, "failed");
		assert.deepEqual(notifications, ["The Zeratul Executor pane is no longer available."]);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conclave storage appends submission state to the configured Archive", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-archive-test-"));
	const agentDir = join(root, "agent");
	const archiveRoot = join(root, "archive");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "khala.json"), JSON.stringify({ archiveRoot }));
	try {
		const storage = createFileConclaveStorage();
		const work = {
			title: "Archive test",
			objective: "Verify Archive persistence.",
			context: "Test context",
			scope: "Test scope",
			acceptanceCriteria: ["The Archive contains every state."],
			constraints: [],
			plan: ["Append state records."],
			validation: ["Read the Archive."],
		};
		const submitted = storage.submit({ workId: "work-archive", projectPath, work });
		assert.equal(submitted.archivePath, getArchivePath(projectPath));
		assert.ok(submitted.archivePath.startsWith(archiveRoot));
		assert.equal(storage.claimSubmission(projectPath, "work-archive"), true);
		storage.markSubmissionQueued(projectPath, "work-archive");
		assert.equal(storage.claimSubmission(projectPath, "work-archive"), true);
		storage.markSubmissionLaunched(projectPath, "work-archive", { sandboxPath: "/tmp/sandbox" });
		assert.equal(storage.getPendingSubmission(projectPath, "work-archive"), undefined);
		assert.equal(storage.requeueSubmission(projectPath, "work-archive"), true);
		assert.equal(storage.getPendingSubmission(projectPath, "work-archive")?.status, "queued");
		assert.equal(storage.claimSubmission(projectPath, "work-archive"), true);
		storage.markSubmissionLaunched(projectPath, "work-archive", { sandboxPath: "/tmp/retry-sandbox" });
		assert.equal(storage.getPendingSubmission(projectPath, "work-archive"), undefined);
		const records = listArchiveRecords(projectPath);
		assert.deepEqual(
			records.filter((record) => record.type === "submission").map((record) => record.payload.status),
			["queued", "launching", "queued", "launching", "launched", "queued", "launching", "launched"],
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Khala demo queues three live dummy Work submissions", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-demo-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const storage = createFileConclaveStorage();
		const result = await runKhalaDemo(projectPath, async (request) => storage.submit(request));
		assert.equal(result.workIds.length, 3);
		assert.equal(result.archivePath, getArchivePath(projectPath));
		const submissions = listArchiveRecords(projectPath).filter((record) => record.type === "submission");
		assert.equal(submissions.length, 3);
		assert.deepEqual(
			submissions.map((record) => record.payload.work.title),
			["Khala live role demo: Direct Success", "Khala live role demo: Retry Success", "Khala live role demo: Retry Failure"],
		);
		assert.ok(submissions.every((record) => record.payload.work.context.includes("Dummy Executor Prompt:")));
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Executor Archive reads stay bound to the marker Project and execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-archive-reader-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const foreignProjectPath = join(root, "foreign-project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		appendArchiveRecord(projectPath, {
			type: "counsel",
			workId: "work-bound",
			payload: {
				workId: "work-bound",
				sourceRecordIds: ["bound-source"],
				observations: ["The assignment is visible."],
				recommendations: ["Read the bound records."],
				uncertainties: [],
				counselId: "bound-counsel",
				createdAt: new Date().toISOString(),
			},
		});
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "work-bound",
			executionId: "execution-bound",
			payload: {
				signalId: "bound-signal",
				workId: "work-bound",
				executionId: "execution-bound",
				executorName: "Bound Executor",
				kind: "progress",
				summary: "bound project",
				evidence: ["bound evidence"],
				observedAt: new Date().toISOString(),
			},
		});
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "work-other",
			executionId: "execution-other",
			payload: {
				signalId: "other-signal",
				workId: "work-other",
				executionId: "execution-other",
				executorName: "Other Executor",
				kind: "progress",
				summary: "other execution",
				evidence: ["other evidence"],
				observedAt: new Date().toISOString(),
			},
		});
		appendArchiveRecord(foreignProjectPath, {
			type: "signal",
			workId: "work-bound",
			executionId: "execution-bound",
			payload: {
				signalId: "foreign-signal",
				workId: "work-bound",
				executionId: "execution-bound",
				executorName: "Bound Executor",
				kind: "progress",
				summary: "foreign project",
				evidence: ["foreign evidence"],
				observedAt: new Date().toISOString(),
			},
		});

		const commands = new Map();
		const tools = new Map();
		const flags = new Map([["khala-project-path", projectPath]]);
		createExtension(createPiStub(commands, tools, flags));
		const archiveTool = tools.get("khala_read_archive");
		const executorContext = {
			cwd: join(root, "sandbox"),
			sessionManager: {
				getBranch() {
					return [
						{
							type: "custom",
							customType: "khala-executor",
							data: {
								workId: "work-bound",
								executionId: "execution-bound",
								executorName: "Bound Executor",
								projectPath,
							},
						},
					];
				},
			},
		};

		const result = await archiveTool.execute(
			"archive",
			{ executionId: "execution-bound" },
			null,
			null,
			executorContext,
		);
		assert.deepEqual(result.details.records.map((record) => record.type), ["counsel", "signal"]);
		initTheme();
		const plainTheme = {
			fg(_color, text) {
				return text;
			},
			bold(text) {
				return text;
			},
		};
		const collapsed = archiveTool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, {});
		const collapsedText = collapsed.render(120).join("\n");
		assert.match(collapsedText, /Khala Archive: 2 record\(s\)/);
		assert.match(collapsedText, /to expand/);
		assert.doesNotMatch(collapsedText, /bound evidence/);
		const expanded = archiveTool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, {});
		const expandedText = expanded.render(120).join("\n");
		assert.match(expandedText, /Records:/);
		assert.match(expandedText, /signal/);
		assert.doesNotMatch(expandedText, /bound evidence/);
		const unscopedResult = await archiveTool.execute("archive", {}, null, null, executorContext);
		assert.deepEqual(unscopedResult.details.records.map((record) => record.type), ["counsel", "signal"]);
		const userContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [];
				},
			},
		};
		const userExecutionResult = await archiveTool.execute(
			"archive",
			{ workId: "work-bound", executionId: "execution-bound" },
			null,
			null,
			userContext,
		);
		assert.deepEqual(userExecutionResult.details.records.map((record) => record.type), ["signal"]);
		const userRoleContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-role", data: { role: "user" } }];
				},
			},
		};
		assert.throws(
			() => archiveTool.execute("archive", {}, null, null, userRoleContext),
			/A User must specify a workId/,
		);
		const userRoleWorkResult = await archiveTool.execute(
			"archive",
			{ workId: "work-bound" },
			null,
			null,
			userRoleContext,
		);
		assert.deepEqual(userRoleWorkResult.details.records.map((record) => record.type), ["counsel", "signal"]);
		const userRoleExecutionResult = await archiveTool.execute(
			"archive",
			{ workId: "work-other", executionId: "execution-other" },
			null,
			null,
			userRoleContext,
		);
		assert.deepEqual(userRoleExecutionResult.details.records.map((record) => record.type), ["signal"]);
		assert.throws(
			() => archiveTool.execute("archive", { executionId: "execution-other" }, null, null, executorContext),
			/An Executor may only read its bound execution/,
		);

		flags.set("khala-project-path", foreignProjectPath);
		assert.throws(
			() => archiveTool.execute("archive", { executionId: "execution-bound" }, null, null, executorContext),
			/An Executor may only read its bound execution/,
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Users can submit Work intent without lifecycle authority", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-user-intent-"));
	const projectPath = join(root, "project");
	try {
		const commands = new Map();
		const tools = new Map();
		let submitted;
		registerKhalaWork(createPiStub(commands, tools), {
			workTemplate: "",
			executorSystemPrompt: "",
			createExecutorStarter: () => {
				throw new Error("not used");
			},
			isDedicatedConclaveSession: () => false,
			submitWork: async (request) => {
				submitted = request;
				return { archivePath: join(root, "archive.jsonl") };
			},
			getSubmission: () => undefined,
			getPendingSubmission: () => undefined,
			claimSubmission: () => false,
			markSubmissionQueued: () => {},
			markSubmissionLaunched: () => {},
		});
		const userContext = {
			cwd: projectPath,
			sessionManager: {
				getEntries() {
					return [];
				},
				getBranch() {
					return [{ type: "custom", customType: "khala-role", data: { role: "user" } }];
				},
			},
		};
		const result = await tools.get("khala_submit_work").execute(
			"user-submit",
			{
				objective: "Gather repository context before Conclave admission.",
				context: "The User supplied initial context.",
				scope: "Only inspect the current repository context.",
				acceptanceCriteria: ["The Conclave receives the Work."],
				constraints: [],
				plan: ["Review the submitted context."],
				validation: ["Confirm the Work is queued."],
			},
			null,
			null,
			userContext,
		);
		assert.equal(result.details.status, "queued");
		assert.equal(submitted.projectPath, projectPath);
		assert.equal(submitted.work.context, "The User supplied initial context.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Executor launch keeps the role prompt separate from the first Mission message", async () => {
	const sandbox = { path: "/tmp/khala-prompt-sandbox", name: "prompt-sandbox", projectPath: "/tmp/project" };
	let launchRequest;
	const starter = createExecutorStarter(
		{
			async createSandbox() {
				return sandbox;
			},
			async removeSandbox() {},
		},
		{
			async launch(request) {
				launchRequest = request;
				return { id: sandbox.name, sandbox };
			},
			async focus() {},
			async close() {},
		},
		["pi"],
		undefined,
		undefined,
		["/tmp/khala", "/tmp/khala-executor"],
	);
	await starter({
		projectPath: "/tmp/project",
		workId: "work-prompt",
		executionId: "execution-prompt",
		name: "Prompt separation",
		executorName: "Executor",
		mission: "Execute the first Mission message.",
		systemPrompt: "Permanent Executor rules.",
	});
	assert.deepEqual(launchRequest.args.slice(0, 8), [
		"--skill",
		"/tmp/khala",
		"--skill",
		"/tmp/khala-executor",
		"--system-prompt",
		"Permanent Executor rules.",
		"--khala-system-prompt-provided",
		"--name",
	]);
	assert.equal(launchRequest.args.at(-1), "Execute the first Mission message.");
});

test("Herdr launcher opens the Executor worktree in a new Herdr workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-herdr-launch-test-"));
	const bin = join(root, "bin");
	const herdrPath = join(bin, "herdr");
	const logPath = join(root, "herdr.jsonl");
	mkdirSync(bin);
	writeFileSync(
		herdrPath,
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.KHALA_HERDR_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({ result: { root_pane: { pane_id: "w-test:p-test" } } }));\n`,
	);
	chmodSync(herdrPath, 0o755);
	const previousPath = process.env.PATH;
	const previousHerdrEnvironment = process.env.HERDR_ENV;
	const previousLogPath = process.env.KHALA_HERDR_LOG;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.HERDR_ENV = "1";
	process.env.KHALA_HERDR_LOG = logPath;
	const sandbox = { path: join(root, "worktree"), name: "executor-worktree", projectPath: root };
	try {
		const launched = await createHerdrLauncher().launch({
			sandbox,
			name: sandbox.name,
			command: "pi",
			args: ["--name", "Executor"],
		});
		assert.equal(launched.target, "w-test:p-test");
		const records = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(records[0], [
			"worktree",
			"open",
			"--cwd",
			sandbox.projectPath,
			"--path",
			sandbox.path,
			"--no-focus",
			"--json",
		]);
		assert.equal(records[1][0], "pane");
		assert.equal(records[1][1], "run");
		assert.equal(records[1][2], launched.target);
		assert.match(records[1][3], /^'pi' '--name' 'Executor'$/);
		await createHerdrLauncher().close(launched.target);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousHerdrEnvironment === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnvironment;
		if (previousLogPath === undefined) delete process.env.KHALA_HERDR_LOG;
		else process.env.KHALA_HERDR_LOG = previousLogPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Git worktree cleanup removes the Executor branch from the project repository", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-worktree-test-"));
	const repo = join(root, "project");
	const worktreeRoot = join(root, "worktrees");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Khala Test"]);
	writeFileSync(join(repo, "README.md"), "test\\n");
	execFileSync("git", ["-C", repo, "add", "README.md"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
	const provider = createGitWorktreeProvider(worktreeRoot, "khala-test/");
	let sandbox;
	try {
		sandbox = await provider.createSandbox({ projectPath: repo, name: "cleanup" });
		assert.equal(sandbox.projectPath, repo);
		assert.equal(execFileSync("git", ["-C", sandbox.path, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), sandbox.path);
	} finally {
		if (sandbox !== undefined) await provider.removeSandbox(sandbox);
		rmSync(root, { recursive: true, force: true });
	}
});

test("Executor launch preserves startup failures when sandbox cleanup also fails", async () => {
	const sandbox = { path: "/tmp/khala-cleanup-sandbox", name: "cleanup-sandbox" };
	for (const failureSource of ["callback", "launcher"]) {
		const startupError = new Error(`${failureSource} failure`);
		const cleanupError = new Error("cleanup failure");
		let cleanupAttempted = false;
		let launcherAttempted = false;
		const vcsProvider = {
			async createSandbox() {
				return sandbox;
			},
			async removeSandbox() {
				cleanupAttempted = true;
				throw cleanupError;
			},
		};
		const launcher = {
			async launch() {
				launcherAttempted = true;
				throw startupError;
			},
			async focus() {},
			async close() {},
		};
		const starter = createExecutorStarter(vcsProvider, launcher);
		const request = {
			projectPath: "/tmp/khala-project",
			workId: "work-cleanup",
			executionId: "execution-cleanup",
			name: "Cleanup test",
			executorName: "Cleanup Executor",
			mission: "",
			systemPrompt: "",
			onSandboxCreated: failureSource === "callback" ? () => {
				throw startupError;
			} : undefined,
		};

		await assert.rejects(starter(request), (error) => {
			assert.equal(error, startupError);
			assert.equal(error.cleanupError, cleanupError);
			return true;
		});
		assert.equal(cleanupAttempted, true);
		assert.equal(launcherAttempted, failureSource === "launcher");
	}
});

test("role-specific tools record only authorized Archive mutations", async () =>{
	const root = mkdtempSync(join(tmpdir(), "khala-tools-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = new Map();
		const tools = new Map();
		createExtension(createPiStub(commands, tools));
		assert.ok(tools.has("khala_submit_work"));
		assert.ok(tools.has("khala_launch_execution"));
		assert.ok(tools.has("khala_signal"));
		assert.ok(tools.has("khala_verdict"));
		assert.ok(tools.has("khala_counsel"));
		assert.ok(tools.has("khala_oracle"));
		assert.equal(tools.has("khala_launch_work"), false);

		const foreignProjectPath = join(root, "foreign-project");
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "execution-foreign",
				workId: "work-foreign",
				executorName: "Foreign Executor",
				projectPath: foreignProjectPath,
				sandboxPath: join(root, "foreign-sandbox"),
				launcher: "demo",
			}),
		);
		const signalTool = tools.get("khala_signal");
		assert.throws(
			() =>
				signalTool.execute(
					"signal",
					{ kind: "progress", summary: "Unexpected cross-project signal.", evidence: [] },
					null,
					null,
					{
						cwd: projectPath,
						sessionManager: {
							getBranch() {
								return [
									{
										type: "custom",
										customType: "khala-executor",
										data: {
											workId: "work-foreign",
											executionId: "execution-foreign",
											executorName: "Foreign Executor",
											projectPath: foreignProjectPath,
										},
									},
								];
							},
							getSessionFile() {
								return undefined;
							},
						},
					},
				),
			/session sandbox does not match/,
		);

		const source = appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "work-counsel",
			executionId: "execution-counsel",
			payload: {
				signalId: "signal-counsel",
				workId: "work-counsel",
				executionId: "execution-counsel",
				executorName: "Counsel Executor",
				kind: "progress",
				summary: "Observed evidence.",
				evidence: ["Source evidence."],
				observedAt: new Date().toISOString(),
			},
		});
		const verdictSignal = appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "work-verdict",
			executionId: "execution-verdict",
			payload: {
				signalId: "signal-verdict",
				workId: "work-verdict",
				executionId: "execution-verdict",
				executorName: "Failure Lane",
				kind: "blocked",
				summary: "Validation failed.",
				evidence: ["The deterministic check failed."],
				observedAt: new Date().toISOString(),
			},
		});
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "execution-verdict",
				workId: "work-verdict",
				executorName: "Failure Lane",
				projectPath,
				sandboxPath: join(root, "failure-sandbox"),
				launcher: "tmux",
			}),
		);
		const counselTool = tools.get("khala_counsel");
		const preserverContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-role", data: { role: "preserver" } }];
				},
				getSessionFile() {
					return join(root, "preserver.jsonl");
				},
			},
		};
		await counselTool.execute("counsel", {
			workId: "work-counsel",
			executionId: "execution-counsel",
			sourceRecordIds: [source.recordId],
			observations: ["Observed evidence."],
			recommendations: ["Continue review."],
			uncertainties: [],
		}, null, null, preserverContext);
		const counselRecords = listArchiveRecords(projectPath).filter((record) => record.type === "counsel");
		assert.equal(counselRecords.length, 1);
		assert.equal(counselRecords[0]?.executionId, "execution-counsel");
		const verdictTool = tools.get("khala_verdict");
		const conclaveContext = {
			...preserverContext,
			sessionManager: {
				...preserverContext.sessionManager,
				getBranch() {
					return [{ type: "custom", customType: "khala-conclave", data: {} }];
				},
			},
		};
		await verdictTool.execute(
			"verdict",
			{
				workId: "work-verdict",
				executionId: "execution-verdict",
				signalId: "signal-verdict",
				decision: "reject",
				reason: "The validation evidence shows this execution cannot be accepted.",
			},
			null,
			null,
			conclaveContext,
		);
		assert.equal(readExecutorRecord(projectPath, "execution-verdict")?.status, "failed");
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "verdict").length, 1);
		assert.equal(verdictSignal.payload.signalId, "signal-verdict");
		assert.equal(
			isSignal({
				signalId: "signal-invalid-kind",
				workId: "work-invalid-signal",
				executionId: "execution-invalid-signal",
				executorName: "Invalid Executor",
				kind: "unknown",
				summary: "Malformed signal.",
				evidence: [],
				observedAt: new Date().toISOString(),
			}),
			false,
		);

		const retryStorage = createFileConclaveStorage();
		const retryWork = {
			title: "Retry test",
			objective: "Verify retry requeue.",
			context: "Test context",
			scope: "Test scope",
			acceptanceCriteria: ["The submission is requeued."],
			constraints: [],
			plan: ["Issue retry."],
			validation: ["Read the pending submission."],
		};
		retryStorage.submit({ workId: "work-retry", projectPath, work: retryWork });
		assert.equal(retryStorage.claimSubmission(projectPath, "work-retry"), true);
		retryStorage.markSubmissionLaunched(projectPath, "work-retry", { sandboxPath: join(root, "retry-sandbox") });
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "work-retry",
			executionId: "execution-retry",
			payload: {
				signalId: "signal-retry",
				workId: "work-retry",
				executionId: "execution-retry",
				executorName: "Retry Executor",
				kind: "blocked",
				summary: "Retryable failure.",
				evidence: ["The first attempt was blocked."],
				observedAt: new Date().toISOString(),
			},
		});
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "execution-retry",
				workId: "work-retry",
				executorName: "Retry Executor",
				projectPath,
				sandboxPath: join(root, "retry-sandbox"),
				launcher: "demo",
			}),
		);
		const retryResult = await verdictTool.execute(
			"retry-verdict",
			{
				workId: "work-retry",
				executionId: "execution-retry",
				signalId: "signal-retry",
				decision: "retry",
				reason: "Retry the blocked execution.",
			},
			null,
			null,
			conclaveContext,
		);
		assert.match(retryResult.content[0].text, /requeued/);
		assert.equal(retryStorage.getPendingSubmission(projectPath, "work-retry")?.status, "queued");

		const userContext = {
			...preserverContext,
			sessionManager: {
			...preserverContext.sessionManager,
			getBranch() {
				return [];
			},
		},
		};
		assert.throws(
			() =>
				counselTool.execute(
					"counsel",
					{
						workId: "work-counsel",
						sourceRecordIds: [source.recordId],
						observations: [],
						recommendations: [],
						uncertainties: [],
					},
					null,
					null,
					userContext,
				),
			/Preserver session/,
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
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
	const list = new KhalaSessionList(sessions, theme);
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
					component = factory({ requestRender() {} }, theme, {}, finish);
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
	component.handleInput("\u001b");
	finish?.(null);
	await popupPromise;
	assert.equal(customOptions, undefined);
});


test("Archive reads fail closed with safe, line-aware corruption errors", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-corrupt-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const archivePath = getArchivePath(projectPath);
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "safe-work",
			payload: {
				signalId: "safe-signal",
				workId: "safe-work",
				executionId: "safe-execution",
				executorName: "Safe Executor",
				kind: "progress",
				summary: "safe",
				evidence: ["safe evidence"],
				observedAt: new Date().toISOString(),
			},
		});
		writeFileSync(archivePath, `${readFileSync(archivePath, "utf8")}not-json-secret-payload\n`);
		assert.throws(
			() => listArchiveRecords(projectPath),
			(error) => error.name === "KhalaArchiveReadError" && error.lineNumber === 2 && !error.message.includes("secret-payload"),
		);
		writeFileSync(
			archivePath,
			`${JSON.stringify({
				recordId: "invalid-payload",
				type: "signal",
				projectPath,
				workId: "safe-work",
				recordedAt: new Date().toISOString(),
				payload: { secret: "not displayed" },
			})}\n`,
		);
		assert.throws(
			() => listArchiveRecords(projectPath),
			(error) => error.name === "KhalaArchiveReadError" && error.lineNumber === 1 && !error.message.includes("not displayed"),
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("schema-less pull-request records remain readable after schema versioning", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-legacy-archive-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const archivePath = getArchivePath(projectPath);
		mkdirSync(dirname(archivePath), { recursive: true });
		writeFileSync(
			archivePath,
			`${JSON.stringify({
				recordId: "legacy-pull-request",
				type: "pull-request",
				projectPath,
				workId: "legacy-work",
				recordedAt: new Date().toISOString(),
				payload: {
					pullRequestId: "legacy-pr",
					workId: "legacy-work",
					missionId: "legacy-mission",
					executionId: "legacy-execution",
					status: "draft",
					changedFiles: [],
					diffSummary: "",
					validationResults: [],
					reviewFeedback: [],
					unresolvedGaps: [],
					recordedAt: new Date().toISOString(),
				},
			})}\n`,
		);

		const records = listArchiveRecords(projectPath);
		assert.equal(records.length, 1);
		assert.equal(records[0].type, "pull-request");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("trusted projects use their archive root consistently", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-trusted-"));
	const agentDir = join(root, "agent");
	const globalRoot = join(root, "global-archive");
	const trustedRoot = join(root, "trusted-archive");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(projectPath, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "khala.json"), JSON.stringify({ archiveRoot: globalRoot }));
	writeFileSync(join(projectPath, ".pi", "khala.json"), JSON.stringify({ archiveRoot: trustedRoot }));
	try {
		const globalPath = getArchivePath(projectPath, false);
		const trustedPath = getArchivePath(projectPath, true);
		assert.notEqual(globalPath, trustedPath);
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "global",
			payload: {
				signalId: "global-signal",
				workId: "global",
				executionId: "global-execution",
				executorName: "Global Executor",
				kind: "progress",
				summary: "global",
				evidence: ["global evidence"],
				observedAt: new Date().toISOString(),
			},
		}, false);
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "trusted",
			payload: {
				signalId: "trusted-signal",
				workId: "trusted",
				executionId: "trusted-execution",
				executorName: "Trusted Executor",
				kind: "progress",
				summary: "trusted",
				evidence: ["trusted evidence"],
				observedAt: new Date().toISOString(),
			},
		}, true);
		assert.equal(listArchiveRecords(projectPath, false)[0].workId, "global");
		assert.equal(listArchiveRecords(projectPath, true)[0].workId, "trusted");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("typed Archive projections expose validated lifecycle records", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-projection-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeExecutorRecord(
			createExecutorRecord({
				executionId: "projection-execution",
				workId: "projection-work",
				executorName: "Projection Executor",
				projectPath,
				sandboxPath: join(root, "sandbox"),
				launcher: "test",
			}),
		);
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: "projection-work",
			executionId: "projection-execution",
			payload: {
				signalId: "projection-signal",
				workId: "projection-work",
				executionId: "projection-execution",
				executorName: "Projection Executor",
				kind: "progress",
				summary: "Projection is covered.",
				evidence: ["test"],
				observedAt: new Date().toISOString(),
			},
		});
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "execution").length, 1);
		assert.equal(listExecutorRecords(projectPath)[0].executionId, "projection-execution");
		assert.equal(listSignals(projectPath)[0].signalId, "projection-signal");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Signals require running executions and Verdict replays are idempotent", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-fences-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = new Map();
		const tools = new Map();
		createExtension(createPiStub(commands, tools));
		const signalTool = tools.get("khala_signal");
		const execution = createExecutorRecord({
			executionId: "fence-execution",
			workId: "fence-work",
			executorName: "Fence Executor",
			projectPath,
			sandboxPath: join(root, "sandbox"),
			launcher: "test",
		});
		writeExecutorRecord(execution);
		updateExecutorRecord(projectPath, execution.executionId, { status: "failed" });
		const executorContext = {
			cwd: execution.sandboxPath,
			sessionManager: {
				getBranch() {
					return [
						{ type: "custom", customType: "khala-role", data: { role: "executor" } },
					{ type: "custom", customType: "khala-executor", data: { workId: execution.workId, executionId: execution.executionId, executorName: execution.executorName, projectPath } },
					];
				},
				getSessionFile() {
					return undefined;
				},
			},
		};
		assert.throws(
			() => signalTool.execute("fenced", { kind: "progress", summary: "late", evidence: [] }, null, null, executorContext),
			/Only a running Executor execution/,
		);

		writeExecutorRecord(execution);
		assert.throws(
			() => signalTool.execute("empty-signal", { kind: "progress", summary: " ", evidence: [" "] }, null, null, executorContext),
			/non-empty summary and at least one evidence item/,
		);
		const signalResult = await signalTool.execute(
			"sandbox-signal",
			{ kind: "progress", summary: "sandbox identity is valid", evidence: ["registered sandbox"] },
			null,
			null,
			executorContext,
		);
		assert.match(signalResult.content[0].text, /recorded/);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "signal").length, 1);
		appendArchiveRecord(projectPath, {
			type: "signal",
			workId: execution.workId,
			executionId: execution.executionId,
			payload: {
				signalId: "idempotent-signal",
				workId: execution.workId,
				executionId: execution.executionId,
				executorName: execution.executorName,
				kind: "blocked",
				summary: "blocked",
				evidence: ["evidence"],
				observedAt: new Date().toISOString(),
			},
		});
		const verdictTool = tools.get("khala_verdict");
		const conclaveContext = {
			cwd: projectPath,
			sessionManager: {
				getBranch() {
					return [{ type: "custom", customType: "khala-conclave", data: {} }];
				},
			},
		};
		const input = { workId: execution.workId, executionId: execution.executionId, signalId: "idempotent-signal", decision: "finish", reason: "verified" };
		assert.throws(
			() => verdictTool.execute("empty-verdict", { ...input, reason: " " }, null, null, conclaveContext),
			/non-empty reason/,
		);
		const first = await verdictTool.execute("first", input, null, null, conclaveContext);
		const second = await verdictTool.execute("second", input, null, null, conclaveContext);
		assert.equal(first.details.verdictId, second.details.verdictId);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "verdict").length, 1);
		assert.throws(() => verdictTool.execute("conflict", { ...input, decision: "reject" }, null, null, conclaveContext), /conflicting Verdict/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("pre-launch starter failures remove the created sandbox", async () => {
	const removed = [];
	const vcs = {
		async createSandbox() {
			return { path: "/tmp/khala-failed-sandbox", name: "failed-sandbox" };
		},
		async removeSandbox(sandbox) {
			removed.push(sandbox.path);
		},
	};
	const launcher = {
		async launch() {
			throw new Error("launcher failed");
		},
		async focus() {},
		async close() {},
	};
	const starter = createExecutorStarter(vcs, launcher);
	await assert.rejects(
		() => starter({ projectPath: "/tmp/project", workId: "work", executionId: "execution", name: "name", executorName: "Executor", mission: "mission", systemPrompt: "prompt" }),
		/launcher failed/,
	);
	assert.deepEqual(removed, ["/tmp/khala-failed-sandbox"]);
});

test("pi-review pure selector helpers preserve target policy", async () => {
	const { createBranchSelectorItems, createCommitSelectorItems, filterReviewSelectorItems, sortReviewBranches } = await import("../dist/extensions/pi-review/review.js");
	assert.deepEqual(sortReviewBranches(["feature", "main", "current"], "current", "main"), ["main", "feature"]);
	assert.deepEqual(createBranchSelectorItems(["main"], "main")[0].description, "(default)");
	assert.equal(createCommitSelectorItems([{ sha: "123456789", title: "Fix" }])[0].label, "1234567 Fix");
	assert.equal(filterReviewSelectorItems(createBranchSelectorItems(["main", "feature"], "main"), "feat").length, 1);
});


test("Khala triage parses approval, starts a Work draft, and requires a Conclave report", async () => {
	assert.deepEqual(parseKhalaTriageArgs('--approve issue 123 --extra "focus on auth"'), {
		approve: true,
		target: "issue 123",
		extraInstruction: "focus on auth",
	});
	assert.equal(
		buildKhalaTriageTemplateInvocation({ target: "issue 123", approve: true }),
		"/khala-triage-prompt 'issue 123' approve",
	);
	assert.throws(
		() => buildKhalaTriageTemplateInvocation({ target: `issue '123' "quoted"`, approve: false }),
		/cannot contain both single and double quotes/,
	);

	const commands = new Map();
	const entries = [];
	const messages = [];
	const notifications = [];
	registerKhalaTriage({
		registerCommand(name, command) {
			commands.set(name, command);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		sendUserMessage(message) {
			messages.push(message);
		},
	});
	await commands.get("khala-triage").handler("--approve issue 123", {
		cwd: "/tmp/project",
		hasUI: true,
		ui: {
			notify(message) {
				notifications.push(message);
			},
		},
	});
	assert.equal(commands.has("triage"), true);
	assert.equal(entries[0].type, "khala-work");
	assert.equal(entries[0].data.status, "draft");
	assert.equal(typeof entries[0].data.workId, "string");
	assert.match(messages[0], /issue 123/);
	assert.equal(messages[0], "/khala-triage-prompt 'issue 123' approve");
	assert.deepEqual(notifications, ["Starting Khala triage for issue 123."]);
});

test("Conclave wake chains recover after a rejected wake", async () => {
	const calls = [];
	const runtime = { wakeChain: Promise.reject(new Error("previous wake failed")) };
	await enqueueConclaveWake(runtime, async () => {
		calls.push("first");
		throw new Error("current wake failed");
	}).catch(() => undefined);
	await enqueueConclaveWake(runtime, async () => {
		calls.push("second");
	});
	assert.deepEqual(calls, ["first", "second"]);
});

test("Mandate admission is Conclave-only, idempotent, and preserves the source submission", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-admission-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const storage = createFileConclaveStorage();
		const work = {
			title: "Admission test",
			objective: "Validate durable admission.",
			context: "The required repository context is known.",
			scope: "The temporary test project.",
			acceptanceCriteria: ["A Mandate is recorded."],
			constraints: [],
			plan: ["Read the Archive."],
			validation: ["Assert the projection."],
		};
		storage.submit({ workId: "admission-work", projectPath, work });
		const tools = new Map();
		createExtension(createPiStub(new Map(), tools));
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
		const admitTool = tools.get("khala_admit_work");
		const first = await admitTool.execute("admit", { workId: "admission-work" }, null, null, conclaveContext);
		const second = await admitTool.execute("admit-again", { workId: "admission-work" }, null, null, conclaveContext);
		assert.equal(first.details.mandateId, second.details.mandateId);
		assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "mandate").length, 1);
		assert.equal(storage.getSubmission(projectPath, "admission-work").submission.status, "admitted");
		assert.equal(readMandate(projectPath, first.details.mandateId).terms.objective, work.objective);

		storage.submit({
			workId: "missing-context",
			projectPath,
			work: { ...work, context: "", title: "Missing context" },
		});
		const rejected = await admitTool.execute("missing", { workId: "missing-context" }, null, null, conclaveContext);
		assert.equal(rejected.isError, true);
		assert.match(rejected.details.reason, /Learning/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Mandate, immutable Mission, retry successor, and Finish fences form one lifecycle", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-mission-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
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
				assert.equal(listArchiveRecords(projectPath).filter((record) => record.type === "mission").length, starts === 1 ? 1 : 2);
				assert.match(request.mission, /Mandate:/);
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
					return undefined;
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
					return undefined;
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
				request.onSandboxCreated?.({ path: join(root, "observer-sandbox"), name: "observer-sandbox" }, "test");
				return { id: "observer-session", sandbox: { path: join(root, "observer-sandbox"), name: "observer-sandbox" } };
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
		storage.markSubmissionQueued(projectPath, "observer-work", observer.executionId);
		assert.equal(storage.getSubmission(projectPath, "observer-work").submission.status, "queued");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});
