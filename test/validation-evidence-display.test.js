import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRecordPage } from "../dist/src/tui-record-list.js";

function validationRecord(proof) {
	return {
		id: "validation-1", sequence: 1, recordNumber: 1, kind: "validation", actor: "executor",
		workId: "work-1", recordedAt: "2026-09-08T00:00:00Z", payloadVersion: 1,
		summary: "Validation attempt recorded.", evidenceRefs: ["check-greeting"],
		payload: {
			executionId: "execution-1", headCommit: "head-1", ...proof,
			results: [{ command: "check-greeting", passed: true, output: "Command passed" }],
		},
	};
}

test("validation Evidence explains changed source while retaining actual command results", () => {
	const page = formatRecordPage(validationRecord({
		sourceVerified: false,
		sourceFailure: "Source changed: greeting.txt. Commit the intended source and rerun validation.",
	}));
	const source = page.sections.find((section) => section.heading === "Source verification");
	assert.ok(source);
	assert.match(source.lines.join("\n"), /greeting\.txt.*rerun validation/);
	assert.match(JSON.stringify(page), /Command passed/);
	assert.doesNotMatch(JSON.stringify(page), /sourceVerified|sourceFailure/);
});

test("validation Evidence distinguishes verified source from missing proof", () => {
	for (const [proof, expected] of [
		[{ sourceVerified: true }, /Committed source stayed unchanged/],
		[{}, /not recorded.*Rerun validation/],
	]) {
		const page = formatRecordPage(validationRecord(proof));
		const source = page.sections.find((section) => section.heading === "Source verification");
		assert.ok(source);
		assert.match(source.lines.join("\n"), expected);
	}
});
