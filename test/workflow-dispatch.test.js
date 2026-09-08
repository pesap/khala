import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SQLiteArchive } from "../dist/src/archive.js";
import { RunLedger } from "../dist/src/run-ledger.js";
import { ApplicationService } from "../dist/src/service.js";

const authority = generateKeyPairSync("ed25519");
const { publicKey } = authority;
const rolePublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const capabilityNonce = "workflow-dispatch-capability";
const zero = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

function terms() {
	return { title: "Waiting", objective: "Test dispatch", context: "", scope: "scope", acceptanceCriteria: ["works"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 };
}

function options(projectPath) {
	return {
		projectPath,
		targetBranch: "main",
		maxConcurrentExecutions: 1,
		maxConcurrentRuns: 1,
		maxCorrections: 3,
		defaultWorkTokens: 100,
		conclaveModel: "provider/conclave",
		conclaveThinking: "medium",
		executorModel: "provider/executor",
		executorThinking: "high",
		oracleModel: "provider/oracle",
		oracleThinking: "high",
		observerModel: "provider/observer",
		observerThinking: "medium",
		conclavePromptIdentity: { packageVersion: "test", promptSha256: "conclave" },
		executorPromptIdentity: { packageVersion: "test", promptSha256: "executor" },
		observerPromptIdentity: { packageVersion: "test", promptSha256: "observer" },
		oraclePromptIdentity: { packageVersion: "test", promptSha256: "oracle" },
		rolePublicKey,
		supervision: "candidate",
		autonomousMonitor: false,
	};
}

function conclaveMeta(commandId, expectedWorkRevision, workId) {
	const payload = Buffer.from(
		JSON.stringify({ role: "conclave", workId, nonce: capabilityNonce }),
		"utf8",
	).toString("base64url");
	return {
		actor: "conclave",
		commandId,
		expectedWorkRevision,
		roleToken: `${payload}.${sign(null, Buffer.from(payload, "utf8"), authority.privateKey).toString("base64url")}`,
		roleNonce: capabilityNonce,
		boundWorkId: workId,
		schemaVersion: 1,
	};
}

function ports(counters) {
	return {
		workspace: {
			async preflight() { return { projectPath: "/project", origin: "origin", targetBranch: "main", headCommit: "base" }; },
			async ensureSandbox() { counters.sandboxes += 1; return { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" }; },
			async prepareSandbox() { return { schemaVersion: 1, sandboxPath: "/tmp/sandbox", baseCommit: "base", manifestSha256: "0".repeat(64), lockfileSha256: "0".repeat(64), runtime: { node: "node", npm: "npm" }, policy: { registries: ["registry.npmjs.org"], maxArtifactBytes: 1, maxPreparationBytes: 1, maxConcurrentDownloads: 1, timeoutMs: 1 }, artifactDigests: [], preparedAt: new Date().toISOString() }; },
			async inspectHead() { return "head"; },
			async inspectChanges() { return []; },
			async runValidation({ commands }) { return commands.map((command) => ({ command, passed: true, output: "ok" })); },
			async publishSandbox() { return "head"; },
			async removeSandbox() {},
		},
		codeHost: { async capabilities() { return { supportsDraft: false, supportsMergeObservation: false }; }, async identity() { return { principalId: "user", verified: true }; }, async ensureReviewRequest() { throw new Error("unused"); }, async poll() { return []; }, async inspectOutcome() { return undefined; } },
		runtime: {
		async ensureSession(input) { counters.sessions += 1; return { sessionId: `${input.role}-session`, sessionPath: "/tmp/session" }; },
		async send(binding, message) {
			if (binding.sessionId.startsWith("conclave")) {
				counters.conclaveCalls = (counters.conclaveCalls ?? 0) + 1;
				await counters.onConclaveSend?.(message);
			}
			return { output: "ok", usage: zero };
		},
		async getState() { return "idle"; },
		async requestStop(binding) {
			if (binding.sessionId.startsWith("observer")) counters.observerStops = (counters.observerStops ?? 0) + 1;
		},
		async close() {},
		},
		models: { listScoped() { return ["provider/model", "provider/conclave", "provider/executor", "provider/oracle", "provider/observer"]; }, resolve(model) { return { model, supportedThinking: ["medium", "high"] }; } },
		oracle: {
			async review() {
				counters.oracleCalls = (counters.oracleCalls ?? 0) + 1;
				counters.oraclePendingAtLaunch = counters.inspectPending?.();
				return { usage: { ...zero, inputTokens: 2, outputTokens: 1 }, verdict: "pass", findings: [], validationGaps: [], durationMs: 1, output: "ok" };
			},
		},
	};
}

for (const role of ["executor", "observer"]) {
	test(`a permanent Archive failure during ${role} dispatch returns instead of tight-looping`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "khala-dispatch-liveness-"));
		const archivePath = join(directory, "archive.sqlite");
		const archive = new SQLiteArchive(archivePath);
		const executionWork = oracleWork("liveness-work");
		const work = role === "executor"
			? { ...executionWork, execution: { ...executionWork.execution, pi: { sessionId: "executor-session", sessionPath: join(directory, "session") } } }
			: { workId: "liveness-work", revision: 1, state: "submitted", terms: terms(), budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 }, observerInFlight: true, queuedSequence: 1, nextAction: "Observer is queued" };
		appendWork(archive, work, [{ effectId: "liveness:wake", kind: `${role}-wake`, payload: { workId: work.workId } }]);
		archive.close();
		const script = join(directory, "check.mjs");
		await writeFile(script, `import assert from "node:assert/strict";
import { SQLiteArchive } from ${JSON.stringify(new URL("../dist/src/archive.js", import.meta.url).href)};
import { ApplicationService } from ${JSON.stringify(new URL("../dist/src/service.js", import.meta.url).href)};
const archive = new SQLiteArchive(${JSON.stringify(archivePath)});
archive.append = () => { throw new Error("Permanent Archive write failure"); };
let prompts = 0;
const runtime = {
 async ensureSession() { throw new Error("No child should launch without a reservation"); },
 async send() { prompts += 1; throw new Error("No model should run without a reservation"); },
 async requestStop() {}, async close() {}, async getState() { return "idle"; }
};
const service = new ApplicationService(archive, { runtime, workspace: {}, codeHost: {}, models: {}, oracle: {} }, ${JSON.stringify(options(directory))});
await service.processPendingEffects();
assert.equal(prompts, 0);
assert.deepEqual(archive.pendingEffects("test").map(effect => effect.effectId), ["liveness:wake"]);
await service.close();
process.stdout.write("returned");
`);
		try {
			const result = await promisify(execFile)(process.execPath, [script], { timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" });
			assert.equal(result.stdout, "returned");
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}

test("waiting preparation is not reclaimed by repeated drains or a restarted supervisor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-waiting-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	const work = {
		workId: "waiting-work",
		revision: 1,
		state: "queued",
		terms: terms(),
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		mission: { missionId: "mission", workId: "waiting-work", assignment: terms(), mandateRevision: 1, createdAt: new Date().toISOString() },
		missionState: "admitted",
		preparation: { status: "waiting", prerequisiteId: "mission:0", operation: "dependencies", diagnostic: "offline", recovery: "user" },
		nextAction: "User recovery is required.",
		queuedSequence: 1,
	};
	archive.append({ commandId: "waiting", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: work.workId, payloadVersion: 1, summary: "waiting", payload: {}, projection: work, effects: [
		{ effectId: "scheduler-wake:waiting", kind: "scheduler-wake", payload: { workId: work.workId } },
		{ effectId: "conclave-wake:waiting", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } },
	] });
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const first = new ApplicationService(archive, ports(counters), options(directory));
		await first.processPendingEffects();
		const second = new ApplicationService(archive, ports(counters), options(directory));
		await second.processPendingEffects();
		assert.equal(counters.sandboxes, 0);
		assert.equal(counters.sessions, 0);
		assert.equal(archive.project(work.workId).preparation.status, "waiting");
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

function observerBinding() {
	return { sessionId: "observer-session", sessionPath: "/tmp/observer" };
}

function oracleWork(workId, oraclePending) {
	const mission = { missionId: "mission", workId, assignment: terms(), mandateRevision: 1, createdAt: new Date().toISOString() };
	const execution = {
		executionId: "execution",
		workId,
		missionId: mission.missionId,
		state: "running",
		runtimeState: "idle",
		model: "model",
		thinking: "medium",
		tokenAllowance: 50,
		promptIdentity: { packageVersion: "test", promptSha256: "test" },
		sandbox: { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" },
	};
	return {
		workId,
		revision: 1,
		state: "active",
		terms: terms(),
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		mission,
		missionState: "active",
		execution,
		lastSignal: { signalId: "signal", executionId: execution.executionId, kind: "ready", summary: "ready", evidence: ["check passed"], observedAt: new Date().toISOString() },
		reviewRequest: { provider: "github", principalId: "user", providerId: "pr-1", url: "https://example.test/pr-1", repository: "repo", status: "open", sourceBranch: "branch", targetBranch: "main", baseCommit: "base", headCommit: "head", diffSummary: "diff", validation: ["check passed"] },
		lastValidation: { executionId: execution.executionId, headCommit: "head", sourceVerified: true, results: [{ command: "check", passed: true, output: "ok" }] },
		oraclePending,
		nextAction: "Oracle review is queued.",
		queuedSequence: 1,
	};
}

function appendWork(archive, work, effects = []) {
	archive.append({ commandId: `seed:${work.workId}:${work.revision}`, expectedWorkRevision: work.revision - 1, kind: "execution", actor: "system", workId: work.workId, missionId: work.mission?.missionId, executionId: work.execution?.executionId, payloadVersion: 1, summary: "seed", payload: {}, projection: work, effects });
}

function queuedDispatchWork(workId, budget, preparation, observer) {
	const assignment = terms();
	const mission = { missionId: `mission-${workId}`, workId, assignment, mandateRevision: 1, createdAt: new Date().toISOString() };
	return {
		workId,
		revision: 1,
		state: "queued",
		terms: assignment,
		budget,
		mission,
		missionState: "admitted",
		preparation,
		observer,
		nextAction: "Waiting for budget or project concurrency.",
		queuedSequence: 1,
	};
}

test("an exhausted Work records one durable budget gate and reevaluates after amendment", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-budget-gate-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("budget-gate", { maxTokens: 100, reservedTokens: 0, consumedTokens: 100 });
	appendWork(archive, work, [{ effectId: "conclave-wake:budget-gate", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } }]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		const gated = archive.project(work.workId);
		assert.equal(counters.sessions, 0);
		assert.equal(gated.lastError.code, "budget-exhausted");
		assert.match(gated.lastError.remediation, /Amend the Work budget/);
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);

		const restarted = new ApplicationService(archive, ports(counters), options(directory));
		await restarted.processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);

		const amended = await restarted.perform({
			action: "amend-budget",
			workId: work.workId,
			input: { maxTokens: 200 },
			meta: { actor: "user", commandId: "budget-gate:amend", expectedWorkRevision: gated.revision, schemaVersion: 1 },
		});
		assert.equal("error" in amended, false);
		await restarted.processPendingEffects();
		assert.equal(counters.conclaveCalls, 1);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a gated Conclave wake does not starve cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-gate-cleanup-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const observer = observerBinding();
	const work = queuedDispatchWork("gate-cleanup", { maxTokens: 100, reservedTokens: 0, consumedTokens: 100 }, undefined, observer);
	appendWork(archive, work, [
		{ effectId: "conclave-wake:gate-cleanup", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } },
		{ effectId: "observer-cleanup:gate-cleanup", kind: "observer-cleanup", payload: { workId: work.workId, ...observer } },
	]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.equal(counters.observerStops, 1);
		assert.deepEqual(archive.pendingEffects("assertion").map((effect) => effect.effectId), ["conclave-wake:gate-cleanup"]);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("explicit preparation recovery clears the dispatch gate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-recovery-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("preparation-recovery", { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 }, { status: "waiting", prerequisiteId: "mission:0", operation: "dependencies", diagnostic: "npm failed", recovery: "user" });
	appendWork(archive, work, [{ effectId: "conclave-wake:preparation-recovery", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } }]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		const gated = archive.project(work.workId);
		const recovered = await service.perform({
			action: "recover",
			workId: work.workId,
			input: {},
			meta: { actor: "user", commandId: "preparation-recovery:apply", expectedWorkRevision: gated.revision, schemaVersion: 1 },
		});
		assert.equal("error" in recovered, false);
		assert.equal(recovered.value.preparation, undefined);
		assert.equal(recovered.value.execution.state, "queued");
		assert.equal(recovered.value.lastError, undefined);
		await service.processPendingEffects();
		assert.equal(counters.conclaveCalls ?? 0, 0);
		assert.equal(counters.sessions, 1);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failed Conclave wake remains the one pending wake and does not starve cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-failure-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const seeded = oracleWork("failed-work", undefined);
	const work = { ...seeded, execution: { ...seeded.execution, state: "failed", endedAt: new Date().toISOString() }, observer: observerBinding(), observerInFlight: true, nextAction: "Conclave must decide how to recover the failed Executor." };
	appendWork(archive, work, [
		{ effectId: "conclave-wake:failed-work", kind: "conclave-wake", payload: { workId: work.workId, reason: "executor-failed" } },
		{ effectId: "observer-cleanup:failed-work", kind: "observer-cleanup", payload: { workId: work.workId, ...observerBinding() } },
	]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		for (let index = 0; index < 3; index++) await service.processPendingEffects();
		assert.equal(counters.conclaveCalls, 1);
		assert.equal(counters.observerStops, 1);
		const pending = archive.pendingEffects("assertion");
		assert.deepEqual(pending.map((effect) => effect.effectId), ["conclave-wake:failed-work"]);
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the scheduler skips exhausted FIFO entries without losing its effect lease", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-fifo-gates-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const exhausted = queuedDispatchWork("exhausted-head", { maxTokens: 100, consumedTokens: 100, reservedTokens: 0 });
	const eligible = { ...queuedDispatchWork("eligible-next", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 }), queuedSequence: 2 };
	appendWork(archive, exhausted, [{ effectId: "scheduler:head", kind: "scheduler-wake", payload: { workId: exhausted.workId } }]);
	appendWork(archive, eligible);
	const counters = { sandboxes: 0, sessions: 0 };
	const fake = ports(counters);
	const launched = [];
	const ensureSession = fake.runtime.ensureSession;
	fake.runtime.ensureSession = (input) => { launched.push(input.bindingScope.workId); return ensureSession(input); };
	try {
		const service = new ApplicationService(archive, fake, options(directory));
		await service.processPendingEffects();
		await service.processPendingEffects();
		assert.deepEqual(launched, [eligible.workId]);
		assert.equal(archive.project(exhausted.workId).lastError.code, "budget-exhausted");
		assert.deepEqual(archive.pendingEffects("assertion"), []);
		assert.equal(archive.query({ workId: exhausted.workId, kinds: ["error"] }).items.length, 1);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a scheduled Conclave startup failure is recorded once and remains deferred after restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-scheduler-failure-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("scheduled-failure", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 });
	appendWork(archive, work, [{ effectId: "scheduler:failure", kind: "scheduler-wake", payload: { workId: work.workId } }]);
	const counters = { sandboxes: 0, sessions: 0 };
	const fake = ports(counters);
	fake.runtime.ensureSession = async () => { counters.sessions += 1; throw new Error("Configured child cannot start"); };
	try {
		const service = new ApplicationService(archive, fake, options(directory));
		await service.processPendingEffects();
		await service.processPendingEffects();
		await new ApplicationService(archive, fake, options(directory)).processPendingEffects();
		assert.equal(counters.sessions, 1);
		assert.equal(archive.project(work.workId).budget.reservedTokens, 0);
		assert.match(archive.project(work.workId).lastError.summary, /Configured child cannot start/);
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("held reservations wait for settlement rather than requesting a budget increase", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-reservation-gate-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("reserved-work", { maxTokens: 100, consumedTokens: 60, reservedTokens: 0 });
	appendWork(archive, work, [{ effectId: "reserved:wake", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } }]);
	const ledger = new RunLedger(archive);
	const held = ledger.reserve({ workId: work.workId, role: "observer", allowance: 40 });
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		await service.processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.match(archive.project(work.workId).lastError.remediation, /existing invocation to settle/);
		assert.doesNotMatch(archive.project(work.workId).nextAction, /amend|increase|exhausted/i);
		ledger.settle({ runId: held.runId, complete: true, usage: zero });
		await service.processPendingEffects();
		assert.equal(counters.conclaveCalls, 1);
		assert.equal(archive.project(work.workId).lastError, undefined);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stale Conclave wakes for cancelled Work complete without invoking a model", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-terminal-wake-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = { ...queuedDispatchWork("cancelled", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 }), state: "stopped", stopReason: "cancelled", missionState: "superseded" };
	appendWork(archive, work, ["admission", "executor-failed"].map((reason) => ({ effectId: `stale:${reason}`, kind: "conclave-wake", payload: { workId: work.workId, reason } })));
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.equal(archive.project(work.workId).revision, 1);
		assert.deepEqual(archive.pendingEffects("assertion"), []);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a stale Executor-failure wake cannot prompt after the Execution is running", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-stale-failure-wake-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = oracleWork("running-again");
	appendWork(archive, work, [{ effectId: "stale:executor-failed", kind: "conclave-wake", payload: { workId: work.workId, reason: "executor-failed" } }]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		await new ApplicationService(archive, ports(counters), options(directory)).processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.equal(archive.project(work.workId).revision, 1);
		assert.deepEqual(archive.pendingEffects("assertion"), []);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("gate attention remains deduplicated after unrelated errors and long history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-durable-gate-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("historical-gate", { maxTokens: 100, consumedTokens: 100, reservedTokens: 0 });
	appendWork(archive, work, [{ effectId: "historic:wake", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } }]);
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		for (let index = 0; index < 80; index++) {
			const current = archive.project(work.workId);
			appendWork(archive, { ...current, revision: current.revision + 1, lastError: { code: "external-failure", summary: "Cleanup requires inspection", retryable: false, remediation: "Inspect cleanup", evidenceRefs: [] } });
		}
		const before = archive.project(work.workId);
		await new ApplicationService(archive, ports(counters), options(directory)).processPendingEffects();
		assert.equal(archive.project(work.workId).revision, before.revision);
		assert.equal(archive.project(work.workId).lastError.summary, "Cleanup requires inspection");
		assert.equal(archive.query({ workId: work.workId, kinds: ["error"] }).items.length, 1);
		assert.equal(counters.sessions, 0);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an atomic capacity collision defers the effect without recording a model failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "khala-capacity-collision-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("capacity-work", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 });
	const competing = queuedDispatchWork("competing-work", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 });
	appendWork(archive, work, [{ effectId: "capacity:wake", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } }]);
	appendWork(archive, competing);
	const ledger = new RunLedger(archive);
	const append = archive.append.bind(archive);
	let held;
	t.mock.method(archive, "append", (input) => {
		if (input.invocationLimit !== undefined && input.workId === work.workId && held === undefined) {
			held = ledger.reserve({ workId: competing.workId, role: "observer", allowance: 20, maxConcurrentRuns: 1 });
		}
		return append(input);
	});
	const counters = { sandboxes: 0, sessions: 0 };
	try {
		const service = new ApplicationService(archive, ports(counters), options(directory));
		await service.processPendingEffects();
		assert.equal(counters.sessions, 0);
		assert.equal(archive.project(work.workId).lastError, undefined);
		assert.equal(archive.project(work.workId).budget.reservedTokens, 0);
		assert.ok(held);
		ledger.settle({ runId: held.runId, complete: true, usage: zero });
		await service.processPendingEffects();
		assert.equal(counters.conclaveCalls, 1);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("scheduler and admission wakes do not repeat a completed launch after restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-wake-dedup-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const work = queuedDispatchWork("duplicate-work", { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 });
	appendWork(archive, work, [
		{ effectId: "duplicate:scheduler", kind: "scheduler-wake", payload: { workId: work.workId } },
		{ effectId: "duplicate:admission", kind: "conclave-wake", payload: { workId: work.workId, reason: "admission" } },
	]);
	const counters = { sandboxes: 0, sessions: 0 };
	const fake = ports(counters);
	fake.runtime.send = async () => {
		counters.conclaveCalls = (counters.conclaveCalls ?? 0) + 1;
		const current = archive.project(work.workId);
		const execution = { ...oracleWork(work.workId).execution, missionId: work.mission.missionId };
		appendWork(archive, { ...current, revision: current.revision + 1, state: "active", missionState: "active", execution });
		return { output: "launched", usage: zero };
	};
	try {
		await new ApplicationService(archive, fake, options(directory)).processPendingEffects();
		await new ApplicationService(archive, fake, options(directory)).processPendingEffects();
		assert.equal(counters.conclaveCalls, 1);
		assert.deepEqual(archive.pendingEffects("assertion"), []);
	} finally { archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Oracle wake invokes once, persists its advisory, and stale cancellation supersedes without resurrection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-oracle-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const pending = { requestId: "request-1", subject: "Review the handoff", missionId: "mission", executionId: "execution", signalId: "signal", headCommit: "head" };
	const work = oracleWork("oracle-work", pending);
	appendWork(archive, work, [{ effectId: "oracle-wake:oracle-work:request-1:1", kind: "oracle-wake", payload: { workId: work.workId, ...pending } }]);
	const conclaveMessages = [];
	let service;
	const counters = {
		sandboxes: 0,
		sessions: 0,
		inspectPending: () => archive.countPendingInvocations(),
		onConclaveSend: async (message) => {
			conclaveMessages.push(message);
			const current = archive.project(work.workId);
			const verdict = await service.perform({
				action: "verdict",
				workId: current.workId,
				input: { decision: "handoff", reason: "Oracle advisory supports handoff.", signalId: current.lastSignal.signalId },
				meta: conclaveMeta(`oracle-verdict:${current.revision}`, current.revision, current.workId),
			});
			assert.equal("error" in verdict, false);
		},
	};
	try {
		service = new ApplicationService(archive, ports(counters), options(directory));
		const callerLedger = new RunLedger(archive);
		const caller = callerLedger.reserve({ workId: work.workId, role: "conclave", allowance: 20, maxConcurrentRuns: 1 });
		await service.processPendingEffects();
		assert.equal(counters.oracleCalls ?? 0, 0);
		callerLedger.settle({ runId: caller.runId, complete: true, usage: zero });
		const queued = archive.pendingEffects("payload")[0];
		assert.deepEqual(queued.payload, { workId: work.workId, ...pending });
		archive.releaseEffect(queued.effectId, "payload");
		await service.processPendingEffects();
		assert.equal(counters.oracleCalls, 1);
		assert.equal(counters.oraclePendingAtLaunch, 1);
		assert.deepEqual(archive.project(work.workId).budget, { maxTokens: 100, reservedTokens: 0, consumedTokens: 3 });
		const oracleInvocations = archive.query({ workId: work.workId, kinds: ["invocation"] }).items.filter((record) => record.payload.role === "oracle");
		assert.equal(oracleInvocations.length, 2);
		assert.equal(oracleInvocations.at(-1).payload.state, "settled");
		const advisory = archive.query({ workId: work.workId, kinds: ["oracle-review"] }).items.at(-1).payload;
		assert.equal(advisory.verdict, "pass");
		assert.equal(conclaveMessages.length, 1);
		assert.match(conclaveMessages[0], /completed Oracle advisory/);
		assert.match(conclaveMessages[0], /action verdict/);
		assert.match(conclaveMessages[0], /current ready Signal/);
		assert.doesNotMatch(conclaveMessages[0], /Process queued Work/);
		assert.equal(archive.project(work.workId).state, "awaiting-review");

		const stalePending = { ...pending, requestId: "request-2" };
		const staleWork = oracleWork("stale-oracle-work", stalePending);
		appendWork(archive, staleWork, [{ effectId: "oracle-wake:stale-oracle-work:request-2:1", kind: "oracle-wake", payload: { workId: staleWork.workId, ...stalePending } }]);
		const cancelled = { ...staleWork, revision: 2, state: "stopped", stopReason: "cancelled", missionState: "superseded", execution: { ...staleWork.execution, state: "stopped", endedAt: new Date().toISOString() } };
		archive.append({ commandId: "cancel-stale-oracle", expectedWorkRevision: 1, kind: "execution", actor: "user", workId: staleWork.workId, missionId: staleWork.mission.missionId, executionId: staleWork.execution.executionId, payloadVersion: 1, summary: "cancelled", payload: {}, projection: cancelled });
		await service.processPendingEffects();
		assert.equal(counters.oracleCalls, 1);
		assert.equal(archive.project(staleWork.workId).state, "stopped");
		assert.equal(archive.project(staleWork.workId).oraclePending, undefined);
		assert.equal(archive.query({ workId: staleWork.workId, kinds: ["oracle-review"] }).items.at(-1).payload.status, "superseded");
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("late settlement after cancellation charges usage without reviving the stopped execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-workflow-late-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const execution = { executionId: "execution", workId: "cancelled-work", missionId: "mission", state: "running", runtimeState: "working", model: "model", thinking: "medium", tokenAllowance: 50, promptIdentity: { packageVersion: "test", promptSha256: "test" }, sandbox: { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" }, pi: { sessionId: "session", sessionPath: "/tmp/session" } };
	const projection = { workId: "cancelled-work", revision: 1, state: "active", terms: terms(), budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 }, mission: { missionId: "mission", workId: "cancelled-work", assignment: terms(), mandateRevision: 1, createdAt: new Date().toISOString() }, missionState: "active", execution, nextAction: "running", queuedSequence: 0 };
	archive.append({ commandId: "running", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: projection.workId, payloadVersion: 1, summary: "running", payload: {}, projection });
	try {
		const ledger = new RunLedger(archive);
		const run = ledger.reserve({ workId: projection.workId, role: "executor", executionId: execution.executionId, allowance: 20 });
		const current = archive.project(projection.workId);
		archive.append({ commandId: "cancel", expectedWorkRevision: current.revision, kind: "observation", actor: "user", workId: projection.workId, executionId: execution.executionId, payloadVersion: 1, summary: "cancelled", payload: {}, projection: { ...current, revision: current.revision + 1, state: "stopped", stopReason: "cancelled", execution: { ...execution, state: "stopped", endedAt: new Date().toISOString() } } });
		ledger.settle({ runId: run.runId, complete: true, usage: { ...zero, inputTokens: 7, outputTokens: 2 } });
		const settled = archive.project(projection.workId);
		assert.equal(settled.state, "stopped");
		assert.equal(settled.execution.state, "stopped");
		assert.equal(settled.budget.consumedTokens, 9);
		assert.equal(settled.budget.reservedTokens, 0);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});
