import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkView } from "../dist/src/archive-codec.js";

function projection(fields = {}) {
	return {
		workId: "work-1",
		revision: 1,
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

test("Work projection validation preserves legacy absence of newer optional fields", () => {
	assert.deepEqual(parseWorkView(JSON.stringify(projection())), projection());
});

test("Work projection validation rejects malformed newer optional fields", () => {
	const malformed = [
		["preparation", { status: "waiting", prerequisiteId: "id", operation: "dependencies", diagnostic: 3, recovery: "user" }],
		["correctionCount", -1],
		["dispatchLimits", { maxCorrections: 0 }],
		["oraclePending", { requestId: "request", signalId: "signal", headCommit: "head", subject: {}, missionId: "mission" }],
		["activeInvocations", [{ runId: "run", role: "executor", allowance: 0, state: "reserved" }]],
	];

	for (const [field, value] of malformed) {
		assert.throws(
			() => parseWorkView(JSON.stringify(projection({ [field]: value }))),
			/Archive Work projection is invalid/,
			`expected malformed ${field} to be rejected`,
		);
	}
});
