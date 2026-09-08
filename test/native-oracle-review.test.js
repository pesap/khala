import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { archivePath } from "../dist/src/config.js";
import { createNativeTerminal, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

const oracleResponse = `Verdict: Pass
Findings:
- [minor] The bounded greeting change matches the Mission. | Evidence: greeting.txt contains hello and validation passed
Validation gaps:
- None.`;

test("native Conclave runs Oracle before handing off the same Execution", { timeout: 90_000 }, async () => {
	const fixture = await createNativeWorkflowFixture({ oracleResponse });
	const terminal = createNativeTerminal(fixture);
	const records = (kinds) => {
		const archive = new SQLiteArchive(archivePath({ archiveRoot: join(fixture.root, "archive") }, fixture.project), { readOnly: true });
		try { return archive.query({ workId: "native-execution", kinds, limit: 100 }).items; }
		finally { archive.close(); }
	};
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String), records: records(["oracle-review", "verdict", "invocation"]) });
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const reviewed = await waitUntil(terminal.readWork, (work) => work?.state === "awaiting-review" && work.budget.reservedTokens === 0 && fixture.steps.conclave >= 10, diagnostic);
		const evidence = records(["oracle-review", "verdict", "invocation"]);
		const advisory = evidence.find((record) => record.kind === "oracle-review");
		const handoff = evidence.find((record) => record.kind === "verdict");
		const oracleInvocations = evidence.filter((record) => record.kind === "invocation" && record.payload.role === "oracle");

		assert.equal(reviewed.execution.state, "awaiting-review");
		assert.equal(reviewed.missionState, "awaiting-review");
		assert.equal(reviewed.oraclePending, undefined);
		assert.equal(fixture.oracleRequests.length, 1);
		assert.equal(fixture.oracleRequests[0].tools, undefined);
		assert.match(JSON.stringify(fixture.oracleRequests[0].messages), /greeting\.txt/);
		assert.equal(advisory.payload.verdict, "pass");
		assert.equal(advisory.payload.output, oracleResponse);
		assert.equal(advisory.executionId, reviewed.execution.executionId);
		assert.ok(advisory.sequence < handoff.sequence, "Conclave must read the advisory before recording handoff");
		assert.equal(handoff.payload.decision, "handoff");
		assert.equal(handoff.executionId, reviewed.execution.executionId);
		assert.equal(oracleInvocations.length, 2);
		assert.equal(oracleInvocations.at(-1).payload.state, "settled");
		assert.ok(fixture.toolResults.some((result) => result.includes("Oracle advisory result: pass.")));
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
