import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	makeService,
	performCurrent,
	repairAction,
	workWithCiFailure,
} from "./helpers/ci-repair-fixtures.mjs";

test("incomplete provider check sets wake Conclave but cannot authorize repair", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-incomplete-"));
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"));
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-incomplete", {
			status: "checks-incomplete",
			details: {
				pullRequest: { url: "https://github.com/example/project/pull/42", status: "draft", state: "OPEN", reviewDecision: "", mergedAt: null },
				comments: [],
				checks: [{ kind: "check-run", name: "unit tests", status: "COMPLETED", conclusion: "FAILURE" }],
			},
		});
		const messages = [];
		controls.onConclaveWake = (message) => messages.push(message);
		assert.equal(work.lastError.summary, "Provider check evidence is incomplete.");
		assert.match(work.nextAction, /incomplete/);
		assert.equal(repairAction(service, work.workId).enabled, false);
		await service.processPendingEffects();
		assert.equal(messages.length, 1);
		assert.match(messages[0], /checksComplete/);
		assert.match(messages[0], /An incomplete check set cannot authorize repair or handoff/);
		const result = await performCurrent(service, "conclave", "repair-ci", "ci-incomplete:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in result, true);
		assert.equal(archive.query({ workId: work.workId, kinds: ["delivery"] }).items.some((record) => record.payload.status === "authorized" && record.payload.kind === "ci-repair"), false);
	} finally {
		await service.close();
	}
});
