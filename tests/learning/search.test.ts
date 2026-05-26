import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  persistKhalaLearningRecord,
  type KhalaLearningRecord,
} from "../../extensions/learning/khala-learn.ts";
import { searchKhalaMemory } from "../../extensions/learning/search.ts";
import { evaluateHarnessTurn } from "../../extensions/runtime/escalation.ts";
import { createTempLearningPaths } from "./helpers.ts";

type HarnessMessage = Parameters<typeof evaluateHarnessTurn>[0]["messages"][number];

const components = {
  reusability: 1,
  evidenceStrength: 1,
  impact: 1,
  novelty: 1,
  clarity: 1,
};

function textMessage(role: HarnessMessage["role"], text: string): HarnessMessage {
  return {
    role,
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(name: string, args: unknown): HarnessMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
  };
}

function toolResult(text: string): HarnessMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
  };
}

function learnedRecord(overrides: Partial<KhalaLearningRecord> = {}): KhalaLearningRecord {
  return {
    version: 1,
    id: "rg-before-grep",
    timestamp: "2026-05-18T00:00:00.000Z",
    source: "auto",
    shouldLearn: true,
    score: 0.9,
    confidence: 0.9,
    kind: "tool_rule",
    scope: "repo",
    trigger: "inspecting src/runtime/profile.ts before code edits",
    lesson:
      "Use rg with a focused src/runtime path before broad recursive grep when inspecting repository code.",
    reason: "test",
    evidence: [
      "A previous src/runtime/profile.ts task used broad recursive grep before using rg.",
      "Focused rg src/runtime found the target file with less output.",
    ],
    evidenceSnippet:
      "A previous src/runtime/profile.ts task used broad recursive grep before focused rg found the target file.",
    promotable: false,
    sensitive: false,
    components,
    ...overrides,
  };
}

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

test("learn-retrieve-apply loop uses stored memory outside recency tail", async () => {
  const paths = await createTempLearningPaths("khala-learn-retrieve-");
  await fs.writeFile(paths.memoryMd, "# MEMORY\n", "utf8");
  await fs.writeFile(paths.khalaLearningJsonl, "", "utf8");

  assert.equal(await persistKhalaLearningRecord(paths, learnedRecord()), true);
  await fs.appendFile(
    paths.memoryMd,
    Array.from(
      { length: 12 },
      (_, index) => `- 2026-05-19 [noise/${index}] unrelated recent lesson ${index}`,
    ).join("\n"),
    "utf8",
  );

  const results = await searchKhalaMemory({
    paths,
    query: "repository search rg before broad grep code edits",
    limit: 3,
    snippetLength: 220,
  });

  assert.ok(results.length > 0);
  assert.match(
    results.map((result) => result.snippet).join("\n"),
    /Use rg with a focused src\/runtime path before broad recursive grep/,
  );
  assert.ok(
    results.some((result) => result.kind === "memory" || result.kind === "learning"),
  );

  const userText = "Inspect repository code before editing src/runtime/profile.ts.";
  const assistantText =
    "Applied the retrieved lesson: use rg with a focused path before broad grep when inspecting repository code.";
  const messages: HarnessMessage[] = [
    textMessage("user", userText),
    assistantToolCall("khala_search_memory", {
      query: "repository search rg before broad grep code edits",
    }),
    toolResult(results[0].snippet),
    assistantToolCall("read", {
      path: "skills/typescript/SKILL.md",
    }),
    toolResult("TypeScript skill guidance for runtime profile edits"),
    assistantToolCall("read", {
      path: "src/runtime/profile.ts",
    }),
    toolResult("runtime profile source exports harness limits"),
  ];

  assert.match(assistantText, /use rg with a focused path before broad grep/i);
  assert.deepEqual(
    evaluateHarnessTurn({
      messages,
      userText,
      assistantText,
      lowConfidenceThreshold: 0.7,
      responseComplianceMode: "enforce",
    }).map((issue) => issue.code),
    [],
  );

  assert.deepEqual(
    evaluateHarnessTurn({
      messages: [textMessage("user", userText)],
      userText,
      assistantText: "I inspected repository code before editing.",
      lowConfidenceThreshold: 0.7,
      responseComplianceMode: "enforce",
    }).map((issue) => issue.code),
    ["skill_routing", "evidence_routing"],
  );
});
