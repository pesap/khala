import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowCommandHandlers } from "../../extensions/commands/workflow-handlers.ts";
import { parseWorkonArgs } from "../../extensions/commands/parsers.ts";
import {
  ensureWorkflowSlotAvailable,
  markWorkflowWaitingForFooter,
  type PendingWorkflow,
} from "../../extensions/workflows/engine.ts";

function createPendingWorkflow(type: string): PendingWorkflow {
  return {
    id: `${type}-1`,
    type,
    input: "debug symptom",
    flags: {},
    startedAt: "2026-06-09T00:00:00.000Z",
    runFile: "/tmp/workflow.json",
    loadedSkills: [],
    skillMetadata: [],
    mutationCount: 0,
    toolCallCount: 0,
    policyWarnings: [],
  };
}

function createHandlers(state: {
  pendingWorkflow: PendingWorkflow | null;
  notifications: string[];
  workonStarted: boolean;
}) {
  return createWorkflowCommandHandlers({
    pi: { appendEntry: () => undefined } as never,
    notify: (_ctx, message) => state.notifications.push(message),
    nowIso: () => "2026-06-09T00:00:00.000Z",
    slugify: (value) => value,
    normalizeWhitespace: (value) => value.trim().replace(/\s+/g, " "),
    ensureWorkflowSlotAvailable: (ctx) =>
      ensureWorkflowSlotAvailable(ctx, state.pendingWorkflow, (_ctx, message) =>
        state.notifications.push(message),
      ),
    ensureAgentEnabledForCommand: () => undefined,
    resolveWorkflowConfig: () => ({
      promptFile: "commands/workon-workflow.md",
      workflowFile: "workflows/workon-workflow.yaml",
      entryType: "workflow",
    }) as never,
    beginWorkflowTracking: async (_pi, _ctx, type) => {
      state.pendingWorkflow = createPendingWorkflow(type);
      if (type === "workon") state.workonStarted = true;
      return state.pendingWorkflow as never;
    },
    enqueueWorkflow: async () => ({ loadedSkills: [], skillMetadata: [] }),
    notifyWorkflowStarted: () => undefined,
    clearPendingWorkflow: () => undefined,
    parseDebugArgs: (args) => ({ problem: args ?? "" }),
    parseReviewArgs: () => ({ mode: "uncommitted" }),
    buildReviewTarget: () => ({ summary: "", instruction: "", flags: {} }),
    loadProjectReviewGuidelines: async () => null,
    parsePlanArgs: () => ({
      plan: "",
      review: {
        enabled: true,
        model: "github-copilot/gpt-5.4-mini",
        thinkingLevel: "medium",
        loops: 1,
        context: "fresh",
        routingMode: "default",
        routingReason: "Reviewer Two development profile (pi-model-discovery)",
      },
    }),
    parseAuditArgs: () => ({ claim: "" }),
    parseTriageArgs: (args) => ({ target: args ?? "" }),
    parseAddressOpenIssuesArgs: () => ({ limit: 20, repo: "" }),
    parseInboxArgs: () => ({
      limit: 20,
      repo: "",
      user: "",
      forge: "auto",
      focus: "all",
      scope: "auto",
      details: false,
      extraInstruction: "",
    }),
    parseWorkonArgs,
    parseLearnSkillArgs: () => ({ topic: "", dryRun: false }),
    ensureLearningStore: async () => ({ root: "", skillsDir: "" }),
    ensureLearnedSkillLayout: async () => ({
      dir: "",
      skillFile: "",
      metadataFile: "",
    }),
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

test("/workon starts after a completed /debug workflow releases the slot", async () => {
  const state = {
    pendingWorkflow: null as PendingWorkflow | null,
    notifications: [] as string[],
    workonStarted: false,
  };
  const handlers = createHandlers(state);

  await handlers.debug("unreported failure", { cwd: process.cwd() } as never);
  assert.equal(state.pendingWorkflow?.type, "debug");

  // Simulates agent_end successfully completing debug with the required footer.
  state.pendingWorkflow = null;

  const previousZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "/tmp/pi-workflow-slot-test-zellij";
  try {
    await handlers.workon("177 --repo pesap/agents --forge gitlab", {
      cwd: process.cwd(),
    } as never);
  } finally {
    if (previousZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = previousZellij;
  }

  assert.equal(state.workonStarted, true);
  assert.equal(
    state.notifications.some((message) =>
      message.includes("Workflow already running (debug)"),
    ),
    false,
  );
});

test("/debug missing-footer wait produces actionable workflow-slot guidance", () => {
  const workflow = createPendingWorkflow("debug");
  const notifications: string[] = [];

  markWorkflowWaitingForFooter(workflow, true);

  const available = ensureWorkflowSlotAvailable(
    { cwd: process.cwd() } as never,
    workflow,
    (_ctx, message) => notifications.push(message),
  );

  assert.equal(available, false);
  assert.match(
    notifications[0] ?? "",
    /missing the required Bias Check plus Result\/Confidence footer/,
  );
  assert.match(notifications[0] ?? "", /waiting for your approval or clarification/);
  assert.match(notifications[0] ?? "", /\/end-agent/);
  assert.doesNotMatch(notifications[0] ?? "", /^Workflow already running \(debug\)/);
});
