import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { makeService, meta, admitAndStart } from "./helpers/mvp-fixtures.mjs";

const FAILED_CHECKS = [
	{ kind: "check-run", name: "format", status: "COMPLETED", conclusion: "SUCCESS" },
	{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" },
];

function failedCiObservation(reviewRequest, observationId, checks, overrides = {}) {
	return {
		observationId,
		kind: "ci-status",
		providerId: reviewRequest.providerId,
		status: "checks-failed",
		summary: "A provider check failed.",
		repository: reviewRequest.repository,
		sourceBranch: reviewRequest.sourceBranch,
		targetBranch: reviewRequest.targetBranch,
		baseCommit: reviewRequest.baseCommit,
		headCommit: reviewRequest.headCommit,
		details: {
			pullRequest: { url: reviewRequest.url, status: reviewRequest.status, state: "OPEN", reviewDecision: "", mergedAt: null },
			comments: [],
			checks,
		},
		changed: true,
		observedAt: new Date().toISOString(),
		...overrides,
	};
}

async function pollFailure(service, controls, workId, reviewRequest, observationId, commandId, checks = FAILED_CHECKS) {
	controls.pollObservations = [failedCiObservation(reviewRequest, observationId, checks)];
	return service.pollProvider(workId, meta("user", commandId, service.inspectWork(workId).revision));
}

async function authorizeRepair(service, workId, observationId, commandId) {
	const current = service.inspectWork(workId);
	return service.perform({
		action: "repair-ci",
		workId,
		input: { observationId, evidence: ["1"] },
		meta: meta("conclave", commandId, current.revision, workId),
	});
}

async function publishReview(service, prefix) {
	const work = await admitAndStart(service, prefix);
	const publication = await service.perform({
		action: "create-review-request",
		workId: work.workId,
		input: {},
		meta: meta("executor", `${prefix}:publish`, work.revision, work.workId, work.execution.executionId),
	});
	assert.equal("error" in publication, false);
	return { work, reviewRequest: publication.value.reviewRequest };
}

function claimCiRepairWakes(archive, owner) {
	const claimed = [];
	while (true) {
		const effect = archive.pendingEffects(owner, claimed.map(({ effectId }) => effectId))[0];
		if (effect === undefined) break;
		claimed.push(effect);
	}
	const repairWakes = claimed.filter(({ kind }) => kind === "ci-repair-wake");
	claimed.filter(({ kind }) => kind !== "ci-repair-wake").forEach(({ effectId }) => archive.releaseEffect(effectId, owner));
	return repairWakes;
}

test("repair indexes select from failed-check evidence when passing checks come first", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-check-indexes-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const running = await admitAndStart(service, "ci-check-indexes");
		const publication = await service.perform({
			action: "create-review-request",
			workId: running.workId,
			input: {},
			meta: meta("executor", "ci-check-indexes:publish", running.revision, running.workId, running.execution.executionId),
		});
		assert.equal("error" in publication, false);
		const observed = await pollFailure(
			service,
			controls,
			running.workId,
			publication.value.reviewRequest,
			"ci-check-indexes:observation",
			"ci-check-indexes:poll",
		);
		const result = await authorizeRepair(
			service,
			running.workId,
			observed.lastObservation.observationId,
			"ci-check-indexes:authorize",
		);
		assert.equal("error" in result, false);
		const authorization = archive.query({ workId: running.workId, kinds: ["delivery"] }).items.find(
			(record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized",
		);
		assert.deepEqual(authorization.payload.selectedChecks.map((check) => check.name), ["unit tests"]);
	} finally {
		await service.close();
	}
});

test("empty or unverified provider checks cannot authorize repair", async (t) => {
	const cases = [
		["empty check list", []],
		["unknown check conclusion", [{ kind: "check-run", name: "audit", status: "COMPLETED", conclusion: "UNKNOWN" }]],
		[
			"stale check beside a failure",
			[
				{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" },
				{ kind: "check-run", name: "security", status: "COMPLETED", conclusion: "STALE" },
			],
		],
		[
			"unknown check beside a failure",
			[
				{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" },
				{ kind: "check-run", name: "security", status: "COMPLETED", conclusion: "FUTURE_STATE" },
			],
		],
	];
	for (const [name, checks] of cases) {
		await t.test(name, async () => {
			const directory = await mkdtemp(join(tmpdir(), "khala-ci-unverified-checks-"));
			const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
			try {
				const { work, reviewRequest } = await publishReview(service, `ci-unverified-${name}`);
				const observed = await pollFailure(
					service,
					controls,
					work.workId,
					reviewRequest,
					`ci-unverified:${name}`,
					`ci-unverified:${name}:poll`,
					checks,
				);
				const action = service.availableActions(work.workId, "conclave").find(({ kind }) => kind === "repair-ci");
				assert.equal(action.enabled, false);
				const result = await authorizeRepair(service, work.workId, observed.lastObservation.observationId, `ci-unverified:${name}:authorize`);
				assert.equal("error" in result, true);
				assert.equal(
					archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some(
						(record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized",
					),
					false,
				);
			} finally {
				await service.close();
			}
		});
	}
});

test("provider ID, PR URL, and provider-reported draft status must match before CI repair", async (t) => {
	const mismatches = [
		{
			name: "provider ID",
			pollRejected: true,
			mutate(observation) {
				observation.providerId = "different-review";
			},
		},
		{
			name: "PR URL",
			pollRejected: false,
			mutate(observation) {
				observation.details.pullRequest.url = "https://github.com/example/project/pull/99";
			},
		},
		{
			name: "missing PR URL",
			pollRejected: true,
			mutate(observation) {
				delete observation.details.pullRequest.url;
			},
		},
		{
			name: "provider reports an open PR",
			pollRejected: false,
			mutate(observation) {
				observation.details.pullRequest.status = "open";
			},
		},
	];
	for (const mismatch of mismatches) {
		await t.test(mismatch.name, async () => {
			const directory = await mkdtemp(join(tmpdir(), "khala-ci-pr-identity-"));
			const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
			try {
				const { work, reviewRequest } = await publishReview(service, `ci-pr-identity-${mismatch.name}`);
				const observation = failedCiObservation(reviewRequest, `ci-pr-identity:${mismatch.name}`, FAILED_CHECKS);
				mismatch.mutate(observation);
				controls.pollObservations = [observation];
				const polling = service.pollProvider(
					work.workId,
					meta("user", `ci-pr-identity:${mismatch.name}:poll`, service.inspectWork(work.workId).revision),
				);
				if (mismatch.pollRejected) {
					await assert.rejects(polling);
					assert.equal(service.inspectWork(work.workId).lastObservation, undefined);
				} else {
					const observed = await polling;
					const action = service.availableActions(work.workId, "conclave").find(({ kind }) => kind === "repair-ci");
					assert.equal(action.enabled, false);
					assert.equal(
						"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, `ci-pr-identity:${mismatch.name}:authorize`),
						true,
					);
				}
				assert.equal(
					archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some(
						(record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized",
					),
					false,
				);
			} finally {
				await service.close();
			}
		});
	}
});

test("an open PR cannot authorize a repair that must preserve the current draft", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-open-pr-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-open-pr");
		const current = service.inspectWork(work.workId);
		const openReviewRequest = { ...current.reviewRequest, status: "open" };
		archive.append({
			commandId: "ci-open-pr:make-open",
			expectedWorkRevision: current.revision,
			kind: "review-request",
			actor: "executor",
			workId: work.workId,
			missionId: current.mission.missionId,
			executionId: current.execution.executionId,
			payloadVersion: 1,
			summary: "The provider reports that the review request is no longer a draft.",
			payload: openReviewRequest,
			projection: { ...current, revision: current.revision + 1, reviewRequest: openReviewRequest },
		});
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			openReviewRequest,
			"ci-open-pr:observation",
			"ci-open-pr:poll",
		);
		assert.equal(service.availableActions(work.workId, "conclave").find(({ kind }) => kind === "repair-ci").enabled, false);
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-open-pr:authorize"),
			true,
		);
		assert.equal(reviewRequest.status, "draft");
		assert.equal(service.inspectWork(work.workId).reviewRequest.status, "open");
	} finally {
		await service.close();
	}
});

test("a newer CI observation during the final idle probe supersedes repair before started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-final-preflight-"));
	let probeCount = 0;
	let holdFinalProbe = false;
	let releaseProbe = () => undefined;
	let enterProbe = () => undefined;
	const probeGate = new Promise((resolve) => {
		releaseProbe = resolve;
	});
	const enteredFinalProbe = new Promise((resolve) => {
		enterProbe = resolve;
	});
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		enableCiRepair: true,
		ports: {
			runtime: {
				async getState() {
					if (holdFinalProbe) {
						probeCount += 1;
						if (probeCount === 2) {
							enterProbe();
							await probeGate;
						}
					}
					return "idle";
				},
			},
		},
	});
	const effectOwner = "ci-repair-final-preflight-test";
	let repairWake;
	let processing;
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-final-preflight");
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-final-preflight:observation",
			"ci-final-preflight:poll",
		);
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-final-preflight:authorize"),
			false,
		);
		repairWake = claimCiRepairWakes(archive, effectOwner)[0];
		assert.ok(repairWake);
		holdFinalProbe = true;
		processing = service.ciRepair.processWake(repairWake);
		await enteredFinalProbe;

		controls.pollObservations = [
			failedCiObservation(reviewRequest, "ci-final-preflight:new-observation", FAILED_CHECKS),
		];
		const current = service.inspectWork(work.workId);
		await service.pollProvider(work.workId, meta("user", "ci-final-preflight:poll-new", current.revision));
		releaseProbe();
		await processing;

		const statuses = archive.query({ workId: work.workId, kinds: ["delivery"] }).items
			.filter((record) => record.payload.kind === "ci-repair")
			.map((record) => record.payload.status)
			.sort();
		assert.deepEqual(statuses, ["authorized", "superseded"]);
		assert.equal(
			archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some(
				(record) => record.payload.kind === "ci-repair" && record.payload.status === "started",
			),
			false,
		);
		assert.equal(controls.prompts.some(({ message }) => message.includes("Provider CI repair")), false);
		assert.equal(archive.completeEffect(repairWake.effectId, effectOwner), true);
	} finally {
		releaseProbe();
		if (processing !== undefined) await processing.catch(() => undefined);
		if (repairWake !== undefined) archive.releaseEffect(repairWake.effectId, effectOwner);
		await service.close();
	}
});

test("a PR reported open during repair publication is not marked completed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-open-republication-"));
	let publicationCount = 0;
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		enableCiRepair: true,
		ports: {
			workspace: {
				async commitSandbox() {
					controls.head = "repaired-head";
					return controls.head;
				},
				async inspectHead() {
					return controls.head;
				},
			},
			codeHost: {
				async ensureReviewRequest(input) {
					publicationCount += 1;
					return {
						provider: "github",
						principalId: "user-1",
						providerId: "42",
						url: "https://github.com/example/project/pull/42",
						repository: "example/project",
						status: publicationCount === 1 ? "draft" : "open",
						sourceBranch: input.sandbox.branch,
						targetBranch: input.targetBranch,
						baseCommit: input.sandbox.baseCommit,
						headCommit: input.headCommit,
						diffSummary: "two files changed",
						validation: input.terms.validation,
					};
				},
			},
		},
	});
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-open-republication");
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-open-republication:observation",
			"ci-open-republication:poll",
		);
		const performExecutor = (action, commandId) => {
			const current = service.inspectWork(work.workId);
			return service.perform({
				action,
				workId: work.workId,
				input: {},
				meta: meta("executor", commandId, current.revision, work.workId, current.execution.executionId),
			});
		};
		const repairActions = [];
		controls.onExecutorTurn = async (message) => {
			if (!message.includes("Provider CI repair")) return;
			repairActions.push(await performExecutor("commit-sandbox", "ci-open-republication:commit"));
			repairActions.push(await performExecutor("run-validation", "ci-open-republication:validate"));
			repairActions.push(await performExecutor("create-review-request", "ci-open-republication:republish"));
		};
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-open-republication:authorize"),
			false,
		);

		await service.processPendingEffects();
		const current = service.inspectWork(work.workId);
		assert.deepEqual(
			repairActions.map((result) => ("error" in result ? result.error.summary : "ok")),
			["ok", "ok", "ok"],
		);
		assert.equal(publicationCount, 2);
		assert.equal(current.reviewRequest.status, "open");
		assert.equal(current.reviewRequest.headCommit, "repaired-head");
		const statuses = archive.query({ workId: work.workId, kinds: ["delivery"] }).items
			.filter((record) => record.payload.kind === "ci-repair")
			.map((record) => record.payload.status)
			.sort();
		assert.deepEqual(statuses, ["authorized", "blocked", "started"]);
	} finally {
		await service.close();
	}
});

test("a current blocked Signal cannot authorize a CI repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-blocked-signal-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-blocked-signal");
		const current = service.inspectWork(work.workId);
		const blocked = await service.perform({
			action: "record-signal",
			workId: work.workId,
			input: { kind: "blocked", summary: "The current Execution is blocked.", evidence: ["awaiting decision"] },
			meta: meta("executor", "ci-blocked-signal:record", current.revision, work.workId, current.execution.executionId),
		});
		assert.equal("error" in blocked, false);
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-blocked-signal:observation",
			"ci-blocked-signal:poll",
		);
		assert.equal(service.inspectWork(work.workId).execution.state, "blocked");
		assert.equal(service.availableActions(work.workId, "conclave").find(({ kind }) => kind === "repair-ci").enabled, false);
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-blocked-signal:authorize"),
			true,
		);
	} finally {
		await service.close();
	}
});

test("concurrent Conclave authorizations append only once at the current Work revision", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-concurrent-authorization-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-concurrent-authorization");
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-concurrent-authorization:observation",
			"ci-concurrent-authorization:poll",
		);
		const attempt = (commandId) => service.perform({
			action: "repair-ci",
			workId: work.workId,
			input: { observationId: observed.lastObservation.observationId, evidence: ["1"] },
			meta: meta("conclave", commandId, observed.revision, work.workId),
		});
		await Promise.all([
			attempt("ci-concurrent-authorization:first"),
			attempt("ci-concurrent-authorization:second"),
		]);
		const authorizations = archive.query({ workId: work.workId, kinds: ["delivery"] }).items.filter(
			(record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized",
		);
		assert.equal(authorizations.length, 1);
	} finally {
		await service.close();
	}
});

test("an unsettled Conclave invocation cannot authorize CI repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-conclave-invocation-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-conclave-invocation");
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-conclave-invocation:observation",
			"ci-conclave-invocation:poll",
		);
		const ledger = new RunLedger(archive);
		ledger.reserve({
			workId: work.workId,
			role: "conclave",
			missionId: work.mission.missionId,
			allowance: 10,
			runId: "uncertain-conclave-run",
		});
		ledger.settle({ runId: "uncertain-conclave-run", complete: false });
		const action = service.availableActions(work.workId, "conclave").find(({ kind }) => kind === "repair-ci");
		assert.equal(action.enabled, false);
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-conclave-invocation:authorize"),
			true,
		);
		assert.equal(
			archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some(
				(record) => record.payload.kind === "ci-repair" && record.payload.status === "authorized",
			),
			false,
		);
	} finally {
		await service.close();
	}
});

test("an Executor turn without governed repair actions is blocked, not marked completed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-incomplete-turn-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	try {
		const { work, reviewRequest } = await publishReview(service, "ci-incomplete-turn");
		const observed = await pollFailure(
			service,
			controls,
			work.workId,
			reviewRequest,
			"ci-incomplete-turn:observation",
			"ci-incomplete-turn:poll",
		);
		assert.equal(
			"error" in await authorizeRepair(service, work.workId, observed.lastObservation.observationId, "ci-incomplete-turn:authorize"),
			false,
		);
		await service.processPendingEffects();
		const statuses = archive.query({ workId: work.workId, kinds: ["delivery"] }).items
			.filter((record) => record.payload.kind === "ci-repair")
			.map((record) => record.payload.status)
			.sort();
		assert.deepEqual(statuses, ["authorized", "blocked", "started"]);
		assert.equal(service.inspectWork(work.workId).reviewRequest.headCommit, reviewRequest.headCommit);
	} finally {
		await service.close();
	}
});

test("a later CI failure cannot authorize a second repair continuation for the same Execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-queued-wakes-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), { enableCiRepair: true });
	const effectOwner = "ci-repair-queued-wakes-test";
	let repairWakes = [];
	try {
		const running = await admitAndStart(service, "ci-queued-wakes");
		const publication = await service.perform({
			action: "create-review-request",
			workId: running.workId,
			input: {},
			meta: meta("executor", "ci-queued-wakes:publish", running.revision, running.workId, running.execution.executionId),
		});
		assert.equal("error" in publication, false);
		const reviewRequest = publication.value.reviewRequest;
		const first = await pollFailure(service, controls, running.workId, reviewRequest, "ci-queued-wakes:first", "ci-queued-wakes:poll-first");
		assert.equal(
			"error" in await authorizeRepair(service, running.workId, first.lastObservation.observationId, "ci-queued-wakes:authorize-first"),
			false,
		);

		const second = await pollFailure(service, controls, running.workId, reviewRequest, "ci-queued-wakes:second", "ci-queued-wakes:poll-second");
		assert.equal(service.availableActions(running.workId, "conclave").find(({ kind }) => kind === "repair-ci").enabled, false);
		assert.equal(
			"error" in await authorizeRepair(service, running.workId, second.lastObservation.observationId, "ci-queued-wakes:authorize-second"),
			true,
		);
		repairWakes = claimCiRepairWakes(archive, effectOwner);
		assert.equal(repairWakes.length, 1);
		await service.ciRepair.processWake(repairWakes[0]);
		assert.equal(archive.completeEffect(repairWakes[0].effectId, effectOwner), true);
		assert.equal(controls.prompts.some(({ message }) => message.includes("Provider CI repair")), false);
		const statuses = archive.query({ workId: running.workId, kinds: ["delivery"] }).items
			.filter((record) => record.payload.kind === "ci-repair")
			.map((record) => record.payload.status)
			.sort();
		assert.deepEqual(statuses, ["authorized", "superseded"]);
	} finally {
		repairWakes.forEach(({ effectId }) => archive.releaseEffect(effectId, effectOwner));
		await service.close();
	}
});
