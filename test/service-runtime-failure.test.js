import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { RuntimeTurnError } from "../dist/src/ports.js";
import { ApplicationService } from "../dist/src/service.js";

const authority = generateKeyPairSync("ed25519");
const publicKey = authority.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const nonce = "test-nonce";

function capability(role, workId, executionId) {
	const encoded = Buffer.from(JSON.stringify({ role, workId, executionId, nonce })).toString("base64url");
	return `${encoded}.${sign(null, Buffer.from(encoded), authority.privateKey).toString("base64url")}`;
}

function meta(actor, commandId, expectedWorkRevision, workId, executionId) {
	return {
		actor,
		commandId,
		expectedWorkRevision,
		roleToken: actor === "user" ? undefined : capability(actor, workId, executionId),
		roleNonce: actor === "user" ? undefined : nonce,
		boundWorkId: workId,
		boundExecutionId: executionId,
		schemaVersion: 1,
	};
}

function makeService(path, controls) {
	const runtime = {
		async ensureSession(input) {
			const binding = { sessionId: `${input.role}-${controls.sessions++}`, sessionPath: "/tmp/test-session.jsonl", capabilityNonce: nonce };
			if (input.role === "executor") controls.executorBinding = binding;
			return binding;
		},
		async send(binding) {
			if (binding.sessionId.startsWith("executor-")) {
				controls.executorSends++;
				if (controls.defer) return new Promise((_, reject) => { controls.release = () => reject(new RuntimeTurnError("executor disconnected", controls.usage)); });
				throw new RuntimeTurnError("executor disconnected", controls.usage);
			}
			return { output: "" };
		},
		async getState() { return "idle"; },
		async requestStop() {},
		async close() {},
	};
	const workspace = {
		async preflight() { return { projectPath: "/project", origin: "https://github.com/example/project", targetBranch: "main", headCommit: "base" }; },
		async ensureSandbox(input) { return { path: join(dirname(path), input.executionId), baseCommit: "base", branch: "branch" }; },
		async removeSandbox() {},
	};
	const ports = {
		runtime,
		workspace,
		codeHost: {},
		models: { listScoped: () => ["conclave", "executor"], resolve: (model) => ({ model, supportedThinking: ["medium"] }) },
		oracle: {},
	};
	return new ApplicationService(new SQLiteArchive(path), ports, {
		projectPath: dirname(path), targetBranch: "main", maxConcurrentExecutions: 1, defaultWorkTokens: 100,
		conclaveModel: "conclave", conclaveThinking: "medium", executorModel: "executor", executorThinking: "medium",
		oracleModel: "conclave", oracleThinking: "medium", observerModel: "conclave", observerThinking: "medium",
		conclavePromptIdentity: { packageVersion: "1", promptSha256: "conclave" }, executorPromptIdentity: { packageVersion: "1", promptSha256: "executor" },
		observerPromptIdentity: { packageVersion: "1", promptSha256: "observer" }, oraclePromptIdentity: { packageVersion: "1", promptSha256: "oracle" },
		rolePublicKey: publicKey,
		supervision: "candidate",
	});
}

test("Executor runtime failure charges partial usage once across repeated effect drains", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-service-runtime-failure-"));
	const controls = { sessions: 0, executorBinding: undefined, executorSends: 0, defer: false, release: undefined, usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 16 } };
	const service = makeService(join(directory, "archive.sqlite"), controls);
	try {
		const submitted = service.submitWork({ title: "Failure", objective: "Charge usage", acceptanceCriteria: ["Usage is retained"] }, meta("user", "submit", 0));
		const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "admit", submitted.revision, submitted.workId) });
		const started = await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "start", admitted.value.revision, submitted.workId) });
		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const failed = service.inspectWork(started.value.workId);
		assert.equal(failed.execution.state, "failed");
		assert.equal(failed.budget.consumedTokens, 18);
		assert.equal(failed.budget.reservedTokens, 0);
		const sends = controls.executorSends;
		await service.processPendingEffects();
		assert.equal(controls.executorSends, sends);
		assert.equal(service.inspectWork(started.value.workId).budget.consumedTokens, 18);
	} finally {
		await service.close();
	}
});

test("Known failure usage is recorded after cancellation without resurrecting Work", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-service-cancelled-failure-"));
	const controls = { sessions: 0, executorBinding: undefined, executorSends: 0, defer: true, release: undefined, usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 16 } };
	const service = makeService(join(directory, "archive.sqlite"), controls);
	try {
		const submitted = service.submitWork({ title: "Cancelled failure", objective: "Charge usage", acceptanceCriteria: ["Cancellation remains terminal"] }, meta("user", "cancel-submit", 0));
		const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "cancel-admit", submitted.revision, submitted.workId) });
		await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "cancel-start", admitted.value.revision, submitted.workId) });
		await service.processPendingEffects();
		await new Promise((resolve) => setImmediate(resolve));
		const running = service.inspectWork(submitted.workId);
		const cancelled = await service.perform({ action: "cancel", workId: submitted.workId, input: {}, meta: meta("user", "cancel", running.revision, submitted.workId) });
		controls.release();
		await new Promise((resolve) => setImmediate(resolve));
		const final = service.inspectWork(submitted.workId);
		assert.equal(cancelled.value.stopReason, "cancelled");
		assert.equal(final.state, "stopped");
		assert.equal(final.stopReason, "cancelled");
		assert.equal(final.budget.consumedTokens, 18);
		assert.equal(final.budget.reservedTokens, 0);
	} finally {
		controls.release?.();
		await service.close();
	}
});
