import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { ciFailure, ciSuccess, makeService, performCurrent, repairAction, workWithCiFailure } from "./helpers/ci-repair-fixtures.mjs";
import { makeService as makeBaseService, meta, admitAndStart } from "./helpers/mvp-fixtures.mjs";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

function claimEffectOfKind(archive, owner, kind) {
	const claimed = [];
	let selected;
	while (true) {
		const effect = archive.pendingEffects(owner, claimed.map((item) => item.effectId))[0];
		if (effect === undefined) break;
		claimed.push(effect);
		if (effect.kind === kind) {
			selected = effect;
			break;
		}
	}
	assert.ok(selected);
	claimed.filter((effect) => effect !== selected).forEach((effect) => archive.releaseEffect(effect.effectId, owner));
	return selected;
}

async function waitForHeldExecutor(controls) {
	for (let attempt = 0; attempt < 100 && controls.releaseExecutor === undefined; attempt += 1)
		await new Promise((resolve) => setImmediate(resolve));
	assert.ok(controls.releaseExecutor !== undefined);
}

async function waitForRuntimeStateRead(stateReads) {
	for (let attempt = 0; attempt < 100 && stateReads.count < 1; attempt += 1)
		await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stateReads.count, 1);
}

function ciRepairStatuses(archive, workId) {
	return archive.query({ workId, kinds: ["delivery"] }).items
		.filter((record) => record.payload.kind === "ci-repair")
		.map((record) => record.payload.status);
}

function releaseEffectClaim(archive, effect, owner) {
	if (effect !== undefined) archive.releaseEffect(effect.effectId, owner);
}

test("CI repair prompts and authority are opt-in", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-opt-in-"));
	const { service, controls, archive } = makeBaseService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-opt-in");
		const messages = [];
		controls.onConclaveWake = (message) => messages.push(message);
		await service.processPendingEffects();
		assert.equal(messages.length, 1);
		assert.doesNotMatch(messages[0], /repair-ci/);
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-opt-in:unauthorized", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("current provider CI wakes Conclave with bounded checks and explicit reconciliation guidance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-wake-"));
	const longBranch = `khala/${"branch".repeat(3_000)}`;
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async ensureSandbox(input) {
					return { path: `/tmp/${input.executionId}`, baseCommit: "base", branch: longBranch };
				},
			},
		},
	});
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-wake");
		const messages = [];
		controls.onConclaveWake = (message) => messages.push(message);
		await service.processPendingEffects();
		assert.equal(messages.length, 1);
		assert.match(messages[0], new RegExp(work.lastObservation.observationId));
		assert.match(messages[0], /unit tests/);
		assert.match(messages[0], /repair-ci/);
		assert.match(messages[0], /one-based indexes/);
		assert.match(messages[0], /Mission, and Execution/);
		assert.doesNotMatch(messages[0], /format/);
		assert.equal(messages[0].includes(longBranch), false);
		assert.equal(messages[0].length < 3_000, true);
	} finally {
		await service.close();
	}
});

test("CI repair wake waits for its originating Conclave invocation to settle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-settlement-order-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-settlement-order");
		controls.onConclaveWake = async (message) => {
			if (!message.includes(work.lastObservation.observationId)) return;
			const current = service.inspectWork(work.workId);
			assert.equal(current.activeInvocations.some((invocation) => invocation.role === "conclave" && invocation.state === "reserved"), true);
			const authorized = await performCurrent(service, "conclave", "repair-ci", "ci-settlement-order:authorize", {
				observationId: work.lastObservation.observationId,
				evidence: ["1"],
			});
			assert.equal("error" in authorized, false);
		};
		controls.onExecutorTurn = async (message) => {
			if (!message.includes("Provider CI repair")) return;
			const current = service.inspectWork(work.workId);
			assert.equal(current.activeInvocations.some((invocation) => invocation.role === "conclave"), false);
			assert.equal(current.activeInvocations.some((invocation) => invocation.role === "executor" && invocation.state === "reserved"), true);
		};

		await service.processPendingEffects();
		assert.equal(
			archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some(
				(record) => record.payload.kind === "ci-repair" && record.payload.status === "started",
			),
			true,
		);
		const blocked = archive.query({ workId: work.workId, kinds: ["delivery"] }).items.find(
			(record) => record.payload.kind === "ci-repair" && record.payload.status === "blocked",
		);
		assert.doesNotMatch(blocked?.payload.reason ?? "", /invocation is unsettled/);
	} finally {
		await service.close();
	}
});

test("Conclave authorizes one bounded same-Execution repair and duplicate drains do not send another turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-repair-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work, reviewRequest } = await workWithCiFailure(service, controls, "ci-repair");
		assert.equal(work.state, "active");
		assert.equal(work.execution.state, "running");
		assert.equal(work.execution.runtimeState, "idle");
		assert.equal(repairAction(service, work.workId).enabled, true);

		let authorizationCalls = 0;
		controls.onConclaveWake = async (message) => {
			if (!message.includes(work.lastObservation.observationId)) return;
			authorizationCalls += 1;
			const first = await performCurrent(service, "conclave", "repair-ci", "ci-repair:authorize:first", {
				observationId: work.lastObservation.observationId,
				evidence: ["1"],
			});
			assert.equal("error" in first, false);
			const duplicate = await performCurrent(service, "conclave", "repair-ci", "ci-repair:authorize:duplicate", {
				observationId: work.lastObservation.observationId,
				evidence: ["1"],
			});
			assert.equal("error" in duplicate, false);
		};
		await Promise.all([service.processPendingEffects(), service.processPendingEffects()]);
		assert.equal(authorizationCalls, 1);

		const repairPrompts = controls.prompts.filter(
			({ binding, message }) => binding.sessionId.startsWith("executor-") && message.includes("Provider CI repair"),
		);
		assert.equal(repairPrompts.length, 1);
		assert.match(repairPrompts[0].message, /unit tests/);
		assert.doesNotMatch(repairPrompts[0].message, /format/);
		assert.equal(repairPrompts[0].binding.sessionId, work.execution.pi.sessionId);

		const current = service.inspectWork(work.workId);
		assert.equal(current.mission.missionId, work.mission.missionId);
		assert.equal(current.execution.executionId, work.execution.executionId);
		assert.equal(current.reviewRequest.providerId, reviewRequest.providerId);
		assert.equal(current.reviewRequest.status, "draft");
		assert.equal(current.budget.maxTokens, work.budget.maxTokens);
		const deliveries = archive.query({ workId: work.workId, kinds: ["delivery"] }).items;
		const authorizations = deliveries.filter((record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized");
		assert.equal(authorizations.length, 1);
		assert.equal(authorizations[0].actor, "conclave");
		assert.equal(authorizations[0].executionId, work.execution.executionId);
		assert.equal(authorizations[0].missionId, work.mission.missionId);
		assert.deepEqual(authorizations[0].payload.selectedChecks.map((check) => check.name), ["unit tests"]);

		controls.pollObservations = [ciFailure(reviewRequest, { observationId: "ci-failure:42:run-2" })];
		const latest = service.inspectWork(work.workId);
		const nextFailure = await service.pollProvider(
			work.workId,
			meta("user", "ci-repair:poll-second-failure", latest.revision),
		);
		assert.equal(nextFailure.lastObservation.observationId, "ci-failure:42:run-2");
		assert.equal(repairAction(service, work.workId).enabled, false);
		const secondAuthorization = await performCurrent(service, "conclave", "repair-ci", "ci-repair:authorize:second-observation", {
			observationId: nextFailure.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in secondAuthorization, true);
		assert.equal(
			controls.prompts.filter(({ binding, message }) => binding.sessionId.startsWith("executor-") && message.includes("Provider CI repair")).length,
			1,
		);
	} finally {
		await service.close();
	}
});

test("repair requires current repository, branch, and PR-head identity", async (t) => {
	const staleObservations = [
		["repository", { repository: "other/project" }],
		["source branch", { sourceBranch: "other-branch" }],
		["target branch", { targetBranch: "other-target" }],
		["PR head", { headCommit: "older-head" }],
	];
	for (const [field, overrides] of staleObservations) {
		await t.test(field, async () => {
			const directory = await mkdtemp(join(tmpdir(), "khala-ci-stale-"));
			const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
			try {
				const { work } = await workWithCiFailure(service, controls, `stale-${field.replaceAll(" ", "-")}`, overrides);
				assert.equal(repairAction(service, work.workId).enabled, false);
				const result = await performCurrent(service, "conclave", "repair-ci", `stale:${field}`, {
					observationId: work.lastObservation.observationId,
					evidence: ["1"],
				});
				assert.equal("error" in result, true);
				assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
			} finally {
				await service.close();
			}
		});
	}
});

test("pending provider checks cannot authorize repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-pending-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-pending", {
			status: "open",
			details: {
				pullRequest: { url: "https://github.com/example/project/pull/42", status: "draft", state: "OPEN", reviewDecision: "", mergedAt: null },
				comments: [],
				checks: [{ kind: "check-run", name: "unit tests", status: "IN_PROGRESS" }],
			},
		});
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-pending:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("a failed check cannot authorize repair while another check is pending", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-mixed-pending-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-mixed-pending", {
			status: "checks-failed",
			details: {
				pullRequest: { url: "https://github.com/example/project/pull/42", status: "draft", state: "OPEN", reviewDecision: "", mergedAt: null },
				comments: [],
				checks: [
					{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" },
					{ kind: "check-run", name: "integration tests", status: "IN_PROGRESS" },
				],
			},
		});
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-mixed-pending:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("a working Executor runtime cannot authorize repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-working-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-working");
		controls.runtimeState = "working";
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-working:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("a failed validation of the current PR head blocks CI repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-validation-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async runValidation({ commands }) {
					return commands.map((command) => ({ command, passed: false, output: "Validation isolation requires bubblewrap." }));
				},
			},
		},
	});
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-validation");
		const validation = await performCurrent(service, "executor", "run-validation", "ci-validation:run");
		assert.equal("error" in validation, false);
		assert.equal(validation.value.lastValidation.sourceVerified, true);
		assert.equal(validation.value.lastValidation.results.every((result) => !result.passed), true);
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-validation:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("reserved and uncertain invocations block CI repair", async (t) => {
	for (const state of ["reserved", "uncertain"]) {
		await t.test(state, async () => {
			const directory = await mkdtemp(join(tmpdir(), "khala-ci-invocation-"));
			const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
			try {
				const { work } = await workWithCiFailure(service, controls, `ci-${state}`);
				const ledger = new RunLedger(archive);
				ledger.reserve({
					workId: work.workId,
					role: "executor",
					missionId: work.mission.missionId,
					executionId: work.execution.executionId,
					allowance: 1,
					runId: `held-${state}`,
				});
				if (state === "uncertain") ledger.settle({ runId: `held-${state}`, complete: false });
				const current = service.inspectWork(work.workId);
				assert.equal(repairAction(service, work.workId).enabled, false);
				const result = await performCurrent(service, "conclave", "repair-ci", `ci:${state}:authorize`, {
					observationId: current.lastObservation.observationId,
					evidence: ["1"],
				});
				assert.equal("error" in result, true);
				assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
			} finally {
				await service.close();
			}
		});
	}
});

test("exhausted Execution allowance blocks repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-budget-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-budget");
		const ledger = new RunLedger(archive);
		const runId = "consume-execution-allowance";
		const allowance = work.execution.tokenAllowance;
		ledger.reserve({
			workId: work.workId,
			role: "executor",
			missionId: work.mission.missionId,
			executionId: work.execution.executionId,
			allowance,
			runId,
		});
		ledger.settle({ runId, complete: true, usage: { ...ZERO_USAGE, inputTokens: allowance } });
		const current = service.inspectWork(work.workId);
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-budget:authorize", {
			observationId: current.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("exhausted Work budget blocks repair separately from Execution allowance exhaustion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-work-budget-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-work-budget");
		const ledger = new RunLedger(archive);
		const runId = "consume-work-budget-without-execution-usage";
		ledger.reserve({
			workId: work.workId,
			role: "observer",
			missionId: work.mission.missionId,
			allowance: work.budget.maxTokens,
			runId,
		});
		ledger.settle({ runId, complete: true, usage: { ...ZERO_USAGE, inputTokens: work.budget.maxTokens } });
		const current = service.inspectWork(work.workId);
		assert.equal(current.budget.consumedTokens, current.budget.maxTokens);
		assert.equal(current.execution.usage?.inputTokens ?? 0, 0);
		assert.equal(repairAction(service, work.workId).enabled, false);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-work-budget:authorize", {
			observationId: current.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});

test("CI repair stays blocked when isolated validation is unavailable", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-isolation-blocked-"));
	let validationRuns = 0;
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async commitSandbox() {
					controls.head = "unvalidated-head";
					return controls.head;
				},
				async runValidation({ commands }) {
					validationRuns += 1;
					return commands.map((command) => ({
						command,
					passed: false,
					output: "Validation isolation requires Linux bubblewrap.",
					}));
				},
			},
		},
	});
	try {
		const { work, reviewRequest } = await workWithCiFailure(service, controls, "ci-isolation");
		controls.onConclaveWake = async (message) => {
			if (!message.includes(work.lastObservation.observationId)) return;
			const result = await performCurrent(service, "conclave", "repair-ci", "ci-isolation:authorize", {
				observationId: work.lastObservation.observationId,
				evidence: ["1"],
			});
			assert.equal("error" in result, false);
		};
		controls.onExecutorTurn = async (message) => {
			if (!message.includes("Provider CI repair")) return;
			await performCurrent(service, "executor", "commit-sandbox", "ci-isolation:commit");
			const validation = await performCurrent(service, "executor", "run-validation", "ci-isolation:validate");
			assert.equal("error" in validation, false);
			assert.equal(validation.value.lastValidation.results.every((result) => !result.passed), true);
			await performCurrent(service, "executor", "record-signal", "ci-isolation:blocked", {
				kind: "blocked",
				summary: "Validation isolation is unavailable; no alternative execution path was used.",
				evidence: [validation.value.lastValidation.results[0].output],
			});
		};

		await service.processPendingEffects();
		const current = service.inspectWork(work.workId);
		assert.equal(validationRuns, 1);
		assert.equal(current.lastValidation.headCommit, "unvalidated-head");
		assert.equal(current.lastValidation.results.every((result) => !result.passed), true);
		assert.equal(current.lastSignal.kind, "blocked");
		assert.equal(current.reviewRequest.providerId, reviewRequest.providerId);
		assert.equal(current.reviewRequest.status, "draft");
		assert.equal(current.reviewRequest.headCommit, reviewRequest.headCommit);
		assert.deepEqual(
			archive.query({ workId: work.workId, kinds: ["delivery"] }).items
				.filter((record) => record.payload.kind === "ci-repair")
				.map((record) => record.payload.status)
				.sort(),
			["authorized", "blocked", "started"],
		);
	} finally {
		await service.close();
	}
});

test("Conclave cannot hand off a ready Signal after matching provider checks fail", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-handoff-blocked-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	try {
		const running = await admitAndStart(service, "ci-handoff-blocked");
		const published = await performCurrent(service, "executor", "create-review-request", "ci-handoff-blocked:publish");
		assert.equal("error" in published, false);
		const validation = await performCurrent(service, "executor", "run-validation", "ci-handoff-blocked:validate");
		assert.equal("error" in validation, false);
		controls.pollObservations = [ciSuccess(published.value.reviewRequest)];
		const beforeSuccessPoll = service.inspectWork(running.workId);
		await service.pollProvider(running.workId, meta("user", "ci-handoff-blocked:poll-success", beforeSuccessPoll.revision));
		const ready = await performCurrent(service, "executor", "record-signal", "ci-handoff-blocked:ready", {
			kind: "ready",
			summary: "The local validation passed before provider checks were observed.",
			evidence: [published.value.reviewRequest.headCommit, "local validation passed"],
		});
		assert.equal("error" in ready, false);

		controls.pollObservations = [ciFailure(published.value.reviewRequest)];
		const current = service.inspectWork(running.workId);
		await service.pollProvider(running.workId, meta("user", "ci-handoff-blocked:poll", current.revision));
		const latest = service.inspectWork(running.workId);
		const repair = await performCurrent(service, "conclave", "repair-ci", "ci-handoff-blocked:repair", {
			observationId: latest.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in repair, true);
		const verdict = await performCurrent(service, "conclave", "verdict", "ci-handoff-blocked:verdict", {
			decision: "handoff",
			reason: "Attempt to hand off despite current failed provider checks.",
			signalId: latest.lastSignal.signalId,
		});
		assert.equal("error" in verdict, true);
		assert.equal(service.inspectWork(running.workId).state, "active");
		assert.equal(service.inspectWork(running.workId).execution.state, "running");
	} finally {
		await service.close();
	}
});

test("repair validates and republishes the same draft PR head before readiness", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-publish-"));
	const validationCommands = [];
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async commitSandbox() {
					controls.head = "repaired-head";
					return controls.head;
				},
				async inspectHead() {
					return controls.head;
				},
				async runValidation({ commands }) {
					validationCommands.push(...commands);
					return commands.map((command) => ({ command, passed: true, output: "isolated check passed" }));
				},
			},
		},
	});
	try {
		const { work, reviewRequest } = await workWithCiFailure(service, controls, "ci-publish");
		controls.onConclaveWake = async (message) => {
			if (message.includes(work.lastObservation.observationId)) {
				const repaired = await performCurrent(service, "conclave", "repair-ci", "ci-publish:authorize", {
					observationId: work.lastObservation.observationId,
					evidence: ["1"],
				});
				assert.equal("error" in repaired, false);
				return;
			}
			if (!message.includes("current ready Signal")) return;
			const current = service.inspectWork(work.workId);
			const verdict = await performCurrent(service, "conclave", "verdict", "ci-publish:handoff", {
				decision: "handoff",
				reason: "The exact repaired draft head passed local and provider checks.",
				signalId: current.lastSignal.signalId,
			});
			assert.equal("error" in verdict, false);
		};
		controls.onExecutorTurn = async (message) => {
			if (!message.includes("Provider CI repair")) return;
			assert.match(message, /unit tests/);
			let result = await performCurrent(service, "executor", "commit-sandbox", "ci-publish:commit");
			assert.equal("error" in result, false);
			assert.equal(controls.head, "repaired-head");
			result = await performCurrent(service, "executor", "run-validation", "ci-publish:validate");
			assert.equal("error" in result, false);
			const published = await performCurrent(service, "executor", "create-review-request", "ci-publish:republish");
			assert.equal("error" in published, false);
			assert.equal(published.value.reviewRequest.providerId, reviewRequest.providerId);
			assert.equal(published.value.reviewRequest.status, "draft");
			assert.equal(published.value.reviewRequest.headCommit, "repaired-head");
			assert.equal(published.value.lastValidation.headCommit, "repaired-head");

			const staleReady = await performCurrent(service, "executor", "record-signal", "ci-publish:stale-ready", {
				kind: "ready",
				summary: "Attempted ready before current provider checks passed.",
				evidence: ["repaired-head", "local validation passed"],
			});
			assert.equal("error" in staleReady, true);

			controls.pollObservations = [ciSuccess(published.value.reviewRequest)];
			const latest = service.inspectWork(work.workId);
			await service.pollProvider(work.workId, meta("user", "ci-publish:poll-pass", latest.revision));
			const ready = await performCurrent(service, "executor", "record-signal", "ci-publish:ready", {
				kind: "ready",
				summary: "The exact repaired commit is validated and current provider checks passed.",
				evidence: ["repaired-head", "local validation passed", "current CI passed"],
			});
			assert.equal("error" in ready, false);
		};

		await service.processPendingEffects();
		assert.deepEqual(validationCommands, ["npm run check"]);
		const current = service.inspectWork(work.workId);
		assert.equal(current.execution.executionId, work.execution.executionId);
		assert.deepEqual(current.mission, work.mission);
		assert.deepEqual(current.terms, work.terms);
		assert.deepEqual(current.budget, work.budget);
		assert.equal(current.execution.tokenAllowance, work.execution.tokenAllowance);
		assert.deepEqual(current.execution.usage ?? ZERO_USAGE, work.execution.usage ?? ZERO_USAGE);
		assert.equal(current.lastValidation.headCommit, "repaired-head");
		assert.equal(current.reviewRequest.providerId, reviewRequest.providerId);
		assert.equal(current.reviewRequest.status, "draft");
		assert.equal(current.reviewRequest.headCommit, "repaired-head");
		assert.equal(current.state, "awaiting-review");
		assert.equal(current.execution.state, "awaiting-review");
		assert.equal(current.lastSignal.kind, "ready");
		const ciRepairStatuses = archive.query({ workId: work.workId, kinds: ["delivery"] }).items
			.filter((record) => record.payload.kind === "ci-repair")
			.map((record) => record.payload.status);
		assert.deepEqual(ciRepairStatuses.sort(), ["authorized", "completed", "started"]);
	} finally {
		await service.close();
	}
});

test("overlapping duplicate repair wakes do not mark an active Executor turn blocked or uncertain", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-duplicate-active-"));
	const stateReads = { count: 0 };
	let holdStateReads = false;
	let releaseStateGate = () => undefined;
	const stateGate = new Promise((resolve) => {
		releaseStateGate = resolve;
	});
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async getState() {
					if (holdStateReads) {
						stateReads.count += 1;
						if (stateReads.count === 1) releaseStateGate();
						await stateGate;
					}
					return "idle";
				},
			},
		},
	});
	const effectOwner = "ci-repair-overlap-test";
	let repairWake;
	let firstWake;
	let secondWake;
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-duplicate-active");
		controls.executorHold = true;
		const authorized = await performCurrent(service, "conclave", "repair-ci", "ci-duplicate-active:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in authorized, false);
		repairWake = claimEffectOfKind(archive, effectOwner, "ci-repair-wake");

		holdStateReads = true;
		firstWake = service.ciRepair.processWake(repairWake);
		secondWake = service.ciRepair.processWake(repairWake);
		await waitForRuntimeStateRead(stateReads);
		await waitForHeldExecutor(controls);
		await service.ciRepair.processWake(repairWake);
		assert.deepEqual(ciRepairStatuses(archive, work.workId).sort(), ["authorized", "started"]);

		controls.releaseExecutor();
		await Promise.all([firstWake, secondWake]);
		assert.equal(archive.completeEffect(repairWake.effectId, effectOwner), true);
		assert.deepEqual(ciRepairStatuses(archive, work.workId).sort(), ["authorized", "blocked", "started"]);
		const blocked = archive
			.query({ workId: work.workId, kinds: ["delivery"] })
			.items.find((record) => record.payload.kind === "ci-repair" && record.payload.status === "blocked");
		assert.match(blocked.payload.reason, /governed commit, exact-commit validation, and same-draft PR reconciliation/);
	} finally {
		controls.releaseExecutor?.();
		if (firstWake !== undefined) await firstWake.catch(() => undefined);
		if (secondWake !== undefined) await secondWake.catch(() => undefined);
		releaseEffectClaim(archive, repairWake, effectOwner);
		await service.close();
	}
});
