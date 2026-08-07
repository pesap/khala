import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadOracleReviewPrompt, parseOracleReviewSummary } from "../dist/src/khala-oracle-summary.js";

const reviseResponse = `## Review Summary
The review found two material defects in the Oracle failure and rendering paths.

## Required Changes
- [P1] Preserve the child diagnostic
  - Evidence: The child writes provider failures to stdout.
  - Impact: Users see the generated command instead of the failure cause.
  - Required action: Render bounded stdout or stderr before a generic process status.
- [P2] Escape Oracle output controls
  - Evidence: The expanded renderer interpolates result output into Markdown.
  - Impact: A reviewer response can emit terminal control sequences.
  - Required action: Escape terminal controls before rendering output.

## Review Gaps
- A live provider response was unavailable.

## Human Reviewer Callouts
- This changes the Oracle review response contract.

## Verdict
revise`;

test("Oracle summary parses required changes, gaps, and callouts from the review contract", () => {
	assert.deepEqual(parseOracleReviewSummary(reviseResponse), {
		verdict: "revise",
		summary: "The review found two material defects in the Oracle failure and rendering paths.",
		requiredChanges: [
			{
				priority: "P1",
				title: "Preserve the child diagnostic",
				evidence: "The child writes provider failures to stdout.",
				impact: "Users see the generated command instead of the failure cause.",
				requiredAction: "Render bounded stdout or stderr before a generic process status.",
			},
			{
				priority: "P2",
				title: "Escape Oracle output controls",
				evidence: "The expanded renderer interpolates result output into Markdown.",
				impact: "A reviewer response can emit terminal control sequences.",
				requiredAction: "Escape terminal controls before rendering output.",
			},
		],
		reviewGaps: ["A live provider response was unavailable."],
		humanReviewerCallouts: ["This changes the Oracle review response contract."],
	});
});

test("Oracle summary accepts pass only when the response requests no changes", () => {
	const passResponse = `## Review Summary
The supplied evidence does not show a material defect.

## Required Changes
- (none)

## Review Gaps
- A live provider response was unavailable.

## Human Reviewer Callouts
- (none)

## Verdict
pass`;
	assert.deepEqual(parseOracleReviewSummary(passResponse), {
		verdict: "pass",
		summary: "The supplied evidence does not show a material defect.",
		requiredChanges: [],
		reviewGaps: ["A live provider response was unavailable."],
		humanReviewerCallouts: [],
	});
});

test("Oracle summary rejects malformed contracts and verdicts that contradict required changes", () => {
	assert.equal(parseOracleReviewSummary(reviseResponse.replace("## Review Gaps", "## Gaps")), undefined);
	assert.equal(parseOracleReviewSummary(reviseResponse.replace("## Verdict\nrevise", "## Verdict\npass")), undefined);
	assert.equal(parseOracleReviewSummary(`${reviseResponse}\nExtra text`), undefined);
});

test("Oracle loads its review instruction from the explicit packaged prompt only", async () => {
	const prompt = await loadOracleReviewPrompt(join(process.cwd(), "prompts", "khala-oracle.md"));
	assert.match(prompt, /You are Khala's Oracle/);
	assert.match(prompt, /## Required Changes/);
	assert.match(prompt, /The Verdict line must be the final non-empty line/);
});
