import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvocationCapacityExceeded } from "../dist/src/archive.js";
import { RunGateUnavailable } from "../dist/src/service-contracts.js";
import { DispatchEligibilityError } from "../dist/src/workflow-dispatch.js";
import { makeService, meta, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";

function terms() {
	return {
		title: "Dispatch",
		objective: "Test dispatch deferral",
		context: "",
		scope: "scope",
		acceptanceCriteria: ["The dispatch remains retryable"],
		constraints: [],
		validation: ["check"],
		allowedPaths: ["."],
		maxTokens: 100,
	};
}

function executionWork(workId) {
	const mission = { missionId: `mission-${workId}`, workId, assignment: terms(), mandateRevision: 1, createdAt: new Date().toISOString() };
	const execution = {
		executionId: `execution-${workId}`,
		workId,
		missionId: mission.missionId,
		state: "running",
		runtimeState: "idle",
		model: "provider/executor",
		thinking: "medium",
		tokenAllowance: 50,
		promptIdentity: { packageVersion: "test", promptSha256: "test" },
		sandbox: { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" },
		pi: { sessionId: "executor-session", sessionPath: "/tmp/executor" },
	};
	return {
		workId,
		revision: 1,
		state: "active",
		terms: terms(),
		budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 },
		mission,
		missionState: "active",
		execution,
		nextAction: "Executor is idle.",
		queuedSequence: 1,
	};
}

function observerWork(workId) {
	return {
		workId,
		revision: 1,
		state: "submitted",
		terms: terms(),
		budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 },
		observerInFlight: true,
		nextAction: "Observer is queued.",
		queuedSequence: 1,
	};
}

function queuedExecutionWork(workId) {
	const work = executionWork(workId);
	return {
		...work,
		execution: { ...work.execution, state: "queued", runtimeState: undefined, pi: undefined },
		nextAction: "Executor is starting.",
	};
}

function boundObserverWork(workId) {
	return {
		...observerWork(workId),
		observer: { sessionId: "observer-session", sessionPath: "/tmp/observer-session.jsonl" },
	};
}

function seed(archive, work, effect) {
	archive.append({
		commandId: `seed:${work.workId}`,
		expectedWorkRevision: 0,
		kind: "execution",
		actor: "system",
		workId: work.workId,
		missionId: work.mission?.missionId,
		executionId: work.execution?.executionId,
		payloadVersion: 1,
		summary: "seed",
		payload: {},
		projection: work,
		effects: [effect],
	});
}

function cases() {
	return [
		{
			role: "executor",
			work: executionWork("executor-dispatch-deferral"),
			effect: {
				effectId: "executor-dispatch-deferral:wake",
				kind: "executor-wake",
				payload: { workId: "executor-dispatch-deferral" },
			},
		},
		{
			role: "feedback",
			work: executionWork("feedback-dispatch-deferral"),
			effect: {
				effectId: "feedback-dispatch-deferral:wake",
				kind: "feedback-wake",
				payload: { workId: "feedback-dispatch-deferral", executionId: "execution-feedback-dispatch-deferral", feedback: ["Address the requested change."] },
			},
		},
		{
			role: "observer",
			work: observerWork("observer-dispatch-deferral"),
			effect: {
				effectId: "observer-dispatch-deferral:wake",
				kind: "observer-wake",
				payload: { workId: "observer-dispatch-deferral" },
			},
		},
	];
}

function deferrableErrors() {
	return [new RunGateUnavailable(), new InvocationCapacityExceeded(), new DispatchEligibilityError("budget-exhausted")];
}

function assertDeferredDispatch(role, current, archive, failure, effect, workId) {
	const errors = archive.query({ workId, kinds: ["error"] }).items;
	if (failure instanceof DispatchEligibilityError) {
		assert.equal(current.lastError.code, "budget-exhausted");
		assert.equal(errors.length, 1);
	} else {
		assert.equal(current.lastError, undefined, `${role} dispatch recorded a durable error`);
		assert.equal(errors.length, 0);
	}
	assert.equal(current.observerInFlight, role === "observer" ? true : undefined);
	if (role !== "observer") {
		assert.equal(current.execution.state, "running");
		assert.notEqual(current.execution.runtimeState, "unreachable");
	}
	assert.deepEqual(archive.pendingEffects("assertion").map(({ effectId }) => effectId), [effect.effectId]);
	archive.releaseEffect(effect.effectId, "assertion");
}

function assertGenuineDispatchFailure(role, current, archive, workId) {
	if (role === "observer") {
		assert.equal(current.observerInFlight, false);
		assert.equal(archive.query({ workId, kinds: ["error"] }).items.some(({ summary }) => summary === "Observer runtime failed."), true);
		return;
	}
	assert.equal(current.execution.state, role === "executor" ? "failed" : "running");
	assert.equal(current.execution.runtimeState, "unreachable");
	if (role === "feedback") {
		assert.equal(
			archive.query({ workId, kinds: ["delivery"] }).items.some(({ payload }) => payload.message === "provider runtime failed"),
			true,
		);
	}
}

test("executor, feedback, and observer dispatch gates remain retryable", async () => {
	for (const { role, work, effect } of cases()) {
		const directory = await mkdtemp(join(tmpdir(), `khala-${role}-dispatch-deferral-`));
		const { service, archive } = makeService(join(directory, "archive.sqlite"));
		seed(archive, work, effect);
		try {
			for (const failure of deferrableErrors()) {
				service.invocations.dispatch = async () => { throw failure; };
				await service.processPendingEffects();
				assertDeferredDispatch(role, service.inspectWork(work.workId), archive, failure, effect, work.workId);
			}
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("subagent Conclave wakes remain queued until a user-session operation can run them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-subagent-wake-deferral-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	const work = service.submitWork(
		{
			title: "Queued Conclave wake",
			objective: "Wait for an active Pi tool call",
			acceptanceCriteria: ["The wake runs in the user session"],
			scope: "Test scope",
			validation: ["node --test"],
		},
		meta("user", "subagent-wake:submit", 0),
	);
	try {
		await service.processPendingEffects();
		assert.equal(controls.prompts.length, 0);
		assert.deepEqual(service.inspectWork(work.workId).activeInvocations ?? [], []);
		assert.equal(service.inspectWork(work.workId).budget.reservedTokens, 0);
		assert.deepEqual(archive.pendingEffects("assertion").map(({ effectId }) => effectId), [`conclave-wake:${work.workId}`]);
		assert.equal(service.conclaveWaitingForUserSession, true);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("subagent Conclave runs inside the active Khala tool operation and completes its receipt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-subagent-active-session-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	service.submitWork(
		{
			title: "Active Conclave subagent",
			objective: "Run Conclave from the current Khala tool call",
			acceptanceCriteria: ["Conclave executes in the parent Pi session"],
			scope: "Test scope",
			validation: ["node --test"],
		},
		meta("user", "active-subagent:submit", 0),
	);
	const calls = [];
	try {
		await service.processPendingEffects({
			sessionId: "parent-session",
			runConclaveSubagent: async (request) => {
				calls.push(request);
				const current = service.inspectWork(request.workId);
				const action = current.mission === undefined ? "admit" : "start-execution";
				const result = await service.perform({
					action,
					workId: request.workId,
					input: {},
					meta: meta("conclave", `active-subagent:${request.runId}`, current.revision, request.workId),
				});
				assert.equal("error" in result, false);
				return { output: "Conclave decision recorded.", usage: ZERO_USAGE };
			},
		});
		assert.ok(calls.length > 0);
		assert.equal(calls.every((call) => call.sessionId === "parent-session"), true);
		assert.equal(controls.nestedInvocations.length, calls.length);
		assert.equal(controls.nestedInvocations.every((invocation) => invocation.complete), true);
		assert.equal(service.conclaveWaitingForUserSession, false);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a User-session drain retries a wake deferred by a concurrent background drain", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-concurrent-subagent-wake-"));
	const { service } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	const work = service.submitWork(
		{
			workId: "concurrent-subagent-wake",
			title: "Concurrent Subagent wake",
			objective: "Run a queued wake from the active User session",
			acceptanceCriteria: ["The pending wake runs in the User session"],
			scope: "Test scope",
			validation: ["node --test"],
		},
		meta("user", "concurrent-subagent:submit", 0),
	);
	let notifyStopWaiter;
	const stopWaiterStarted = new Promise((resolve) => {
		notifyStopWaiter = resolve;
	});
	let releaseStopWaiter;
	const stopWaiter = new Promise((resolve) => {
		releaseStopWaiter = resolve;
	});
	service.executorRuntime.stopStoppedTurns = async () => {
		notifyStopWaiter();
		await stopWaiter;
	};
	const calls = [];
	const operation = {
		sessionId: "parent-session",
		runConclaveSubagent: async (request) => {
			calls.push(request);
			const current = service.inspectWork(work.workId);
			const result = await service.perform({
				action: "request-input",
				workId: work.workId,
				input: { reason: "Clarify the task." },
				meta: meta("conclave", `concurrent-subagent:${request.runId}`, current.revision, work.workId),
			});
			assert.equal("error" in result, false);
			return { output: "Requested clarification.", usage: ZERO_USAGE };
		},
	};
	const backgroundRun = service.processPendingEffects();
	const userRun = service.processPendingEffects(operation);
	try {
		await stopWaiterStarted;
		await backgroundRun;
		releaseStopWaiter();
		await userRun;
		assert.equal(calls.length, 1);
		assert.equal(service.inspectWork(work.workId).state, "needs-input");
	} finally {
		releaseStopWaiter();
		await Promise.allSettled([backgroundRun, userRun]);
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("headless processing clears the queued Subagent status after draining its wake", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-headless-clears-subagent-queue-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { conclaveMode: "subagent" });
	const work = service.submitWork(
		{
			workId: "headless-clears-subagent-queue",
			title: "Deferred Subagent wake",
			objective: "Switch the queued wake to Headless",
			acceptanceCriteria: ["Headless handles the pending wake"],
			scope: "Test scope",
			validation: ["node --test"],
		},
		meta("user", "headless-clears-queue:submit", 0),
	);
	try {
		await service.processPendingEffects();
		assert.equal(service.conclaveWaitingForUserSession, true);
		service.updateRoleSetting("conclave", "mode", "headless");
		controls.onConclaveWake = async () => {
			const current = service.inspectWork(work.workId);
			const result = await service.perform({
				action: "request-input",
				workId: work.workId,
				input: { reason: "Clarify the task." },
				meta: meta("conclave", `headless-decision:${current.revision}`, current.revision, work.workId),
			});
			assert.equal("error" in result, false);
		};
		await service.processPendingEffects();
		assert.equal(service.inspectWork(work.workId).state, "needs-input");
		assert.equal(service.conclaveWaitingForUserSession, false);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("genuine dispatch errors still record runtime failures", async () => {
	for (const { role, work, effect } of cases()) {
		const directory = await mkdtemp(join(tmpdir(), `khala-${role}-dispatch-failure-`));
		const { service, archive } = makeService(join(directory, "archive.sqlite"));
		seed(archive, work, effect);
		try {
			service.invocations.dispatch = async () => { throw new Error("provider runtime failed"); };
			await service.processPendingEffects();
			assertGenuineDispatchFailure(role, service.inspectWork(work.workId), archive, work.workId);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});

async function cancelAfterReservation(service, workId, commandId) {
	const current = service.inspectWork(workId);
	const result = await service.perform({
		action: "cancel",
		workId,
		input: {},
		meta: meta("user", commandId, current.revision, workId),
	});
	assert.equal("value" in result, true);
}

function installCancellationRace(service, workId, commandId) {
	const dispatch = service.invocations.dispatch.bind(service.invocations);
	service.invocations.dispatch = (work, input, send) =>
		dispatch(work, input, async (reservation, operation) => {
			await cancelAfterReservation(service, workId, commandId);
			return send(reservation, operation);
		});
}

function assertSettledLaunchAbort(service, archive, controls, workId, effectId) {
	const current = service.inspectWork(workId);
	assert.equal(current.state, "stopped");
	assert.deepEqual(current.activeInvocations, []);
	assert.equal(current.budget.reservedTokens, 0);
	assert.equal(archive.countPendingInvocations(), 0);
	assert.equal(archive.query({ workId, kinds: ["error"] }).items.length, 0);
	assert.equal(controls.prompts.length, 0);
	const invocation = archive.query({ workId, kinds: ["invocation"], order: "desc" }).items[0].payload;
	assert.equal(invocation.state, "settled");
	assert.deepEqual(invocation.usage, { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
	if (effectId !== undefined)
		assert.equal(archive.pendingEffects("assertion").some(({ effectId: pendingId }) => pendingId === effectId), false);
}

function installInitialEnsureCancellationRace(service, runtime, workId, commandId) {
	const ensureSession = runtime.ensureSession.bind(runtime);
	let cancelled = false;
	runtime.ensureSession = async (input, operation) => {
		const binding = await ensureSession(input, operation);
		if (!cancelled && input.role === "executor") {
			cancelled = true;
			await cancelAfterReservation(service, workId, commandId);
		}
		return binding;
	};
}

test("initial sender rechecks Work after runtime preparation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-initial-stale-preparation-"));
	const { service, runtime, controls, archive } = makeService(join(directory, "archive.sqlite"));
	const work = queuedExecutionWork("stale-executor-preparation");
	const effect = { effectId: "stale-executor-preparation:wake", kind: "executor-wake", payload: { workId: work.workId } };
	seed(archive, work, effect);
	installInitialEnsureCancellationRace(service, runtime, work.workId, "executor-preparation:cancel");
	try {
		await service.processPendingEffects();
		await service.processPendingEffects();
		assertSettledLaunchAbort(service, archive, controls, work.workId, effect.effectId);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("bound observer sender rejects stale Work before its prompt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-bound-observer-stale-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	const work = boundObserverWork("stale-bound-observer");
	seed(archive, work, { effectId: "unused", kind: "observer-wake", payload: { workId: work.workId } });
	installCancellationRace(service, work.workId, "bound-observer:cancel");
	try {
		await assert.rejects(service.observer.drive(work, work.observer), /Observer Work became stale before its prompt/);
		await service.processPendingEffects();
		assertSettledLaunchAbort(service, archive, controls, work.workId);
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("post-reservation stale sender paths settle without retaining capacity", async () => {
	const staleCases = [
		{
			name: "executor-initial",
			work: queuedExecutionWork("stale-executor-initial"),
			effect: { effectId: "stale-executor-initial:wake", kind: "executor-wake", payload: { workId: "stale-executor-initial" } },
		},
		{
			name: "executor-turn",
			work: executionWork("stale-executor-turn"),
			effect: { effectId: "stale-executor-turn:wake", kind: "executor-wake", payload: { workId: "stale-executor-turn" } },
		},
		{
			name: "feedback",
			work: executionWork("stale-feedback"),
			effect: { effectId: "stale-feedback:wake", kind: "feedback-wake", payload: { workId: "stale-feedback", executionId: "execution-stale-feedback", feedback: ["Address the requested change."] } },
		},
		{
			name: "observer",
			work: observerWork("stale-observer"),
			effect: { effectId: "stale-observer:wake", kind: "observer-wake", payload: { workId: "stale-observer" } },
		},
	];
	for (const { name, work, effect } of staleCases) {
		const directory = await mkdtemp(join(tmpdir(), `khala-${name}-stale-launch-`));
		const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
		seed(archive, work, effect);
		installCancellationRace(service, work.workId, `${name}:cancel`);
		try {
			await service.processPendingEffects();
			await service.processPendingEffects();
			assertSettledLaunchAbort(service, archive, controls, work.workId, effect.effectId);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
});
