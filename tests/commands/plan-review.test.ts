import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlanReviewerTwoSections,
  formatReviewerTwoLaunchContract,
  normalizePlanWorkPacket,
  normalizeReviewerTwoReviewResult,
  resolveReviewerTwoReviewSettings,
} from "../../extensions/commands/plan-review.ts";

test("normalizes draft work packets from plain text and structured input", () => {
  assert.deepEqual(normalizePlanWorkPacket("add reviewer two"), {
    goal: "add reviewer two",
    why: "",
    inScope: [],
    outOfScope: [],
    acceptanceCriteria: [],
    validationPlan: [],
    risks: [],
    openQuestions: [],
    canonicalRefs: [],
  });

  assert.deepEqual(
    normalizePlanWorkPacket({
      goal: " add reviewer two ",
      why: " better draft quality ",
      inScope: [" /plan review ", ""],
      outOfScope: ["public command"],
      acceptanceCriteria: ["result is structured"],
      validationPlan: ["typecheck"],
      risks: ["flow change"],
      openQuestions: ["default model"],
      canonicalRefs: ["README.md"],
    }),
    {
      goal: "add reviewer two",
      why: "better draft quality",
      inScope: ["/plan review"],
      outOfScope: ["public command"],
      acceptanceCriteria: ["result is structured"],
      validationPlan: ["typecheck"],
      risks: ["flow change"],
      openQuestions: ["default model"],
      canonicalRefs: ["README.md"],
    },
  );
});

test("builds a Reviewer Two prompt contract with bounded stop rules", () => {
  const sections = buildPlanReviewerTwoSections("shape a plan", {
    enabled: true,
    model: "github-copilot/gpt-5.4-mini",
    thinkingLevel: "medium",
    loops: 1,
    context: "fresh",
    routingMode: "default",
    routingReason: "Reviewer Two development profile (pi-model-discovery)",
  });

  const rendered = sections.join("\n");
  assert.match(rendered, /reuses the \/review posture/);
  assert.match(rendered, /Reviewer Two is advisory only/);
  assert.match(rendered, /decision, blockers, importantRevisions/);
  assert.match(rendered, /decision vocabulary: pass, revise, blocked/);
  assert.match(rendered, /Reviewer Two launch contract: \/run reviewer\[model=github-copilot\/gpt-5\.4-mini:medium\] "<review task>"/);
  assert.match(rendered, /maximum review loop budget bounded at 2/);
  assert.match(rendered, /do not create issues, do not create PRs/);
});

test("formats a blocked Reviewer Two launch contract when model is unresolved", () => {
  const contract = formatReviewerTwoLaunchContract({
    enabled: true,
    model: "",
    thinkingLevel: "high",
    loops: 1,
    context: "fresh",
    routingMode: "default",
    routingReason: "Reviewer Two peer-review profile unresolved via builtin route peer-review -> peer-review: unknown reason",
  });

  assert.match(contract, /blocked until the Reviewer Two model is resolved/);
  assert.doesNotMatch(contract, /\[model=/);
});

test("resolves reviewer two defaults without implementation workflow flags", () => {
  const settings = resolveReviewerTwoReviewSettings();
  assert.equal(settings.model, "NLR/HALO GPT OSS 120b");
  assert.equal(settings.thinkingLevel, "off");
  assert.equal(settings.routingMode, "default");
});

test("normalizes structured Reviewer Two output from JSON text", () => {
  const result = normalizeReviewerTwoReviewResult(
    JSON.stringify({
      decision: "revise",
      blockers: ["missing validation"],
      importantRevisions: "tighten criteria",
      optionalSuggestions: ["call out defaults"],
      missingAcceptanceCriteria: ["loop budget"],
      validationGaps: ["typecheck"],
      scopeConcerns: ["scope is broad"],
      recommendation: "Revise before issue creation.",
    }),
  );

  assert.deepEqual(result, {
    decision: "revise",
    blockers: ["missing validation"],
    importantRevisions: ["tighten criteria"],
    optionalSuggestions: ["call out defaults"],
    missingAcceptanceCriteria: ["loop budget"],
    validationGaps: ["typecheck"],
    scopeConcerns: ["scope is broad"],
    recommendation: "Revise before issue creation.",
  });
});

test("rejects malformed Reviewer Two output", () => {
  assert.deepEqual(normalizeReviewerTwoReviewResult({ decision: "maybe" }), {
    error: "Invalid Reviewer Two result: decision must be pass, revise, or blocked.",
  });

  assert.deepEqual(
    normalizeReviewerTwoReviewResult(JSON.stringify({ decision: "pass" })),
    {
      error: "Invalid Reviewer Two result: recommendation is required.",
    },
  );
});
