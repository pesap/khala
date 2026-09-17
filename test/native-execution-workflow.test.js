import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createApplication } from "../dist/src/factory.js";
import { createNativeWorkflowFixture, git, packageRoot } from "./helpers/native-workflow.mjs";

async function waitForState(service, state) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		await service.processPendingEffects();
		const work = service.inspectWork("native-execution");
		if (work.state === state || work.lastError !== undefined) return work;
		await setTimeout(50);
	}
	return service.inspectWork("native-execution");
}

test("native workflow with local model and code-host fixtures survives recovery and reaches success", { timeout: 60_000 }, async () => {
	const fixture = await createNativeWorkflowFixture();
	const { root, project, remote, agent, bin, modelsPath, steps, failures, toolResults } = fixture;
	const oldAgent = process.env.PI_CODING_AGENT_DIR;
	const oldPath = process.env.PATH;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.PATH = `${bin}:${oldPath}`;
	let application;
	try {
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(agent, "auth.json"), allowModelNetwork: false });
		const modelRegistry = new ModelRegistry(runtime);
		application = createApplication(project, true, packageRoot, { modelRegistry });
		application.service.submitWork({ workId: "native-execution", title: "Native greeting", objective: "Create greeting.txt containing hello", scope: "Create only greeting.txt.", acceptanceCriteria: ["greeting.txt contains hello"], allowedPaths: ["greeting.txt"], validation: ["test \"$(cat greeting.txt)\" = hello"] }, { actor: "user", commandId: "native-submit", expectedWorkRevision: 0, schemaVersion: 1 });
		await application.service.processPendingEffects();
		const current = await waitForState(application.service, "awaiting-review");
		assert.equal(current.state, "awaiting-review", JSON.stringify({ state: current.state, error: current.lastError, failures: failures.map(String), toolResults: toolResults.filter((text) => !text.startsWith("Archive records:")) }));
		assert.equal(current.reviewRequest.providerId, "42");
		assert.equal(await readFile(join(current.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.equal(current.lastValidation.results.every((result) => result.passed), true);
		assert.notEqual(current.reviewRequest.headCommit, current.execution.sandbox.baseCommit);
		const completedSteps = { ...steps };
		await application.service.close();
		application = createApplication(project, true, packageRoot, { modelRegistry });
		const saved = application.service.inspectWork(current.workId);
		const recovered = await application.service.recoverWork(saved.workId, { actor: "user", commandId: "native-recover", expectedWorkRevision: saved.revision, schemaVersion: 1 });
		await application.service.processPendingEffects();
		assert.equal(recovered.state, "awaiting-review");
		assert.equal(recovered.execution.executionId, current.execution.executionId);
		assert.equal(recovered.execution.sandbox.path, current.execution.sandbox.path);
		assert.deepEqual(steps, completedSteps, "recovery must not repeat completed model turns");
		assert.equal(git("-C", recovered.execution.sandbox.path, "rev-parse", "HEAD"), current.reviewRequest.headCommit);
		git("-C", project, "merge", "--ff-only", recovered.execution.sandbox.branch);
		git("-C", project, "push", "origin", "main");
		const reviewPath = join(root, "review.json");
		const review = JSON.parse(await readFile(reviewPath, "utf8"));
		await writeFile(reviewPath, JSON.stringify({ ...review, state: "MERGED", isDraft: false, mergedAt: new Date().toISOString(), mergeCommit: { oid: current.reviewRequest.headCommit } }));
		const beforePoll = application.service.inspectWork(current.workId);
		await application.service.pollProvider(beforePoll.workId, { actor: "user", commandId: "native-poll", expectedWorkRevision: beforePoll.revision, schemaVersion: 1 });
		const succeeded = await waitForState(application.service, "succeeded");
		assert.equal(succeeded.state, "succeeded", JSON.stringify({ error: succeeded.lastError, failures: failures.map(String) }));
		assert.equal(succeeded.execution.executionId, current.execution.executionId);
		assert.equal(git("--git-dir", remote, "rev-parse", "refs/heads/main"), current.reviewRequest.headCommit);
		assert.equal(succeeded.budget.reservedTokens, 0);
		assert.deepEqual(failures, []);
	} finally {
		await application?.service.close().catch(() => undefined);
		if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
		process.env.PATH = oldPath;
		await fixture.close();
	}
});
