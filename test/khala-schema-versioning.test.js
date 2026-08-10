import assert from "node:assert/strict";
import test from "node:test";
import { isArchiveRecord } from "../dist/src/khala-model.js";

test("execution schema v3 rejects non-Execution Archive records", () => {
	assert.equal(
		isArchiveRecord({
			recordId: "schema-v3-signal",
			schemaVersion: 3,
			type: "signal",
			projectPath: "/tmp/project",
			workId: "work",
			executionId: "execution",
			recordedAt: "2026-01-01T00:00:00.000Z",
			payload: {
				signalId: "signal",
				workId: "work",
				executionId: "execution",
				executorName: "Executor",
				missionId: "mission",
				participantId: "executor:mission",
				kind: "progress",
				summary: "Progress",
				evidence: [],
				observedAt: "2026-01-01T00:00:00.000Z",
			},
		}),
		false,
	);
});
