import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { dispatchInvocation, InvocationLaunchError } from "../dist/src/dispatch.js";
import { RunLedger } from "../dist/src/run-ledger.js";

function view(workId, revision, budget = { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 }) {
	return {
		workId,
		revision,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 },
		budget,
		nextAction: "pending",
		queuedSequence: 0,
	};
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "khala-run-dispatch-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	archive.append({ commandId: "submission", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "work-1", payloadVersion: 1, summary: "submitted", payload: {}, projection: view("work-1", 1) });
	return { archive, directory };
}

test("dispatch reserves, settles once, and preserves uncertain usage", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const turn = await dispatchInvocation(ledger, { workId: "work-1", role: "conclave", allowance: 50 }, async (reservation) => {
		assert.deepEqual(reservation, { runId: reservation.runId, allowance: 50 });
		return { output: "ok", usage: { inputTokens: 7, outputTokens: 3, cacheHitTokens: 20, cacheMissTokens: 1 } };
	});
		assert.equal(turn.usage.inputTokens + turn.usage.outputTokens, 10);
		const settled = archive.project("work-1");
		assert.deepEqual(settled.budget, { maxTokens: 100, reservedTokens: 0, consumedTokens: 10 });
		const run = archive.query({ workId: "work-1", kinds: ["invocation"], order: "desc" }).items[0].payload;
		assert.equal(run.state, "settled");
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("older run settlement survives intervening history and cannot replay the provider", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const old = ledger.reserve({ workId: "work-1", role: "oracle", allowance: 10 });
		const zero = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
		for (let index = 0; index < 60; index++) {
			const run = ledger.reserve({ workId: "work-1", role: "conclave", allowance: 1 });
			ledger.settle({ runId: run.runId, complete: true, usage: zero });
		}
		ledger.settle({ runId: old.runId, complete: true, usage: { ...zero, inputTokens: 3 } });
		const revision = archive.project("work-1").revision;
		ledger.settle({ runId: old.runId, complete: true, usage: { ...zero, inputTokens: 3 } });
		assert.equal(archive.project("work-1").revision, revision);
		let calls = 0;
		await assert.rejects(dispatchInvocation(ledger, { workId: "work-1", role: "oracle", allowance: 10, runId: old.runId }, async () => { calls++; return { usage: zero }; }), /reconciliation/);
		assert.equal(calls, 0);
		assert.deepEqual(archive.project("work-1").budget, { maxTokens: 100, consumedTokens: 3, reservedTokens: 0 });
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("known launcher failure releases capacity before any model prompt", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		await assert.rejects(dispatchInvocation(ledger, { workId: "work-1", role: "executor", allowance: 20, maxConcurrentRuns: 1 }, async () => { throw new InvocationLaunchError(new Error("native version mismatch")); }), /native version mismatch/);
		assert.equal(archive.countPendingInvocations(), 0);
		assert.deepEqual(archive.project("work-1").budget, { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 });
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a persisted reservation is not permission to repeat an unobserved provider call", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const input = { workId: "work-1", role: "conclave", allowance: 20, runId: "interrupted-run" };
		ledger.reserve(input);
		let called = false;
		await assert.rejects(dispatchInvocation(ledger, input, async () => { called = true; return { output: "" }; }), /reconciliation/);
		assert.equal(called, false);
		assert.equal(archive.project("work-1").budget.reservedTokens, 20);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reconciliation charges only newly observed usage and never borrows another run reservation", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const run = ledger.reserve({ workId: "work-1", role: "executor", allowance: 20 });
		ledger.reserve({ workId: "work-1", role: "observer", allowance: 30 });
		const usage = { inputTokens: 12, outputTokens: 3, cacheHitTokens: 2, cacheMissTokens: 1 };
		ledger.settle({ runId: run.runId, complete: false, usage });
		assert.deepEqual(archive.project("work-1").budget, { maxTokens: 100, consumedTokens: 15, reservedTokens: 35 });
		ledger.settle({ runId: run.runId, complete: true, usage: { ...usage, inputTokens: 100 } });
		assert.deepEqual(archive.project("work-1").budget, { maxTokens: 100, consumedTokens: 103, reservedTokens: 30 });
		assert.throws(() => ledger.settle({ runId: run.runId, complete: true, usage }), /erase/);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive enforces total role capacity and preserves uncertain slots across readers", async () => {
	const { archive, directory } = await fixture();
	const observer = new SQLiteArchive(join(directory, "archive.sqlite"));
	try {
		const ledger = new RunLedger(archive);
		const competing = new RunLedger(observer);
		const run = ledger.reserve({ workId: "work-1", role: "conclave", allowance: 10, maxConcurrentRuns: 1 });
		assert.equal(observer.countPendingInvocations(), 1);
		assert.throws(() => competing.reserve({ workId: "work-1", role: "oracle", allowance: 10, maxConcurrentRuns: 1 }), /limit is occupied/);
		ledger.settle({ runId: run.runId, complete: false });
		assert.equal(observer.countPendingInvocations(), 1);
		ledger.settle({ runId: run.runId, complete: true, usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 } });
		assert.equal(observer.countPendingInvocations(), 0);
		competing.reserve({ workId: "work-1", role: "oracle", allowance: 10, maxConcurrentRuns: 1 });
		assert.equal(archive.countPendingInvocations(), 1);
	} finally {
		observer.close();
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a missing usage report remains uncertain and holds its reservation", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const reserved = ledger.reserve({ workId: "work-1", role: "observer", allowance: 40 });
		ledger.settle({ runId: reserved.runId, complete: false });
		assert.equal(archive.project("work-1").budget.reservedTokens, 40);
		ledger.settle({ runId: reserved.runId, complete: true, usage: { inputTokens: 2, outputTokens: 3, cacheHitTokens: 0, cacheMissTokens: 0 } });
		assert.deepEqual(archive.project("work-1").budget, { maxTokens: 100, reservedTokens: 0, consumedTokens: 5 });
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

function userMeta(commandId, revision, commandFingerprint = `${commandId}-fingerprint`) {
	return { actor: "user", commandId, commandFingerprint, expectedWorkRevision: revision, schemaVersion: 1 };
}

test("User reconciliation atomically records evidence and releases only its run across reopen and replay", async () => {
	const { archive, directory } = await fixture();
	const path = join(directory, "archive.sqlite");
	let reopened;
	try {
		const ledger = new RunLedger(archive);
		const target = ledger.reserve({ workId: "work-1", role: "conclave", allowance: 20, runId: "held-run" });
		ledger.reserve({ workId: "work-1", role: "observer", allowance: 30, runId: "other-run" });
		const usage = { inputTokens: 24, outputTokens: 6, cacheHitTokens: 4, cacheMissTokens: 2 };
		const meta = userMeta("user-reconcile-held", target.projection.revision + 1);
		const reconciled = ledger.reconcile({ runId: target.runId, workId: "work-1", usage, meta, evidence: ["provider usage export #17"] });
		assert.deepEqual(reconciled.budget, { maxTokens: 100, reservedTokens: 30, consumedTokens: 30 });
		assert.deepEqual(reconciled.activeInvocations.map((run) => run.runId), ["other-run"]);
		const record = archive.findCommand(meta.commandId, meta.commandFingerprint).record;
		assert.equal(record.actor, "user");
		assert.deepEqual(record.evidenceRefs, ["provider usage export #17"]);
		assert.equal(record.payload.state, "settled");
		assert.equal(archive.countPendingInvocations(), 1);

		archive.close();
		reopened = new SQLiteArchive(path);
		const replayed = new RunLedger(reopened).reconcile({ runId: target.runId, workId: "work-1", usage, meta, evidence: ["provider usage export #17"] });
		assert.equal(replayed.revision, reconciled.revision);
		assert.equal(new RunLedger(reopened).find(target.runId).state, "settled");
		assert.equal(reopened.query({ workId: "work-1", kinds: ["invocation"] }).items.length, 3);
	} finally {
		reopened?.close();
		try { archive.close(); } catch {}
		await rm(directory, { recursive: true, force: true });
	}
});

test("User reconciliation rejects stale, cross-Work, non-User, blank-evidence, and invalid cumulative usage", async () => {
	const { archive, directory } = await fixture();
	try {
		archive.append({ commandId: "submission-2", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "work-2", payloadVersion: 1, summary: "submitted", payload: {}, projection: view("work-2", 1) });
		const ledger = new RunLedger(archive);
		const run = ledger.reserve({ workId: "work-1", role: "oracle", allowance: 20, runId: "reconcile-invalid" });
		ledger.settle({ runId: run.runId, complete: false, usage: { inputTokens: 8, outputTokens: 2, cacheHitTokens: 1, cacheMissTokens: 0 } });
		const revision = archive.project("work-1").revision;
		const usage = { inputTokens: 8, outputTokens: 2, cacheHitTokens: 1, cacheMissTokens: 0 };
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage, evidence: ["usage log"], meta: userMeta("stale", revision - 1) }), /revision conflict/);
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-2", usage, evidence: ["usage log"], meta: userMeta("cross-work", 1) }), /another Work/);
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage, evidence: ["usage log"], meta: { ...userMeta("system", revision), actor: "system" } }), /User actor/);
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage, evidence: ["  "], meta: userMeta("blank", revision) }), /nonblank evidence/);
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage: { ...usage, inputTokens: 7 }, evidence: ["usage log"], meta: userMeta("lower", revision) }), /erase/);
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }, evidence: ["usage log"], meta: userMeta("overflow", revision) }), /safe integers/);
		assert.equal(archive.project("work-1").revision, revision);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("settled User reconciliation replay rejects changed usage", async () => {
	const { archive, directory } = await fixture();
	try {
		const ledger = new RunLedger(archive);
		const systemRun = ledger.reserve({ workId: "work-1", role: "oracle", allowance: 10, runId: "system-settled" });
		const systemUsage = { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 };
		ledger.settle({ runId: systemRun.runId, complete: true, usage: systemUsage });
		assert.throws(() => ledger.reconcile({ runId: systemRun.runId, workId: "work-1", usage: systemUsage, evidence: ["usage log"], meta: userMeta("settled-conflict", archive.project("work-1").revision) }), /already settled/);
		const run = ledger.reserve({ workId: "work-1", role: "executor", allowance: 20, runId: "settled-replay" });
		const usage = { inputTokens: 4, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 };
		const meta = userMeta("settled-user-command", run.projection.revision);
		ledger.reconcile({ runId: run.runId, workId: "work-1", usage, evidence: ["usage log"], meta });
		assert.throws(() => ledger.reconcile({ runId: run.runId, workId: "work-1", usage: { ...usage, outputTokens: 2 }, evidence: ["usage log"], meta }), /different usage/);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("reconciliation rejects unsafe aggregate counters without changing the Archive", async () => {
	const { archive, directory } = await fixture();
	try {
		const maximum = Number.MAX_SAFE_INTEGER;
		const budgetView = view("work-budget-overflow", 1, { maxTokens: maximum, reservedTokens: 0, consumedTokens: maximum - 2 });
		budgetView.terms = { ...budgetView.terms, maxTokens: maximum };
		archive.append({ commandId: "budget-overflow-submission", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: budgetView.workId, payloadVersion: 1, summary: "submitted", payload: {}, projection: budgetView });

		const ledger = new RunLedger(archive);
		const budgetRun = ledger.reserve({ workId: budgetView.workId, role: "oracle", allowance: 1, runId: "budget-overflow-run" });
		const budgetMeta = userMeta("budget-overflow-reconciliation", budgetRun.projection.revision);
		assert.throws(() => ledger.reconcile({ runId: budgetRun.runId, workId: budgetView.workId, usage: { inputTokens: 2, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 }, evidence: ["usage log"], meta: budgetMeta }), /projection/);
		assert.equal(archive.project(budgetView.workId).revision, budgetRun.projection.revision);
		assert.deepEqual(archive.project(budgetView.workId).budget, budgetRun.projection.budget);
		assert.equal(archive.findCommand(budgetMeta.commandId), undefined);

		const executionView = view("work-execution-overflow", 1);
		executionView.mission = { missionId: "mission-overflow", workId: executionView.workId, assignment: executionView.terms, mandateRevision: 1, createdAt: "2026-01-01T00:00:00.000Z" };
		executionView.execution = { executionId: "execution-overflow", workId: executionView.workId, missionId: executionView.mission.missionId, model: "model", thinking: "medium", state: "running", tokenAllowance: 10, usage: { inputTokens: maximum - 1, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, promptIdentity: { packageVersion: "1", promptSha256: "sha" }, sandbox: { path: ".", baseCommit: "base", branch: "branch" } };
		archive.append({ commandId: "execution-overflow-submission", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: executionView.workId, payloadVersion: 1, summary: "submitted", payload: {}, projection: executionView });
		const executionRun = ledger.reserve({ workId: executionView.workId, role: "executor", missionId: executionView.mission.missionId, executionId: executionView.execution.executionId, allowance: 10, runId: "execution-overflow-run" });
		const executionMeta = userMeta("execution-overflow-reconciliation", executionRun.projection.revision);
		assert.throws(() => ledger.reconcile({ runId: executionRun.runId, workId: executionView.workId, usage: { inputTokens: 2, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, evidence: ["usage log"], meta: executionMeta }), /projection/);
		assert.equal(archive.project(executionView.workId).revision, executionRun.projection.revision);
		assert.deepEqual(archive.project(executionView.workId).activeInvocations, executionRun.projection.activeInvocations);
		assert.equal(archive.findCommand(executionMeta.commandId), undefined);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});
