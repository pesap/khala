import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeHostForOrigin, CommandCodeHost } from "../dist/src/adapters.js";
import { SQLiteArchive } from "../dist/src/archive.js";
import { PiOracle } from "../dist/src/oracle.js";
import { createApplication } from "../dist/src/factory.js";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { ApplicationService } from "../dist/src/service.js";

const authority = generateKeyPairSync("ed25519");
const ROLE_PUBLIC_KEY = authority.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const TEST_CAPABILITY_NONCE = "test-capability-nonce";

function makePorts(overrides = {}) {
	const { ports: portOverrides = {}, maxConcurrentExecutions: _maxConcurrentExecutions, ...controlOverrides } = overrides;
	const controls = {
		head: "head",
		outcome: false,
		outcomeObservation: undefined,
		pollObservations: [],
		turnUsage: undefined,
		runtimeState: "idle",
		observerHold: false,
		releaseObserver: undefined,
		executorHold: false,
		releaseExecutor: undefined,
		published: [],
		sessions: [],
		prompts: [],
		stopped: [],
		cleaned: [],
		...controlOverrides,
	};
	const runtime = {
		async ensureSession(input) {
			const binding = { sessionId: `${input.role}-${controls.sessions.length + 1}`, sessionPath: `/tmp/${input.role}-${controls.sessions.length + 1}.jsonl`, capabilityNonce: input.tools.length === 0 ? undefined : TEST_CAPABILITY_NONCE };
			controls.sessions.push({ input, binding });
			return binding;
		},
		async send(binding, message) {
			controls.prompts.push({ binding, message });
			if (controls.observerHold && binding.sessionId.startsWith("observer-"))
				return new Promise((resolve) => {
					controls.releaseObserver = resolve;
				});
			if (controls.executorHold && binding.sessionId.startsWith("executor-"))
				return new Promise((resolve) => {
					controls.releaseExecutor = () => resolve({ output: "" });
				});
			return {
				output: "",
				usage: binding.sessionId.startsWith("executor-") ? controls.turnUsage : undefined,
			};
		},
		async getState() {
			return controls.runtimeState;
		},
		async requestStop(binding) {
			controls.stopped.push(binding);
		},
		async close() {},
	};
	const workspace = {
		async preflight() {
			return { projectPath: "/project", origin: "https://github.com/example/project", targetBranch: "main", headCommit: "base" };
		},
		async ensureSandbox(input) {
			return { path: `/tmp/${input.executionId}`, baseCommit: "base", branch: `khala/${input.workId}/${input.executionId}` };
		},
		async inspectHead() {
			return controls.head;
		},
		async publishSandbox(sandbox) {
			controls.published.push(sandbox);
			return controls.head;
		},
		async removeSandbox(sandbox) {
			controls.cleaned.push(sandbox);
		},
	};
	const codeHost = {
		async capabilities() {
			return { supportsDraft: true, supportsMergeObservation: true };
		},
		async identity() {
			return { principalId: "user-1", verified: true };
		},
		async ensureReviewRequest(input) {
			return {
				provider: "github",
				principalId: "user-1",
				providerId: "42",
				url: "https://github.com/example/project/pull/42",
				repository: "example/project",
				status: "draft",
				sourceBranch: input.sandbox.branch,
				targetBranch: input.targetBranch,
				headCommit: input.headCommit,
				diffSummary: "two files changed",
				validation: input.terms.validation,
			};
		},
		async poll() {
			return controls.pollObservations;
		},
		async inspectOutcome(request) {
			if (controls.outcomeObservation !== undefined) return controls.outcomeObservation;
			if (!controls.outcome) return undefined;
			return {
				observationId: `merge:${request.providerId}`,
				kind: "provider-outcome",
				providerId: request.providerId,
				status: "merged",
				repository: request.repository,
				summary: "The provider reports a merged review request.",
				sourceBranch: request.sourceBranch,
				targetBranch: request.targetBranch,
				headCommit: request.headCommit,
				mergeCommit: "merge-commit",
				changed: true,
				observedAt: new Date().toISOString(),
			};
		},
	};
	return {
		ports: {
			workspace: { ...workspace, ...portOverrides.workspace },
			codeHost: { ...codeHost, ...portOverrides.codeHost },
			runtime: { ...runtime, ...portOverrides.runtime },
			models: {
				listScoped() {
					return ["provider/conclave", "provider/executor", "provider/oracle", "provider/observer"];
				},
				resolve(model) {
					return { model, supportedThinking: ["medium", "high"] };
				},
				...portOverrides.models,
			},
			oracle: {
				async review() {
					return { verdict: "pass", findings: [], validationGaps: [], durationMs: 1, output: "Verdict: Pass" };
				},
				...portOverrides.oracle,
			},
		},
		controls,
	};
}

function makeService(path, overrides = {}) {
	const fake = makePorts(overrides);
	const archive = new SQLiteArchive(path);
	const service = new ApplicationService(archive, fake.ports, {
		projectPath: "/project",
		targetBranch: "main",
		maxConcurrentExecutions: overrides.maxConcurrentExecutions ?? 2,
		defaultWorkTokens: 100,
		conclaveModel: "provider/conclave",
		conclaveThinking: "medium",
		executorModel: "provider/executor",
		executorThinking: "high",
		oracleModel: "provider/oracle",
		oracleThinking: "high",
		observerModel: "provider/observer",
		observerThinking: "medium",
		conclavePromptIdentity: { packageVersion: "1.1.0", promptSha256: "conclave" },
		executorPromptIdentity: { packageVersion: "1.1.0", promptSha256: "executor" },
		observerPromptIdentity: { packageVersion: "1.1.0", promptSha256: "observer" },
		rolePublicKey: ROLE_PUBLIC_KEY,
	});
	return { service, controls: fake.controls, runtime: fake.ports.runtime, archive };
}

function meta(actor, commandId, expectedWorkRevision, workId, executionId) {
	return {
		actor,
		commandId,
		expectedWorkRevision,
		roleToken: actor === "user" ? undefined : capability(actor, workId, executionId),
		roleNonce: actor === "user" ? undefined : TEST_CAPABILITY_NONCE,
		boundWorkId: workId,
		boundExecutionId: executionId,
		schemaVersion: 1,
	};
}

function capability(role, workId, executionId) {
	const payload = Buffer.from(JSON.stringify({ role, workId, executionId, nonce: TEST_CAPABILITY_NONCE }), "utf8").toString("base64url");
	return `${payload}.${sign(null, Buffer.from(payload, "utf8"), authority.privateKey).toString("base64url")}`;
}

async function admitAndStart(service, idPrefix) {
	const submitted = service.submitWork({ title: `${idPrefix} feature`, objective: "Implement the feature", acceptanceCriteria: ["The behavior works"] }, meta("user", `${idPrefix}:submit`, 0));
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", `${idPrefix}:admit`, submitted.revision, submitted.workId) });
	assert.equal(admitted.value.state, "queued");
	const queued = service.inspectWork(submitted.workId);
	const started = await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", `${idPrefix}:start`, queued.revision, submitted.workId) });
	assert.equal("value" in started, true);
	assert.equal(started.value.execution.state, "queued");
	await service.processPendingEffects();
	await new Promise((resolve) => setImmediate(resolve));
	return service.inspectWork(submitted.workId);
}

test("generated Work IDs use Nano ID format", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-work-id-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Generated ID", objective: "Verify generated IDs", acceptanceCriteria: ["The ID uses Nano ID format"] },
		meta("user", "work-id:submit", 0),
	);
	assert.match(submitted.workId, /^[A-Za-z0-9_-]{21}$/);
	await service.close();
});

test("generated Mission and Execution IDs use Nano ID format", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-derived-id-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "derived-ids");
	assert.match(running.mission.missionId, /^[A-Za-z0-9_-]{21}$/);
	assert.match(running.execution.executionId, /^[A-Za-z0-9_-]{21}$/);
	await service.close();
});

test("Conclave wake failures preserve provider detail and remediation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-wake-failure-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send(binding) {
					if (binding.sessionId.startsWith("conclave-")) {
						throw new Error("OpenAI API error (429): quota exceeded");
					}
					return { output: "" };
				},
			},
		},
	});
	const submitted = service.submitWork(
		{ title: "Wake failure", objective: "Expose the cause", acceptanceCriteria: ["The error is actionable"] },
		meta("user", "wake-failure:submit", 0),
	);
	await service.processPendingEffects();
	const failed = service.inspectWork(submitted.workId);
	assert.equal(failed.lastError?.summary, "Conclave admission failed: OpenAI API error (429): quota exceeded");
	assert.match(failed.lastError?.remediation ?? "", /\/khala/);
	assert.equal(failed.nextAction, "Resolve the Conclave admission error, then retry admission.");
	const records = service.readRecords(
		{ workId: submitted.workId, kinds: ["error"] },
		meta("user", "wake-failure:read", failed.revision, submitted.workId),
	);
	assert.equal(records.items[0]?.payload.summary, failed.lastError?.summary);
	await service.close();
});

test("Executor usage records cache hits, misses, and idle runtime state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-usage-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		turnUsage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 5 },
	});
	const running = await admitAndStart(service, "usage");
	assert.deepEqual(running.execution.usage, {
		inputTokens: 11,
		outputTokens: 7,
		cacheHitTokens: 13,
		cacheMissTokens: 5,
	});
	assert.equal(running.execution.runtimeState, "idle");
	assert.equal(running.nextAction, "Executor is idle; waiting for a Signal.");
	await service.close();
});

test("a runtime failure during the first Executor turn is recorded as unreachable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-turn-failure-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send(binding) {
					if (binding.sessionId.startsWith("executor-")) throw new Error("runtime disconnected");
					return { output: "" };
				},
			},
		},
	});
	const failed = await admitAndStart(service, "runtime-turn-failure");
	assert.equal(failed.execution.state, "failed");
	assert.equal(failed.execution.runtimeState, "unreachable");
	assert.equal(failed.nextAction, "Executor runtime failed; Conclave may replace it.");
	await service.close();
});

test("recovery starts a new Executor turn while the old turn is still in flight", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-rebind-"));
	const runtimeProbe = { oldSession: undefined };
	const recoveryUpdates = [];
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		executorHold: true,
		ports: {
			runtime: {
				async getState(binding) {
					return runtimeProbe.oldSession !== undefined && binding.sessionId === runtimeProbe.oldSession
						? "unreachable"
						: "idle";
				},
			},
		},
	});
	const running = await admitAndStart(service, "runtime-rebind");
	runtimeProbe.oldSession = running.execution.pi.sessionId;
	const releaseOldTurn = controls.releaseExecutor;
	assert.ok(releaseOldTurn);
	const promptsBeforeRecovery = controls.prompts.length;
	controls.executorHold = false;
	const observed = await service.inspectRuntime(running.workId);
	const result = await service.perform({
		action: "recover",
		workId: running.workId,
		input: {},
		meta: meta("user", "runtime-rebind:recover", observed.revision, running.workId),
		onRecoveryUpdate: (update) => recoveryUpdates.push(update),
	});
	assert.equal("error" in result, false);
	assert.deepEqual(
		new Set(recoveryUpdates.map((update) => update.stage)),
		new Set(["checking", "stopping", "restoring", "confirming", "finishing"]),
	);
	assert.equal(recoveryUpdates.at(-1).stage, "finishing");
	releaseOldTurn();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(controls.prompts.length, promptsBeforeRecovery + 1);
	const recovered = service.inspectWork(running.workId);
	assert.equal(recovered.execution.executionId, running.execution.executionId);
	assert.equal(recovered.execution.runtimeState, "idle");
	await service.close();
});

test("runtime inspection refreshes active Work without writing the Archive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-view-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: { runtime: { async getState() { return "working"; } } },
	});
	const running = await admitAndStart(service, "runtime-view");
	const before = service.inspectWork(running.workId);
	const observed = await service.inspectRuntime(running.workId);
	assert.equal(observed.execution.runtimeState, "working");
	assert.equal(observed.nextAction, "Executor is working.");
	assert.equal(observed.revision, before.revision);
	await service.close();
});

test("unreachable runtime recovery fails closed and is visible to another Archive reader", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-recovery-"));
	const path = join(directory, "archive.sqlite");
	const { service, controls } = makeService(path);
	const running = await admitAndStart(service, "runtime-recovery");
	controls.runtimeState = "unreachable";
	const observed = await service.inspectRuntime(running.workId);
	assert.equal(observed.execution.runtimeState, "unreachable");
	assert.equal(observed.nextAction, "Executor runtime is unreachable; recover it from Actions.");
	const actions = service.availableActions(
		observed.workId,
		"user",
		observed.revision,
		observed.execution.runtimeState,
	);
	assert.equal(actions[0].kind, "recover");
	assert.equal(actions[1].kind, "cancel");
	assert.equal(actions.find((action) => action.kind === "recover")?.enabled, true);
	const result = await service.perform({
		action: "recover",
		workId: observed.workId,
		input: {},
		meta: meta("user", "runtime-recovery:recover", observed.revision, observed.workId),
	});
	assert.equal("error" in result, false);
	assert.equal(result.value.execution.state, "failed");
	assert.equal(result.value.execution.runtimeState, "unreachable");
	assert.equal(result.value.nextAction, "Execution runtime unavailable; replace it explicitly.");

	const observer = makeService(path);
	const visible = observer.service.inspectWork(observed.workId);
	assert.equal(visible.execution.state, "failed");
	assert.equal(visible.execution.runtimeState, "unreachable");
	const records = observer.service.readRecords(
		{ workId: observed.workId, kinds: ["error"] },
		meta("user", "runtime-recovery:observe", visible.revision),
	);
	assert.equal(records.items.some((record) => record.summary.includes("could not be reconciled")), true);
	await observer.service.close();
	await service.close();
});

test("cancelled Work can be explicitly recovered for fresh admission", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-cancel-recovery-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Recoverable Work", objective: "Verify recovery", acceptanceCriteria: ["The Work can be recovered"] },
		meta("user", "cancel-recovery:submit", 0),
	);
	const cancelled = await service.perform({
		action: "cancel",
		workId: submitted.workId,
		input: {},
		meta: meta("user", "cancel-recovery:cancel", submitted.revision, submitted.workId),
	});
	assert.equal(cancelled.value.state, "cancelled");
	const recovery = service.availableActions(cancelled.value.workId, "user", cancelled.value.revision).find(
		(action) => action.kind === "recover",
	);
	assert.equal(recovery?.enabled, true);
	const recovered = await service.perform({
		action: "recover",
		workId: submitted.workId,
		input: {},
		meta: meta("user", "cancel-recovery:recover", cancelled.value.revision, submitted.workId),
	});
	assert.equal("error" in recovered, false);
	assert.equal(recovered.value.state, "submitted");
	assert.equal(recovered.value.mission, undefined);
	assert.equal(recovered.value.execution, undefined);
	assert.equal(recovered.value.nextAction, "Recovered Work is pending Conclave admission.");
	const admitted = await service.perform({
		action: "admit",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", "cancel-recovery:admit", recovered.value.revision, submitted.workId),
	});
	assert.equal(admitted.value.state, "queued");
	await service.close();
});

test("a Work reaches success through branch publication, handoff, polling, and outcome evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-lifecycle-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "success");
	assert.equal(running.state, "active");
	assert.equal(running.execution.state, "running");
	assert.equal(controls.prompts.some((entry) => entry.message.includes("is bound")), true);

	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "success:review", running.revision, running.workId, running.execution.executionId) });
	assert.equal(review.value.reviewRequest.sourceBranch, running.execution.sandbox.branch);
	assert.equal(review.value.reviewRequest.headCommit, "head");
	assert.equal(controls.published.length, 1);
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready for review", evidence: ["head", "diff", "validation"] }, meta: meta("executor", "success:ready", review.value.revision, running.workId, running.execution.executionId) });
	const conclavesBeforeReadyWake = controls.sessions.filter((entry) => entry.input.role === "conclave").length;
	await service.processPendingEffects();
	assert.equal(controls.sessions.filter((entry) => entry.input.role === "conclave").length > conclavesBeforeReadyWake, true);
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "The evidence is complete", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "success:handoff", ready.value.revision, running.workId) });
	assert.equal(handoff.value.state, "awaiting-review");

	const merged = await service.perform({ action: "record-review", workId: running.workId, input: { status: "merged" }, meta: meta("user", "success:reviewed", handoff.value.revision) });
	controls.outcome = true;
	const observed = await service.pollProvider(running.workId, meta("user", "success:poll", merged.value.revision));
	assert.equal(observed.lastObservation.status, "merged");
	controls.outcome = false;
	controls.pollObservations = [{ observationId: "ci:42", kind: "ci-status", providerId: "42", status: "observed", summary: "Checks passed", changed: true, observedAt: new Date().toISOString() }];
	const refreshed = await service.pollProvider(running.workId, meta("user", "success:poll-ci", observed.revision));
	assert.equal(refreshed.lastObservation.kind, "ci-status");
	const outcome = await service.perform({ action: "record-outcome", workId: running.workId, input: {}, meta: meta("conclave", "success:outcome", refreshed.revision, running.workId) });
	assert.equal(outcome.value.state, "succeeded");
	assert.equal(outcome.value.missionState, "succeeded");
	await service.processPendingEffects();
	assert.equal(controls.cleaned.some((sandbox) => sandbox.branch === running.execution.sandbox.branch), true);
	assert.equal(controls.stopped.some((binding) => binding.sessionId.startsWith("executor-")), true);
	await service.close();
});

test("Provider polling remains idempotent across restart for multi-observation polls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-observations-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const running = await admitAndStart(first.service, "observations");
	const review = await first.service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "observations:review", running.revision, running.workId, running.execution.executionId) });
	const ci = { observationId: "ci:42", kind: "ci-status", providerId: "42", status: "passed", summary: "Checks passed", changed: true, observedAt: new Date().toISOString() };
	const merge = { observationId: "merge:42", kind: "provider-outcome", providerId: "42", status: "merged", repository: review.value.reviewRequest.repository, summary: "Merged", sourceBranch: review.value.reviewRequest.sourceBranch, targetBranch: review.value.reviewRequest.targetBranch, headCommit: review.value.reviewRequest.headCommit, mergeCommit: "merge-commit", changed: true, observedAt: new Date().toISOString() };
	first.controls.pollObservations = [ci];
	first.controls.outcomeObservation = merge;
	const observed = await first.service.pollProvider(running.workId, meta("user", "observations:poll", review.value.revision));
	await first.service.close();

	const second = makeService(path);
	second.controls.pollObservations = [ci];
	second.controls.outcomeObservation = merge;
	const replayed = await second.service.pollProvider(running.workId, meta("user", "observations:replay", observed.revision));
	assert.equal(replayed.revision, observed.revision);
	await second.service.close();
});

test("authorized review feedback resumes the same Execution instead of leaving it idle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "feedback");
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback:review", running.revision, running.workId, running.execution.executionId) });
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "feedback:ready", review.value.revision, running.workId, running.execution.executionId) });
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "feedback:handoff", ready.value.revision, running.workId) });
	const reviewed = await service.perform({ action: "record-review", workId: running.workId, input: { status: "changes-requested", feedback: ["Add the missing regression test."] }, meta: meta("user", "feedback:changes", handoff.value.revision) });
	assert.equal(reviewed.value.state, "active");
	assert.equal(reviewed.value.execution.state, "running");
	assert.equal(reviewed.value.missionState, "active");
	await service.processPendingEffects();
	assert.equal(controls.prompts.some((entry) => entry.message.includes("missing regression test")), true);
	const resumed = service.inspectWork(running.workId);
	controls.head = "feedback-head";
	const republished = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback:republish", resumed.revision, running.workId, running.execution.executionId) });
	assert.equal(republished.value.reviewRequest.headCommit, "feedback-head");
	const readyAgain = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Updated and validated", evidence: ["feedback-head", "validation"] }, meta: meta("executor", "feedback:ready-again", republished.value.revision, running.workId, running.execution.executionId) });
	assert.equal(readyAgain.value.lastSignal.kind, "ready");
	await service.close();
});

test("Feedback waits for an active Executor turn instead of being dropped", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-feedback-race-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { executorHold: true });
	const submitted = service.submitWork({ title: "Feedback race", objective: "Deliver feedback", acceptanceCriteria: ["Feedback is delivered"] }, meta("user", "feedback-race:submit", 0));
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "feedback-race:admit", submitted.revision, submitted.workId) });
	await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "feedback-race:start", admitted.value.revision, submitted.workId) });
	await service.processPendingEffects();
	const running = service.inspectWork(submitted.workId);
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "feedback-race:review", running.revision, running.workId, running.execution.executionId) });
	const ready = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "feedback-race:ready", review.value.revision, running.workId, running.execution.executionId) });
	const handoff = await service.perform({ action: "verdict", workId: running.workId, input: { decision: "handoff", reason: "Review it", signalId: ready.value.lastSignal.signalId }, meta: meta("conclave", "feedback-race:handoff", ready.value.revision, running.workId) });
	const changed = await service.perform({ action: "record-review", workId: running.workId, input: { status: "changes-requested", feedback: ["Fix the edge case."] }, meta: meta("user", "feedback-race:changes", handoff.value.revision) });
	const processing = service.processPendingEffects();
	controls.executorHold = false;
	controls.releaseExecutor();
	await processing;
	assert.equal(controls.prompts.some((entry) => entry.message.includes("Fix the edge case.")), true);
	assert.equal(service.inspectWork(running.workId).revision > changed.value.revision, true);
	await service.close();
});

test("Verdicts resume blocked Executors and prevent rejected Missions from restarting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-verdicts-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "verdicts");
	const blocked = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "blocked", summary: "Waiting for a decision", evidence: ["blocked"] },
		meta: meta("executor", "verdicts:blocked", running.revision, running.workId, running.execution.executionId),
	});
	await service.processPendingEffects();
	const executorPrompts = () => controls.prompts.filter((entry) => entry.binding.sessionId.startsWith("executor-")).length;
	const beforeContinue = executorPrompts();
	const continued = await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "continue", reason: "The Executor can continue", signalId: blocked.value.lastSignal.signalId },
		meta: meta("conclave", "verdicts:continue", blocked.value.revision, running.workId),
	});
	await service.processPendingEffects();
	assert.equal(continued.value.execution.state, "running");
	assert.equal(executorPrompts() > beforeContinue, true);
	const continuedCurrent = service.inspectWork(running.workId);
	const progress = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "progress", summary: "Progress before rejection", evidence: ["progress"] },
		meta: meta("executor", "verdicts:progress", continuedCurrent.revision, running.workId, running.execution.executionId),
	});
	const rejected = await service.perform({
		action: "verdict",
		workId: running.workId,
		input: { decision: "reject", reason: "The Mission no longer applies", signalId: progress.value.lastSignal.signalId },
		meta: meta("conclave", "verdicts:reject", progress.value.revision, running.workId),
	});
	assert.equal(rejected.value.missionState, "rejected");
	assert.equal(service.availableActions(running.workId, "conclave").find((action) => action.kind === "start-execution").enabled, false);
	const restart = await service.perform({
		action: "start-execution",
		workId: running.workId,
		input: {},
		meta: meta("conclave", "verdicts:restart", rejected.value.revision, running.workId),
	});
	assert.equal(restart.error.code, "invalid-state");
	await service.close();
});

test("child role sessions resolve the parent project Archive instead of their sandbox Archive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-shared-archive-"));
	const project = await mkdtemp(join(directory, "project-"));
	const sandbox = await mkdtemp(join(directory, "sandbox-"));
	const names = ["PI_CODING_AGENT_DIR", "KHALA_PROJECT_PATH", "KHALA_PROJECT_TRUSTED", "KHALA_BOUND_WORK_ID", "KHALA_ROLE_TOKEN"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	let parent;
	let child;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		delete process.env.KHALA_PROJECT_PATH;
		delete process.env.KHALA_PROJECT_TRUSTED;
		delete process.env.KHALA_ROLE_TOKEN;
		parent = createApplication(project, false, process.cwd(), { requireModels: false });
		const submitted = parent.service.submitWork({ title: "Shared Archive", objective: "Use the parent project archive", acceptanceCriteria: ["The child sees the Work"] }, meta("user", "shared:submit", 0));
		process.env.KHALA_PROJECT_PATH = project;
		process.env.KHALA_PROJECT_TRUSTED = "0";
		process.env.KHALA_BOUND_WORK_ID = submitted.workId;
		process.env.KHALA_ROLE_TOKEN = "unused";
		child = createApplication(sandbox, false, process.cwd(), { requireModels: false });
		assert.equal(child.service.inspectWork(submitted.workId).workId, submitted.workId);
	} finally {
		if (child !== undefined) await child.service.close();
		if (parent !== undefined) await parent.service.close();
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("a queued Execution is resumed after a crash window without creating a second attempt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovery-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path);
	const submitted = first.service.submitWork({ title: "Recovery feature", objective: "Recover queued work", acceptanceCriteria: ["The same attempt resumes"] }, meta("user", "recovery:submit", 0));
	const admitted = await first.service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "recovery:admit", submitted.revision, submitted.workId) });
	const queued = await first.service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "recovery:start", admitted.value.revision, submitted.workId) });
	const executionId = queued.value.execution.executionId;
	assert.equal(queued.value.execution.state, "queued");
	await first.service.close();

	const second = makeService(path);
	const current = second.service.inspectWork(submitted.workId);
	const recovered = await second.service.recoverWork(submitted.workId, meta("user", "recovery:resume", current.revision));
	assert.equal(recovered.execution.executionId, executionId);
	assert.equal(recovered.execution.state, "running");
	await second.service.processPendingEffects();
	const running = second.service.inspectWork(submitted.workId);
	assert.equal(running.execution.executionId, executionId);
	const reconciled = await second.service.recoverWork(submitted.workId, meta("user", "recovery:already-running", running.revision));
	assert.equal(reconciled.revision, running.revision);
	await second.service.close();
});

test("Concurrent idempotent starts clean up the losing sandbox", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-start-race-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork({ title: "Start race", objective: "Start once", acceptanceCriteria: ["One Execution is reserved"] }, meta("user", "start-race:submit", 0));
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "start-race:admit", submitted.revision, submitted.workId) });
	const command = { action: "start-execution", workId: submitted.workId, input: {}, meta: meta("conclave", "start-race:start", admitted.value.revision, submitted.workId) };
	const results = await Promise.all([service.perform(command), service.perform(command)]);
	assert.equal("value" in results[0], true);
	assert.equal("value" in results[1], true);
	assert.equal(results[0].value.execution.executionId, results[1].value.execution.executionId);
	assert.equal(controls.cleaned.length, 1);
	await service.close();
});

test("Observer evidence is read-only, bound to one Work, and becomes admission context", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-observer-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { observerHold: true });
	const submitted = service.submitWork({ title: "Context feature", objective: "Use repository facts", acceptanceCriteria: ["Facts are used"] }, meta("user", "observer:submit", 0));
	const launched = await service.perform({ action: "launch-observer", workId: submitted.workId, input: {}, meta: meta("conclave", "observer:launch", submitted.revision, submitted.workId) });
	assert.equal(launched.value.observerInFlight, true);
	await service.processPendingEffects();
	const bound = service.inspectWork(submitted.workId);
	assert.deepEqual(controls.sessions.find((entry) => entry.input.role === "observer").input.tools, ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"]);
	const denied = await service.perform({ action: "record-assessment", workId: submitted.workId, input: { summary: "Facts", evidence: ["README.md"] }, meta: meta("observer", "observer:wrong-scope", bound.revision, "other-work") });
	assert.equal(denied.error.code, "forbidden");
	const assessment = await service.perform({ action: "record-assessment", workId: submitted.workId, input: { summary: "The project uses SQLite", evidence: ["src/archive.ts"] }, meta: meta("observer", "observer:record", bound.revision, submitted.workId) });
	assert.equal(assessment.value.observerInFlight, false);
	assert.match(assessment.value.terms.context, /The project uses SQLite/);
	assert.equal(service.availableActions(submitted.workId, "conclave").find((action) => action.kind === "launch-observer").enabled, false);
	await service.processPendingEffects();
	assert.equal(controls.stopped.some((binding) => binding.sessionId.startsWith("observer-")), true);
	controls.releaseObserver();
	await service.close();
});

test("project concurrency reserves a slot before runtime launch and reports external failures distinctly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-concurrency-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path, { maxConcurrentExecutions: 1 });
	const firstSubmitted = first.service.submitWork({ title: "First", objective: "Use the first slot", acceptanceCriteria: ["It starts"] }, meta("user", "slots:first-submit", 0));
	const firstAdmitted = await first.service.perform({ action: "admit", workId: firstSubmitted.workId, input: {}, meta: meta("conclave", "slots:first-admit", firstSubmitted.revision, firstSubmitted.workId) });
	const firstQueued = await first.service.perform({ action: "start-execution", workId: firstSubmitted.workId, input: {}, meta: meta("conclave", "slots:first-start", firstAdmitted.value.revision, firstSubmitted.workId) });
	assert.equal(firstQueued.value.execution.state, "queued");
	const secondSubmitted = first.service.submitWork({ title: "Second", objective: "Wait for the slot", acceptanceCriteria: ["It waits"] }, meta("user", "slots:second-submit", 0));
	const secondAdmitted = await first.service.perform({ action: "admit", workId: secondSubmitted.workId, input: {}, meta: meta("conclave", "slots:second-admit", secondSubmitted.revision, secondSubmitted.workId) });
	const secondStart = await first.service.perform({ action: "start-execution", workId: secondSubmitted.workId, input: {}, meta: meta("conclave", "slots:second-start", secondAdmitted.value.revision, secondSubmitted.workId) });
	assert.equal(secondStart.value.execution, undefined);
	await first.service.close();

	const failure = makeService(join(directory, "failure.sqlite"), { ports: { workspace: { async publishSandbox() { throw new Error("push failed"); } } } });
	const running = await admitAndStart(failure.service, "external");
	const result = await failure.service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "external:review", running.revision, running.workId, running.execution.executionId) });
	assert.equal(result.error.code, "external-failure");
	assert.equal(result.error.retryable, true);
	await failure.service.close();
});

test("Executor authority is bound to the current Work and ready evidence rejects a stale head", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-authority-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "authority");
	const denied = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "progress", summary: "Progress", evidence: ["file"] }, meta: meta("executor", "authority:wrong-work", running.revision, "other-work", running.execution.executionId) });
	assert.equal(denied.error.code, "forbidden");
	const scopedRecords = service.readRecords(
		{ workId: running.workId },
		meta("executor", "authority:scoped-read", 0, running.workId, running.execution.executionId),
	);
	assert.equal(scopedRecords.items.every((record) => record.executionId === undefined || record.executionId === running.execution.executionId), true);
	const mismatchedRead = { ...meta("conclave", "authority:mismatched-read", 0, running.workId), actor: "executor" };
	assert.throws(() => service.readRecords({ workId: running.workId }, mismatchedRead), /does not match/);
	const other = service.submitWork({ title: "Other", objective: "Other Work", acceptanceCriteria: ["It remains separate"] }, meta("user", "authority:other-submit", 0));
	const wrongConclave = await service.perform({ action: "admit", workId: other.workId, input: {}, meta: meta("conclave", "authority:wrong-conclave", other.revision, running.workId) });
	assert.equal(wrongConclave.error.code, "forbidden");
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "authority:review", running.revision, running.workId, running.execution.executionId) });
	controls.head = "changed-after-publication";
	const stale = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "authority:stale", review.value.revision, running.workId, running.execution.executionId) });
	assert.equal(stale.error.code, "invalid-state");
	controls.outcomeObservation = { observationId: "bad", kind: "provider-outcome", providerId: "42", status: "observed", summary: "Not a merge", changed: true, observedAt: new Date().toISOString() };
	await assert.rejects(
		service.pollProvider(running.workId, meta("user", "authority:bad-observation", review.value.revision)),
		/merged reviewed/,
	);
	await service.close();
});

test("Archive appends validate projections and claim each external effect once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const projection = {
		workId: "w1",
		revision: 1,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
	};
	const input = { commandId: "command-1", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "w1", payloadVersion: 1, summary: "submitted", payload: projection.terms, projection };
	const first = archive.append(input);
	const duplicate = archive.append(input);
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.record.sequence, first.record.sequence);
	assert.equal(archive.project("w1").queuedSequence, first.record.sequence);
	assert.equal(archive.query({ states: ["submitted"] }).items.length, 1);
	assert.throws(() => archive.append({ ...input, workId: "w2" }), /already used for Work w1/);
	archive.append({ ...input, commandId: "command-3", expectedWorkRevision: 1, projection: { ...projection, revision: 2, state: "queued" }, effects: [{ effectId: "effect-1", kind: "conclave-wake", payload: { workId: "w1" } }] });
	assert.equal(archive.pendingEffects("owner-a").length, 1);
	assert.equal(archive.pendingEffects("owner-b").length, 0);
	archive.completeEffect("effect-1", "owner-a");
	assert.equal(archive.pendingEffects("owner-b").length, 0);
	archive.close();
});

test("a real RPC child is bounded and removed after an agent turn timeout", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `import readline from "node:readline";\nconst input = readline.createInterface({ input: process.stdin });\ninput.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: "${join(directory, "session.jsonl")}", isStreaming: false } }) + "\\n"); else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n"); });\n`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ command: [process.execPath, script], rpcTimeoutMs: 100, agentTimeoutMs: 30 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	await assert.rejects(runtime.send(binding, "never completes"), /timed out/);
	assert.equal(await runtime.getState(binding), "unreachable");
	await runtime.close();
});

test("a real RPC child waits for each prompt completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-turns-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `import readline from "node:readline";\nconst input = readline.createInterface({ input: process.stdin });\nlet turns = 0;\ninput.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: "${join(directory, "session.jsonl")}", isStreaming: false } }) + "\\n"); else if (request.type === "prompt") { turns += 1; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n"); if (turns === 1) process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first output" }], usage: { input: 11, output: 7, cacheRead: 13, cacheWrite: 5 } } }) + "\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n"), turns === 2 ? 50 : 0); } });\n`);
	const runtime = new PiRpcRuntime({ command: [process.execPath, script], rpcTimeoutMs: 100, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	assert.deepEqual(await runtime.send(binding, "first"), {
		output: "first output",
		usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 16 },
	});
	const second = runtime.send(binding, "second");
	const earlyResult = await Promise.race([second.then(() => "completed"), new Promise((resolve) => setTimeout(() => resolve("pending"), 10))]);
	assert.equal(earlyResult, "pending");
	assert.deepEqual(await second, { output: "" });
	await runtime.close();
});

test("GitHub publication uses the sandbox branch and current head", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-code-host-"));
	const commandDirectory = await mkdtemp(join(directory, "bin-"));
	const log = join(directory, "commands.log");
	const gh = join(commandDirectory, "gh");
	await writeFile(gh, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nif (args[0] === "api") process.stdout.write("principal\\n");\nelse if (args[0] === "repo") process.stdout.write("example/project\\n");\nelse if (args[1] === "list") process.stdout.write("[]");\nelse if (args[1] === "create") process.stdout.write("https://github.com/example/project/pull/42\\n");\nelse if (args[1] === "view") process.stdout.write(JSON.stringify({ number: 42, url: "https://github.com/example/project/pull/42", state: "OPEN", isDraft: true, headRefName: "khala/branch", baseRefName: "main", headRefOid: "head" }));\nelse if (args[1] === "diff") process.stdout.write("diff");\n`);
	await chmod(gh, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${commandDirectory}:${previousPath ?? ""}`;
	try {
		const host = new CommandCodeHost("github", directory);
		const request = await host.ensureReviewRequest({
			workId: "work-1",
			mission: { missionId: "mission-1", workId: "work-1", assignment: { title: "Feature", objective: "Implement", context: "", scope: "scope", acceptanceCriteria: ["works"], constraints: [], validation: ["npm test"], maxTokens: 100 }, mandateRevision: 1, createdAt: new Date().toISOString() },
			execution: { executionId: "execution-1", workId: "work-1", missionId: "mission-1", state: "running", model: "model", thinking: "high", tokenAllowance: 50, promptIdentity: { packageVersion: "1", promptSha256: "hash" }, sandbox: { path: directory, baseCommit: "base", branch: "khala/branch" } },
			terms: { title: "Feature", objective: "Implement", context: "", scope: "scope", acceptanceCriteria: ["works"], constraints: [], validation: ["npm test"], maxTokens: 100 },
			sandbox: { path: directory, baseCommit: "base", branch: "khala/branch" },
			headCommit: "head",
			targetBranch: "main",
			draftMarker: "Khala-Work: work-1",
		});
		assert.equal(request.sourceBranch, "khala/branch");
		const commands = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const create = commands.find((args) => args[1] === "create");
		assert.equal(create.includes("--head"), true);
		assert.equal(create[create.indexOf("--head") + 1], "khala/branch");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
});

test("Oracle keeps advisory output bounded and origin matching rejects lookalike hosts", async () => {
	const oracle = new PiOracle({
		async ensureSession() {
			return { sessionId: "oracle-session", sessionPath: "/tmp/oracle-session.jsonl" };
		},
		async send() {
			return { output: "Verdict: Needs revision\n\nFindings:\n- [major] Missing test | Evidence: no test result\n\nValidation gaps:\n- integration test not run" };
		},
		async getState() {
			return "idle";
		},
		async requestStop() {},
		async close() {},
	}, "/project", "1.1.0", "oracle prompt");
	const result = await oracle.review({ subject: "Review", mission: { missionId: "m", workId: "w", assignment: { title: "T", objective: "O", context: "", scope: "S", acceptanceCriteria: ["A"], constraints: [], validation: ["check"], maxTokens: 100 }, mandateRevision: 1, createdAt: new Date().toISOString() }, diff: "diff", validation: ["check"], providerEvidence: [] }, "provider/oracle", "high");
	assert.equal(result.verdict, "needs-revision");
	assert.equal(result.findings[0].summary, "Missing test");
	assert.equal(codeHostForOrigin("git@github.com:example/project.git", "/project").provider, "github");
	assert.equal(codeHostForOrigin("https://gitlab.com/example/project.git", "/project").provider, "gitlab");
	assert.throws(() => codeHostForOrigin("https://github.com.attacker.example/project.git", "/project"));
});
