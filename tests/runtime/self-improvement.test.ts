import test from "node:test";
import assert from "node:assert/strict";

import type { LearnedSkillRecord } from "../../extensions/learning/skills.ts";
import { buildLearnedWorkflowArtifact } from "../../extensions/learning/workflows.ts";
import {
  appendBackgroundReviewLearningSection,
  buildAutonomousSkillName,
  buildAutonomousSkillText,
  chooseAvailableGeneratedSkillName,
  chooseWritableLearnedSkillTarget,
  formatSkillPromotionQueueLine,
  shouldRunSelfImprovementReview,
} from "../../extensions/runtime/self-improvement.ts";

const components = {
  reusability: 1,
  evidenceStrength: 1,
  impact: 1,
  novelty: 1,
  clarity: 1,
};

function skillRecord(
  name: string,
  provenance: LearnedSkillRecord["metadata"]["provenance"],
  state: LearnedSkillRecord["metadata"]["state"] = "active",
): LearnedSkillRecord {
  return {
    dir: `/tmp/${name}`,
    skillFile: `/tmp/${name}/SKILL.md`,
    metadataFile: `/tmp/${name}/metadata.json`,
    metadata: {
      name,
      provenance,
      createdAt: "2026-01-01T00:00:00Z",
      lastUsedAt: null,
      lastPatchedAt: null,
      useCount: 0,
      patchCount: 0,
      state,
      pinned: false,
      sourceRunId: null,
    },
  };
}

test("self-improvement review runs for safe stored learnings and corrections", () => {
  assert.equal(
    shouldRunSelfImprovementReview({
      hasMeaningfulWorkflow: false,
      userCorrection: false,
      skillPatchSignal: false,
      assessment: {
        shouldLearn: true,
        sensitive: false,
        score: 0.9,
        confidence: 0.9,
        kind: "project_fact",
        scope: "repo",
        trigger: "correction",
        lesson: "patch skills quickly",
        reason: "reusable",
        evidence: [],
        evidenceSnippet: "",
        promotable: false,
        components,
      },
    }),
    true,
  );

  assert.equal(
    shouldRunSelfImprovementReview({
      hasMeaningfulWorkflow: false,
      userCorrection: true,
      skillPatchSignal: false,
      assessment: null,
    }),
    true,
  );
});

test("self-improvement review skips sensitive learnings even with other signals", () => {
  assert.equal(
    shouldRunSelfImprovementReview({
      hasMeaningfulWorkflow: true,
      userCorrection: true,
      skillPatchSignal: true,
      assessment: {
        shouldLearn: true,
        sensitive: true,
        score: 0.9,
        confidence: 0.9,
        kind: "project_fact",
        scope: "repo",
        trigger: "secret",
        lesson: "contains secret",
        reason: "sensitive",
        evidence: [],
        evidenceSnippet: "",
        promotable: false,
        components,
      },
    }),
    false,
  );
});

test("chooses the first writable active learned skill target", () => {
  const userAuthored = skillRecord("user", "user-authored");
  const archived = skillRecord("archived", "agent-authored", "archived");
  const writable = skillRecord("writable", "background-review-authored");

  assert.equal(
    chooseWritableLearnedSkillTarget([null, userAuthored, archived, writable])
      ?.metadata.name,
    "writable",
  );
});

test("appends background review section once and preserves existing content", () => {
  const first = appendBackgroundReviewLearningSection(
    "# Skill\nBody\n",
    "- lesson one",
  );
  assert.equal(
    first,
    "# Skill\nBody\n\n## Background review learnings\n- lesson one\n",
  );

  const second = appendBackgroundReviewLearningSection(first, "- lesson two");
  assert.equal(
    second,
    "# Skill\nBody\n\n## Background review learnings\n- lesson one\n- lesson two\n",
  );
});

test("formats promotion queue lines with target, trigger, and lesson", () => {
  assert.equal(
    formatSkillPromotionQueueLine({
      date: "2026-05-18",
      target: "debug-investigation",
      trigger: "user correction",
      lesson: "inspect before guessing",
    }),
    "- 2026-05-18 [self-improvement/skill] Target: debug-investigation. Trigger: user correction. Lesson: inspect before guessing",
  );
});

test("builds safe autonomous skill names and skill content", () => {
  const skillName = buildAutonomousSkillName({
    trigger: "User corrects stale review workflow behavior",
    fallback: "fallback",
    slugify: (value) => value.toLowerCase().replaceAll(" ", "-"),
  });

  assert.equal(skillName, "khala-user-corrects-stale-review-workflow-behavior");
  const skillText = buildAutonomousSkillText({
    skillName,
    trigger: "user corrects stale workflow behavior",
    lesson: "patch the learned procedure immediately after validation",
    evidence: "review failed because the prior skill omitted validation",
    date: "2026-05-18",
  });

  assert.match(skillText, /^---\nname: "khala-user-corrects-stale-review-workflow-behavior"\ndescription: "Background-learned procedure for user corrects stale workflow behavior"\n---/);
  assert.match(skillText, /## Use when/);
  assert.match(skillText, /patch the learned procedure immediately/);
  assert.match(skillText, /do not rely on stale memory/);
});

test("chooses a collision-free generated skill name", () => {
  assert.equal(
    chooseAvailableGeneratedSkillName({
      preferredName: "khala-review-skill",
      reservedNames: new Set(["khala-review-skill", "khala-review-skill-2"]),
    }),
    "khala-review-skill-3",
  );
});

test("builds autonomous workflow artifact for repeated successful actions", () => {
  const artifact = buildLearnedWorkflowArtifact({
    workflowName: "review-autonomous-workflow",
    taskType: "review",
    date: "2026-05-18",
    sampleSize: 3,
    scoreRate: 1,
    summary: "Observed repeated successful review runs.",
  });

  assert.match(artifact, /source: khala-autonomous-memory/);
  assert.match(artifact, /read_memory: call khala_read_memory/);
  assert.match(artifact, /search_memory: call khala_search_memory/);
  assert.match(artifact, /validate: run targeted validation/);
  assert.match(artifact, /eval: define reusable validation prompts or checks/);
  assert.match(artifact, /artifactRequirements:/);
  assert.match(artifact, /triggers: explicit use-when conditions/);
  assert.match(artifact, /validation: commands, checks, or eval prompts/);
  assert.match(artifact, /taskType: "review"/);
});
