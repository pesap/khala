import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkflowCommandHandlers,
  workonLocalContextFlags,
} from "../../extensions/commands/workflow-handlers.ts";
import { parseWorkonArgs } from "../../extensions/commands/parsers.ts";
import type { WorkonBootstrapRequest } from "../../extensions/commands/workon.ts";

// /workon now fails fast when no active Zellij session is detected. Default to
// a sentinel value so existing handler tests continue to exercise the launch
// path; tests that need the fail-fast path manage ZELLIJ explicitly.
if (!process.env.ZELLIJ) {
  process.env.ZELLIJ = "/tmp/pi-workflow-handlers-test-zellij";
}

function createHandlers(
  captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string; notifications?: string[]; enqueueCwd?: string },
  overrides: { prepareWorkonBootstrap?: (request: WorkonBootstrapRequest) => Promise<string[]> } = {},
) {
  return createWorkflowCommandHandlers({
    pi: { appendEntry: () => undefined } as never,
    notify: (_ctx, message) => captured.notifications?.push(message),
    nowIso: () => "2026-06-05T00:00:00.000Z",
    slugify: (value) => value,
    normalizeWhitespace: (value) => value.trim().replace(/\s+/g, " "),
    ensureWorkflowSlotAvailable: () => true,
    ensureAgentEnabledForCommand: () => undefined,
    resolveWorkflowConfig: () => ({
      promptFile: "commands/workon-workflow.md",
      workflowFile: "workflows/workon-workflow.yaml",
      entryType: "workflow",
    }) as never,
    prepareWorkonBootstrap: overrides.prepareWorkonBootstrap,
    beginWorkflowTracking: async (_pi, _ctx, _type, input, flags) => {
      captured.input = input;
      captured.flags = flags as Record<string, unknown>;
      return {} as never;
    },
    enqueueWorkflow: async (_pi, _prompt, _workflow, sections, _pending, cwd) => {
      captured.sections = sections;
      captured.enqueueCwd = cwd;
      return { loadedSkills: [], skillMetadata: [] };
    },
    notifyWorkflowStarted: () => undefined,
    clearPendingWorkflow: () => undefined,
    parseDebugArgs: (args) => ({ problem: args ?? "" }),
    parseReviewArgs: () => ({ mode: "uncommitted" }),
    buildReviewTarget: () => ({ summary: "", instruction: "", flags: {} }),
    loadProjectReviewGuidelines: async () => null,
    parsePlanArgs: (args) => {
      const raw = args ?? "";
      const plan = raw
        .replace(/(^|\s)--review-model\s+\S+(\s|$)/g, " ")
        .replace(/(^|\s)--review-thinking\s+\S+(\s|$)/g, " ")
        .replace(/(^|\s)--review-loops\s+\S+(\s|$)/g, " ")
        .replace(/(^|\s)--no-review(\s|$)/g, " ")
        .trim()
        .replace(/\s+/g, " ");
      return {
        plan,
        review: {
          enabled: !/--no-review\b/.test(raw),
          model: /--review-model\s+\S+/.test(raw) ? "github-copilot/gpt-5.5" : "github-copilot/gpt-5.4-mini",
          thinkingLevel: /--review-thinking\s+high/.test(raw) ? "high" : "medium",
          loops: /--review-loops\s+2/.test(raw) ? 2 : 1,
          context: "fresh",
          routingMode: /--review-model\s+\S+|--no-review\b|--review-thinking\s+\S+/.test(raw)
            ? "override"
            : "default",
          routingReason: /--no-review\b/.test(raw)
            ? "explicit --no-review override"
            : /--review-model\s+\S+/.test(raw)
              ? "explicit --review-model override"
              : /--review-thinking\s+\S+/.test(raw)
                ? "explicit --review-thinking override"
                : "Reviewer Two development profile (pi-model-discovery)",
        },
      };
    },
    parseAuditArgs: () => ({ claim: "" }),
    parseTriageArgs: (args) => ({ target: args ?? "" }),
    parseAddressOpenIssuesArgs: () => ({ limit: 20, repo: "" }),
    parseInboxArgs: () => ({ limit: 20, repo: "", user: "", forge: "auto", focus: "all", scope: "auto", details: false, extraInstruction: "" }),
    parseWorkonArgs,
    parseLearnSkillArgs: () => ({ topic: "", dryRun: false }),
    ensureLearningStore: async () => ({ root: "", skillsDir: "" }),
    ensureLearnedSkillLayout: async () => ({ dir: "", skillFile: "", metadataFile: "" }),
    exists: async () => false,
    readText: async () => "",
    buildSkillTemplate: () => "",
    chooseAvailableSkillName: () => "",
    packageSkillsPath: "",
    buildSimplifyTarget: () => ({ summary: "", instruction: "", flags: {} }),
    constants: {
      POSTFLIGHT_INSTRUCTION: "postflight",
      REQUIRED_WORKFLOW_FOOTER_INSTRUCTION: "footer",
      REVIEW_COMMAND_SOURCE: "review",
      GIT_REVIEW_COMMAND_SOURCE: "git-review",
      SIMPLIFY_COMMAND_SOURCE: "simplify",
      PLAN_COMMAND_SOURCE: "plan",
      AUDIT_COMMAND_SOURCE: "audit",
      SHIP_COMMAND_SOURCE: "ship",
      INBOX_COMMAND_SOURCE: "inbox",
      WORKON_COMMAND_SOURCE: "workon",
      TRIAGE_COMMAND_SOURCE: "triage",
      ADDRESS_OPEN_ISSUES_COMMAND_SOURCE: "address-open-issues",
    },
  });
}

test("plan handler tags planning and Reviewer Two routing", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string; enqueueCwd?: string } = {};
  const handlers = createHandlers(captured);
  const cwd = process.cwd();

  await handlers.plan("shape model profiles --review-model github-copilot/gpt-5.5 --review-thinking high --review-loops 2", { cwd } as never);

  const rendered = captured.sections?.join("\n") ?? "";
  assert.equal(captured.input, "shape model profiles");
  assert.equal(captured.enqueueCwd, cwd);
  assert.equal(captured.flags?.model, "github-copilot/gpt-5.5");
  assert.equal(captured.flags?.thinkingLevel, "xhigh");
  assert.equal(captured.flags?.modelRoutingMode, "default");
  assert.match(String(captured.flags?.modelRoutingReason), /Khala planning profile/);
  assert.equal(captured.flags?.review_enabled, true);
  assert.equal(captured.flags?.review_context, "fresh");
  assert.equal(captured.flags?.review_loops, 2);
  assert.equal(captured.flags?.review_model, "github-copilot/gpt-5.5");
  assert.equal(captured.flags?.review_thinking_level, "high");
  assert.equal(captured.flags?.review_routing_mode, "override");
  assert.match(String(captured.flags?.review_routing_reason), /explicit --review-model override/);
  assert.match(rendered, /Model routing: default \(Khala planning profile/);
  assert.match(rendered, /Reviewer Two routing: enabled/);
  assert.match(rendered, /Reviewer Two default context: fresh/);
  assert.match(rendered, /Reviewer Two loop budget: 2/);
  assert.match(rendered, /Reviewer Two model: github-copilot\/gpt-5\.5/);
  assert.match(rendered, /Reviewer Two thinking level: high/);
  assert.match(rendered, /Plan loop states: candidate -> audited -> draft/);
  assert.match(rendered, /Issue labels on published packets: improve, workon-ready/);
  assert.match(rendered, /Reviewer prompt contract: do not implement edits/);
  assert.match(rendered, /same review workflow contract used by \/review/);
  assert.match(rendered, /Stop rules: use one fresh-context Reviewer Two pass by default/);
});

test("triage handler asks for /workon-ready packet contract headings", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string } = {};
  const handlers = createHandlers(captured);

  await handlers.triage("broken command", { cwd: process.cwd() } as never);

  const rendered = captured.sections?.join("\n") ?? "";
  assert.match(rendered, /\/workon-ready work packet/);
  assert.match(rendered, /Acceptance criteria/);
  assert.match(rendered, /Validation plan/);
  assert.match(rendered, /Non-goals/);
  assert.match(rendered, /Breaking-change risk/);
  assert.match(rendered, /Review-size risk/);
  assert.match(rendered, /\/workon readiness notes/);
});

test("debug handler asks proposed issues to satisfy /workon packet contract", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string } = {};
  const handlers = createHandlers(captured);

  await handlers.debug("unreported failure", { cwd: process.cwd() } as never);

  const rendered = captured.sections?.join("\n") ?? "";
  assert.match(rendered, /Produce the proposed issue as a \/workon-ready work packet/);
  assert.match(rendered, /Current behavior/);
  assert.match(rendered, /Desired behavior/);
  assert.match(rendered, /Acceptance criteria/);
  assert.match(rendered, /Validation plan/);
  assert.match(rendered, /Non-goals/);
  assert.match(rendered, /Breaking-change risk/);
  assert.match(rendered, /Review-size risk/);
});

test("workon bootstrap sections expose resumable local run ledger context", () => {
  assert.deepEqual(
    workonLocalContextFlags([
      "Worktree path: /tmp/worktrunk.fix-73",
      "Session capsule: /tmp/khala/github.com/pesap/agents/issue-73/capsule.md",
      "Handoff ledger: /tmp/khala/github.com/pesap/agents/issue-73/handoff-ledger.json",
    ]),
    {
      worktreePath: "/tmp/worktrunk.fix-73",
      capsulePath: "/tmp/khala/github.com/pesap/agents/issue-73/capsule.md",
      ledgerPath: "/tmp/khala/github.com/pesap/agents/issue-73/handoff-ledger.json",
    },
  );
  assert.deepEqual(
    workonLocalContextFlags([
      "Worktree path: (not available)",
      "Session capsule: not written",
      "Handoff ledger: not written",
    ]),
    {},
  );
});

test("workon handler groups comma-separated issue targets into one bootstrap", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string } = {};
  const handlers = createHandlers(captured);

  await handlers.workon("73, 74 --repo pesap/agents --forge gitlab", { cwd: process.cwd() } as never);

  assert.equal(captured.input, "73, 74");
  assert.deepEqual(captured.flags?.targets, ["73", "74"]);
  assert.ok(captured.sections?.includes("Workon targets: 73, 74"));
  assert.equal(
    captured.sections?.filter((section) => section.includes("GitHub workon bootstrap skipped for forge=gitlab")).length,
    1,
  );
});

test("workon handler puts deterministic route before advisory instructions", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string } = {};
  const handlers = createHandlers(captured);

  await handlers.workon("73 --repo pesap/agents --forge gitlab", { cwd: process.cwd() } as never);

  const rendered = captured.sections?.join("\n") ?? "";
  const routeIndex = rendered.indexOf("## Deterministic /workon route");
  const advisoryIndex = rendered.indexOf("Instruction: Treat the deterministic /workon route above");

  assert.ok(routeIndex >= 0);
  assert.ok(advisoryIndex > routeIndex);
  assert.match(rendered, /Route: not_ready/);
  assert.doesNotMatch(rendered.slice(0, routeIndex), /Instruction:/);
});

test("workon handler groups space-separated issue targets into one bootstrap", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string } = {};
  const handlers = createHandlers(captured);

  await handlers.workon("73 74 --repo pesap/agents --forge gitlab", { cwd: process.cwd() } as never);

  assert.equal(captured.input, "73 74");
  assert.deepEqual(captured.flags?.targets, ["73", "74"]);
  assert.ok(captured.sections?.includes("Workon targets: 73, 74"));
  assert.equal(
    captured.sections?.filter((section) => section.includes("GitHub workon bootstrap skipped for forge=gitlab")).length,
    1,
  );
});

test("workon handler accepts multiple GitHub Enterprise issue URLs from one host and repo", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);

  await handlers.workon(
    "https://github.nrel.gov/org/repo/issues/73 https://github.nrel.gov/org/repo/issues/74 --forge gitlab",
    { cwd: process.cwd() } as never,
  );

  assert.equal(
    captured.input,
    "https://github.nrel.gov/org/repo/issues/73 https://github.nrel.gov/org/repo/issues/74",
  );
  assert.deepEqual(captured.flags?.targets, [
    "https://github.nrel.gov/org/repo/issues/73",
    "https://github.nrel.gov/org/repo/issues/74",
  ]);
  assert.deepEqual(captured.notifications, []);
  assert.ok(
    captured.sections?.includes(
      "Workon targets: https://github.nrel.gov/org/repo/issues/73, https://github.nrel.gov/org/repo/issues/74",
    ),
  );
});

test("workon handler fails fast when issue URLs span multiple repos", async () => {
  const captured: { sections?: string[]; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);

  await handlers.workon(
    "https://github.com/pesap/agents/issues/73 https://github.com/pesap/other/issues/74",
    { cwd: process.cwd() } as never,
  );

  assert.equal(captured.sections, undefined);
  assert.deepEqual(captured.notifications, [
    "All /workon issue URLs must be from the same repo and host; found github.com/pesap/agents, github.com/pesap/other.",
  ]);
});

test("workon handler rejects mixed github.com and GitHub Enterprise issue URLs", async () => {
  const captured: { sections?: string[]; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);

  await handlers.workon(
    "https://github.com/pesap/agents/issues/73 https://github.nrel.gov/pesap/agents/issues/74",
    { cwd: process.cwd() } as never,
  );

  assert.equal(captured.sections, undefined);
  assert.deepEqual(captured.notifications, [
    "All /workon issue URLs must be from the same repo and host; found github.com/pesap/agents, github.nrel.gov/pesap/agents.",
  ]);
});

test("workon handler fails fast when issue URL does not match repo override", async () => {
  const captured: { sections?: string[]; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);

  await handlers.workon("73 https://github.com/pesap/other/issues/74 --repo pesap/agents", {
    cwd: process.cwd(),
  } as never);

  assert.equal(captured.sections, undefined);
  assert.deepEqual(captured.notifications, [
    "All /workon targets must match --repo pesap/agents; found issue URL for pesap/other.",
  ]);
});

test("workon handler fails fast when no active Zellij session in start mode", async () => {
  const captured: { sections?: string[]; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);
  const previous = process.env.ZELLIJ;
  delete process.env.ZELLIJ;
  try {
    await handlers.workon("73 --repo pesap/agents", { cwd: process.cwd() } as never);
  } finally {
    if (previous !== undefined) process.env.ZELLIJ = previous;
  }

  assert.equal(captured.sections, undefined);
  assert.equal(captured.notifications?.length, 1);
  assert.match(
    captured.notifications?.[0] ?? "",
    /needs an active multiplexer session/,
  );
  assert.match(captured.notifications?.[0] ?? "", /--dry-run/);
});

test("workon handler skips the Zellij gate in --dry-run mode", async () => {
  const captured: { sections?: string[]; flags?: Record<string, unknown>; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured, {
    prepareWorkonBootstrap: async () => [
      "Deterministic workon bootstrap evidence:",
      [
        "Route: prepared",
        "Worktree status: prepared",
        "Worktree path: (not available)",
        "Session capsule: not written",
        "Handoff ledger: /tmp/khala/github.com/pesap/agents/issue-73/handoff-ledger.json",
      ].join("\n"),
    ],
  });
  const previous = process.env.ZELLIJ;
  delete process.env.ZELLIJ;
  try {
    await handlers.workon("73 --repo pesap/agents --dry-run", { cwd: process.cwd() } as never);
  } finally {
    if (previous !== undefined) process.env.ZELLIJ = previous;
  }

  // Dry-run should still build sections (it never launches anything).
  assert.ok(captured.sections);
  assert.equal(captured.flags?.capsulePath, undefined);
  assert.equal(typeof captured.flags?.ledgerPath, "string");
  assert.match(String(captured.flags?.ledgerPath), /\/handoff-ledger\.json$/);
  assert.equal(captured.flags?.worktreePath, undefined);
  assert.deepEqual(captured.notifications, []);
});
