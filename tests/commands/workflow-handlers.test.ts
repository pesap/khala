import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowCommandHandlers } from "../../extensions/commands/workflow-handlers.ts";
import { parseWorkonArgs } from "../../extensions/commands/parsers.ts";

function createHandlers(captured: { sections?: string[]; flags?: Record<string, unknown>; input?: string; notifications?: string[] }) {
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
    beginWorkflowTracking: async (_pi, _ctx, _type, input, flags) => {
      captured.input = input;
      captured.flags = flags as Record<string, unknown>;
      return {} as never;
    },
    enqueueWorkflow: async (_pi, _prompt, _workflow, sections) => {
      captured.sections = sections;
      return { loadedSkills: [] };
    },
    notifyWorkflowStarted: () => undefined,
    parseDebugArgs: () => ({ problem: "" }),
    parseReviewArgs: () => ({ mode: "uncommitted" }),
    buildReviewTarget: () => ({ summary: "", instruction: "", flags: {} }),
    loadProjectReviewGuidelines: async () => null,
    parsePlanArgs: () => ({ plan: "" }),
    parseAuditArgs: () => ({ claim: "" }),
    parseTriageArgs: () => ({ target: "" }),
    parseAddressOpenIssuesArgs: () => ({ limit: 20, repo: "" }),
    parseInboxArgs: () => ({ limit: 20, repo: "", user: "", forge: "auto", focus: "all", scope: "auto", extraInstruction: "" }),
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

test("workon handler fails fast when issue URLs span multiple repos", async () => {
  const captured: { sections?: string[]; notifications?: string[] } = { notifications: [] };
  const handlers = createHandlers(captured);

  await handlers.workon(
    "https://github.com/pesap/agents/issues/73 https://github.com/pesap/other/issues/74",
    { cwd: process.cwd() } as never,
  );

  assert.equal(captured.sections, undefined);
  assert.deepEqual(captured.notifications, [
    "All /workon issue URLs must be from the same repo; found pesap/agents, pesap/other.",
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
