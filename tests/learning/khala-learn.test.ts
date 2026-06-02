import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

import {
  appendKhalaLearningRecord,
  assessLearning,
  normalizeKhalaLearningRecordForPersistence,
  persistKhalaLearningRecord,
  readRecentKhalaLearningRecords,
  searchKhalaLearningRecords,
  validateLearningCandidateQuality,
  type KhalaLearningRecord,
} from "../../extensions/learning/khala-learn.ts";
import { createTempLearningPaths } from "./helpers.ts";

const components = {
  reusability: 1,
  evidenceStrength: 1,
  impact: 1,
  novelty: 1,
  clarity: 1,
};

function learningRecord(
  id: string,
  overrides: Partial<KhalaLearningRecord> = {},
): KhalaLearningRecord {
  return {
    version: 1,
    id,
    timestamp: "2026-05-18T00:00:00.000Z",
    source: "auto",
    shouldLearn: true,
    score: 0.9,
    confidence: 0.9,
    kind: "project_fact",
    scope: "repo",
    trigger: `trigger ${id}`,
    lesson: `lesson ${id}`,
    reason: "test",
    evidence: [],
    evidenceSnippet: "test",
    promotable: false,
    sensitive: false,
    components,
    ...overrides,
  };
}

function concreteLearningRecord(overrides: Partial<KhalaLearningRecord> = {}): KhalaLearningRecord {
  return {
    version: 1,
    id: "concrete",
    timestamp: "2026-05-18T00:00:00.000Z",
    source: "auto",
    shouldLearn: true,
    score: 0.92,
    confidence: 0.93,
    kind: "workflow_correction",
    scope: "repo",
    trigger: "reviewing pull request diffs",
    lesson:
      "Read the merge-base diff before reporting findings so comments cite changed behavior.",
    reason: "test",
    evidence: ["PR review missed a changed file", "merge-base diff showed it"],
    evidenceSnippet: "PR review missed a changed file; merge-base diff showed it",
    promotable: true,
    sensitive: false,
    components,
    ...overrides,
  };
}

test("recent khala learning reads only bounded tail from large jsonl files", async () => {
  const paths = await createTempLearningPaths("khala-recent-tail-");
  await fs.writeFile(
    paths.khalaLearningJsonl,
    [
      ...Array.from({ length: 4_000 }, (_, index) =>
        JSON.stringify(learningRecord(`old-${index}`)),
      ),
      JSON.stringify(learningRecord("recent-one")),
      JSON.stringify(learningRecord("recent-two")),
      JSON.stringify(learningRecord("recent-three")),
    ].join("\n"),
    "utf8",
  );

  const records = await readRecentKhalaLearningRecords(paths, 2);

  assert.deepEqual(
    records.map((record) => record.id),
    ["recent-two", "recent-three"],
  );
});

test("recent khala learning filters audit-only and mismatched repo records", async () => {
  const paths = await createTempLearningPaths("khala-recent-filter-");
  await fs.writeFile(
    paths.khalaLearningJsonl,
    [
      JSON.stringify(
        learningRecord("other-repo", {
          repoKey: "github.com/example/other",
        }),
      ),
      JSON.stringify(
        learningRecord("threshold", {
          repoKey: "github.com/example/current",
          trigger: "task exceeds memory refresh threshold",
          reason: "Forced learning review after 20 tool calls exceeded the 15-tool threshold.",
        }),
      ),
      JSON.stringify(learningRecord("legacy-current")),
      JSON.stringify(
        learningRecord("current", {
          repoKey: "github.com/example/current",
        }),
      ),
    ].join("\n"),
    "utf8",
  );

  const records = await readRecentKhalaLearningRecords(paths, 10, {
    repoKey: "github.com/example/current",
  });

  assert.deepEqual(
    records.map((record) => record.id),
    ["legacy-current", "current"],
  );
});

test("search khala learning returns record-level hits for the current repo", async () => {
  const paths = await createTempLearningPaths("khala-record-search-");
  await fs.writeFile(
    paths.khalaLearningJsonl,
    [
      JSON.stringify(
        concreteLearningRecord({
          id: "forge-release",
          repoKey: "github.com/example/forge",
          trigger: "Forge cargo-dist release workflow",
          lesson:
            "Configure cargo-dist in dist-workspace.toml and avoid hand-editing generated workflows.",
        }),
      ),
      JSON.stringify(
        concreteLearningRecord({
          id: "agents-memory",
          repoKey: "github.com/example/agents",
          trigger: "Khala memory retrieval relevance",
          lesson:
            "Filter memory retrieval by repo identity and task context before injecting records.",
        }),
      ),
    ].join("\n"),
    "utf8",
  );

  const hits = await searchKhalaLearningRecords({
    paths,
    query: "memory retrieval relevance",
    limit: 5,
    repoKey: "github.com/example/agents",
  });

  assert.deepEqual(
    hits.map((hit) => hit.record.id),
    ["agents-memory"],
  );
});

test("learning assessment rejects vague high-confidence candidates", () => {
  const assessment = assessLearning({
    taskSummary: "The agent should learn from this run.",
    assistantSummary: "Everything finished.",
    reusable: true,
    confidenceHint: 0.99,
    trigger: "task",
    lessonCandidate: "Do better and avoid mistakes.",
    evidence: ["completed run"],
  });

  assert.equal(assessment.shouldLearn, false);
  assert.match(assessment.reason, /failed quality gate/);
  assert.match(assessment.reason, /trigger is too broad/);
  assert.match(assessment.reason, /vague quality language/);
});

test("learning assessment accepts concrete correction lessons with evidence", () => {
  const assessment = assessLearning({
    taskSummary: "Stop planning and implement it when I ask you to continue.",
    assistantSummary: "Applied code edits and ran targeted tests.",
    userCorrection: true,
    workflowType: "feature",
    mutationCount: 2,
    confidenceHint: 0.9,
    evidence: ["user explicitly reported stalling", "npm test passed"],
  });

  assert.equal(assessment.shouldLearn, true);
  assert.equal(
    assessment.lesson,
    "Move to concrete tool action or ask one blocking question; do not keep responding with plans only.",
  );
});

test("learning assessment turns harness issues into concrete tool rules", () => {
  const assessment = assessLearning({
    taskSummary: "Patch README.md after checking project conventions.",
    assistantSummary: "Harness warned that task-specific memory was missing.",
    mutationCount: 1,
    confidenceHint: 0.9,
    policyWarnings: ["harness issue: memory_search - MEMORY SEARCH REQUIRED"],
  });

  assert.equal(assessment.shouldLearn, true);
  assert.equal(assessment.kind, "tool_rule");
  assert.equal(
    assessment.lesson,
    "Call khala_search_memory with a focused query containing workflow, technology, file, symbol, error, correction, or user intent before substantial work.",
  );
  assert.match(assessment.evidenceSnippet, /harness issue: memory_search/);
});

test("learning candidate quality requires concrete trigger, lesson, and evidence", () => {
  assert.deepEqual(
    validateLearningCandidateQuality({
      trigger: "reviewing pull request diffs",
      lesson:
        "Read the merge-base diff before reporting findings so review comments cite changed behavior.",
      evidence: ["PR review missed a changed file", "merge-base diff showed it"],
      hasConcreteEvidence: true,
    }),
    { ok: true, issues: [] },
  );

  const rejected = validateLearningCandidateQuality({
    trigger: "review",
    lesson: "Be careful.",
    evidence: [],
    hasConcreteEvidence: false,
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.issues.join("\n"), /trigger is too broad/);
  assert.match(rejected.issues.join("\n"), /lesson is too short/);
  assert.match(rejected.issues.join("\n"), /lacks concrete evidence/);
});

test("learning persistence rejects malformed records even when callers bypass assessment", async () => {
  const paths = await createTempLearningPaths("khala-persist-quality-");
  await fs.writeFile(paths.khalaLearningJsonl, "", "utf8");
  await fs.writeFile(paths.memoryMd, "# MEMORY\n", "utf8");
  const stored = await appendKhalaLearningRecord(
    paths,
    concreteLearningRecord({
      trigger: "task",
      lesson: "Do better.",
      evidence: [],
      evidenceSnippet: "completed",
    }),
  );

  assert.equal(stored, false);
  assert.equal((await fs.readFile(paths.khalaLearningJsonl, "utf8")).trim(), "");
});

test("learning persistence does not promote below promotion threshold", async () => {
  const paths = await createTempLearningPaths("khala-persist-promote-");
  await fs.writeFile(paths.khalaLearningJsonl, "", "utf8");
  await fs.writeFile(paths.memoryMd, "# MEMORY\n", "utf8");
  await fs.writeFile(paths.promotionQueue, "# Promotion Queue\n", "utf8");
  const record = concreteLearningRecord({
    score: 0.8,
    confidence: 0.82,
    promotable: true,
  });

  assert.equal(
    normalizeKhalaLearningRecordForPersistence(record)?.promotable,
    false,
  );
  assert.equal(await persistKhalaLearningRecord(paths, record), true);

  const stored = await readRecentKhalaLearningRecords(paths, 1);
  assert.equal(stored[0].promotable, false);
  assert.doesNotMatch(
    await fs.readFile(paths.promotionQueue, "utf8"),
    /khala-learn\/promote/,
  );
});
