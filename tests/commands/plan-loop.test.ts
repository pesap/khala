import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_DEFAULT_MAX_ISSUES,
  PLAN_LOOP_ISSUE_LABELS,
  PLAN_LOOP_PHASES,
  PLAN_LOOP_STATES,
  PLAN_REVIEW_SIZE_TARGET_CHANGED_LOC,
  buildPlanLoopRuntimeSections,
} from "../../extensions/commands/plan-loop.ts";

test("plan loop contract exposes stable states, phases, and publish labels", () => {
  assert.deepEqual(PLAN_LOOP_STATES, [
    "candidate",
    "audited",
    "draft",
    "needs-revision",
    "blocked",
    "workon-ready",
    "published",
  ]);
  assert.deepEqual(PLAN_LOOP_PHASES, ["AUDIT", "DRAFT", "REVIEW", "REVISE", "READY ISSUE"]);
  assert.deepEqual(PLAN_LOOP_ISSUE_LABELS, ["improve", "workon-ready"]);
  assert.equal(PLAN_DEFAULT_MAX_ISSUES, 3);
  assert.equal(PLAN_REVIEW_SIZE_TARGET_CHANGED_LOC, 500);
});

test("plan loop runtime sections include model routing and readiness contract", () => {
  const sections = buildPlanLoopRuntimeSections({
    planningModel: "github-copilot/gpt-5.5",
    planningThinkingLevel: "xhigh",
    planningRoutingReason: "test planning profile",
    reviewerTwo: {
      enabled: true,
      context: "fresh",
      loops: 2,
      model: "github-copilot/gpt-5.4-mini",
      thinkingLevel: "medium",
      routingMode: "default",
      routingReason: "test reviewer profile",
    },
  });
  const rendered = sections.join("\n");

  assert.match(rendered, /Plan loop states: candidate -> audited -> draft/);
  assert.match(rendered, /Issue labels on published packets: improve, workon-ready/);
  assert.match(rendered, /Exact model: github-copilot\/gpt-5\.5/);
  assert.match(rendered, /Reviewer Two loop budget: 2/);
  assert.match(rendered, /canonical headings that \/workon parses exactly/);
  assert.match(rendered, /same review workflow contract used by \/review/);
});
