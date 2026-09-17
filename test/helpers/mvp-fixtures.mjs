import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { dirname } from "node:path";
import { SQLiteArchive } from "../../dist/src/archive.js";
import { ApplicationService } from "../../dist/src/service.js";

const authority = generateKeyPairSync("ed25519");
const ROLE_PUBLIC_KEY = authority.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const TEST_CAPABILITY_NONCE = "test-capability-nonce";
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function mockBinding(input, controls) {
	const sessionNumber = controls.sessions.length + 1;
	return {
		sessionId: `${input.role}-${sessionNumber}`,
		sessionPath: `/tmp/${input.role}-${sessionNumber}.jsonl`,
		capabilityNonce: input.tools.length === 0 ? undefined : TEST_CAPABILITY_NONCE,
	};
}

function recoverMockExecutor(input, controls) {
	if (input.role === "executor" && controls.recoverExecutor && controls.runtimeState === "unreachable")
		controls.runtimeState = "idle";
}

async function mockEnsureSession(input, controls) {
	const binding = mockBinding(input, controls);
	controls.sessions.push({ input, binding });
	recoverMockExecutor(input, controls);
	return binding;
}

function isMockSession(binding, role) {
	return binding.sessionId.startsWith(`${role}-`);
}

async function wakeMockConclave(binding, message, controls) {
	if (isMockSession(binding, "conclave") && controls.onConclaveWake !== undefined)
		await controls.onConclaveWake(message);
}

function holdMockObserver(binding, controls) {
	if (!controls.observerHold || !isMockSession(binding, "observer")) return undefined;
	return new Promise((resolve) => {
		controls.releaseObserver = () => resolve({ output: "", usage: ZERO_USAGE });
	});
}

function holdMockExecutor(binding, controls) {
	if (!controls.executorHold || !isMockSession(binding, "executor")) return undefined;
	return new Promise((resolve) => {
		controls.releaseExecutor = () => resolve({ output: "", usage: ZERO_USAGE });
	});
}

function mockFeedbackFailureRequested(message, controls) {
	if (!controls.failFeedbackOnce || !message.includes("Review feedback delivery")) return false;
	controls.failFeedbackOnce = false;
	return true;
}

function mockTurn(binding, controls) {
	return {
		output: "",
		usage: controls.missingUsage ? undefined : isMockSession(binding, "executor") ? controls.turnUsage ?? ZERO_USAGE : ZERO_USAGE,
	};
}

function assertMockSendAllowance(message, options, controls) {
	const { tokenAllowance } = options;
	assert.equal(Number.isSafeInteger(tokenAllowance), true);
	assert.ok(tokenAllowance > 0);
	if (controls.archive === undefined) return;
	const identity = message.match(/Invocation run ID: ([\w-]+)\./);
	assert.ok(identity, "Governed prompts must identify their reserved invocation");
	const runId = identity[1];
	const reservation = controls.archive.findCommand(`invocation-reserve:${runId}`);
	assert.ok(reservation, "The invocation must be durably reserved before sending");
	assert.equal(tokenAllowance, reservation.record.payload.allowance);
	const work = controls.archive.project(reservation.record.workId);
	assert.ok(work.activeInvocations.some((run) => run.runId === runId));
}

async function mockSend(binding, message, options, controls) {
	assertMockSendAllowance(message, options, controls);
	controls.prompts.push({ binding, message, tokenAllowance: options.tokenAllowance });
	await wakeMockConclave(binding, message, controls);
	const held = holdMockObserver(binding, controls) ?? holdMockExecutor(binding, controls);
	if (held !== undefined) return held;
	if (mockFeedbackFailureRequested(message, controls)) throw new Error("simulated feedback delivery failure");
	return mockTurn(binding, controls);
}

function makePorts(overrides = {}) {
	const { ports: portOverrides = {}, maxConcurrentExecutions: _maxConcurrentExecutions, ...controlOverrides } = overrides;
	const controls = {
		head: "head",
		outcome: false,
		outcomeObservation: undefined,
		pollObservations: [],
		turnUsage: undefined,
		missingUsage: false,
		runtimeState: "idle",
		recoverExecutor: false,
		observerHold: false,
		releaseObserver: undefined,
		executorHold: false,
		failFeedbackOnce: false,
		releaseExecutor: undefined,
		published: [],
		sessions: [],
		prompts: [],
		onConclaveWake: undefined,
		stopped: [],
		cleaned: [],
		...controlOverrides,
	};
	const runtime = {
		ensureSession(input) {
			return mockEnsureSession(input, controls);
		},
		send(binding, message, options) {
			return mockSend(binding, message, options, controls);
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
		async prepareSandbox(sandbox) {
			return {
				schemaVersion: 1,
				sandboxPath: sandbox.path,
				baseCommit: sandbox.baseCommit,
				manifestSha256: EMPTY_SHA256,
				lockfileSha256: EMPTY_SHA256,
				runtime: { node: process.version, npm: "test-fixture" },
				policy: { registries: ["registry.npmjs.org"], maxArtifactBytes: 52_428_800, maxPreparationBytes: 524_288_000, maxConcurrentDownloads: 2, timeoutMs: 120_000 },
				artifactDigests: [],
				preparedAt: "2020-01-01T00:00:00.000Z",
			};
		},
		async inspectHead() {
			return controls.head;
		},
		async inspectChanges() {
			return [];
		},
		async runValidation({ commands }) {
			return commands.map((command) => ({ command, passed: true, output: "fixture validation passed" }));
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
					return { usage: ZERO_USAGE, verdict: "pass", findings: [], validationGaps: [], durationMs: 1, output: "Verdict: Pass" };
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
	fake.controls.archive = archive;
	const service = new ApplicationService(archive, fake.ports, {
		projectPath: dirname(path),
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
		oraclePromptIdentity: { packageVersion: "1.1.0", promptSha256: "oracle" },
		rolePublicKey: ROLE_PUBLIC_KEY,
		supervision: overrides.supervision ?? "candidate",
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

async function validateWork(service, work, commandId) {
	const result = await service.perform({
		action: "run-validation",
		workId: work.workId,
		input: {},
		meta: meta("executor", commandId, work.revision, work.workId, work.execution.executionId),
	});
	assert.equal("value" in result, true);
	assert.equal(result.value.lastValidation.sourceVerified, true);
	return result.value;
}

function restorePath(value) {
	if (value === undefined) delete process.env.PATH;
	else process.env.PATH = value;
}

export { makeService, meta, admitAndStart, validateWork, restorePath, ZERO_USAGE, authority };
