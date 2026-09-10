import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { admitAndStart, makeService, meta } from "./helpers/mvp-fixtures.mjs";

const usage = (inputTokens, outputTokens = 0) => ({
	inputTokens,
	outputTokens,
	cacheHitTokens: 0,
	cacheMissTokens: 0,
});

async function fixture(receipt) {
	const directory = await mkdtemp(join(tmpdir(), "khala-invocation-recovery-"));
	const calls = [];
	const runtime = {
		async reconcileInvocation(runId) {
			calls.push(runId);
			if (receipt instanceof Error) throw receipt;
			return receipt;
		},
		async getState() {
			return receipt.runtimeState ?? "idle";
		},
	};
	const made = makeService(join(directory, "archive.sqlite"), { ports: { runtime } });
	const submitted = made.service.submitWork(
		{ title: "Recovery", objective: "Recover a held run", acceptanceCriteria: ["Budget is exact"] },
		meta("user", "submit", 0),
	);
	return { ...made, calls, directory, ledger: new RunLedger(made.archive), work: submitted };
}

async function cleanup(value) {
	await value.service.close();
	await rm(value.directory, { recursive: true, force: true });
}

function reserve(value, workId = value.work.workId) {
	return value.ledger.reserve({ workId, role: "conclave", allowance: 40 });
}

function reconcileCommand(value, runId, actor = "user", reported = usage(5), evidence = ["operator log"]) {
	const work = value.service.inspectWork(value.work.workId);
	return {
		action: "reconcile-invocation",
		workId: work.workId,
		input: { runId, usage: reported, evidence },
		meta: meta(actor, "reconcile", work.revision, work.workId),
	};
}

test("reconciliation is User-only and verifies Work ownership before touching runtime", async () => {
	const value = await fixture({ complete: false, usage: usage(2) });
	try {
		const run = reserve(value);
		const forbidden = await value.service.perform(reconcileCommand(value, run.runId, "conclave"));
		assert.equal(forbidden.error.code, "forbidden");
		const other = value.service.submitWork(
			{ title: "Other", objective: "Other work", acceptanceCriteria: ["Separate"] },
			meta("user", "other-submit", 0),
		);
		const current = value.service.inspectWork(other.workId);
		const crossed = await value.service.perform({
			...reconcileCommand(value, run.runId),
			workId: other.workId,
			meta: meta("user", "crossed", current.revision),
		});
		assert.equal(crossed.error.code, "invalid-input");
		assert.equal(value.calls.length, 0);
	} finally {
		await cleanup(value);
	}
});

test("runtime refusal and incomplete evidence preserve the held reservation", async () => {
	const active = await fixture(new Error("Invocation is currently active."));
	try {
		const run = reserve(active);
		const refused = await active.service.perform(reconcileCommand(active, run.runId));
		assert.equal(refused.error.code, "external-failure");
		assert.equal(active.service.inspectWork(active.work.workId).budget.reservedTokens, 40);
	} finally {
		await cleanup(active);
	}

	const missingEvidence = await fixture({ complete: false, usage: usage(2) });
	try {
		const run = reserve(missingEvidence);
		const result = await missingEvidence.service.perform(reconcileCommand(missingEvidence, run.runId, "user", usage(5), []));
		assert.match(result.error.summary, /evidence/i);
		assert.equal(missingEvidence.service.inspectWork(missingEvidence.work.workId).budget.reservedTokens, 40);
	} finally {
		await cleanup(missingEvidence);
	}
});

test("partial receipts require monotonic cumulative usage and command replay is exact", async () => {
	const value = await fixture({ complete: false, usage: usage(4) });
	try {
		const run = reserve(value);
		value.ledger.settle({ runId: run.runId, usage: usage(6), complete: false });
		const tooLow = await value.service.perform(reconcileCommand(value, run.runId, "user", usage(5)));
		assert.match(tooLow.error.summary, /lower/i);
		const command = reconcileCommand(value, run.runId, "user", usage(8));
		const settled = await value.service.perform(command);
		assert.deepEqual(settled.value.budget, { maxTokens: 100, reservedTokens: 0, consumedTokens: 8 });
		const replayed = await value.service.perform(command);
		assert.equal(replayed.value.workId, settled.value.workId);
		assert.equal(value.archive.findCommand("reconcile").record.actor, "user");
		assert.equal(value.calls.length, 2);
	} finally {
		await cleanup(value);
	}
});

test("complete receipts are exact and terminal settlement does not resurrect Work", async () => {
	const value = await fixture({ complete: true, usage: usage(7, 2) });
	try {
		const run = reserve(value);
		let work = value.service.inspectWork(value.work.workId);
		value.archive.append({
			commandId: "terminal",
			expectedWorkRevision: work.revision,
			kind: "outcome",
			actor: "system",
			workId: work.workId,
			payloadVersion: 1,
			summary: "terminal",
			payload: {},
			projection: { ...work, revision: work.revision + 1, state: "succeeded", nextAction: "Inspect evidence." },
		});
		work = value.service.inspectWork(work.workId);
		assert.equal(
			value.service.availableActions(work.workId, "user").some((action) => action.kind === "reconcile-invocation"),
			true,
		);
		const mismatch = await value.service.perform({
			...reconcileCommand(value, run.runId, "user", usage(8, 2)),
			meta: meta("user", "mismatch", work.revision),
		});
		assert.match(mismatch.error.summary, /differs/i);
		const exact = await value.service.perform({
			...reconcileCommand(value, run.runId, "user", usage(7, 2), []),
			meta: meta("user", "exact", work.revision),
		});
		assert.equal(exact.value.state, "succeeded");
		assert.equal(exact.value.activeInvocations.length, 0);
	} finally {
		await cleanup(value);
	}
});

test("recover auto-settles only complete durable receipts and clears held-run attention", async () => {
	const value = await fixture({ complete: true, usage: usage(3) });
	try {
		reserve(value);
		let work = value.service.inspectWork(value.work.workId);
		value.archive.append({
			commandId: "held-attention",
			expectedWorkRevision: work.revision,
			kind: "error",
			actor: "system",
			workId: work.workId,
			payloadVersion: 1,
			summary: "held",
			payload: {},
			projection: {
				...work,
				revision: work.revision + 1,
				lastError: { code: "external-failure", summary: "Model dispatch is waiting for an existing invocation to settle.", retryable: false, remediation: "reconcile", evidenceRefs: ["held"] },
				nextAction: "waiting",
			},
		});
		work = value.service.inspectWork(work.workId);
		const recovered = await value.service.recoverWork(work.workId, meta("user", "recover", work.revision));
		assert.equal(recovered.budget.reservedTokens, 0);
		assert.equal(recovered.lastError, undefined);
	} finally {
		await cleanup(value);
	}

	const incomplete = await fixture({ complete: false, usage: usage(3) });
	try {
		reserve(incomplete);
		const work = incomplete.service.inspectWork(incomplete.work.workId);
		await assert.rejects(
			incomplete.service.recoverWork(work.workId, meta("user", "recover-incomplete", work.revision)),
			/complete durable receipt/i,
		);
		assert.equal(incomplete.service.inspectWork(work.workId).budget.reservedTokens, 40);
	} finally {
		await cleanup(incomplete);
	}
});

test("complete receipt recovery refreshes revision before recording the current Executor state", async () => {
	const value = await fixture({ complete: true, usage: usage(2), runtimeState: "working" });
	try {
		const running = await admitAndStart(value.service, "executor-recovery-revision");
		value.ledger.reserve({
			workId: running.workId,
			role: "executor",
			executionId: running.execution.executionId,
			missionId: running.mission.missionId,
			allowance: 20,
		});
		const held = value.service.inspectWork(running.workId);
		const recovered = await value.service.recoverWork(
			held.workId,
			meta("user", "recover-executor-revision", held.revision),
		);
		assert.equal(recovered.execution.executionId, running.execution.executionId);
		assert.equal(recovered.execution.runtimeState, "working");
		assert.equal(recovered.budget.reservedTokens, 0);
	} finally {
		await cleanup(value);
	}
});
