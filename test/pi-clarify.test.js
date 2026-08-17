import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import test from "node:test";
import clarifyExtension, { applyClarifyOutcome, extractClarifyText, USAGE } from "../dist/extensions/pi-clarify/clarify.js";

function response(overrides = {}) {
	return {
		content: [],
		stopReason: "stop",
		...overrides,
	};
}

function registerClarifyProvider(message) {
	const id = `clarify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const sourceId = `${id}-source`;
	const model = {
		id: "rewrite-model",
		name: "Rewrite model",
		api: id,
		provider: id,
		baseUrl: "http://localhost:0",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 512,
	};

	let requestedModel;
	registerApiProvider(
		{
			api: id,
			stream() {
				throw new Error("Clarify used the reasoning-enabled stream");
			},
			streamSimple(streamModel) {
				requestedModel = streamModel;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.end(message));
				return stream;
			},
		},
		sourceId,
	);

	return {
		model,
		getRequestedModel() {
			return requestedModel;
		},
		cleanup() {
			unregisterApiProviders(sourceId);
		},
	};
}

test("clarify uses simple completion and puts the rewrite in the editor", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-clarify-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const provider = registerClarifyProvider({
		role: "assistant",
		content: [{ type: "text", text: "Use a debounce for the search input." }],
		api: "clarify-test",
		provider: "clarify-test",
		model: "rewrite-model",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			conclaveModel: `${provider.model.provider}/${provider.model.id}`,
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 1,
		}),
	);
	const commands = new Map();
	const notices = [];
	let editorText = "";

	try {
		clarifyExtension({
			registerCommand(name, command) {
				commands.set(name, command);
			},
			on() {},
		});
		const command = commands.get("clarify");
		await command.handler("make search wait until typing stops", {
			cwd: agentDir,
			isProjectTrusted: () => false,
			hasUI: true,
			mode: "rpc",
			model: { ...provider.model, id: "session-model", provider: "session", api: "session" },
			modelRegistry: {
				find: () => provider.model,
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key" };
				},
			},
			ui: {
				setEditorText(text) {
					editorText = text;
				},
				notify(message, type) {
					notices.push({ message, type });
				},
			},
		});

		assert.equal(editorText, "Use a debounce for the search input.");
		assert.equal(provider.getRequestedModel()?.id, provider.model.id);
		assert.deepEqual(notices, [{ message: "Rewrite ready. Edit if needed, then send.", type: "info" }]);
	} finally {
		provider.cleanup();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("clarify keeps returned text and joins multiple text blocks", () => {
	assert.equal(
		extractClarifyText(
			response({
				content: [
					{ type: "thinking", thinking: "Choose the concise term." },
					{ type: "text", text: "Use a debounce." },
					{ type: "text", text: "Preserve the acceptance criteria." },
				],
			}),
		),
		"Use a debounce.\nPreserve the acceptance criteria.",
	);
});

test("clarify exposes provider errors instead of reporting an empty response", () => {
	assert.throws(
		() =>
			extractClarifyText(
				response({
					content: [{ type: "text", text: "partial output" }],
					stopReason: "error",
					errorMessage: "The provider rejected the request.",
				}),
			),
		/Clarify model failed: The provider rejected the request\./,
	);
});

test("clarify explains when a model returns only non-text blocks", () => {
	assert.throws(
		() =>
			extractClarifyText(
				response({
					content: [{ type: "thinking", thinking: "The model used its reasoning channel." }],
				}),
			),
		/Clarify returned no text \(stop reason: stop; content blocks: thinking\)/,
	);
});

function uiStub(notices) {
	return {
		hasUI: true,
		mode: "rpc",
		modelRegistry: {},
		cwd: "/tmp",
		isProjectTrusted: () => false,
		ui: {
			notify(message, type) {
				notices.push({ message, type });
			},
		},
	};
}

test("clarify maps cancellation and invalid input through the outcome boundary", () => {
	const cancelledNotices = [];
	applyClarifyOutcome({ result: "cancelled" }, uiStub(cancelledNotices));
	assert.deepEqual(cancelledNotices, [{ message: "Cancelled", type: "info" }]);

	const invalidNotices = [];
	applyClarifyOutcome({ result: "invalid", reason: USAGE }, uiStub(invalidNotices));
	assert.deepEqual(invalidNotices, [{ message: USAGE, type: "warning" }]);

	const unavailableNotices = [];
	applyClarifyOutcome({ result: "unavailable", reason: "No model." }, uiStub(unavailableNotices));
	assert.deepEqual(unavailableNotices, [{ message: "No model.", type: "error" }]);

	const failureNotices = [];
	applyClarifyOutcome({ result: "failure", reason: "Boom." }, uiStub(failureNotices));
	assert.deepEqual(failureNotices, [{ message: "Boom.", type: "error" }]);
});

test("clarify reports an unavailable configured model through the handler", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-clarify-unavailable-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			conclaveModel: "provider/executor",
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 1,
		}),
	);
	const commands = new Map();
	const notices = [];
	try {
		clarifyExtension({
			registerCommand(name, command) {
				commands.set(name, command);
			},
			on() {},
		});
		await commands.get("clarify").handler("make search wait", {
			cwd: agentDir,
			isProjectTrusted: () => false,
			hasUI: true,
			mode: "rpc",
			modelRegistry: {
				find() {
					return undefined;
				},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key" };
				},
			},
			ui: {
				notify(message, type) {
					notices.push({ message, type });
				},
			},
		});
		assert.deepEqual(notices, [
			{ message: "Configured Conclave model is unavailable: provider/executor", type: "error" },
		]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("clarify reports provider failures through the handler", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-clarify-failure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const provider = registerClarifyProvider({
		role: "assistant",
		content: [{ type: "text", text: "partial output" }],
		api: "clarify-test",
		provider: "clarify-test",
		model: "rewrite-model",
		usage: {},
		stopReason: "error",
		errorMessage: "The provider rejected the request.",
		timestamp: Date.now(),
	});
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			conclaveModel: `${provider.model.provider}/${provider.model.id}`,
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 1,
		}),
	);
	const commands = new Map();
	const notices = [];
	try {
		clarifyExtension({
			registerCommand(name, command) {
				commands.set(name, command);
			},
			on() {},
		});
		await commands.get("clarify").handler("make search wait", {
			cwd: agentDir,
			isProjectTrusted: () => false,
			hasUI: true,
			mode: "rpc",
			modelRegistry: {
				find: () => provider.model,
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key" };
				},
			},
			ui: {
				notify(message, type) {
					notices.push({ message, type });
				},
			},
		});
		assert.deepEqual(notices, [
			{ message: "Clarify model failed: The provider rejected the request.", type: "error" },
		]);
	} finally {
		provider.cleanup();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("clarify warns on empty input through the handler", async () => {
	const commands = new Map();
	const notices = [];
	clarifyExtension({
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on() {},
	});
	await commands.get("clarify").handler("", {
		cwd: "/tmp",
		isProjectTrusted: () => false,
		hasUI: true,
		mode: "rpc",
		modelRegistry: {},
		ui: {
			notify(message, type) {
				notices.push({ message, type });
			},
		},
	});
	assert.deepEqual(notices, [{ message: USAGE, type: "warning" }]);
});

initTheme();

test("a ready rewrite whose text starts with 'error:' stays ready through the TUI loader", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-clarify-loader-ready-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const provider = registerClarifyProvider({
		role: "assistant",
		content: [{ type: "text", text: "error: documented limitation" }],
		api: "clarify-test",
		provider: "clarify-test",
		model: "rewrite-model",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			conclaveModel: `${provider.model.provider}/${provider.model.id}`,
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 1,
		}),
	);
	const commands = new Map();
	const notices = [];
	let editorText = "";
	try {
		clarifyExtension({
			registerCommand(name, command) {
				commands.set(name, command);
			},
			on() {},
		});
		await commands.get("clarify").handler("make search wait", {
			cwd: agentDir,
			isProjectTrusted: () => false,
			hasUI: true,
			mode: "tui",
			modelRegistry: {
				find: () => provider.model,
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key" };
				},
			},
			ui: {
				setEditorText(text) {
					editorText = text;
				},
				notify(message, type) {
					notices.push({ message, type });
				},
				custom(factory) {
					const tui = { requestRender() {} };
					const theme = { fg: (_color, text) => text };
					let settle;
					const pending = new Promise((resolve) => {
						settle = resolve;
					});
					const loader = factory(tui, theme, {}, (outcome) => settle(outcome));
					// Stop the spinner timer so the test process can exit.
					if (typeof loader.dispose === "function") {
						loader.dispose();
					}
					return pending;
				},
			},
		});
		assert.equal(editorText, "error: documented limitation");
		assert.deepEqual(notices, [{ message: "Rewrite ready. Edit if needed, then send.", type: "info" }]);
	} finally {
		provider.cleanup();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
