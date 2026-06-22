import assert from "node:assert/strict";
import test from "node:test";

import { buildRunLedgerSkillEvent } from "../../extensions/runtime/run-ledger.ts";
import {
  assistantClaimedSkillNames,
  buildSkillMetadataFromMarkdown,
  buildSkillRegistryEvent,
  buildSkillUsedWithoutLoadEvents,
  classifySkillPath,
  explicitSkillNamesForUserText,
  isSkillReadPath,
  normalizeAttemptedSkillSources,
  normalizeSkillMetadata,
  normalizeSkillName,
  recommendedSkillsForUserText,
  skillMetadataFromSkillReadPath,
  skillNameFromSkillReadPath,
  skillNeedReason,
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
  assert.equal(
    classifySkillPath("/work/repo/skills/local/SKILL.md", {
      repoRoot: "/work/repo",
    }),
    "repo-local",
  );
  assert.equal(
    classifySkillPath("/work/repo/extensions/skills/code-review/SKILL.md", {
      packageRoot: "/work/repo/extensions",
      repoRoot: "/work/repo",
    }),
    "packaged",
  );
});

test("skill registry derives metadata name from SKILL.md frontmatter", () => {
  assert.deepEqual(
    buildSkillMetadataFromMarkdown({
      name: "fallback-name",
      markdown: "---\nname: Code Review\n---\nUse concrete findings.",
      path: "/work/repo/skills/code-review/SKILL.md",
      repoRoot: "/work/repo",
    }),
    {
      name: "code-review",
      source: "repo-local",
      path: "/work/repo/skills/code-review/SKILL.md",
    },
  );
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

test("skill registry events normalize attempted source metadata", () => {
  assert.deepEqual(
    normalizeAttemptedSkillSources([
      "packaged",
      "learned",
      "packaged",
      "unknown",
      "not-real",
      123,
    ]),
    ["packaged", "learned"],
  );
  assert.deepEqual(normalizeAttemptedSkillSources("packaged"), []);

  assert.deepEqual(
    buildSkillRegistryEvent({
      type: "skill_missing",
      name: "Debug Helper",
      reason: "workflow required missing skill",
      attemptedSources: ["packaged", "learned", "packaged", "unknown"],
    }),
    {
      type: "skill_missing",
      skill: {
        name: "debug-helper",
        source: "unknown",
        path: undefined,
      },
      reason: "workflow required missing skill",
      attemptedSources: ["packaged", "learned"],
    },
  );
});

test("skill registry metadata uses path classification context", () => {
  assert.deepEqual(
    buildSkillRegistryEvent({
      type: "skill_loaded",
      name: "Repo Skill",
      reason: "loaded from the current repository",
      path: "/work/repo/skills/repo-skill/SKILL.md",
      repoRoot: "/work/repo",
    }).skill,
    {
      name: "repo-skill",
      source: "repo-local",
      path: "/work/repo/skills/repo-skill/SKILL.md",
    },
  );
});

test("skill registry normalizes externally supplied metadata", () => {
  assert.deepEqual(
    normalizeSkillMetadata({
      name: "Code Review",
      source: "user",
      path: "/home/user/.codex/skills/code-review/SKILL.md",
    }),
    {
      name: "code-review",
      source: "user",
      path: "/home/user/.codex/skills/code-review/SKILL.md",
    },
  );
  assert.deepEqual(
    normalizeSkillMetadata({
      name: "Repo Review",
      source: "not-a-source",
      path: "/work/repo/skills/repo-review/SKILL.md",
    } as never),
    {
      name: "repo-review",
      source: "packaged",
      path: "/work/repo/skills/repo-review/SKILL.md",
    },
  );
  assert.deepEqual(
    normalizeSkillMetadata({
      name: "Mystery Skill",
      source: "not-a-source",
    } as never),
    {
      name: "mystery-skill",
      source: "unknown",
      path: undefined,
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
  const missingWithAttempts = buildRunLedgerSkillEvent({
    workflowId: "run-1",
    at: "2026-06-20T00:03:00.000Z",
    event: buildSkillRegistryEvent({
      type: "skill_missing",
      name: "Debug Helper",
      reason: "referenced by workflow but not installed",
      attemptedSources: ["packaged", "learned", "repo-local"],
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
  assert.match(
    missingWithAttempts.summary,
    /skill_missing: debug-helper source=unknown attempted_sources=packaged,learned,repo-local\. reason=referenced by workflow but not installed/,
  );
  const missingWithAttemptsData = missingWithAttempts.data as {
    attemptedSources: string[];
  };
  assert.deepEqual(missingWithAttemptsData.attemptedSources, [
    "packaged",
    "learned",
    "repo-local",
  ]);
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
      knownSkills: [
        {
          name: "TypeScript",
          source: "user",
          path: "/home/user/.codex/skills/typescript/SKILL.md",
        },
      ],
      reason: "assistant claimed skill use without a loaded SKILL.md",
    }).map((event) => event.skill),
    [
      {
        name: "typescript",
        source: "user",
        path: "/home/user/.codex/skills/typescript/SKILL.md",
      },
    ],
  );
  assert.deepEqual(
    buildSkillUsedWithoutLoadEvents({
      claimedSkills: ["Code Review", "Python Developer"],
      loadedSkills: [
        {
          name: "Code Review",
          source: "repo-local",
          path: "/work/repo/skills/code-review/SKILL.md",
        },
      ],
      reason: "assistant claimed skill use without a loaded SKILL.md",
    }).map((event) => event.skill.name),
    ["python-developer"],
  );
});

test("skill registry extracts assistant skill claims", () => {
  assert.deepEqual(
    assistantClaimedSkillNames(
      "I used the TypeScript skill and followed github skill guidance.",
    ),
    ["typescript", "github"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I used the TypeScript and code review skills."),
    ["typescript", "code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I followed TypeScript and code review best practices."),
    ["typescript", "code-review"],
  );
  assert.deepEqual(
    assistantClaimedSkillNames("I used the code review skill."),
    ["code-review"],
  );
  assert.deepEqual(assistantClaimedSkillNames("I used a skill."), []);
  assert.deepEqual(assistantClaimedSkillNames("I followed best practices."), []);
});

test("skill registry detects explicit skill requests", () => {
  assert.equal(
    skillNeedReason("Load your librarian skill before inspecting the repo."),
    "user explicitly requested a skill",
  );
  assert.equal(skillNeedReason("Improve skill routing in the runtime."), null);
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Use tdd-core skill and /skill:github before reading skills/typescript/SKILL.md.",
    ),
    ["tdd-core", "github", "typescript"],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText("Use GitHub and code review skills for this PR."),
    ["github", "code-review"],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Do not count skills/typescript/SKILL.md.bak as a skill read.",
    ),
    [],
  );
  assert.deepEqual(
    explicitSkillNamesForUserText(
      "Use a skill for this failing TypeScript test.",
    ),
    [],
  );
});

test("skill registry recognizes exact SKILL.md read paths", () => {
  assert.equal(isSkillReadPath("skills/typescript/SKILL.md"), true);
  assert.equal(
    isSkillReadPath(
      "/home/morgoth/.codex/skills/.system/openai-docs/SKILL.md",
    ),
    true,
  );
  assert.equal(
    isSkillReadPath("/home/user/.codex/skills/code-review/SKILL.md"),
    true,
  );
  assert.equal(isSkillReadPath("/repo/skills/typescript/SKILL.md.bak"), false);
  assert.equal(isSkillReadPath("/repo/skills/typescript/SKILL.md/notes"), false);
  assert.equal(skillNameFromSkillReadPath("skills/code-review/SKILL.md.bak"), null);
  assert.equal(
    skillNameFromSkillReadPath(
      "/home/morgoth/.codex/skills/.system/openai-docs/SKILL.md",
    ),
    "openai-docs",
  );
  assert.equal(
    skillNameFromSkillReadPath("/home/user/.codex/skills/code-review/SKILL.md"),
    "code-review",
  );
});

test("skill registry derives metadata from exact SKILL.md read paths", () => {
  assert.deepEqual(skillMetadataFromSkillReadPath("skills/code-review/SKILL.md"), {
    name: "code-review",
    source: "repo-local",
    path: "skills/code-review/SKILL.md",
  });
  assert.deepEqual(
    skillMetadataFromSkillReadPath(
      "/home/user/.codex/plugins/cache/github/rev/skills/gh-fix-ci/SKILL.md",
    ),
    {
      name: "gh-fix-ci",
      source: "plugin",
      path: "/home/user/.codex/plugins/cache/github/rev/skills/gh-fix-ci/SKILL.md",
    },
  );
  assert.deepEqual(
    skillMetadataFromSkillReadPath("/work/repo/skills/code-review/SKILL.md", {
      repoRoot: "/work/repo",
    }),
    {
      name: "code-review",
      source: "repo-local",
      path: "/work/repo/skills/code-review/SKILL.md",
    },
  );
  assert.equal(
    skillMetadataFromSkillReadPath("/work/repo/skills/code-review/SKILL.md.bak"),
    null,
  );
});

test("skill registry recommends proactive skill routes", () => {
  assert.deepEqual(recommendedSkillsForUserText("Review this PR."), [
    "design-quality-review",
    "github",
  ]);
  assert.deepEqual(
    recommendedSkillsForUserText("Debug the failing pytest test."),
    ["debug-investigation", "python-developer", "testing-pytest"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Review this SDK design for API ergonomics."),
    ["design-quality-review", "good-api"],
  );
  assert.deepEqual(
    recommendedSkillsForUserText("Improve skill routing in the runtime."),
    [],
  );
});
