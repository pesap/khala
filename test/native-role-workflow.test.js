import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createApplication } from "../dist/src/factory.js";

const packageRoot = new URL("..", import.meta.url).pathname;

async function readRequest(request) {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body);
}

function streamResponse(response, call, text = "Decision recorded.") {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = call === undefined
		? { role: "assistant", content: text }
		: { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] };
	const chunk = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "conclave" };
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
	response.end("data: [DONE]\n\n");
}

test("native Conclave reads its Archive and records a signed decision across a supervisor restart", { timeout: 30_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-native-workflow-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDirectory = join(directory, "agent");
	const projectDirectory = join(directory, "project");
	await mkdir(agentDirectory);
	await mkdir(projectDirectory);
	const requests = [];
	const toolResults = [];
	const failures = [];
	const server = createServer(async (request, response) => {
		try {
			const input = await readRequest(request);
			requests.push(input);
			const last = input.messages.at(-1);
			if (last.role !== "tool") {
				streamResponse(response, { id: "archive-read", name: "khala_read_archive", input: { workId: "native-work" } });
				return;
			}
			toolResults.push(last);
			assert.doesNotMatch(last.content, /^Error:/);
			if (last.tool_call_id === "archive-read") {
				const packet = JSON.parse(last.content.slice(last.content.indexOf("\n") + 1));
				const work = packet.work;
				assert.equal(work.workId, "native-work");
				streamResponse(response, { id: `request-input-${work.revision}`, name: "khala_perform_action", input: {
					action: "request-input", workId: work.workId, expectedWorkRevision: work.revision,
					input: { reason: "Specify the expected greeting.", missing: ["Expected greeting"] },
				} });
				return;
			}
			assert.match(last.content, /State: needs-input/);
			streamResponse(response);
		} catch (error) {
			failures.push(error);
			response.writeHead(500);
			response.end(String(error));
		}
	});
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const modelsPath = join(agentDirectory, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "conclave", reasoning: false, contextWindow: 100_000, maxTokens: 1000 }],
	} } }));
	await writeFile(join(agentDirectory, "khala.json"), JSON.stringify({
		archiveRoot: join(directory, "archive"), worktreeRoot: join(directory, "worktrees"),
		piCommand: [join(packageRoot, "node_modules", ".bin", "pi"), "--offline"],
		conclaveModel: "fixture/conclave", conclaveThinking: "off",
		executorModel: "fixture/conclave", executorThinking: "off",
		oracleModel: "fixture/conclave", oracleThinking: "off",
		observerModel: "fixture/conclave", observerThinking: "off",
	}));
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	let application;
	try {
		const modelRuntime = await ModelRuntime.create({ modelsPath, authPath: join(agentDirectory, "auth.json"), allowModelNetwork: false });
		const modelRegistry = new ModelRegistry(modelRuntime);
		application = createApplication(projectDirectory, true, packageRoot, { modelRegistry });
		application.service.submitWork({ workId: "native-work", title: "Greeting", objective: "Write a greeting", acceptanceCriteria: ["Greeting matches the User's expected text"] }, {
			actor: "user", commandId: "native-submit", expectedWorkRevision: 0, schemaVersion: 1,
		});
		await application.service.processPendingEffects();
		assert.deepEqual(failures, []);
		assert.equal(application.service.inspectWork("native-work").state, "needs-input");
		assert.equal(application.service.inspectWork("native-work").budget.consumedTokens, 45);
		const decisions = application.service.readRecords({ workId: "native-work", kinds: ["error"] }, { actor: "user", commandId: "inspect-native-decision", expectedWorkRevision: 0, schemaVersion: 1 });
		assert.ok(decisions.items.some((record) => record.actor === "conclave" && record.payload.reason === "Specify the expected greeting."));
		assert.equal(toolResults.length, 2);
		assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), ["khala_inspect_runtime", "khala_perform_action", "khala_read_archive", "khala_run_oracle"]);
		assert.match(JSON.stringify(requests[0].messages), /Conclave/);
		await application.service.close();
		application = createApplication(projectDirectory, true, packageRoot, { modelRegistry });
		const current = application.service.inspectWork("native-work");
		await application.service.recoverWork(current.workId, { actor: "user", commandId: "native-recover", expectedWorkRevision: current.revision, schemaVersion: 1 });
		await application.service.processPendingEffects();
		assert.equal(application.service.inspectWork(current.workId).state, "needs-input");
		assert.equal(application.service.inspectWork(current.workId).budget.consumedTokens, 45);
		assert.equal(requests.length, 3, "recovery must not repeat the completed Conclave decision");
	} finally {
		await application?.service.close();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	}
});
