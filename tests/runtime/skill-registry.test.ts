import assert from "node:assert/strict";
import test from "node:test";

import { buildRunLedgerSkillEvent } from "../../extensions/runtime/run-ledger.ts";
import {
  buildSkillUsedWithoutLoadEvents,
  buildSkillRegistryEvent,
  classifySkillPath,
  normalizeSkillName,
} from "../../extensions/runtime/skill-registry.ts";

test("skill registry normalizes names and classifies known skill sources", () => {
  assert.equal(normalizeSkillName("Code Review"), "code-review");
  assert.equal(classifySkillPath("/repo/skills/code-review/SKILL.md"), "packaged");
  assert.equal(
    classifySkillPath("/home/user/.pi/khala/skills/debug/SKILL.md"),
    "learned",
  );
  assert.equal(
    classifySkillPath("/home/user/.agents/skills/grill-me/SKILL.md"),
    "user",
  );
  assert.equal(
    classifySkillPath("/home/user/.codex/skills/python-developer/SKILL.md"),
    "user",
  );
  assert.equal(
    classifySkillPath("/home/user/.codex/plugins/cache/github/skills/yeet/SKILL.md"),
    "plugin",
  );
  assert.equal(classifySkillPath("skills/local/SKILL.md"), "repo-local");
});

test("skill registry events carry source metadata", () => {
  assert.deepEqual(
    buildSkillRegistryEvent({
      type: "skill_loaded",
      name: "Code Review",
      reason: "workflow loaded skill",
      path: "/repo/skills/code-review/SKILL.md",
    }),
    {
      type: "skill_loaded",
      skill: {
        name: "code-review",
        source: "packaged",
        path: "/repo/skills/code-review/SKILL.md",
      },
      reason: "workflow loaded skill",
    },
  );
});

test("skill registry ledger events keep operator context in summary and data", () => {
  const routed = buildRunLedgerSkillEvent({
    workflowId: "run-1",
    at: "2026-06-20T00:01:00.000Z",
    event: buildSkillRegistryEvent({
      type: "skill_routed",
      name: "Code Review",
      path: "/repo/.codex/skills/code-review/SKILL.md",
      reason: "matched review request",
    }),
  });
  const missing = buildRunLedgerSkillEvent({
    workflowId: "run-1",
    at: "2026-06-20T00:02:00.000Z",
    event: buildSkillRegistryEvent({
      type: "skill_missing",
      name: "Python Developer",
      reason: "referenced by workflow but not installed",
    }),
  });

  assert.match(
    routed.summary,
    /skill_routed: code-review source=user path=\/repo\/\.codex\/skills\/code-review\/SKILL\.md\. reason=matched review request/,
  );
  const routedData = routed.data as {
    skill: { name: string; source: string; path?: string };
    reason: string;
  };
  assert.equal(routedData.skill.name, "code-review");
  assert.equal(routedData.skill.source, "user");
  assert.equal(routedData.skill.path, "/repo/.codex/skills/code-review/SKILL.md");
  assert.equal(routedData.reason, "matched review request");
  assert.match(
    missing.summary,
    /skill_missing: python-developer source=unknown\. reason=referenced by workflow but not installed/,
  );
  const missingData = missing.data as {
    skill: { name: string; source: string };
    reason: string;
  };
  assert.equal(missingData.skill.name, "python-developer");
  assert.equal(missingData.skill.source, "unknown");
  assert.equal(missingData.reason, "referenced by workflow but not installed");
});

test("skill registry builds used-without-load events from claimed skills", () => {
  assert.deepEqual(
    buildSkillUsedWithoutLoadEvents({
      claimedSkills: ["Code Review", "code-review", "TypeScript"],
      reason: "assistant claimed skill use without a loaded SKILL.md",
    }),
    [
      {
        type: "skill_used_without_load",
        skill: {
          name: "code-review",
          source: "unknown",
          path: undefined,
        },
        reason: "assistant claimed skill use without a loaded SKILL.md",
      },
      {
        type: "skill_used_without_load",
        skill: {
          name: "typescript",
          source: "unknown",
          path: undefined,
        },
        reason: "assistant claimed skill use without a loaded SKILL.md",
      },
    ],
  );
  assert.deepEqual(
    buildSkillUsedWithoutLoadEvents({
      claimedSkills: ["Code Review", "TypeScript"],
      loadedSkills: ["code-review"],
      reason: "assistant claimed skill use without a loaded SKILL.md",
    }).map((event) => event.skill.name),
    ["typescript"],
  );
});
