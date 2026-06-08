import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewTarget,
  buildSkillTemplate,
  chooseAvailableSkillName,
  parseDebugArgs,
  parseInboxArgs,
  parseReviewArgs,
  parseWorkonArgs,
} from "../../extensions/commands/parsers.ts";
import { DEFAULT_WORKON_MODEL_SELECTION } from "../../extensions/commands/workon.ts";

test("parses direct GitHub PR URLs as review PR targets", () => {
  const parsed = parseReviewArgs(
    "https://github.com/earendil-works/pi-review/pull/123 --extra security",
    process.cwd(),
  );

  assert.deepEqual(parsed, {
    mode: "pr",
    pr: "123",
    extraInstruction: "security",
  });
});

test("normalizes explicit PR number and URL targets", () => {
  assert.deepEqual(parseReviewArgs("pr 42", process.cwd()), {
    mode: "pr",
    pr: "42",
    extraInstruction: undefined,
  });
  assert.deepEqual(
    parseReviewArgs("pr https://github.com/owner/repo/pull/77", process.cwd()),
    {
      mode: "pr",
      pr: "77",
      extraInstruction: undefined,
    },
  );
});

test("builds PR review instructions with pi-review checkout safeguards", () => {
  const parsed = parseReviewArgs("pr 42", process.cwd());
  assert.ok(!("error" in parsed));

  const target = buildReviewTarget(parsed);

  assert.equal(target.summary, "pull request 42");
  assert.match(target.instruction, /Require GitHub CLI/);
  assert.match(target.instruction, /no staged or unstaged tracked-file changes/);
  assert.match(target.instruction, /compute the merge base/);
});

test("parses debug input as an issue-evidence brief and strips legacy fix flag", () => {
  assert.deepEqual(parseDebugArgs("handoff heartbeat is ignored --fix"), {
    problem: "handoff heartbeat is ignored",
  });
});

test("parses inbox flags with safe defaults", () => {
  assert.deepEqual(parseInboxArgs(""), {
    limit: 20,
    repo: "",
    user: "",
    forge: "auto",
    focus: "all",
    scope: "auto",
    details: false,
    extraInstruction: "",
  });

  assert.deepEqual(
    parseInboxArgs(
      "--limit 5 --repo owner/repo --user psanchez --forge gitlab --focus reviews stale blockers",
    ),
    {
      limit: 5,
      repo: "owner/repo",
      user: "psanchez",
      forge: "gitlab",
      focus: "reviews",
      scope: "auto",
      details: false,
      extraInstruction: "stale blockers",
    },
  );

  assert.deepEqual(parseInboxArgs("--user --limit 3"), {
    limit: 3,
    repo: "",
    user: "@me",
    forge: "auto",
    focus: "all",
    scope: "auto",
    details: false,
    extraInstruction: "",
  });

  assert.deepEqual(parseInboxArgs("--limit 0 --forge unknown --focus invalid"), {
    limit: 20,
    repo: "",
    user: "",
    forge: "auto",
    focus: "all",
    scope: "auto",
    details: false,
    extraInstruction: "",
  });

  assert.deepEqual(parseInboxArgs("--global --scope current parked pane"), {
    limit: 20,
    repo: "",
    user: "",
    forge: "auto",
    focus: "all",
    scope: "global",
    details: false,
    extraInstruction: "parked pane",
  });

  assert.deepEqual(parseInboxArgs("--scope current"), {
    limit: 20,
    repo: "",
    user: "",
    forge: "auto",
    focus: "all",
    scope: "current",
    details: false,
    extraInstruction: "",
  });
});

test("parses workon target and flags", () => {
  const defaultModelSelection = DEFAULT_WORKON_MODEL_SELECTION;

  assert.equal(defaultModelSelection.exactModel, "github-copilot/gpt-5.5");
  assert.equal(defaultModelSelection.exactThinkingLevel, "medium");

  assert.deepEqual(parseWorkonArgs("61 --repo pesap/agents --forge github"), {
    target: "61",
    targets: ["61"],
    repo: "pesap/agents",
    forge: "github",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "61",
  });

  assert.deepEqual(
    parseWorkonArgs(
      "collect GitHub maintainer queue --mode start --forge gitlab",
    ),
    {
      target: "collect GitHub maintainer queue",
      targets: ["collect GitHub maintainer queue"],
      repo: "",
      forge: "gitlab",
      mode: "start",
      heartbeat: "1.0",
      dryRun: false,
      modelSelection: defaultModelSelection,
      extraInstruction: "collect GitHub maintainer queue",
    },
  );

  assert.deepEqual(parseWorkonArgs("73 --mode prepare"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "prepare",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("topic --mode invalid --forge unknown"), {
    target: "topic",
    targets: ["topic"],
    repo: "",
    forge: "auto",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "topic",
  });

  assert.deepEqual(parseWorkonArgs("73 --mode start --heartbeat 0.25"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    heartbeat: "0.25",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("73 --mode start --interval 0.01"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    heartbeat: "0.01",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("73 --heartbeat nope"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("73 --dry-run --mode start"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "prepare",
    heartbeat: "1.0",
    dryRun: true,
    modelSelection: defaultModelSelection,
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("73 --model anthropic/claude-sonnet-4"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: {
      exactModel: "anthropic/claude-sonnet-4",
      exactThinkingLevel: defaultModelSelection.exactThinkingLevel,
      routingMode: "exact-model",
      routingReason: "explicit --model override with default workon thinking",
    },
    extraInstruction: "73",
  });

  assert.deepEqual(parseWorkonArgs("73, 74 --repo pesap/agents"), {
    target: "73, 74",
    targets: ["73", "74"],
    repo: "pesap/agents",
    forge: "auto",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73, 74",
  });

  assert.deepEqual(parseWorkonArgs("73 74 --repo pesap/agents"), {
    target: "73 74",
    targets: ["73", "74"],
    repo: "pesap/agents",
    forge: "auto",
    mode: "start",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "73 74",
  });
});

test("buildSkillTemplate quotes YAML frontmatter values with colons", () => {
  const skill = buildSkillTemplate("good-api", "good-api --from=https://example.com/a:b");

  assert.match(skill, /^---\nname: "good-api"\ndescription: "Reusable workflow for good-api --from=https:\/\/example.com\/a:b"\n---/);
});

test("chooseAvailableSkillName always namespaces learned skills under khala", () => {
  const skillName = chooseAvailableSkillName({
    topic: "bash-script",
    fromUrl: "https://www.mechanicalrock.io/blog/modern-bash",
    reservedNames: new Set(),
    slugify: (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
  });

  assert.equal(skillName, "khala-bash-script");
});

test("chooseAvailableSkillName uses a stable fallback for source-only imports", () => {
  const skillName = chooseAvailableSkillName({
    topic: "",
    fromUrl: "https://example.com/one",
    reservedNames: new Set(),
    slugify: (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
  });

  assert.equal(skillName, "khala-learned-skill");
});

test("chooseAvailableSkillName preserves an existing khala prefix", () => {
  const skillName = chooseAvailableSkillName({
    topic: "khala-librarian",
    reservedNames: new Set(),
    slugify: (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
  });

  assert.equal(skillName, "khala-librarian");
});

test("chooseAvailableSkillName adds numeric suffix only when companion name is taken", () => {
  const skillName = chooseAvailableSkillName({
    topic: "librarian",
    reservedNames: new Set(["khala-librarian"]),
    slugify: (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
  });

  assert.equal(skillName, "khala-librarian-2");
});
