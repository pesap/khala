import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runConclaveSubagent } from "../dist/src/conclave-subagent.js";
import { InvocationSteering } from "../dist/src/invocation-steering.js";
import {
	createToolOperation,
	finishUserTool,
	processUserToolEffects,
} from "../dist/src/extension-conclave-subagent.js";
import { makeService } from "./helpers/mvp-fixtures.mjs";

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(content, stopReason, tokenUsage) {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fixture",
		model: "conclave-model",
		usage: tokenUsage,
		stopReason,
		timestamp: 1,
	};
}

function responseStream(message) {
	const stream = createAssistantMessageEventStream();
	stream.end(message);
	return stream;
}

function text(value) {
	return { type: "text", text: value };
}

function toolCall(name, argumentsValue) {
	return { type: "toolCall", id: "call-1", name, arguments: argumentsValue };
}

function toolDefinition(name) {
	return { name, description: `${name} description`, parameters: { type: "object", properties: {} } };
}

function makeContext(streams, overrides = {}) {
	const requests = [];
	const calls = [];
	const model = { provider: "fixture", id: "conclave-model" };
	return {
		requests,
		calls,
		context: {
			tools: [toolDefinition("khala_read_archive"), toolDefinition("bash")],
			modelRegistry: {
				find: () => model,
				streamSimple: (_model, request, options) => {
					requests.push({ request, options });
					const stream = streams.shift();
					assert.ok(stream, "each model response should have a deterministic fixture");
					return stream;
				},
			},
			executeTool: async (name, args, options) => {
				calls.push({ name, args, options });
				return {
					toolCall: toolCall(name, args),
					result: { content: [text("bounded Archive evidence")], details: null },
					isError: false,
				};
			},
			...overrides,
		},
	};
}

function request(input, toolContext, onUsage, onProviderUsage = () => {}) {
	const steering = input.steering ?? new InvocationSteering();
	return {
		workId: "work-1",
		runId: "run-1",
		sessionId: "parent-session",
		model: "fixture/conclave-model",
		thinking: "medium",
		systemPrompt: "Conclave system instructions",
		message: "Inspect Work and make an admission decision.",
		tokenAllowance: 100,
		steering,
		signal: new AbortController().signal,
		onUsage,
		onProviderUsage,
		toolContext,
		...input,
	};
}

test("Conclave subagent uses only scoped Khala tools without copying the parent transcript", async () => {
	const first = assistantMessage(
		[text("I will inspect the Archive."), toolCall("khala_read_archive", { workId: "work-1" })],
		"toolUse",
		usage(6, 2, 1),
	);
	const second = assistantMessage([text("Admission is complete.")], "stop", usage(10, 4, 2));
	const fixture = makeContext([responseStream(first), responseStream(second)]);
	const usageUpdates = [];
	const providerUsageUpdates = [];
	const result = await runConclaveSubagent(
		request(
			{},
			fixture.context,
			(value) => usageUpdates.push(value),
			(value) => providerUsageUpdates.push(value),
		),
	);

	assert.equal(result.output, "Admission is complete.");
	assert.deepEqual(result.usage, { inputTokens: 16, outputTokens: 6, cacheHitTokens: 3, cacheMissTokens: 16 });
	assert.deepEqual(fixture.calls.map(({ name }) => name), ["khala_read_archive"]);
	assert.deepEqual(fixture.requests[0].request.messages.map(({ role, content }) => ({ role, content })), [
		{ role: "user", content: "Inspect Work and make an admission decision." },
	]);
	assert.equal(fixture.requests[0].request.systemPrompt, "Conclave system instructions");
	assert.deepEqual(fixture.requests[0].request.tools.map(({ name }) => name), ["khala_read_archive"]);
	assert.deepEqual(fixture.requests[1].request.messages.map(({ role }) => role), ["user", "assistant", "toolResult"]);
	assert.deepEqual(usageUpdates, [
		{ inputTokens: 6, outputTokens: 2, cacheHitTokens: 1, cacheMissTokens: 6 },
		{ inputTokens: 16, outputTokens: 6, cacheHitTokens: 3, cacheMissTokens: 16 },
	]);
	assert.equal(providerUsageUpdates.length, 2);
});

test("nested Conclave provider usage is returned through the active Khala tool operation", async () => {
	const firstUsage = { ...usage(6, 2, 1), cacheWrite1h: 2, reasoning: 1 };
	const secondUsage = { ...usage(10, 4, 2), cacheWrite1h: 3, reasoning: 4 };
	const first = assistantMessage([toolCall("khala_read_archive", { workId: "work-1" })], "toolUse", firstUsage);
	const second = assistantMessage([text("Decision complete.")], "stop", secondUsage);
	const fixture = makeContext([responseStream(first), responseStream(second)]);
	const context = {
		...fixture.context,
		getSystemPrompt: () => "Parent system prompt",
		sessionManager: { getSessionId: () => "parent-session" },
	};
	const application = {
		config: { conclaveMode: "subagent" },
		service: { getRoleSettings: () => ({ conclave: { mode: "subagent" } }) },
		createConclaveCapability: (workId) => ({ roleToken: "signed-token", roleNonce: "scope-nonce", workId }),
	};
	const operation = createToolOperation(
		application,
		{ getFlag: () => undefined },
		"parent-tool-call",
		context,
		undefined,
		undefined,
	);
	const turn = await operation.operation.runConclaveSubagent(
		request({}, context, () => {}),
	);

	assert.equal(turn.output, "Decision complete.");
	assert.deepEqual(operation.usage(), {
		input: 16,
		output: 6,
		cacheRead: 3,
		cacheWrite: 0,
		cacheWrite1h: 5,
		reasoning: 5,
		totalTokens: 25,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("Conclave tool operations follow mode changes made through live role settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-live-conclave-mode-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const processedOperations = [];
	const processPendingEffects = service.processPendingEffects.bind(service);
	service.processPendingEffects = async (operation) => {
		processedOperations.push(operation);
		await processPendingEffects(operation);
	};
	const application = {
		config: { conclaveMode: "headless" },
		service,
		createConclaveCapability: (workId) => ({ roleToken: "signed-token", roleNonce: "scope-nonce", workId }),
	};
	const context = {
		...makeContext([]).context,
		getSystemPrompt: () => "Parent system prompt",
		sessionManager: { getSessionId: () => "parent-session" },
	};
	try {
		const headless = createToolOperation(application, { getFlag: () => undefined }, "parent-call", context, undefined, undefined);
		assert.equal(headless.operation.runConclaveSubagent, undefined);

		service.updateRoleSetting("conclave", "mode", "subagent");
		const subagent = createToolOperation(application, { getFlag: () => undefined }, "next-call", context, undefined, undefined);
		assert.ok(subagent.operation.runConclaveSubagent);
		await processUserToolEffects(application, subagent, "user");
		await finishUserTool(application, subagent, "user");
		assert.deepEqual(processedOperations, [subagent.operation, subagent.operation]);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Conclave subagent does not dispatch tool calls after reaching its token allowance", async () => {
	const response = assistantMessage(
		[toolCall("khala_read_archive", { workId: "work-1" })],
		"toolUse",
		usage(8, 3),
	);
	const fixture = makeContext([responseStream(response)]);
	const result = await runConclaveSubagent(request({ tokenAllowance: 10 }, fixture.context, () => {}));

	assert.equal(result.usage.inputTokens + result.usage.outputTokens, 11);
	assert.equal(fixture.calls.length, 0);
	assert.equal(fixture.requests.length, 1);
});

test("nested Conclave inserts queued guidance only after the current tool batch", async () => {
	const steering = new InvocationSteering();
	const first = assistantMessage([toolCall("khala_read_archive", { workId: "work-1" })], "toolUse", usage(3, 2));
	const second = assistantMessage([text("Decision complete.")], "stop", usage(5, 1));
	let releaseTool;
	let toolStarted;
	const waiting = new Promise((resolve) => { releaseTool = resolve; });
	const started = new Promise((resolve) => { toolStarted = resolve; });
	const fixture = makeContext([responseStream(first), responseStream(second)], {
		executeTool: async () => {
			toolStarted();
			await waiting;
			return { result: { content: [text("Archive evidence")] }, isError: false };
		},
	});
	const turn = runConclaveSubagent(request({ steering }, fixture.context, () => {}));
	await started;
	const receipt = steering.enqueue("Use the public API.");
	assert.equal(receipt.status, "queued");
	assert.equal(fixture.requests.length, 1);
	releaseTool();
	await turn;
	assert.deepEqual(fixture.requests[1].request.messages.map(({ role }) => role), ["user", "assistant", "toolResult", "user"]);
	assert.equal(fixture.requests[1].request.messages.at(-1).content, "Use the public API.");
	assert.equal(steering.snapshot()[0].status, "inserted");
	assert.throws(() => steering.enqueue("too late"), /settled/i);
});

test("guidance queued during a tool-free Conclave response starts the next bounded turn", async () => {
	const steering = new InvocationSteering();
	const first = createAssistantMessageEventStream();
	const second = assistantMessage([text("Guidance considered.")], "stop", usage(3, 1));
	const fixture = makeContext([first, responseStream(second)]);
	const turn = runConclaveSubagent(request({ steering }, fixture.context, () => {}));
	assert.equal(fixture.requests.length, 1);
	steering.enqueue("Consider the public API.");
	first.end(assistantMessage([text("Initial answer.")], "stop", usage(2, 1)));
	assert.equal((await turn).output, "Guidance considered.");
	assert.deepEqual(fixture.requests[1].request.messages.map(({ role }) => role), ["user", "assistant", "user"]);
	assert.equal(fixture.requests[1].request.messages.at(-1).content, "Consider the public API.");
	assert.equal(steering.snapshot()[0].status, "inserted");
});

test("nested Conclave does not use queued guidance after exhausting its reservation", async () => {
	const steering = new InvocationSteering();
	steering.enqueue("Do more work.");
	const response = assistantMessage([text("Done")], "stop", usage(8, 3));
	const fixture = makeContext([responseStream(response)]);
	await runConclaveSubagent(request({ tokenAllowance: 10, steering }, fixture.context, () => {}));
	assert.equal(fixture.requests.length, 1);
	assert.equal(steering.snapshot()[0].status, "not-inserted");
});

test("a failed usage callback retains the just-consumed provider usage", async () => {
	const response = assistantMessage([text("Done")], "stop", usage(8, 3));
	const fixture = makeContext([responseStream(response)]);
	await assert.rejects(
		runConclaveSubagent(request({}, fixture.context, () => { throw new Error("receipt failed"); })),
		(error) => {
			assert.equal(error.message, "receipt failed");
			assert.equal(error.usage.inputTokens, 8);
			assert.equal(error.usage.outputTokens, 3);
			return true;
		},
	);
});

test("cancellation after a tool does not dispatch its siblings or insert queued guidance", async () => {
	const steering = new InvocationSteering();
	const abort = new AbortController();
	const secondCall = { ...toolCall("khala_read_archive", { workId: "work-1" }), id: "call-2" };
	const response = assistantMessage([toolCall("khala_read_archive", {}), secondCall], "toolUse", usage(2, 1));
	let calls = 0;
	const fixture = makeContext([responseStream(response)], {
		executeTool: async () => {
			calls += 1;
			steering.enqueue("Please reconsider.");
			abort.abort(new Error("stopped"));
			return { result: { content: [text("Evidence")] }, isError: false };
		},
	});
	await assert.rejects(runConclaveSubagent(request({ steering, signal: abort.signal }, fixture.context, () => {})), /stopped/);
	assert.equal(calls, 1);
	assert.equal(steering.snapshot()[0].status, "not-inserted");
	assert.equal(fixture.requests.length, 1);
});

test("guidance is not marked inserted when the next provider request cannot start", async () => {
	const steering = new InvocationSteering();
	const first = assistantMessage([toolCall("khala_read_archive", {})], "toolUse", usage(2, 1));
	const fixture = makeContext([responseStream(first)], {
		executeTool: async () => {
			steering.enqueue("Use the public API.");
			return { result: { content: [text("Evidence")] }, isError: false };
		},
	});
	await assert.rejects(runConclaveSubagent(request({ steering }, fixture.context, () => {})), /deterministic fixture/);
	assert.equal(steering.snapshot()[0].status, "not-inserted");
});

test("Conclave fails closed when usage is missing before a tool-bearing continuation", async () => {
	const response = assistantMessage([toolCall("khala_read_archive", {})], "toolUse", undefined);
	const fixture = makeContext([responseStream(response)]);
	await assert.rejects(runConclaveSubagent(request({}, fixture.context, () => {})), /usage/i);
	assert.equal(fixture.calls.length, 0);
	assert.equal(fixture.requests.length, 1);
});

test("Conclave does not complete successfully after cancellation during usage reporting", async () => {
	const controller = new AbortController();
	const response = assistantMessage([text("Done")], "stop", usage(2, 1));
	const fixture = makeContext([responseStream(response)]);
	await assert.rejects(
		runConclaveSubagent(request({ signal: controller.signal }, fixture.context, () => controller.abort(new Error("stopped")))),
		/stopped/,
	);
});

test("Conclave subagent rejects model tool calls outside its allowlist", async () => {
	const response = assistantMessage([toolCall("bash", {})], "toolUse", usage(1, 1));
	const fixture = makeContext([responseStream(response)]);
	await assert.rejects(
		runConclaveSubagent(request({}, fixture.context, () => {})),
		/Conclave requested an unavailable tool: bash/,
	);
	assert.equal(fixture.calls.length, 0);
});
