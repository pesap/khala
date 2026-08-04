import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, initTheme } from "@earendil-works/pi-coding-agent";
import createExtension from "../dist/src/index.js";
import { runKhalaDemo } from "../dist/src/khala-demo.js";
import { appendArchiveRecord, getArchivePath, listArchiveRecords } from "../dist/src/khala-archive.js";
import { createFileConclaveStorage } from "../dist/src/khala-conclave-storage-file.js";
import { readMandate } from "../dist/src/khala-archive-projections.js";
import { createConclaveCoordinator, enqueueConclaveWake } from "../dist/src/khala-conclave.js";
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
import { createSessionSource } from "../dist/src/khala-sessions.js";
import { listSignals, readSignal } from "../dist/src/khala-signal.js";
import { isSignal } from "../dist/src/khala-model.js";
import { buildOracleArguments, buildOracleCommand, registerKhalaOracle } from "../dist/src/khala-oracle.js";
import { registerKhalaWork } from "../dist/src/khala-work.js";
import { buildKhalaTriageTemplateInvocation, parseKhalaTriageArgs, registerKhalaTriage } from "../dist/src/khala-triage.js";

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

function validWork(overrides = {}) {
	return {
		title: "Test Work",
		objective: "Exercise the requested Khala behavior.",
		context: "The Work has enough context for Conclave review.",
		scope: "The current project.",
		acceptanceCriteria: ["The observable behavior is preserved."],
		constraints: [],
		plan: ["Exercise the behavior."],
		validation: ["Inspect the result."],
		...overrides,
	};
}

function appendWake(projectPath, workId, status, evidence = {}) {
	createFileConclaveStorage().submit({ workId, projectPath, work: validWork() });
	appendArchiveRecord(projectPath, {
		schemaVersion: 2,
		type: "conclave-wake",
		workId,
		payload: {
			wakeId: `${workId}-${status}-${evidence.recovery ?? "complete"}`,
			workId,
			status,
			attemptedAt: new Date().toISOString(),
			...evidence,
		},
	});
}

function startRoleSession(root, role, activeTools) {
	const tools = new Map();
	const events = new Map();
	const pi = createPiStub(new Map(), tools, new Map(), { events, activeTools });
	createExtension(pi);
	let branch = [];
	if (role === "conclave") branch = [{ type: "custom", customType: "khala-conclave", data: {} }];
	else if (role === "executor") branch = [{ type: "custom", customType: "khala-executor", data: {} }];
	else if (role === "observer") branch = [{ type: "custom", customType: "khala-observer", data: {} }];
	else if (role === "preserver") branch = [{ type: "custom", customType: "khala-role", data: { role } }];
	events.get("session_start")({}, {
		cwd: join(root, role),
		mode: "tui",
		isIdle: () => true,
		isProjectTrusted: () => false,
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
		},
		ui: { theme: { fg: (_color, text) => text }, setStatus() {} },
	});
	return { pi, tools };
}

test("package manifest declares source extensions and exposes Khala commands", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.scripts.prepare, undefined);
	assert.equal(manifest.dependencies.jiti, "2.7.0");
	assert.equal(manifest.dependencies.typescript, undefined);
	assert.equal(manifest.devDependencies.typescript, "5.9.3");
	assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], "0.83.0");
	assert.equal(manifest.dependencies["@earendil-works/pi-tui"], "0.83.0");
	assert.equal(manifest.dependencies.typebox, "1.1.38");
	assert.deepEqual(manifest.pi.extensions, [
		"./src/index.ts",
		"./extensions/pi-review/review.ts",
	]);
	assert.deepEqual(manifest.pi.prompts, ["./prompts"]);
	assert.deepEqual(manifest.pi.skills, ["./skills/khala", "./skills/khala-executor", "./skills/herdr"]);
	for (const extensionPath of manifest.pi.extensions) {
		assert.ok(readFileSync(new URL(`../${extensionPath}`, import.meta.url)).length > 0);
	}
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.match(readme, /npx --yes --silent github:pesap\/khala setup/);
	assert.doesNotMatch(readme, /Rerun setup with `khala setup`/);
	const pullRequestTemplate = readFileSync(new URL("../templates/pull-request.md", import.meta.url), "utf8");
	assert.equal(pullRequestTemplate.includes("<!-- Work: <!--"), false);
	assert.doesNotMatch(pullRequestTemplate.replaceAll(/<!--.*?-->/gs, ""), /Closes\s*$/m);
	for (const skillName of ["khala", "khala-executor", "herdr"]) {
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

test("sessions expose only role-authorized Khala tools and schemas", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-role-tools-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const expectedByRole = new Map([
		[
			"user",
			["khala_oracle", "khala_read_archive", "khala_record_pull_request_review", "khala_submit_work"],
		],
		[
			"conclave",
			[
				"khala_admit_work",
				"khala_coordinate_work",
				"khala_launch_execution",
				"khala_launch_observer",
				"khala_read_archive",
				"khala_record_intervention_outcome",
				"khala_record_work_outcome",
				"khala_steer_execution",
				"khala_verdict",
			],
		],
		["executor", ["khala_read_archive", "khala_signal"]],
		["observer", ["khala_read_archive", "khala_record_learning"]],
		["preserver", ["khala_counsel", "khala_read_archive"]],
	]);
	try {
		for (const [role, expected] of expectedByRole) {
			const { pi, tools } = startRoleSession(root, role);
			assert.deepEqual(
				pi.getActiveTools().filter((name) => name.startsWith("khala_")).sort(),
				expected,
				`${role} tool inventory`,
			);
			const archiveSchema = tools.get("khala_read_archive").parameters;
			if (role === "user") {
				assert.ok(archiveSchema.required.includes("workId"));
			} else if (role === "conclave") {
				assert.equal(archiveSchema.required?.includes("workId") ?? false, false);
			}
		}
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("role activation preserves explicit Pi tool exclusions", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-role-tool-exclusions-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const { pi } = startRoleSession(root, "executor", ["read", "khala_read_archive"]);
		assert.deepEqual(pi.getActiveTools(), ["read", "khala_read_archive"]);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conclave recreation reports setup before scheduling recovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-recreate-config-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const commands = new Map();
		const notifications = [];
		createExtension(createPiStub(commands));
		await commands.get("khala-recreate").handler("", {
			cwd: join(root, "project"),
			isProjectTrusted: () => false,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
			},
		});
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /npx --yes --silent github:pesap\/khala setup/);
		assert.doesNotMatch(notifications[0].message, /pending Work recovery was scheduled/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("an idle direct User turn receives persisted override provenance for every active Execution", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-direct-user-test-"));
	const projectPath = join(root, "project");
	const events = new Map();
	const branch = [
		{ id: "role", type: "custom", customType: "khala-role", data: { role: "conclave" } },
		{ id: "conclave", type: "custom", customType: "khala-conclave", data: { projectPath } },
	];
	let entryOrdinal = 0;
	try {
		writeExecutorRecord(
			createExecutorRecord(
				{
					executionId: "direct-execution",
					workId: "direct-work",
					executorName: "Direct Executor",
					kind: "executor",
					participantId: "direct-participant",
					purpose: { kind: "mission", missionId: "direct-mission" },
					missionId: "direct-mission",
					projectPath,
					sandboxPath: join(root, "sandbox"),
					launcher: "headless-rpc",
					piSessionId: "direct-executor-session",
					sessionPath: join(root, "executor.jsonl"),
					promptIdentity: { packageVersion: "test", promptSha256: "a".repeat(64) },
				},
				"running",
			),
		);
		const pi = createPiStub(new Map(), new Map(), new Map(), {
			events,
			appendEntry(customType, data) {
				entryOrdinal += 1;
				branch.push({ id: `custom-${entryOrdinal}`, type: "custom", customType, data });
			},
		});
		createExtension(pi);
		const sessionManager = {
			getBranch: () => branch,
			getEntries: () => branch,
			getEntry: (id) => branch.find((entry) => entry.id === id),
			getSessionId: () => "direct-conclave-session",
			getSessionFile: () => join(root, "conclave.jsonl"),
		};
		const context = { cwd: projectPath, sessionManager };
		const userMessage = { role: "user", content: "Prioritize direct-work over its peer conflict." };
		events.get("input")({ source: "interactive", text: userMessage.content }, context);
		branch.push({ id: "direct-user-entry", type: "message", message: userMessage });
		events.get("message_end")({ message: userMessage }, context);

		const assessment = branch.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "khala-supervision-assessment-start" &&
				entry.data.sourceKind === "direct-user",
		);
		assert.ok(assessment);
		const marker = branch.find(
			(entry) => entry.type === "custom" && entry.customType === "khala-conclave-direct-user-entry",
		);
		assert.equal(marker.data.entryId, "direct-user-entry");
		assert.equal(marker.data.assessmentId, assessment.data.assessmentId);
		const transformed = events.get("context")({ messages: [userMessage] }, context);
		assert.match(transformed.messages.at(-1).content, /coordinate-override actionId=/);
		assert.match(transformed.messages.at(-1).content, /userEntryId=direct-user-entry/);

		events.get("agent_settled")({}, context);
		assert.ok(
			branch.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "khala-supervision-assessment-complete" &&
					entry.data.assessmentId === assessment.data.assessmentId,
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("launched Executor status uses the Executor name after marker registration", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-status-test-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	const branch = [];
	const events = new Map();
	const statuses = [];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const startupMarker = join(root, "observer-startup");
	process.env.KHALA_STARTUP_MARKER = startupMarker;
	try {
		const flags = new Map([
			["khala-work-id", "status-work"],
			["khala-execution-id", "status-execution"],
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
		assert.equal(readFileSync(startupMarker, "utf8"), "ready");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.KHALA_STARTUP_MARKER;
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
	const oracleArguments = buildOracleArguments("packet", "test-model", "xhigh");
	assert.deepEqual(oracleArguments.slice(oracleArguments.indexOf("--model"), oracleArguments.indexOf("--model") + 4), [
		"--model",
		"test-model",
		"--thinking",
		"xhigh",
	]);
	assert.equal(buildOracleArguments("packet", "test-model", "").includes("--thinking"), false);
	const oracleCommand = buildOracleCommand(
		[
			"/custom/pi",
			"--offline",
			"--verbose",
			"--api-key",
			"configured-key",
			"--extension",
			"/unsafe/extension.ts",
			"--continue",
			"--model",
			"old-model",
			"--thinking",
			"low",
			"--",
			"--api-key=positional-key",
		],
		"packet",
		"test-model",
		"high",
	);
	assert.deepEqual(oracleCommand.slice(0, 5), [
		"/custom/pi",
		"--offline",
		"--verbose",
		"--api-key",
		"configured-key",
	]);
	assert.equal(oracleCommand.includes("--extension"), false);
	assert.equal(oracleCommand.includes("--continue"), false);
	assert.equal(oracleCommand.includes("old-model"), false);
	assert.equal(oracleCommand.includes("--api-key=positional-key"), false);
	assert.deepEqual(oracleCommand.slice(oracleCommand.indexOf("--model"), oracleCommand.indexOf("--model") + 4), [
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
		assert.match(result.content[0].text, /Conclave processing completed/);
		assert.doesNotMatch(result.content[0].text, /admission and launch are pending/);
		assert.equal(submitted.projectPath, projectPath);
		assert.equal(submitted.work.context, "The User supplied initial context.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed Conclave wakes are durable without assuming Executor state", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-wake-failure-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"));
	try {
		const result = await coordinator.submit({
			workId: "wake-failure-work",
			projectPath,
			work: validWork({ title: "Wake failure", objective: "Preserve a failed Conclave wake." }),
		});
		assert.equal(result.wakeFailure.recovery, "setup");
		const records = listArchiveRecords(projectPath);
		assert.deepEqual(records.map((record) => record.type), ["submission", "conclave-wake"]);
		assert.deepEqual(
			{
				status: records[1].payload.status,
				recovery: records[1].payload.recovery,
				workId: records[1].payload.workId,
			},
			{ status: "failed", recovery: "setup", workId: "wake-failure-work" },
		);
		assert.match(records[1].payload.failure, /supervision configuration is incomplete/);
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "conclave-wake",
					workId: "wake-failure-work",
					payload: { ...records[1].payload, wakeId: "mismatched-wake", workId: "different-work" },
				}),
			/inconsistent Archive bindings/,
		);
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "conclave-wake",
					workId: "wake-failure-work",
					payload: records[1].payload,
				}),
			/is duplicated/,
		);
		const context = {
			cwd: projectPath,
			isIdle: () => true,
			isProjectTrusted: () => false,
			sessionManager: { getSessionFile: () => undefined },
		};
		const setupSessionSource = createSessionSource(
			context,
			coordinator.getConclaveSessionPath,
			coordinator.getConclaveUserSessionPath,
		);
		const setupConclave = setupSessionSource.getActiveSessions("").find((session) => session.role === "Conclave");
		assert.equal(setupConclave.state, "failed");
		assert.equal(setupConclave.action, "run setup");
		assert.equal(setupConclave.displayOnly, true);
		assert.notEqual(setupConclave.sessionPath, "");
		assert.match(setupConclave.task, /supervision configuration is incomplete/);

		appendWake(projectPath, "later-successful-work", "woken");
		const unresolvedConclave = setupSessionSource
			.getActiveSessions("")
			.find((session) => session.role === "Conclave");
		assert.equal(unresolvedConclave.state, "failed");
		assert.equal(unresolvedConclave.action, "run setup");
		assert.match(unresolvedConclave.task, /supervision configuration is incomplete/);

		appendWake(projectPath, "wake-failure-work", "failed", {
			failure: "The configured Conclave runtime failed.",
			recovery: "recreate",
		});
		const recreateSessionSource = createSessionSource(context, () => undefined, () => undefined);
		const recreateConclave = recreateSessionSource
			.getActiveSessions("")
			.find((session) => session.role === "Conclave");
		assert.equal(recreateConclave.action, "run /khala-recreate");
		assert.equal(recreateConclave.displayOnly, true);
		assert.equal(recreateConclave.sessionPath, "");
	} finally {
		await coordinator.dispose();
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Archive persistence failures remain distinct from Conclave wake failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-wake-evidence-failure-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const fileStorage = createFileConclaveStorage();
	let archivePath = "";
	const storage = {
		...fileStorage,
		submit(request) {
			const queued = fileStorage.submit(request);
			archivePath = queued.archivePath;
			chmodSync(archivePath, 0o444);
			return queued;
		},
	};
	const coordinator = createConclaveCoordinator(join(process.cwd(), "dist", "src", "index.js"), storage);
	try {
		const result = await coordinator.submit({
			workId: "wake-evidence-failure-work",
			projectPath,
			work: validWork({ title: "Wake evidence failure" }),
		});
		assert.equal(result.wakeFailure.recovery, "setup");
		assert.match(result.wakeFailure.message, /wake failed.*Archive evidence could not be persisted/s);
	} finally {
		await coordinator.dispose();
		if (archivePath.length > 0) {
			chmodSync(archivePath, 0o600);
		}
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Work wake diagnostics preserve recovery without assuming Executor state", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-work-wake-error-"));
	const tools = new Map();
	const entries = [];
	let wakeFailure;
	registerKhalaWork(
		createPiStub(new Map(), tools, new Map(), {
			appendEntry: (type, data) => entries.push({ type, data }),
		}),
		{
			workTemplate: "",
			executorSystemPrompt: "",
			createExecutorStarter: () => {
				throw new Error("not used");
			},
			isDedicatedConclaveSession: () => false,
			submitWork: async () => ({ archivePath: join(root, "archive.jsonl"), wakeFailure }),
			getSubmission: () => undefined,
			getPendingSubmission: () => undefined,
			claimSubmission: () => false,
			markSubmissionQueued: () => {},
			markSubmissionLaunched: () => {},
		},
	);
	const context = { cwd: root, sessionManager: { getEntries: () => [], getBranch: () => [] } };
	const scenarios = [
		{
			recovery: "setup",
			message: "Khala supervision configuration is incomplete or invalid.",
			recoveryPattern: /npx --yes --silent github:pesap\/khala setup/,
		},
		{
			recovery: "recreate",
			message: "The Conclave wake completed, but its Archive evidence could not be persisted.",
			recoveryPattern: /\/khala-recreate/,
		},
	];
	try {
		for (const scenario of scenarios) {
			wakeFailure = { message: scenario.message, recovery: scenario.recovery };
			await assert.rejects(
				() => tools.get("khala_submit_work").execute("submit", validWork(), null, null, context),
				(error) => {
					assert.match(error.message, /durable Conclave wake completion could not be confirmed/);
					assert.match(error.message, /Executor state is unknown/);
					assert.match(error.message, scenario.recoveryPattern);
					assert.ok(error.message.includes(scenario.message));
					assert.doesNotMatch(error.message, /No Executor was launched/);
					return true;
				},
			);
			assert.equal(entries.at(-1).data.status, "queued");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
		assert.doesNotMatch(signalResult.content[0].text, /Review evidence update failed/);
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
