import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildReviewTarget,
  buildSkillTemplate,
  chooseAvailableSkillName,
  parseDebugArgs,
  parseInboxArgs,
  parsePlanArgs,
  parseReviewArgs,
  parseWorkonArgs,
} from "../../extensions/commands/parsers.ts";
import { DEFAULT_WORKON_MODEL_SELECTION } from "../../extensions/commands/workon.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";
import {
  resetActiveWorkflowRouteForTests,
  setWorkflowModelConfig,
} from "../../extensions/runtime/workflow-model-router.ts";

let defaultPiPathDir: string | null = null;
let previousPath: string | undefined;

before(async () => {
  defaultPiPathDir = await mkdtemp(path.join(tmpdir(), "khala-parsers-default-pi-"));
  previousPath = process.env.PATH;
  await writeFile(
    path.join(defaultPiPathDir, "pi"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\n'
  printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
fi
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${defaultPiPathDir}${path.delimiter}${previousPath ?? ""}`;
  resetActiveWorkflowRouteForTests();
  resetKhalaProfileDiscoveryForTests();
});

after(async () => {
  resetActiveWorkflowRouteForTests();
  resetKhalaProfileDiscoveryForTests();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (defaultPiPathDir) await rm(defaultPiPathDir, { force: true, recursive: true });
});

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

test("parses plan review flags with bounded defaults", () => {
  assert.deepEqual(parsePlanArgs("shape reviewer two"), {
    plan: "shape reviewer two",
    review: {
      enabled: true,
      model: "github-copilot/gpt-5.4-mini",
      thinkingLevel: "medium",
      loops: 1,
      context: "fresh",
      routingMode: "default",
      routingReason: "Reviewer Two development profile (pi-model-discovery; builtin route review -> development)",
    },
  });

  assert.deepEqual(parsePlanArgs("shape reviewer two --no-review"), {
    plan: "shape reviewer two",
    review: {
      enabled: false,
      model: "github-copilot/gpt-5.4-mini",
      thinkingLevel: "medium",
      loops: 0,
      context: "fresh",
      routingMode: "override",
      routingReason: "explicit --no-review override",
    },
  });

  assert.deepEqual(parsePlanArgs("shape reviewer two --review-model github-copilot/gpt-5.5 --review-thinking high --review-loops 2"), {
    plan: "shape reviewer two",
    review: {
      enabled: true,
      model: "github-copilot/gpt-5.5",
      thinkingLevel: "high",
      loops: 2,
      context: "fresh",
      routingMode: "override",
      routingReason: "explicit --review-model override",
    },
  });
});

test("plan review defaults use workflow review route overrides", () => {
  resetActiveWorkflowRouteForTests();
  try {
    setWorkflowModelConfig({
      routes: { review: "agents" },
      profiles: { agents: "openai-codex/gpt-5.4-mini:low" },
    });

    const parsed = parsePlanArgs("shape reviewer two");
    assert.ok(!("error" in parsed));
    assert.equal(parsed.review.model, "openai-codex/gpt-5.4-mini");
    assert.equal(parsed.review.thinkingLevel, "low");
    assert.equal(parsed.review.routingMode, "default");
    assert.match(parsed.review.routingReason, /Reviewer Two agents profile/);
    assert.match(parsed.review.routingReason, /workflow route config route review -> agents/);

    const explicit = parsePlanArgs("shape reviewer two --review-model anthropic/claude-sonnet-4");
    assert.ok(!("error" in explicit));
    assert.equal(explicit.review.model, "anthropic/claude-sonnet-4");
    assert.equal(explicit.review.thinkingLevel, "low");
    assert.equal(explicit.review.routingMode, "override");
    assert.equal(explicit.review.routingReason, "explicit --review-model override");
  } finally {
    resetActiveWorkflowRouteForTests();
  }
});

test("rejects invalid plan review flags", () => {
  assert.deepEqual(parsePlanArgs("shape reviewer two --review-model invalid"), {
    error: "Usage: /plan <plan_or_topic> [--review-model provider/model] [--review-thinking off|minimal|low|medium|high|xhigh] [--review-loops N] [--no-review]",
  });

  assert.deepEqual(parsePlanArgs("shape reviewer two --review-thinking weird"), {
    error: "Usage: /plan <plan_or_topic> [--review-model provider/model] [--review-thinking off|minimal|low|medium|high|xhigh] [--review-loops N] [--no-review]",
  });

  assert.deepEqual(parsePlanArgs("shape reviewer two --review-loops 3"), {
    error: "Usage: /plan <plan_or_topic> [--review-model provider/model] [--review-thinking off|minimal|low|medium|high|xhigh] [--review-loops 1|2] [--no-review]",
  });
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

  assert.equal(defaultModelSelection.exactModel, "github-copilot/gpt-5.4-mini");
  assert.equal(defaultModelSelection.exactThinkingLevel, "medium");

  assert.deepEqual(parseWorkonArgs("61 --repo pesap/agents --forge github"), {
    target: "61",
    targets: ["61"],
    repo: "pesap/agents",
    forge: "github",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
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
      multiplexer: "auto",
      heartbeat: "1.0",
      dryRun: false,
      modelSelection: defaultModelSelection,
      extraInstruction: "",
    },
  );

  assert.deepEqual(parseWorkonArgs("73 --mode prepare"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "prepare",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(parseWorkonArgs("topic --mode invalid --forge unknown"), {
    target: "topic",
    targets: ["topic"],
    repo: "",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(parseWorkonArgs("73 --mode start --heartbeat 0.25"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "0.25",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(parseWorkonArgs("73 --mode start --interval 0.01"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "0.01",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.equal(parseWorkonArgs("73 --multiplexer tmux").multiplexer, "tmux");

  assert.deepEqual(parseWorkonArgs("73 --heartbeat nope"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(parseWorkonArgs("73 --dry-run --mode start"), {
    target: "73",
    targets: ["73"],
    repo: "",
    forge: "auto",
    mode: "prepare",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: true,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  const modelOnlyResult = parseWorkonArgs("73 --model anthropic/claude-sonnet-4");
  assert.equal(modelOnlyResult.target, "73");
  assert.equal(modelOnlyResult.modelSelection.exactModel, "anthropic/claude-sonnet-4");
  assert.equal(modelOnlyResult.modelSelection.routingMode, "override");

  const modelAndThinkingResult = parseWorkonArgs("73 --model anthropic/claude-sonnet-4 --thinking high");
  assert.equal(modelAndThinkingResult.target, "73 --thinking high");
  assert.equal(modelAndThinkingResult.modelSelection.exactModel, "anthropic/claude-sonnet-4");
  assert.equal(modelAndThinkingResult.modelSelection.exactThinkingLevel, "medium");

  assert.deepEqual(parseWorkonArgs("73, 74 --repo pesap/agents"), {
    target: "73, 74",
    targets: ["73", "74"],
    repo: "pesap/agents",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(parseWorkonArgs("73 74 --repo pesap/agents"), {
    target: "73 74",
    targets: ["73", "74"],
    repo: "pesap/agents",
    forge: "auto",
    mode: "start",
    multiplexer: "auto",
    heartbeat: "1.0",
    dryRun: false,
    modelSelection: defaultModelSelection,
    extraInstruction: "",
  });

  assert.deepEqual(
    parseWorkonArgs(
      "https://github.nrel.gov/org/repo/issues/123 https://github.nrel.gov/org/repo/issues/124 --forge github",
    ),
    {
      target: "https://github.nrel.gov/org/repo/issues/123 https://github.nrel.gov/org/repo/issues/124",
      targets: [
        "https://github.nrel.gov/org/repo/issues/123",
        "https://github.nrel.gov/org/repo/issues/124",
      ],
      repo: "",
      forge: "github",
      mode: "start",
      multiplexer: "auto",
      heartbeat: "1.0",
      dryRun: false,
      modelSelection: defaultModelSelection,
      extraInstruction: "",
    },
  );
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
