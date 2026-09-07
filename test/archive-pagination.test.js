import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";

function projection(workId, revision) {
	return {
		workId,
		revision,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
	};
}

async function createArchive() {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-pagination-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	for (let revision = 1; revision <= 201; revision += 1) {
		archive.append({
			commandId: `command-${revision}`,
			expectedWorkRevision: revision - 1,
			kind: "submission",
			actor: "user",
			workId: "work-1",
			payloadVersion: 1,
			summary: `record-${revision}`,
			payload: { revision },
			projection: projection("work-1", revision),
		});
	}
	return { archive, directory, path };
}

test("Archive record pages support bounded newest-first snapshots", async () => {
	const { archive, directory, path } = await createArchive();
	try {
		const first = archive.query({ order: "desc" });
		assert.equal(first.items.length, 100);
		assert.deepEqual(first.items.map((item) => item.sequence), Array.from({ length: 100 }, (_, index) => 201 - index));
		assert.ok(first.nextCursor);

		archive.append({
			commandId: "command-202",
			expectedWorkRevision: 201,
			kind: "submission",
			actor: "user",
			workId: "work-1",
			payloadVersion: 1,
			summary: "record-202",
			payload: { revision: 202 },
			projection: projection("work-1", 202),
		});
		const second = archive.query({ order: "desc" }, first.nextCursor);
		assert.deepEqual(second.items.map((item) => item.sequence), Array.from({ length: 100 }, (_, index) => 101 - index));
		assert.ok(second.nextCursor);
		const restarted = new SQLiteArchive(path);
		try {
			const third = restarted.query({ order: "desc" }, second.nextCursor);
			assert.deepEqual(third.items.map((item) => item.sequence), [1]);
			assert.throws(() => restarted.query({ order: "asc" }, first.nextCursor), /does not match/);
			assert.throws(() => restarted.query({ order: "sideways" }, first.nextCursor), /order/);
		} finally {
			restarted.close();
		}
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Archive ascending queries remain unchanged", async () => {
	const { archive, directory } = await createArchive();
	try {
		const implicit = archive.query();
		const explicit = archive.query({ order: "asc" });
		assert.deepEqual(explicit.items.map((item) => item.sequence), implicit.items.map((item) => item.sequence));
		assert.deepEqual(implicit.items.map((item) => item.sequence), Array.from({ length: 100 }, (_, index) => index + 1));
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});
