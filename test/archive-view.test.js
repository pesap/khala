import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { openKhalaArchive } from "../dist/src/index.js";

function workProjection(workId, state = "queued") {
	const terms = {
		title: "Demo Work",
		objective: "Show the read-only demo archive.",
		context: "Fixture context",
		scope: "Fixture scope",
		acceptanceCriteria: ["The fixture is visible."],
		constraints: [],
		validation: ["No model calls"],
		allowedPaths: ["."],
		maxTokens: 1000,
	};
	const mission = {
		missionId: "mission-1",
		workId,
		assignment: terms,
		mandateRevision: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	return {
		workId,
		revision: 1,
		state,
		terms,
		budget: { maxTokens: 1000, reservedTokens: 0, consumedTokens: 0 },
		missionState: "admitted",
		mission,
		execution: {
			executionId: "execution-1",
			workId,
			missionId: mission.missionId,
			state: "queued",
			model: "demo/model",
			thinking: "off",
			tokenAllowance: 500,
			promptIdentity: { packageVersion: "1.0.0", promptSha256: "fixture" },
			sandbox: { path: "/tmp/demo", baseCommit: "base", branch: "khala/demo" },
		},
		nextAction: "Wait for the demo execution.",
		queuedSequence: 0,
	};
}

async function createArchive() {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-view-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	archive.append({
		commandId: "command-1",
		expectedWorkRevision: 0,
		kind: "submission",
		actor: "user",
		workId: "work-1",
		payloadVersion: 1,
		summary: "Demo Work submitted",
		payload: { title: "Demo Work" },
		projection: workProjection("work-1"),
	});
	archive.close();
	return { directory, path };
}

test("read-only Khala archive views expose projections and records without writes", async () => {
	const { directory, path } = await createArchive();
	try {
		const before = await readFile(path);
		const view = openKhalaArchive(path);
		assert.deepEqual(view.listWork(), [
			{
				workId: "work-1",
				title: "Demo Work",
				state: "queued",
				stopReason: undefined,
				missionState: "admitted",
				executionState: "queued",
				hasFailure: false,
				revision: 1,
				queuePosition: 1,
				budget: { maxTokens: 1000, reservedTokens: 0, consumedTokens: 0 },
				nextAction: "Wait for the demo execution.",
			},
		]);
		assert.equal(view.inspectWork("work-1").workId, "work-1");
		assert.equal(view.readRecords({ workId: "work-1" }).items.length, 1);
		assert.equal("append" in view, false);
		view.close();
		assert.deepEqual(await readFile(path), before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("opening a missing Khala archive fails instead of creating one", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-view-missing-"));
	try {
		assert.throws(() => openKhalaArchive(join(directory, "missing.sqlite")), /does not exist/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
