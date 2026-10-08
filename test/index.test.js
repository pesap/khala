import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createApplication } from "../dist/src/factory.js";

const theme = { fg: (_color, text) => text };

test("user sessions show a branded Executor status in the footer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-footer-status-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "khala.json"), JSON.stringify({ archiveRoot: join(directory, "archive") }));
		const { default: khalaExtension, summarizeToolError } = await import("../dist/src/index.js");
		initTheme();
		assert.equal(
			summarizeToolError({
				summary: "Runtime failed; the child exited.",
				remediation: "Inspect Evidence; do not restart the primary Pi session.",
				evidenceRefs: [],
			}),
			"Error: Runtime failed. The child exited.\nNext step: Inspect Evidence. Do not restart the primary Pi session.",
		);
		const handlers = new Map();
		const statuses = [];
		const notices = [];
		const tools = new Map();
		const activeTools = ["read", "write", "edit", "grep", "find", "ls", "bash", "khala_read_archive", "khala_perform_action", "khala_record_signal", "khala_record_assessment", "khala_run_oracle", "khala_inspect_runtime", "khala_submit_work", "khala_poll_provider"];
		const pi = {
			registerFlag() {},
			registerTool: (tool) => tools.set(tool.name, tool),
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			getFlag() {
				return undefined;
			},
			getActiveTools() {
				return [...activeTools];
			},
			setActiveTools(names) {
				activeTools.splice(0, activeTools.length, ...names);
			},
		};
		khalaExtension(pi);
		assert.equal(await handlers.get("before_agent_start")({ systemPrompt: "base" }), undefined);
		const context = {
			cwd: directory,
			isProjectTrusted: () => false,
			ui: {
				theme,
				setStatus: (key, text) => statuses.push({ key, text }),
				notify: (message) => notices.push(message),
			},
		};
		const initialTools = [...activeTools];
		await handlers.get("session_start")({}, context);
		assert.deepEqual(activeTools, initialTools);
		assert.deepEqual(notices, []);
		assert.deepEqual(statuses.at(-1), { key: "khala-executors", text: "khala: idle" });
		const archiveTool = tools.get("khala_read_archive");
		const archiveResult = await archiveTool.execute("unknown-work", { workId: "unknown-work" }, new AbortController().signal, undefined, context);
		assert.deepEqual(archiveResult.details.items, []);
		const collapsed = archiveTool.renderResult(archiveResult, { expanded: false, isPartial: false }, theme, {});
		assert.match(collapsed.render(120).join("\n"), /0 recent summaries through sequence 0/);
		const expanded = archiveTool.renderResult(archiveResult, { expanded: true, isPartial: false }, theme, {});
		assert.match(expanded.render(120).join("\n"), /Archive records: 0/);
		const populatedResult = {
			content: [{ type: "text", text: "Archive records: 1\n#1 signal: Completed" }],
			details: {
				items: [{ sequence: 1, kind: "signal", summary: "Completed", payload: { secret: "hidden" } }],
				asOfSequence: 1,
			},
		};
		const populatedCollapsed = archiveTool.renderResult(populatedResult, { expanded: false, isPartial: false }, theme, {});
		assert.doesNotMatch(populatedCollapsed.render(120).join("\n"), /Completed/);
		const populatedExpanded = archiveTool.renderResult(populatedResult, { expanded: true, isPartial: false }, theme, {});
		assert.match(populatedExpanded.render(120).join("\n"), /Completed/);
		assert.doesNotMatch(populatedExpanded.render(120).join("\n"), /hidden/);
		await handlers.get("session_shutdown")({});
		assert.deepEqual(statuses.at(-1), { key: "khala-executors", text: undefined });
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Subagent effect processing does not invalidate a fresh runtime inspection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-subagent-inspect-revision-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const workId = "subagent-inspect-revision";
	const parentToolCallId = "inspect-runtime-parent";
	const model = { provider: "fixture", id: "conclave", reasoning: false };
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const responseStream = (content, stopReason) => {
		const stream = createAssistantMessageEventStream();
		stream.end({
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "fixture",
			model: "conclave",
			usage,
			stopReason,
			timestamp: 1,
		});
		return stream;
	};
	let modelTurn = 0;
	const modelRegistry = {
		find: (provider, id) => (provider === "fixture" && id === "conclave" ? model : undefined),
		streamSimple: (_model, request) => {
			modelTurn += 1;
			if (modelTurn === 1)
				return responseStream(
					[{ type: "toolCall", id: "archive-read", name: "khala_read_archive", arguments: { workId } }],
					"toolUse",
				);
			if (modelTurn === 2) {
				const last = request.messages.at(-1);
				assert.equal(last.role, "toolResult");
				const text = last.content.find((block) => block.type === "text").text;
				const packet = JSON.parse(text.slice(text.indexOf("\n") + 1));
				assert.equal(packet.work.workId, workId);
				return responseStream(
					[
						{
							type: "toolCall",
							id: "request-input",
							name: "khala_perform_action",
							arguments: {
								action: "request-input",
								workId,
								expectedWorkRevision: packet.work.revision,
								input: { reason: "Clarify the task." },
							},
						},
					],
					"toolUse",
				);
			}
			return responseStream([{ type: "text", text: "Requested clarification." }], "stop");
		},
	};
	const handlers = new Map();
	const tools = new Map();
	const pi = {
		registerFlag() {},
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand() {},
		on(event, handler) {
			handlers.set(event, handler);
		},
		getFlag() {
			return undefined;
		},
	};
	let application;
	try {
		await writeFile(
			join(directory, "khala.json"),
			JSON.stringify({ archiveRoot: join(directory, "archive"), conclaveModel: "fixture/conclave", conclaveThinking: "off", conclaveMode: "subagent" }),
		);
		const packageRoot = new URL("..", import.meta.url).pathname;
		application = createApplication(directory, false, packageRoot, { requireModels: false, modelRegistry });
		application.service.submitWork(
			{
				workId,
				title: "Inspect runtime with pending wake",
				objective: "Check runtime liveness while Conclave admission is pending",
				acceptanceCriteria: ["Inspection uses the submitted Work revision"],
			},
			{ actor: "user", commandId: "inspection-work:submit", expectedWorkRevision: 0, schemaVersion: 1 },
		);
		await application.service.close();
		application = undefined;

		const { default: khalaExtension } = await import("../dist/src/index.js");
		khalaExtension(pi);
		const nestedToolCallIds = [];
		let nestedToolFailure;
		const context = {
			cwd: directory,
			isProjectTrusted: () => false,
			getSystemPrompt: () => "Parent system prompt",
			sessionManager: { getSessionId: () => "parent-session" },
			modelRegistry,
			tools: ["khala_read_archive", "khala_inspect_runtime", "khala_perform_action", "khala_run_oracle"].map((name) => {
				const tool = tools.get(name);
				return { name, description: tool.description, parameters: tool.parameters };
			}),
			executeTool: async (name, args, options) => {
				const tool = tools.get(name);
				assert.ok(tool, `the nested tool ${name} should be registered`);
				const nestedToolCallId = `${parentToolCallId}/${nestedToolCallIds.length}`;
				nestedToolCallIds.push(nestedToolCallId);
				let result;
				try {
					result = await tool.execute(nestedToolCallId, args, options?.signal, undefined, context);
				} catch (error) {
					nestedToolFailure = error;
					throw error;
				}
				return {
					toolCall: { id: nestedToolCallId, name, arguments: args },
					result,
					isError: false,
				};
			},
		};
		const result = await tools.get("khala_inspect_runtime").execute(
			parentToolCallId,
			{ workId, expectedWorkRevision: 1 },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.deepEqual(nestedToolCallIds, [`${parentToolCallId}/0`, `${parentToolCallId}/1`]);
		assert.equal(nestedToolFailure, undefined, String(nestedToolFailure));
		assert.equal(modelTurn, 3);
		assert.equal(result.details.workId, workId);
		assert.equal(result.details.state, "needs-input");
		assert.equal(result.usage.totalTokens, 6);
	} finally {
		await handlers.get("session_shutdown")?.({});
		if (application !== undefined) await application.service.close();
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});

test("role session starts install only its public tool contract", async () => {
	const { default: khalaExtension } = await import("../dist/src/index.js");
	const expectedExecutorTools = ["read", "write", "edit", "grep", "find", "ls", "khala_read_archive", "khala_perform_action", "khala_record_signal"];
	for (const [role, expected] of [
		["executor", expectedExecutorTools],
		["oracle", []],
	]) {
		const handlers = new Map();
		const activeTools = ["read", "write", "edit", "grep", "find", "ls", "bash", "khala_read_archive", "khala_perform_action", "khala_record_signal", "khala_record_assessment", "khala_run_oracle", "khala_inspect_runtime", "khala_submit_work", "khala_poll_provider"];
		const pi = {
			registerFlag() {},
			registerTool() {},
			registerCommand() {},
			on(event, handler) {
				handlers.set(event, handler);
			},
			getFlag() {
				return role;
			},
			getActiveTools() {
				return [...activeTools];
			},
			setActiveTools(names) {
				activeTools.splice(0, activeTools.length, ...names);
			},
		};
		khalaExtension(pi);
		await handlers.get("session_start")({}, { cwd: process.cwd(), ui: { notify() {} } });
		assert.deepEqual(activeTools, expected);
		if (role === "executor") {
			assert.equal(handlers.get("tool_call")({ toolName: "bash", input: {} }).block, true);
		}
	}
});
function restoreEnvironmentVariable(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function assertSandboxPathScope(root) {
	const { default: khalaExtension } = await import("../dist/src/index.js");
	const handlers = new Map();
	const pi = {
		registerFlag() {},
		registerTool() {},
		registerCommand() {},
		on(event, handler) {
			handlers.set(event, handler);
		},
		getFlag() {
			return "executor";
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
	};
	khalaExtension(pi);
	const handler = handlers.get("tool_call");
	assert.equal(handler({ toolName: "write", input: {} }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: join(root, "linked", "secret.txt") } }).block, true);
	assert.equal(handler({ toolName: "read", input: { path: join(root, "linked", "secret.txt") } }).block, true);
	assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } }), undefined);
	delete process.env.KHALA_SANDBOX_ROOT;
	assert.equal(handler({ toolName: "write", input: { path: join(root, "inside.txt") } }).block, true);
	process.env.KHALA_SANDBOX_ROOT = root;
}

async function cleanupSandboxPathScope(root, outside, previousRoot, previousPaths) {
	restoreEnvironmentVariable("KHALA_SANDBOX_ROOT", previousRoot);
	restoreEnvironmentVariable("KHALA_ALLOWED_PATHS", previousPaths);
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
}

test("Executor write checks resolve symlinks before enforcing sandbox paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-path-scope-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-path-outside-"));
	await symlink(outside, join(root, "linked"));
	const previousRoot = process.env.KHALA_SANDBOX_ROOT;
	const previousPaths = process.env.KHALA_ALLOWED_PATHS;
	process.env.KHALA_SANDBOX_ROOT = root;
	process.env.KHALA_ALLOWED_PATHS = JSON.stringify(["."]);
	try {
		await assertSandboxPathScope(root);
	} finally {
		await cleanupSandboxPathScope(root, outside, previousRoot, previousPaths);
	}
});
