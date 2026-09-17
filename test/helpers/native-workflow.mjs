import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const packageRoot = new URL("../..", import.meta.url).pathname;
export const nativeSubmission = { workId: "native-execution", title: "Native greeting", objective: "Create greeting.txt containing hello", scope: "Create only greeting.txt.", acceptanceCriteria: ["greeting.txt contains hello"], allowedPaths: ["greeting.txt"], validation: ['test "$(cat greeting.txt)" = hello'] };

export function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function requestBody(request) {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body);
}

function archivePacket(input) {
	const tool = [...input.messages].reverse().find((message) => message.role === "tool");
	if (tool === undefined || !tool.content.includes("{")) return undefined;
	try {
		return JSON.parse(tool.content.slice(tool.content.indexOf("{")));
	} catch {
		return undefined;
	}
}

function toolCall(response, id, name, input) {
	const chunk = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "native" };
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
	response.end("data: [DONE]\n\n");
}

function finish(response, content = "Recorded.") {
	const chunk = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "native" };
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
	response.end("data: [DONE]\n\n");
}

function executorCall(step, work, greeting, idle) {
	if (idle === true) return undefined;
	const read = () => ["khala_read_archive", { workId: "native-execution" }];
	const action = (name) => ["khala_perform_action", { action: name, workId: work.workId, expectedWorkRevision: work.revision }];
	const calls = [read, () => ["write", { path: "greeting.txt", content: greeting ?? "hello\n" }], read, () => action("commit-sandbox"), read, () => action("run-validation"), read, () => action("create-review-request"), read, () => ["khala_perform_action", { ...action("record-signal")[1], input: { kind: "ready", summary: "Native edit committed, validated, and published.", evidence: ["greeting.txt", "validation passed", "draft review 42"] } }]];
	return calls[step]?.();
}

function feedbackExecutorCall(step, work, options) {
	if (step <= 10) return executorCall(step, work, options.greeting, options.idleExecutor);
	const read = () => ["khala_read_archive", { workId: "native-execution" }];
	const action = (name) => ["khala_perform_action", { action: name, workId: work.workId, expectedWorkRevision: work.revision }];
	const calls = new Map([
		[11, read],
		[12, () => ["write", { path: "greeting.txt", content: options.feedbackGreeting ?? "hello\n" }]],
		[13, read],
		[14, () => action("commit-sandbox")],
		[15, read],
		[16, () => action("run-validation")],
		[17, read],
		[18, () => action("create-review-request")],
		[19, read],
		[20, () => ["khala_perform_action", { ...action("record-signal")[1], input: { kind: "ready", summary: "Authorized provider feedback was corrected, validated, and republished.", evidence: ["greeting.txt", "validation passed", "updated review 42"] } }]],
	]);
	return calls.get(step)?.();
}

function conclaveCall(step, work, oracleResponse) {
	const read = () => ["khala_read_archive", { workId: "native-execution" }];
	const action = (name) => ["khala_perform_action", { action: name, workId: work.workId, expectedWorkRevision: work.revision }];
	const review = oracleResponse === undefined
		? [[6, () => ["khala_perform_action", { ...action("verdict")[1], input: { decision: "handoff", reason: "Native evidence is complete.", signalId: work.signal.signalId } }]], [8, read], [9, () => action("record-outcome")]]
		: [[6, () => ["khala_run_oracle", { workId: work.workId, subject: "Review the bounded native greeting handoff.", expectedWorkRevision: work.revision }]], [8, read], [9, () => ["khala_perform_action", { ...action("verdict")[1], input: { decision: "handoff", reason: "The Oracle advisory and native evidence support handoff.", signalId: work.signal.signalId } }]]];
	const calls = new Map([[0, read], [1, () => action("admit")], [2, read], [3, () => action("start-execution")], [5, read], ...review]);
	return calls.get(step)?.();
}

function feedbackConclaveCall(step, work) {
	if (step < 8) return conclaveCall(step, work);
	const read = () => ["khala_read_archive", { workId: "native-execution" }];
	const action = (name) => ["khala_perform_action", { action: name, workId: work.workId, expectedWorkRevision: work.revision }];
	const calls = new Map([
		[8, read],
		[9, () => ["khala_perform_action", { ...action("deliver-feedback")[1], input: { observationId: work.provider.observationId } }]],
		[11, read],
		[12, () => ["khala_perform_action", { ...action("verdict")[1], input: { decision: "handoff", reason: "Authorized provider feedback is corrected and validated.", signalId: work.signal.signalId } }]],
	]);
	return calls.get(step)?.();
}

function closedConclaveCall(step, work) {
	if (step !== 9) return conclaveCall(step, work);
	return ["khala_perform_action", { action: "fail-work", workId: work.workId, expectedWorkRevision: work.revision, input: { reason: "The provider review was closed without acceptance." } }];
}

function needsInputConclaveCall(step, work) {
	if (step >= 3) return conclaveCall(step - 3, work);
	if (step === 0) return ["khala_read_archive", { workId: "native-execution" }];
	if (step === 1) return ["khala_perform_action", { action: "request-input", workId: work.workId, expectedWorkRevision: work.revision, input: { reason: "Clarify the greeting file scope before admission.", missing: ["scope"] } }];
	return undefined;
}

function conclaveHandler(options) {
	if (options.needsInput === true) return needsInputConclaveCall;
	if (options.providerClosed === true) return closedConclaveCall;
	if (options.providerFeedback === true) return feedbackConclaveCall;
	return (step, work) => conclaveCall(step, work, options.oracleResponse);
}

function executorHandler(options) {
	if (options.providerFeedback === true) return (step, work) => feedbackExecutorCall(step, work, options);
	return (step, work) => executorCall(step, work, options.greeting, options.idleExecutor);
}

function nextCall(role, step, packet, options) {
	const work = packet?.work;
	const handlers = { user: (step, work) => userCall(step, work, options), executor: executorHandler(options), conclave: conclaveHandler(options) };
	return handlers[role](step, work);
}

function userCall(step, work, options) {
	const submission = { ...nativeSubmission };
	if (options.validation !== undefined) submission.validation = options.validation;
	if (options.maxTokens !== undefined) submission.maxTokens = options.maxTokens;
	const calls = new Map([[0, () => ["khala_submit_work", submission]], [2, () => ["khala_read_archive", { workId: "native-execution" }]], [3, () => ["khala_poll_provider", { workId: work.workId, expectedWorkRevision: work.revision }]]]);
	return calls.get(step)?.();
}

function fixtureModelIds(options) {
	if (options.oracleResponse === undefined) return ["user", "conclave", "executor"];
	return ["user", "conclave", "executor", "oracle"];
}

function fixtureOracleModel(options) {
	return options.oracleResponse === undefined ? "fixture/conclave" : "fixture/oracle";
}

function respondAsOracle(input, response, options, oracleRequests) {
	if (input.model !== "oracle" || options.oracleResponse === undefined) return false;
	oracleRequests.push(input);
	finish(response, options.oracleResponse);
	return true;
}

function holdModelResponse(role, heldRoles, heldRequests, response) {
	if (!heldRoles.has(role)) return false;
	heldRequests.push(response);
	return true;
}

function fixtureHeldRoles(options) {
	return new Set([
		...(options.holdExecutor === true ? ["executor"] : []),
		...(options.holdConclave === true ? ["conclave"] : []),
	]);
}

export async function createNativeWorkflowFixture(options = {}) {
	const root = await mkdtemp(join(tmpdir(), "khala-native-execution-"));
	const server = createServer();
	const close = async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	};
	try {
	const project = join(root, "project");
	const remote = join(root, "remote.git");
	const agent = join(root, "agent");
	const bin = join(root, "bin");
	await Promise.all([mkdir(project), mkdir(agent), mkdir(bin)]);
	git("init", "--bare", remote);
	git("init", "-b", "main", project);
	git("-C", project, "config", "user.email", "khala@example.test");
	git("-C", project, "config", "user.name", "Khala Test");
	await writeFile(join(project, "README.md"), "fixture\n");
	git("-C", project, "add", "README.md");
	git("-C", project, "commit", "-m", "initial");
	git("-C", project, "remote", "add", "origin", "git@github.com:fixture/native-workflow.git");
	git("-C", project, "remote", "set-url", "--push", "origin", remote);
	git("-C", project, "push", "origin", "main");
	// Git's transport is local while the unchanged code-host adapter sees the advertised host.
	const transport = join(bin, "local-upload-pack");
	await writeFile(transport, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`);
	await chmod(transport, 0o755);
	git("-C", project, "config", "core.sshCommand", transport);
	git("-C", project, "config", "ssh.variant", "simple");
	const gh = join(bin, "gh");
	await writeFile(gh, `#!/usr/bin/env node\nimport { runCodeHostFixture } from ${JSON.stringify(new URL("./native-code-host.mjs", import.meta.url).href)};\nrunCodeHostFixture(process.argv.slice(2), ${JSON.stringify(join(root, "review.json"))});\n`);
	await chmod(gh, 0o755);
	const steps = { user: 0, conclave: 0, executor: 0 };
	let callSequence = 0;
	const failures = [];
	const toolResults = [];
	const oracleRequests = [];
	const heldRequests = [];
	const heldRoles = fixtureHeldRoles(options);
	const resumeRole = (role) => { heldRoles.delete(role); for (const response of heldRequests.splice(0)) response.destroy(); };
	const pauseExecutor = () => heldRoles.add("executor");
	const resumeExecutor = () => resumeRole("executor");
	const resumeConclave = () => resumeRole("conclave");
	const respond = (input, response) => {
		const role = input.model;
		if (respondAsOracle(input, response, options, oracleRequests)) return;
		if (holdModelResponse(role, heldRoles, heldRequests, response)) return;
		const call = nextCall(role, steps[role]++, archivePacket(input), options);
		if (call === undefined) finish(response);
		else toolCall(response, `${role}-${++callSequence}`, call[0], call[1]);
	};
	server.on("request", async (request, response) => {
		try {
			const input = await requestBody(request);
			const latestTool = [...input.messages].reverse().find((message) => message.role === "tool");
			if (latestTool !== undefined) toolResults.push(latestTool.content);
			respond(input, response);
		} catch (error) {
			failures.push(error);
			response.writeHead(500).end(String(error));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const modelsPath = join(agent, "models.json");
	const modelIds = fixtureModelIds(options);
	await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture", models: modelIds.map((id) => ({ id, reasoning: false, contextWindow: 100_000, maxTokens: 2000 })) } } }));
	await writeFile(join(agent, "khala.json"), JSON.stringify({ archiveRoot: join(root, "archive"), worktreeRoot: join(root, "worktrees"), piCommand: [join(packageRoot, "node_modules", ".bin", "pi"), "--offline"], conclaveModel: "fixture/conclave", conclaveThinking: "off", executorModel: "fixture/executor", executorThinking: "off", oracleModel: fixtureOracleModel(options), oracleThinking: "off", observerModel: "fixture/conclave", observerThinking: "off" }));
	return { root, project, remote, agent, bin, modelsPath, steps, failures, toolResults, oracleRequests, heldRequests, pauseExecutor, resumeExecutor, resumeConclave, close };
	} catch (error) {
		server.closeAllConnections();
		await close();
		throw error;
	}
}
