import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

import {
  readRecentKhalaLearningRecords,
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

function learningRecord(id: string): KhalaLearningRecord {
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
