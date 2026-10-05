import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { openSqlite } from "../dist/src/sqlite.js";
import { RunLedger } from "../dist/src/run-ledger.js";

function view(workId, revision, fields = {}) {
	return {
		workId,
		revision,
		state: "submitted",
		terms: {
			title: "Title",
			objective: "Objective",
			context: "",
			scope: "scope",
			acceptanceCriteria: ["accept"],
			constraints: [],
			validation: ["check"],
			allowedPaths: ["."],
			maxTokens: 100,
		},
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
		...fields,
	};
}

function createArchive(path, workId = "work-1") {
	const archive = new SQLiteArchive(path);
	const projection = view(workId, 1);
	archive.append({
		commandId: `submission:${workId}`,
		expectedWorkRevision: 0,
		kind: "submission",
		actor: "user",
		workId,
		payloadVersion: 1,
		summary: "submitted",
		payload: {},
		projection,
	});
	return archive;
}

function installLegacyExecutionProjection(
	path,
	{ allowance, usage, reservedTokens, consumedTokens = 0, executionState = "running" },
) {
	const database = openSqlite(path);
	try {
		const row = database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get("work-1");
		const current = JSON.parse(String(row.view_json));
		const execution = {
			executionId: "execution-1",
			workId: "work-1",
			missionId: "mission-1",
			state: executionState,
			model: "model",
			thinking: "high",
			tokenAllowance: allowance,
			promptIdentity: { packageVersion: "1.0.0", promptSha256: "digest" },
			sandbox: { path: "/tmp/sandbox", baseCommit: "base", branch: "branch" },
		};
		if (usage !== undefined) execution.usage = usage;
		const legacy = {
			...current,
			revision: current.revision + 1,
			state: "active",
			missionState: "active",
			mission: {
				missionId: "mission-1",
				workId: "work-1",
				createdAt: "2026-01-01T00:00:00.000Z",
				assignment: current.terms,
				mandateRevision: 1,
			},
			execution,
			budget: { ...current.budget, reservedTokens, consumedTokens },
		};
		delete legacy.activeInvocations;
		database
			.prepare("UPDATE work_projection SET revision = ?, view_json = ? WHERE work_id = ?")
			.run(legacy.revision, JSON.stringify(legacy), "work-1");
	} finally {
		database.close();
	}
}

function storedWorkProjection(path, workId = "work-1") {
	const database = openSqlite(path, { readOnly: true });
	try {
		const row = database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get(workId);
		return String(row.view_json);
	} finally {
		database.close();
	}
}

function appendProjection(archive, current, projection, commandId) {
	return archive.append({
		commandId,
		expectedWorkRevision: current.revision,
		kind: "error",
		actor: "system",
		workId: current.workId,
		payloadVersion: 1,
		summary: "projection update",
		payload: {},
		projection,
	});
}

async function cleanup(directory, archive) {
	try {
		archive.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("Archive rejects phantom active invocations on append", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-phantom-"));
	const archive = createArchive(join(directory, "archive.sqlite"));
	try {
		const current = archive.project("work-1");
		const projection = {
			...current,
			revision: current.revision + 1,
			activeInvocations: [{ runId: "phantom", role: "executor", allowance: 20, state: "reserved" }],
			budget: { ...current.budget, reservedTokens: 20 },
		};
		assert.throws(
			() => appendProjection(archive, current, projection, "phantom-projection"),
			/durable invocation fact/,
		);
		assert.equal(archive.project("work-1").revision, current.revision);
	} finally {
		await cleanup(directory, archive);
	}
});

test("Archive rejects duplicate active run IDs and inconsistent reservation accounting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-duplicates-"));
	const archive = createArchive(join(directory, "archive.sqlite"));
	try {
		const ledger = new RunLedger(archive);
		const reserved = ledger.reserve({ workId: "work-1", role: "executor", allowance: 20, runId: "duplicate-run" });
		const current = archive.project("work-1");
		const active = current.activeInvocations[0];
		const duplicate = {
			...current,
			revision: current.revision + 1,
			activeInvocations: [active, active],
		};
		assert.throws(
			() => appendProjection(archive, current, duplicate, "duplicate-projection"),
			/duplicate active invocation/,
		);
		const inconsistent = {
			...current,
			revision: current.revision + 1,
			budget: { ...current.budget, reservedTokens: 0 },
		};
		assert.throws(
			() => appendProjection(archive, current, inconsistent, "inconsistent-projection"),
			/reservation accounting/,
		);
		assert.deepEqual(archive.project("work-1").activeInvocations, reserved.projection.activeInvocations);
	} finally {
		await cleanup(directory, archive);
	}
});

test("Archive rejects a persisted phantom active invocation on restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-restart-"));
	const path = join(directory, "archive.sqlite");
	const archive = createArchive(path);
	archive.close();
	const database = openSqlite(path);
	try {
		const row = database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get("work-1");
		const projection = JSON.parse(String(row.view_json));
		projection.activeInvocations = [{ runId: "persisted-phantom", role: "observer", allowance: 10, state: "uncertain" }];
		projection.budget.reservedTokens = 10;
		database
			.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?")
			.run(JSON.stringify(projection), "work-1");
	} finally {
		database.close();
	}
	assert.throws(() => new SQLiteArchive(path), /durable invocation fact/);
	await rm(directory, { recursive: true, force: true });
});

test("Archive rejects untracked Execution reservations without rewriting them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-untracked-reservation-"));
	const path = join(directory, "archive.sqlite");
	const initial = createArchive(path);
	initial.close();
	installLegacyExecutionProjection(path, {
		allowance: 50,
		usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 0 },
		reservedTokens: 35,
		consumedTokens: 15,
	});
	const before = storedWorkProjection(path);

	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			assert.throws(() => new SQLiteArchive(path), /reservation accounting/);
			assert.equal(storedWorkProjection(path), before);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive rejects held tokens with an empty active invocation list", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-active-invocations-"));
	const path = join(directory, "archive.sqlite");
	const archive = createArchive(path);
	archive.close();
	installLegacyExecutionProjection(path, { allowance: 20, reservedTokens: 20 });
	const database = openSqlite(path);
	try {
		const row = database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get("work-1");
		const legacy = JSON.parse(String(row.view_json));
		legacy.activeInvocations = [];
		database
			.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?")
			.run(JSON.stringify(legacy), "work-1");
	} finally {
		database.close();
	}

	try {
		assert.throws(() => new SQLiteArchive(path), /reservation accounting/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive rejects untracked reservations even with invocation history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-invocation-history-"));
	const path = join(directory, "archive.sqlite");
	const archive = createArchive(path);
	new RunLedger(archive).reserve({ workId: "work-1", role: "executor", allowance: 20, runId: "durable-run" });
	archive.close();
	installLegacyExecutionProjection(path, { allowance: 20, reservedTokens: 20 });

	try {
		assert.throws(() => new SQLiteArchive(path), /reservation accounting/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive rejects untracked reservations and incomplete Execution usage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-invalid-legacy-reservation-"));
	try {
		for (const scenario of [
			{
				name: "mismatched-reservation",
				usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 0 },
				reservedTokens: 34,
				error: /reservation accounting/,
			},
			{
				name: "underreported-consumption",
				usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 0 },
				reservedTokens: 35,
				consumedTokens: 0,
				error: /reservation accounting/,
			},
			{
				name: "partial-usage",
				usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 },
				reservedTokens: 35,
				error: /Work projection is invalid/,
			},
		]) {
			const path = join(directory, scenario.name, "archive.sqlite");
			const archive = createArchive(path);
			archive.close();
			installLegacyExecutionProjection(path, {
				allowance: 50,
				usage: scenario.usage,
				reservedTokens: scenario.reservedTokens,
				consumedTokens: scenario.consumedTokens ?? 15,
			});
			const before = storedWorkProjection(path);
			assert.throws(() => new SQLiteArchive(path), scenario.error, scenario.name);
			assert.equal(storedWorkProjection(path), before, scenario.name);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive preserves queued Executions without invocation reservations", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-queued-execution-"));
	const path = join(directory, "archive.sqlite");
	const initial = createArchive(path);
	initial.close();
	installLegacyExecutionProjection(path, { allowance: 50, reservedTokens: 0, executionState: "queued" });

	let archive;
	try {
		archive = new SQLiteArchive(path);
		const work = archive.project("work-1");
		assert.equal(work.execution.state, "queued");
		assert.equal(work.budget.reservedTokens, 0);
		assert.equal(work.activeInvocations, undefined);
	} finally {
		archive?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive rejects untracked Execution reservations without usage evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-untracked-no-usage-"));
	const path = join(directory, "archive.sqlite");
	const initial = createArchive(path);
	initial.close();
	installLegacyExecutionProjection(path, { allowance: 50, reservedTokens: 50 });
	const before = storedWorkProjection(path);

	try {
		assert.throws(() => new SQLiteArchive(path), /reservation accounting/);
		assert.equal(storedWorkProjection(path), before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Failed Archive startup preserves another Work's reservations", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-failed-startup-"));
	const path = join(directory, "archive.sqlite");
	const initial = createArchive(path);
	initial.append({
		commandId: "submission:work-2",
		expectedWorkRevision: 0,
		kind: "submission",
		actor: "user",
		workId: "work-2",
		payloadVersion: 1,
		summary: "submitted",
		payload: {},
		projection: view("work-2", 1),
	});
	initial.close();
	installLegacyExecutionProjection(path, {
		allowance: 50,
		usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 0 },
		reservedTokens: 35,
		consumedTokens: 15,
	});
	const other = JSON.parse(storedWorkProjection(path, "work-2"));
	other.budget.consumedTokens = -1;
	const database = openSqlite(path);
	try {
		database
			.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?")
			.run(JSON.stringify(other), "work-2");
	} finally {
		database.close();
	}
	const before = storedWorkProjection(path);

	try {
		assert.throws(() => new SQLiteArchive(path), /Work projection is invalid/);
		assert.equal(storedWorkProjection(path), before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive accepts reserved and uncertain invocations across Works and restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-integrity-valid-"));
	const path = join(directory, "archive.sqlite");
	let archive = createArchive(path);
	try {
		archive.append({
			commandId: "submission:work-2",
			expectedWorkRevision: 0,
			kind: "submission",
			actor: "user",
			workId: "work-2",
			payloadVersion: 1,
			summary: "submitted",
			payload: {},
			projection: view("work-2", 1),
		});
		const ledger = new RunLedger(archive);
		const settled = ledger.reserve({ workId: "work-1", role: "conclave", allowance: 10, runId: "settled-run" });
		ledger.settle({ runId: settled.runId, complete: true, usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 } });
		const uncertain = ledger.reserve({ workId: "work-2", role: "observer", allowance: 20, runId: "uncertain-run" });
		ledger.settle({ runId: uncertain.runId, complete: false });
		const expected = archive.project("work-2");
		archive.close();
		archive = new SQLiteArchive(path);
		assert.deepEqual(archive.project("work-2"), expected);
		assert.equal(archive.project("work-2").activeInvocations[0].state, "uncertain");
	} finally {
		await cleanup(directory, archive);
	}
});
