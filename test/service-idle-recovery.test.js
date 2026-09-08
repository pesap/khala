import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta, validateWork } from "./helpers/mvp-fixtures.mjs";

function recovery(actions) {
	return actions.find((action) => action.kind === "recover");
}

function userRecovery(service, work, runtimeState) {
	return recovery(service.availableActions(work.workId, "user", work.revision, runtimeState));
}

function enabled(action) {
	if (action === undefined) return undefined;
	return action.enabled;
}

function replaceProjection(archive, work, changes, suffix) {
	const projection = {
		...work,
		...changes,
		revision: work.revision + 1,
		execution: changes.execution ?? work.execution,
	};
	archive.append({
		commandId: `idle-recovery:${work.workId}:${suffix}`,
		expectedWorkRevision: work.revision,
		kind: "execution",
		actor: "system",
		workId: work.workId,
		missionId: work.mission.missionId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: `Idle recovery guard: ${suffix}`,
		payload: {},
		projection,
	});
	return projection;
}

async function idleWork(prefix, overrides) {
	const directory = await mkdtemp(join(tmpdir(), `khala-idle-recovery-${prefix}-`));
	const fixture = makeService(join(directory, "archive.sqlite"), overrides);
	const work = await admitAndStart(fixture.service, prefix);
	assert.equal(work.execution.runtimeState, "idle");
	return { ...fixture, work };
}

test("recoverWork rechecks the live Signal after its runtime probe", async () => {
	let releaseProbe;
	let markProbeStarted;
	const probeStarted = new Promise((resolve) => {
		markProbeStarted = resolve;
	});
	const probeResult = new Promise((resolve) => {
		releaseProbe = resolve;
	});
	const { service, archive, controls, work } = await idleWork("deferred-ready", {
		ports: {
			runtime: {
				async getState() {
					markProbeStarted();
					return probeResult;
				},
			},
		},
	});
	const sendsBefore = controls.prompts.length;
	const recovering = service.recoverWork(
		work.workId,
		meta("user", "deferred-ready:recover", work.revision, work.workId),
	);
	await probeStarted;
	const probed = archive.project(work.workId);
	const ready = replaceProjection(
		archive,
		probed,
		{
			lastSignal: {
				signalId: "ready-during-probe",
				executionId: probed.execution.executionId,
				kind: "ready",
				summary: "Ready while recovery probes runtime.",
				evidence: ["concurrent-ready"],
				observedAt: new Date().toISOString(),
			},
		},
		"ready-during-probe",
	);
	releaseProbe("idle");
	const recovered = await recovering;
	assert.equal(recovered.revision, ready.revision);
	assert.equal(recovered.lastSignal.signalId, ready.lastSignal.signalId);
	await service.close();
	assert.equal(controls.prompts.length, sendsBefore);
});

test("recoverWork does not dispatch exhausted idle Work", async () => {
	const { service, archive, controls, work } = await idleWork("direct-exhausted");
	const exhausted = replaceProjection(
		archive,
		work,
		{ budget: { ...work.budget, consumedTokens: work.budget.maxTokens } },
		"direct-exhausted",
	);
	const sendsBefore = controls.prompts.length;
	await service.recoverWork(
		exhausted.workId,
		meta("user", "direct-exhausted:recover", exhausted.revision, exhausted.workId),
	);
	await service.close();
	assert.equal(controls.prompts.length, sendsBefore);
});

test("observed runtime state controls idle recovery without changing Conclave actions", async () => {
	const { service, controls, work } = await idleWork("observed-runtime");
	assert.equal(enabled(userRecovery(service, work, "idle")), true);
	assert.equal(enabled(userRecovery(service, work, "working")), false);

	const conclaveWithoutObservation = recovery(
		service.availableActions(work.workId, "conclave", work.revision),
	);
	const conclaveWithIdleObservation = recovery(
		service.availableActions(work.workId, "conclave", work.revision, "idle"),
	);
	assert.equal(enabled(conclaveWithoutObservation), false);
	assert.equal(enabled(conclaveWithIdleObservation), false);

	controls.runtimeState = "working";
	const sendsBefore = controls.prompts.length;
	const result = await service.perform({
		action: "recover",
		workId: work.workId,
		input: {},
		meta: meta("user", "observed-runtime:recover", work.revision, work.workId),
	});
	assert.equal(result.error.code, "invalid-state");
	assert.equal(controls.prompts.length, sendsBefore);
	await service.close();
});

test("ready and blocked Signals disable idle recovery", async () => {
	for (const kind of ["ready", "blocked"]) {
		const { service, work } = await idleWork(`signal-${kind}`);
		let current = work;
		if (kind === "ready") {
			const review = await service.perform({
				action: "create-review-request",
				workId: work.workId,
				input: {},
				meta: meta("executor", `signal-${kind}:review`, current.revision, work.workId, work.execution.executionId),
			});
			assert.equal("value" in review, true);
			current = await validateWork(service, review.value, `signal-${kind}:validate`);
		}
		const signaled = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: { kind, summary: `${kind} Signal`, evidence: ["observable evidence"] },
			meta: meta("executor", `signal-${kind}:record`, current.revision, work.workId, work.execution.executionId),
		});
		assert.equal("value" in signaled, true);
		assert.equal(enabled(userRecovery(service, signaled.value, "idle")), false);
		await service.close();
	}
});

test("held invocations and exhausted allowances disable idle recovery", async () => {
	const cases = [
		{
			name: "active-invocation",
			changes(work) {
				return {
					activeInvocations: [{ runId: "held-run", role: "executor", allowance: 1, state: "uncertain" }],
					budget: { ...work.budget, reservedTokens: 1 },
				};
			},
		},
		{
			name: "execution-allowance",
			changes(work) {
				return {
					execution: {
						...work.execution,
						usage: { inputTokens: work.execution.tokenAllowance, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
					},
				};
			},
		},
		{
			name: "work-budget",
			changes(work) {
				return { budget: { ...work.budget, consumedTokens: work.budget.maxTokens } };
			},
		},
	];

	for (const scenario of cases) {
		const { service, archive, work } = await idleWork(scenario.name);
		const guarded = replaceProjection(archive, work, scenario.changes(work), scenario.name);
		assert.equal(enabled(userRecovery(service, guarded, "idle")), false, scenario.name);
		await service.close();
	}
});
