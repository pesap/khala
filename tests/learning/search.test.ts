import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { searchKhalaMemory } from "../../extensions/learning/search.ts";
import { createTempLearningPaths } from "./helpers.ts";

test("searches khala memory corpus and sorts by relevance", async () => {
  const paths = await createTempLearningPaths("khala-search-");
  await fs.mkdir(path.join(paths.skillsDir, "git-review"), { recursive: true });
  await fs.writeFile(
    paths.memoryMd,
    "- Review workflows should inspect git status before conclusions.\n",
    "utf8",
  );
  await fs.writeFile(
    paths.lessonsJsonl,
    JSON.stringify({
      trigger: "stale git review",
      lesson:
        "For git review tasks, run git status and inspect branch divergence before finalizing.",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(paths.skillsDir, "git-review", "SKILL.md"),
    [
      "# Git Review",
      "When reviewing git history, check git status, git merge-base, and branch divergence.",
      "Repeat git status before mutation.",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(paths.workflowsDir, "review-autonomous-workflow.yaml"),
    "steps:\n  - inspect git status before review finalization\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(paths.promptsDir, "review-autonomous-workflow.md"),
    "Run review workflow. Call khala_search_memory for git review status branch divergence.\n",
    "utf8",
  );

  const results = await searchKhalaMemory({
    paths,
    query: "git review status branch divergence",
    limit: 5,
    snippetLength: 160,
  });

  assert.equal(results.length, 5);
  assert.equal(results[0].kind, "skill");
  assert.match(results[0].snippet, /branch divergence/);
  assert.ok(results[0].score >= results[1].score);
  assert.ok(results.some((result) => result.kind === "workflow"));
  assert.ok(results.some((result) => result.kind === "prompt"));
  assert.ok(results.every((result) => result.score > 0));
});

test("memory search remains bounded with many candidate files and missing dirs", async () => {
  const paths = await createTempLearningPaths("khala-search-");
  await fs.rm(paths.workflowsDir, { recursive: true, force: true });
  await fs.writeFile(paths.memoryMd, "bounded search target\n", "utf8");

  for (let index = 0; index < 550; index += 1) {
    const dir = path.join(paths.skillsDir, `skill-${index}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `# Skill ${index}\nThis file mentions bounded search target ${index}.\n`,
      "utf8",
    );
  }

  const results = await searchKhalaMemory({
    paths,
    query: "bounded search target",
    limit: 25,
    snippetLength: 80,
  });

  assert.equal(results.length, 25);
  assert.ok(results.every((result) => result.score > 0));
  const lastResult = results.at(-1);
  assert.ok(lastResult);
  assert.ok(results[0].score >= lastResult.score);
});
