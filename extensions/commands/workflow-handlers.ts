import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  collectInboxDashboard,
  collectInboxEvidence,
  type InboxFocus,
  type InboxForge,
  type InboxScope,
} from "./inbox.ts";
import {
  prepareWorkonBootstrap,
  resolveWorkonMultiplexer,
  type WorkonBootstrapRequest,
} from "./workon.ts";
import type { ParsedWorkonArgs } from "./parsers.ts";
import { resolveWorkflowRoute } from "../runtime/workflow-model-router.ts";
import type { WorkflowCommandConfig, WorkflowType } from "../runtime/profile.ts";
import type { PendingWorkflow } from "../workflows/engine.ts";
import { buildPlanReviewerTwoSections } from "./plan-review.ts";
import type { ReviewerTwoReviewSettings } from "./plan-review.ts";
import { buildPlanLoopRuntimeSections } from "./plan-loop.ts";
import { workonReadyPacketContractInstruction } from "./workon-ready-packet.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type WorkflowFlags = Record<
  string,
  string | number | boolean | null | string[]
>;

type ReviewArgsResult =
  | { mode: "uncommitted"; extraInstruction?: string }
  | { mode: "branch"; branch: string; extraInstruction?: string }
  | { mode: "commit"; commit: string; extraInstruction?: string }
  | { mode: "pr"; pr: string; extraInstruction?: string }
  | { mode: "folder"; paths: string[]; extraInstruction?: string }
  | { error: string };

interface ScopedTarget {
  summary: string;
  instruction: string;
  flags: WorkflowFlags;
}
type ParsedScopedTarget = Exclude<ReviewArgsResult, { error: string }>;

interface GithubIssueUrlParts {
  host: string;
  repo: string;
  repoKey: string;
}

function normalizeIssueHost(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function githubIssueUrlParts(target: string): GithubIssueUrlParts | null {
  const match = target.trim().match(/^(?:https?:\/\/)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/[1-9]\d*$/i);
  if (!match) return null;
  const host = normalizeIssueHost(match[1] ?? "");
  const repo = `${match[2]}/${match[3]}`;
  return { host, repo, repoKey: `${host}/${repo}` };
}

function githubIssueRepoFromUrl(target: string): string | null {
  return githubIssueUrlParts(target)?.repo ?? null;
}

function githubIssueRepoKeyFromUrl(target: string): string | null {
  return githubIssueUrlParts(target)?.repoKey ?? null;
}

function isWorkonIssueTarget(target: string): boolean {
  return /^[1-9]\d*$/.test(target.trim()) || githubIssueUrlParts(target) !== null;
}

function validateWorkonIssueTargets(targets: string[]): string | null {
  return targets.every(isWorkonIssueTarget)
    ? null
    : "Usage: /workon <issue-url|issue-number> [--repo owner/repo] [--forge auto|github|gitlab|all] [--multiplexer auto|none|zellij|tmux] [--dry-run] [--heartbeat HOURS|--interval HOURS] [--model MODEL]. Heartbeat defaults to 5 minutes. Child Pi launches pin the workon default thinking level. Use /plan for maintainer ideas or /triage for user-posted issue intake before /workon.";
}

function validateWorkonTargetRepos(targets: string[], repo: string): string | null {
  const urlRepoKeys = [...new Set(targets.map(githubIssueRepoKeyFromUrl).filter((value): value is string => Boolean(value)))];
  if (urlRepoKeys.length > 1) {
    return `All /workon issue URLs must be from the same repo and host; found ${urlRepoKeys.join(", ")}.`;
  }
  const urlRepos = [...new Set(targets.map(githubIssueRepoFromUrl).filter((value): value is string => Boolean(value)))];
  if (repo && urlRepos.length === 1 && urlRepos[0].toLowerCase() !== repo.toLowerCase()) {
    return `All /workon targets must match --repo ${repo}; found issue URL for ${urlRepos[0]}.`;
  }
  return null;
}

function workonBootstrapLineValue(sections: string[], label: string): string | undefined {
  const prefix = `${label}:`;
  for (const line of sections.flatMap((section) => section.split(/\r?\n/))) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    if (!value || value.startsWith("(") || !path.isAbsolute(value)) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

export function workonLocalContextFlags(sections: string[]): WorkflowFlags {
  const worktreePath = workonBootstrapLineValue(sections, "Worktree path");
  const capsulePath = workonBootstrapLineValue(sections, "Session capsule");
  const ledgerPath = workonBootstrapLineValue(sections, "Handoff ledger");
  return {
    ...(worktreePath ? { worktreePath } : {}),
    ...(capsulePath ? { capsulePath } : {}),
    ...(ledgerPath ? { ledgerPath } : {}),
  };
}

interface RunWorkflowCommandParams {
  ctx: ExtensionCommandContext;
  type: WorkflowType;
  input: string;
  flags: WorkflowFlags;
  sections: string[];
  entry: Record<string, string | number | boolean | null | string[]>;
  startedMessage: string;
}

export function createWorkflowCommandHandlers(params: {
  pi: ExtensionAPI;
  notify: (
    ctx: ExtensionCommandContext,
    message: string,
    type: NotifyType,
  ) => void;
  nowIso: () => string;
  slugify: (value: string) => string;
  normalizeWhitespace: (value: string) => string;
  ensureWorkflowSlotAvailable: (ctx: ExtensionCommandContext) => boolean;
  ensureAgentEnabledForCommand: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    source: WorkflowType,
  ) => void;
  resolveWorkflowConfig: (type: WorkflowType) => WorkflowCommandConfig | null;
  prepareWorkonBootstrap?: (request: WorkonBootstrapRequest) => Promise<string[]>;
  beginWorkflowTracking: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    type: WorkflowType,
    input: string,
    flags: WorkflowFlags,
  ) => Promise<PendingWorkflow<WorkflowType, WorkflowFlags>>;
  enqueueWorkflow: (
    pi: ExtensionAPI,
    workflowPromptName: string,
    workflowFileName: string,
    sections: string[],
    workflow?: PendingWorkflow<WorkflowType, WorkflowFlags>,
    cwd?: string,
  ) => Promise<{
    loadedSkills: string[];
    skillMetadata: PendingWorkflow<WorkflowType, WorkflowFlags>["skillMetadata"];
  }>;
  clearPendingWorkflow: () => Promise<void> | void;
  notifyWorkflowStarted: (
    ctx: ExtensionCommandContext,
    message: string,
    notify: (
      ctx: ExtensionCommandContext,
      message: string,
      type: NotifyType,
    ) => void,
  ) => void;
  parseDebugArgs: (args: string) => { problem: string };
  parseReviewArgs: (
    args: string,
    cwd: string,
    commandName?: string,
  ) => ReviewArgsResult;
  buildReviewTarget: (
    parsed: Exclude<ReviewArgsResult, { error: string }>,
  ) => ScopedTarget;
  loadProjectReviewGuidelines: (cwd: string) => Promise<string | null>;
  parsePlanArgs: (
    args: string,
  ) => { plan: string; review: ReviewerTwoReviewSettings } | { error: string };
  parseAuditArgs: (args: string) => { claim: string };
  parseTriageArgs: (args: string) => { target: string };
  parseAddressOpenIssuesArgs: (args: string) => { limit: number; repo: string };
  parseInboxArgs: (args: string) => {
    limit: number;
    repo: string;
    user: string;
    forge: InboxForge;
    focus: InboxFocus;
    scope: InboxScope;
    details: boolean;
    extraInstruction: string;
  };
  parseWorkonArgs: (args: string) => ParsedWorkonArgs | { error: string };
  parseLearnSkillArgs: (args: string) => {
    topic: string;
    fromFile?: string;
    fromUrl?: string;
    dryRun: boolean;
  };
  ensureLearningStore: (cwd: string) => Promise<{ root: string; skillsDir: string }>;
  ensureLearnedSkillLayout: (
    cwd: string,
    skillName: string,
    sourceRunId?: string | null,
  ) => Promise<{ dir: string; skillFile: string; metadataFile: string }>;
  exists: (filePath: string) => Promise<boolean>;
  readText: (filePath: string) => Promise<string>;
  buildSkillTemplate: (skillName: string, topic: string) => string;
  chooseAvailableSkillName: (params: {
    topic: string;
    fromFile?: string;
    fromUrl?: string;
    reservedNames: ReadonlySet<string>;
    slugify: (value: string) => string;
  }) => string;
  packageSkillsPath: string;
  buildSimplifyTarget: (
    parsed: Exclude<ReviewArgsResult, { error: string }>,
  ) => ScopedTarget;
  constants: {
    POSTFLIGHT_INSTRUCTION: string;
    REQUIRED_WORKFLOW_FOOTER_INSTRUCTION: string;
    REVIEW_COMMAND_SOURCE: string;
    GIT_REVIEW_COMMAND_SOURCE: string;
    SIMPLIFY_COMMAND_SOURCE: string;
    PLAN_COMMAND_SOURCE: string;
    AUDIT_COMMAND_SOURCE: string;
    SHIP_COMMAND_SOURCE: string;
    INBOX_COMMAND_SOURCE: string;
    WORKON_COMMAND_SOURCE: string;
    TRIAGE_COMMAND_SOURCE: string;
    ADDRESS_OPEN_ISSUES_COMMAND_SOURCE: string;
  };
}): {
  debug: CommandHandler;
  review: CommandHandler;
  gitReview: CommandHandler;
  simplify: CommandHandler;
  ship: CommandHandler;
  inbox: CommandHandler;
  workon: CommandHandler;
  plan: CommandHandler;
  audit: CommandHandler;
  triage: CommandHandler;
  addressOpenIssues: CommandHandler;
  learnSkill: CommandHandler;
} {
  const {
    pi,
    notify,
    nowIso,
    slugify,
    normalizeWhitespace,
    ensureWorkflowSlotAvailable,
    ensureAgentEnabledForCommand,
    resolveWorkflowConfig,
    beginWorkflowTracking,
    enqueueWorkflow,
    notifyWorkflowStarted,
    clearPendingWorkflow,
    parseDebugArgs,
    parseReviewArgs,
    buildReviewTarget,
    loadProjectReviewGuidelines,
    parsePlanArgs,
    parseAuditArgs,
    parseTriageArgs,
    parseAddressOpenIssuesArgs,
    parseInboxArgs,
    parseWorkonArgs,
    parseLearnSkillArgs,
    ensureLearningStore,
    exists,
    readText,
    buildSkillTemplate,
    chooseAvailableSkillName,
    packageSkillsPath,
    buildSimplifyTarget,
    constants,
  } = params;

  async function runWorkflowCommand(
    config: RunWorkflowCommandParams,
  ): Promise<void> {
    const runtime = resolveWorkflowConfig(config.type);
    if (!runtime) {
      notify(
        config.ctx,
        `Workflow command /${config.type} is disabled by runtime/profile.yaml or failed validation.`,
        "error",
      );
      return;
    }

    ensureAgentEnabledForCommand(pi, config.ctx, config.type);
    try {
      const pending = await beginWorkflowTracking(
        pi,
        config.ctx,
        config.type,
        config.input,
        config.flags,
      );
      const queued = await enqueueWorkflow(
        pi,
        runtime.promptFile,
        runtime.workflowFile,
        config.sections,
        pending,
        config.ctx.cwd,
      );
      pending.loadedSkills = queued.loadedSkills;
      pending.skillMetadata = queued.skillMetadata;

      pi.appendEntry(runtime.entryType, {
        ...config.entry,
        at: nowIso(),
      });

      notifyWorkflowStarted(config.ctx, config.startedMessage, notify);
    } catch (error) {
      await clearPendingWorkflow();
      const message = error instanceof Error ? error.message : String(error);
      notify(
        config.ctx,
        `Workflow /${config.type} failed to start: ${message}`,
        "error",
      );
    }
  }
  const requireInput = (
    ctx: ExtensionCommandContext,
    value: string,
    usage: string,
  ): string | null => {
    if (value) return value;
    notify(ctx, usage, "error");
    return null;
  };
  const withFooter = (sections: string[]): string[] => [
    ...sections,
    constants.POSTFLIGHT_INSTRUCTION,
    constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
  ];
  const readReservedSkillNames = async (root: string): Promise<Set<string>> => {
    const names = new Set<string>();
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // best effort only
    }
    return names;
  };
  const readSourceExcerpt = async (
    ctx: ExtensionCommandContext,
    fromFile?: string,
  ): Promise<{ excerpt: string; resolvedSourcePath: string | null }> => {
    if (!fromFile) return { excerpt: "", resolvedSourcePath: null };
    const resolvedSourcePath = path.resolve(ctx.cwd, fromFile);
    if (!(await exists(resolvedSourcePath))) {
      notify(ctx, `Source file not found: ${resolvedSourcePath}`, "error");
      return { excerpt: "", resolvedSourcePath: null };
    }
    const raw = await readText(resolvedSourcePath);
    return { excerpt: raw.slice(0, 4000), resolvedSourcePath };
  };
  const runScopedWorkflow = async (params: {
    args: string | undefined;
    ctx: ExtensionCommandContext;
    commandName?: string;
    type: "review" | "simplify";
    source: string;
    targetBuilder: (parsed: ParsedScopedTarget) => ScopedTarget;
    header: (summary: string) => string;
    extraSections?: string[];
  }): Promise<void> => {
    const parsed = parseReviewArgs(params.args ?? "", params.ctx.cwd, params.commandName);
    if (!ensureWorkflowSlotAvailable(params.ctx)) return;
    if ("error" in parsed) return notify(params.ctx, parsed.error, "error");
    const target = params.targetBuilder(parsed);
    const scopedFields = {
      ...target.flags,
      extraInstruction: parsed.extraInstruction ?? null,
    };
    await runMirroredSourceWorkflow({
      ctx: params.ctx,
      type: params.type,
      source: params.source,
      input: target.summary,
      fields: scopedFields,
      sections: [
        params.header(target.summary),
        `Target mode: ${parsed.mode}`,
        `Instruction: ${target.instruction}`,
        parsed.extraInstruction
          ? `Additional focus: ${parsed.extraInstruction}`
          : "",
        ...(params.extraSections ?? []),
      ],
      startedMessage: `Started ${params.type} workflow (${target.summary}).`,
    });
  };
  const runSourceWorkflow = async (params: {
    ctx: ExtensionCommandContext;
    type: WorkflowType;
    source: string;
    input: string;
    sections: string[];
    flags: WorkflowFlags;
    entry: WorkflowFlags;
    startedMessage: string;
  }): Promise<void> => {
    if (!ensureWorkflowSlotAvailable(params.ctx)) return;
    return runWorkflowCommand({
      ctx: params.ctx,
      type: params.type,
      input: params.input,
      flags: { ...params.flags, source: params.source },
      sections: withFooter([
        `Source reference: ${params.source}`,
        "",
        ...params.sections,
      ]),
      entry: { ...params.entry, source: params.source },
      startedMessage: params.startedMessage,
    });
  };
  const runMirroredSourceWorkflow = async (params: {
    ctx: ExtensionCommandContext;
    type: WorkflowType;
    source: string;
    input: string;
    sections: string[];
    fields: WorkflowFlags;
    startedMessage: string;
  }): Promise<void> =>
    runSourceWorkflow({
      ...params,
      flags: params.fields,
      entry: params.fields,
    });
  const runRequiredSourceWorkflow = async (params: {
    ctx: ExtensionCommandContext;
    type: WorkflowType;
    source: string;
    value: string;
    usage: string;
    sections: (value: string) => string[];
    flags?: (value: string) => WorkflowFlags;
    entry?: (value: string) => WorkflowFlags;
    startedMessage: (value: string) => string;
  }): Promise<void> => {
    const value = requireInput(params.ctx, params.value, params.usage);
    if (!value) return;
    await runSourceWorkflow({
      ctx: params.ctx,
      type: params.type,
      source: params.source,
      input: value,
      sections: params.sections(value),
      flags: params.flags?.(value) ?? {},
      entry: params.entry?.(value) ?? {},
      startedMessage: params.startedMessage(value),
    });
  };
  return {
    debug: async (args, ctx) => {
      const parsed = parseDebugArgs(args ?? "");
      if (githubIssueRepoFromUrl(parsed.problem)) {
        notify(
          ctx,
          "Existing GitHub issues should be shaped with /triage <issue-url>. /debug is for maintainer-observed, unreported symptoms.",
          "error",
        );
        return;
      }
      await runRequiredSourceWorkflow({
        ctx,
        type: "debug",
        source: "khala-debug-command",
        value: parsed.problem,
        usage: "Usage: /debug <unreported_problem_or_symptom>",
        sections: (problem) => [
          `Observed symptom: ${problem}`,
          "Debug source: maintainer-observed unreported problem",
          "Debug outcome: evidence-backed new issue proposal",
          "Apply fix: no",
          "",
          "Instruction: Build a reproduction or observable feedback loop first, investigate hypotheses rigorously, and converge on the highest-confidence root cause or candidate. Draft a new GitHub issue only when evidence justifies it, ask explicit approval before creating it, and do not apply code changes.",
          `Instruction: ${workonReadyPacketContractInstruction({ subject: "proposed issue", action: "produce" })}`,
        ],
        flags: () => ({ fix: false, createIssueBrief: true }),
        entry: (problem) => ({
          problem,
          fix: false,
          createIssueBrief: true,
        }),
        startedMessage: () =>
          "Started debug workflow (new issue evidence brief; fix=off).",
      });
    },

    review: async (args, ctx) => {
      const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);
      await runScopedWorkflow({
        args,
        ctx,
        type: "review",
        source: constants.REVIEW_COMMAND_SOURCE,
        targetBuilder: buildReviewTarget,
        header: (summary) => `Review target: ${summary}`,
        extraSections: [
          projectGuidelines
            ? [
                "",
                "Project review guidelines (REVIEW_GUIDELINES.md):",
                "```markdown",
                projectGuidelines,
                "```",
              ].join("\n")
            : "",
          "Instruction: Prioritize correctness, security, performance, and maintainability findings with concrete evidence.",
        ],
      });
    },

    gitReview: async (args, ctx) => {
      const extraFocus = normalizeWhitespace(args ?? "");

      await runMirroredSourceWorkflow({
        ctx,
        type: "git-review",
        source: constants.GIT_REVIEW_COMMAND_SOURCE,
        input: extraFocus ? `current repository (${extraFocus})` : "current repository",
        fields: {
          extraFocus: extraFocus || null,
        },
        sections: [
          "Repository scope: current working tree",
          "Instruction: Run the git diagnostics from the prompt before reading code.",
          extraFocus ? `Additional focus: ${extraFocus}` : "",
          "Instruction: Compare churn, authorship, bug clusters, velocity, and firefighting signals.",
        ],
        startedMessage: `Started git-review workflow${extraFocus ? ` (${extraFocus})` : ""}.`,
      });
    },

    simplify: async (args, ctx) => {
      await runScopedWorkflow({
        args,
        ctx,
        type: "simplify",
        commandName: "simplify",
        source: constants.SIMPLIFY_COMMAND_SOURCE,
        targetBuilder: buildSimplifyTarget,
        header: (summary) => `Simplify target: ${summary}`,
        extraSections: [
          "Instruction: Preserve exact behavior, API shape, and outputs. Ask before any semantic change.",
        ],
      });
    },

    plan: async (args, ctx) => {
      const planningRoute = resolveWorkflowRoute("plan");
      const planningProfile = planningRoute.profile;
      const routeSource = planningRoute.source === "flag"
        ? `workflow flag ${planningRoute.description}`
        : planningRoute.source === "route"
          ? `workflow route config ${planningRoute.description}`
          : `builtin ${planningRoute.description}`;
      const routingReason = `Khala planning profile ${planningRoute.profileName} (${planningProfile.source}; ${routeSource})`;
      const parsed = parsePlanArgs(args ?? "");
      if ("error" in parsed) {
        notify(ctx, parsed.error, "error");
        return;
      }
      const reviewSections = buildPlanReviewerTwoSections(parsed.plan || "current plan/topic", parsed.review);
      await runRequiredSourceWorkflow({
        ctx,
        type: "plan",
        source: constants.PLAN_COMMAND_SOURCE,
        value: parsed.plan,
        usage: "Usage: /plan <plan_or_topic> [--review-model provider/model] [--review-thinking off|minimal|low|medium|high|xhigh] [--review-loops 1|2] [--no-review]",
        sections: (plan) => [
          `Plan/topic: ${plan}`,
          ...buildPlanLoopRuntimeSections({
            planningModel: planningProfile.model,
            planningThinkingLevel: planningProfile.thinkingLevel,
            planningRoutingReason: routingReason,
            reviewerTwo: parsed.review,
          }),
          ...reviewSections,
          "Instruction: Detect issue tracker platform first and use matching skill: github for GitHub, gitlab for GitLab.",
        ],
        entry: (plan) => ({
          plan,
          review_enabled: parsed.review.enabled,
          review_context: parsed.review.context,
          review_loops: parsed.review.loops,
          review_model: parsed.review.model,
          review_thinking_level: parsed.review.thinkingLevel,
          review_routing_mode: parsed.review.routingMode,
          review_routing_reason: parsed.review.routingReason,
          model: planningProfile.model,
          thinkingLevel: planningProfile.thinkingLevel,
          modelRoutingMode: "default",
          modelRoutingReason: routingReason,
        }),
        flags: () => ({
          review_enabled: parsed.review.enabled,
          review_context: parsed.review.context,
          review_loops: parsed.review.loops,
          review_model: parsed.review.model,
          review_thinking_level: parsed.review.thinkingLevel,
          review_routing_mode: parsed.review.routingMode,
          review_routing_reason: parsed.review.routingReason,
          model: planningProfile.model,
          thinkingLevel: planningProfile.thinkingLevel,
          modelRoutingMode: "default",
          modelRoutingReason: routingReason,
        }),
        startedMessage: (plan) => `Started plan workflow (${plan}).`,
      });
    },

    audit: async (args, ctx) => {
      await runRequiredSourceWorkflow({
        ctx,
        type: "audit",
        source: constants.AUDIT_COMMAND_SOURCE,
        value: parseAuditArgs(args ?? "").claim,
        usage: "Usage: /audit <claim>",
        sections: (claim) => [
          `Claim: ${claim}`,
          "Instruction: Run the full anti-confirmation-bias claim audit workflow and treat the original claim as one hypothesis among several.",
        ],
        entry: (claim) => ({ claim }),
        startedMessage: (claim) => `Started audit workflow (${claim}).`,
      });
    },

    ship: async (args, ctx) => {
      const extraInstruction = normalizeWhitespace(args ?? "");

      await runMirroredSourceWorkflow({
        ctx,
        type: "ship",
        source: constants.SHIP_COMMAND_SOURCE,
        input: extraInstruction || "current Git branch",
        fields: {
          extraInstruction: extraInstruction || null,
        },
        sections: [
          "Scope: publish one focused branch/stack safely",
          "Instruction: Follow the workflow order exactly: detect -> target -> draft PR/MR -> sync -> validate -> publish/update -> verify PR/MR -> summarize.",
          "Instruction: Prefer deterministic command-handler and VCS evidence before model exploration; avoid repeated evidence collection, shell-quoting repair loops, and full session artifact reads when summaries or bounded excerpts suffice.",
          "Instruction: Inspect Git state with bounded commands; identify the current branch and candidate ship target.",
          "Instruction: Select exactly one ship target branch/stack; if ambiguous, show a branch/change table and ask before shipping.",
          "Instruction: Reuse or open a draft PR/MR for the selected head branch before any sync/rebase/cleanup command; check `gh pr list --repo <owner/repo> --state open --head <branch>` or the GitLab equivalent first so you do not create duplicates.",
          "Instruction: If the target has only uncommitted changes and no pushable unique commit, stop before sync/rebase/cleanup and report that an early PR/MR cannot be opened until there is a signed checkpoint commit or an existing remote head.",
          "Instruction: Treat other applied branches as parallel work; do not commit, push, or include their changes unless explicitly requested.",
          "Instruction: Sync the target with the latest base/default branch only after the draft PR/MR exists, and stop if there is no unique unmerged work.",
          "Instruction: Simplify the selected scope, run project CI/test command(s), then create a signed commit if needed, push the head branch, and update the existing draft PR/MR body after every new signed ship commit or meaningful validation status change.",
          "Instruction: Reuse an existing draft PR/MR when present; otherwise open one against the default branch and verify the real remote artifact, including base, head, commits, signature, body placeholders, close markers, and checks.",
          extraInstruction ? `Additional instruction: ${extraInstruction}` : "",
        ],
        startedMessage: "Started ship workflow (detect -> target -> draft PR/MR -> sync -> validate -> publish/update -> verify PR/MR).",
      });
    },

    inbox: async (args, ctx) => {
      const parsed = parseInboxArgs(args ?? "");
      const inboxRequest = {
        cwd: ctx.cwd,
        limit: parsed.limit,
        repo: parsed.repo,
        user: parsed.user,
        forge: parsed.forge,
        focus: parsed.focus,
        scope: parsed.scope,
      };
      const inboxEvidenceSections = parsed.details
        ? await collectInboxEvidence(inboxRequest)
        : await collectInboxDashboard(inboxRequest);

      await runMirroredSourceWorkflow({
        ctx,
        type: "inbox",
        source: constants.INBOX_COMMAND_SOURCE,
        input:
          parsed.extraInstruction ||
          `maintainer inbox (focus=${parsed.focus}, limit=${parsed.limit})`,
        fields: {
          limit: parsed.limit,
          repo: parsed.repo || null,
          user: parsed.user || null,
          forge: parsed.forge,
          focus: parsed.focus,
          scope: parsed.scope,
          details: parsed.details,
          extraInstruction: parsed.extraInstruction || null,
        },
        sections: [
          "Inbox scope: read-only maintainer visibility across forge, local git, and agent/session signals.",
          `Limit: ${parsed.limit}`,
          `Repo override: ${parsed.repo || "(current repo / configured repos)"}`,
          `User repo discovery: ${parsed.user || "(disabled)"}`,
          `Forge preference: ${parsed.forge}`,
          `Focus: ${parsed.focus}`,
          `Scope: ${parsed.scope}`,
          "Instruction: Do not mutate files, branches, issues, PRs, MRs, labels, comments, CI runs, or sessions.",
          "Instruction: If user repo discovery is enabled, list repositories for that user with read-only forge commands before collecting per-repo signals; use @me for the authenticated user and keep repository discovery bounded by the limit.",
          "Instruction: If both repo override and user repo discovery are set, prioritize the explicit repo override and report that user discovery was ignored.",
          "Instruction: Gather bounded evidence from git state plus gh/glab when available; gracefully degrade when a forge CLI is missing or unauthenticated.",
          "Instruction: Group findings into Needs you now, My work is broken, Agent/session needs attention, New work needs shaping, Ready for agents, and Low-risk background.",
          "Instruction: Rank by age, blocker status, review-request state, CI failure, stale local work, and explicit mentions.",
          parsed.details
            ? "Instruction: Treat the detailed deterministic evidence below as already collected read-only input; run more read-only commands only when required to fill a material evidence gap."
            : "Instruction: Treat the compact dashboard below as the default human-facing output; keep the final answer compact and action-first unless the user asks for details.",
          "Instruction: Avoid model-led re-bootstrap, repeated evidence collection, shell-quoting repair loops, and full session artifact reads when summaries or bounded excerpts suffice.",
          "Instruction: End with the top 3 next commands a maintainer should run.",
          ...inboxEvidenceSections,
          parsed.extraInstruction
            ? `Additional focus: ${parsed.extraInstruction}`
            : "",
        ],
        startedMessage: `Started inbox workflow (focus=${parsed.focus}, limit=${parsed.limit}).`,
      });
    },

    workon: async (args, ctx) => {
      const parsed = parseWorkonArgs(args ?? "");
      if ("error" in parsed) {
        notify(ctx, parsed.error, "error");
        return;
      }
      if (!parsed.target) {
        notify(
          ctx,
          "Usage: /workon <issue-url|issue-number> [--repo owner/repo] [--forge auto|github|gitlab|all] [--multiplexer auto|none|zellij|tmux] [--dry-run] [--heartbeat HOURS|--interval HOURS] [--model MODEL] [--review-model provider/model] [--review-thinking off|minimal|low|medium|high|xhigh] [--review-loops 1|2] [--no-review]. Heartbeat defaults to 5 minutes. Child Pi launches pin the workon default thinking level and record Reviewer Two settings.",
          "error",
        );
        return;
      }

      const targets = parsed.targets?.length ? parsed.targets : [parsed.target];
      const targetShapeError = validateWorkonIssueTargets(targets);
      if (targetShapeError) {
        notify(ctx, targetShapeError, "error");
        return;
      }
      const targetRepoError = validateWorkonTargetRepos(targets, parsed.repo);
      if (targetRepoError) {
        notify(ctx, targetRepoError, "error");
        return;
      }
      const resolvedMultiplexer = resolveWorkonMultiplexer({
        requested: parsed.multiplexer,
        env: {
          ZELLIJ: process.env.ZELLIJ,
          TMUX: process.env.TMUX,
        },
      });
      if (parsed.mode === "start" && !parsed.dryRun && parsed.multiplexer !== "none" && resolvedMultiplexer === "none") {
        notify(
          ctx,
          "/workon needs an active multiplexer session to launch the worktree and Pi handoff. Run 'zellij', 'zellij attach <session>', or tmux, then re-run /workon <issue>. Use '--multiplexer none' for direct Worktrunk start without Pi/heartbeat launch, or '--dry-run' to prepare only.",
          "error",
        );
        return;
      }
      const workonBootstrap = params.prepareWorkonBootstrap ?? prepareWorkonBootstrap;
      const workonBootstrapSections = await workonBootstrap({
        cwd: ctx.cwd,
        target: parsed.target,
        targets,
        repo: parsed.repo,
        forge: parsed.forge,
        mode: parsed.mode,
        dryRun: parsed.dryRun,
        capsuleRoot: path.join(homedir(), ".pi", "khala"),
        nowIso: nowIso(),
        requestedMultiplexer: parsed.multiplexer,
        resolvedMultiplexer,
        heartbeat: parsed.heartbeat,
        modelSelection: parsed.modelSelection,
        reviewSettings: parsed.review,
      });
      const localContext = workonLocalContextFlags(workonBootstrapSections);
      const routeOwnedFollowUpInstructions = workonBootstrapSections.some((section) =>
        section.includes("Operator follow-up send command:"),
      )
        ? [
            "Instruction: If a launched /workon ledger has a reachable Pi pane and a route-owned operator follow-up send command, use that direct pane route; do not substitute pi-subagents worker for that communication path.",
          ]
        : [];

      await runMirroredSourceWorkflow({
        ctx,
        type: "workon",
        source: constants.WORKON_COMMAND_SOURCE,
        input: parsed.target,
        fields: {
          target: parsed.target,
          repo: parsed.repo || null,
          forge: parsed.forge,
          mode: parsed.mode,
          dryRun: parsed.dryRun,
          multiplexer: parsed.multiplexer,
          resolvedMultiplexer,
          heartbeat: parsed.heartbeat,
          model: parsed.modelSelection.exactModel || null,
          thinkingLevel: parsed.modelSelection.exactThinkingLevel,
          modelRoutingMode: parsed.modelSelection.routingMode,
          modelRoutingReason: parsed.modelSelection.routingReason,
          review_enabled: parsed.review.enabled,
          review_context: parsed.review.context,
          review_loops: parsed.review.loops,
          review_model: parsed.review.model,
          review_thinking_level: parsed.review.thinkingLevel,
          review_routing_mode: parsed.review.routingMode,
          review_routing_reason: parsed.review.routingReason,
          targets,
          ...localContext,
          extraInstruction: parsed.extraInstruction || null,
        },
        sections: [
          `Workon target: ${parsed.target}`,
          targets.length > 1 ? `Workon targets: ${targets.join(", ")}` : "",
          `Repo override: ${parsed.repo || "(current repo / infer from target)"}`,
          `Forge preference: ${parsed.forge}`,
          `Dry run: ${parsed.dryRun ? "yes" : "no"}`,
          `Multiplexer requested: ${parsed.multiplexer}`,
          `Multiplexer resolved: ${resolvedMultiplexer}`,
          `Forge feedback heartbeat: ${parsed.heartbeat}`,
          `Exact model: ${parsed.modelSelection.exactModel}`,
          `Exact thinking level: ${parsed.modelSelection.exactThinkingLevel}`,
          `Model routing mode: ${parsed.modelSelection.routingMode}`,
          `Model routing reason: ${parsed.modelSelection.routingReason}`,
          `Reviewer Two enabled: ${parsed.review.enabled ? "yes" : "no"}`,
          `Reviewer Two loop budget: ${parsed.review.loops}`,
          `Reviewer Two model: ${parsed.review.model}`,
          `Reviewer Two thinking level: ${parsed.review.thinkingLevel}`,
          `Reviewer Two routing mode: ${parsed.review.routingMode}`,
          `Reviewer Two routing reason: ${parsed.review.routingReason}`,
          ...workonBootstrapSections,
          "Instruction: Treat the deterministic /workon route above as the source of truth. Do not reinterpret readiness, branch, capsule, multiplexer, Pi, heartbeat, or recovery state from free-form reasoning.",
          "Instruction: Resolve the durable source issue before branch/worktree work only when the route permits branch/worktree work.",
          "Instruction: Run the autonomous-readiness rubric before starting; if readiness fails, return only concrete action items needed to make the issue /workon-ready.",
          "Instruction: Follow only route-owned branch/worktree/handoff/recovery commands. Never invent alternate Worktrunk or multiplexer commands, and never bypass Worktrunk hook approval prompts.",
          ...routeOwnedFollowUpInstructions,
          "Instruction: Do not redefine the issue scope; consume the approved work packet and stop after source-of-truth, route-approved branch/worktree preparation, and route-approved session capsule handoff.",
          "Instruction: Use the deterministic bootstrap evidence above as the source-of-truth handoff; do not spend model/tool tokens recreating issue, branch, capsule, multiplexer, or heartbeat evidence the handler already supplied.",
          "Instruction: When the route permits a session capsule, it must include repo, issue/PR, branch/worktree, problem, acceptance criteria, non-goals, validation, open questions, and next prompt.",
          parsed.extraInstruction
            ? `Additional focus: ${parsed.extraInstruction}`
            : "",
        ],
        startedMessage: `Started workon workflow (${parsed.target}).`,
      });
    },

    triage: async (args, ctx) => {
      await runRequiredSourceWorkflow({
        ctx,
        type: "triage",
        source: constants.TRIAGE_COMMAND_SOURCE,
        value: parseTriageArgs(args ?? "").target,
        usage: "Usage: /triage <issue-url|user_posted_request>",
        sections: (target) => [
          `Triage target: ${target}`,
          "Instruction: Treat this as user-posted issue/request intake. Gather issue context, comments, labels, reporter activity, relevant code/docs, repo guidelines, and prior out-of-scope decisions when available.",
          "Instruction: Default to one cleaned-up issue/work packet. Propose a split table only when the issue is clearly too broad or likely to exceed reviewable PR size.",
          "Instruction: Write acceptance criteria (plain markdown bullets, not task-list checkboxes) so /workon can parse the packet without checklist syntax.",
          `Instruction: ${workonReadyPacketContractInstruction({ subject: "issue body", action: "produce or update" })}`,
          "Instruction: Ask explicit approval before creating or updating any GitHub issue, labels, or comments.",
        ],
        entry: (target) => ({ target }),
        startedMessage: (target) => `Started triage workflow (${target}).`,
      });
    },

    addressOpenIssues: async (args, ctx) => {
      const parsed = parseAddressOpenIssuesArgs(args ?? "");

      await runMirroredSourceWorkflow({
        ctx,
        type: "address-open-issues",
        source: constants.ADDRESS_OPEN_ISSUES_COMMAND_SOURCE,
        input: `open issues by me (limit=${parsed.limit})`,
        fields: {
          limit: parsed.limit,
          repo: parsed.repo || null,
        },
        sections: [
          "Issue query: author:@me state:open",
          `Limit: ${parsed.limit}`,
          `Repo override: ${parsed.repo || "(current repo)"}`,
          "Instruction: Skip issues labeled blocked (or equivalent blocked label) and mark them skipped-blocked.",
          "Instruction: If an issue description is unclear/incomplete, post a clarification comment tagging the issue creator and abort remaining stages for that issue.",
          "Instruction: For well-described issues, run stages in order: triage -> workon -> review -> simplify -> review -> address review findings.",
          "Instruction: Re-review after remediation up to 2 loops per issue, then mark blocked if unresolved.",
        ],
        startedMessage: `Started address-open-issues workflow (limit=${parsed.limit}, repo=${parsed.repo || "current"}).`,
      });
    },

    learnSkill: async (args, ctx) => {
      const parsed = parseLearnSkillArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;
      if (!parsed.topic && !parsed.fromFile && !parsed.fromUrl) {
        notify(
          ctx,
          "Usage: /learn-skill <topic> [--from <path|url>] [--from-file path] [--from-url url] [--dry-run]",
          "error",
        );
        return;
      }

      if (!resolveWorkflowConfig("learn-skill")) {
        notify(
          ctx,
          "Workflow command /learn-skill is disabled by runtime/profile.yaml or failed validation.",
          "error",
        );
        return;
      }

      const paths = await ensureLearningStore(ctx.cwd);
      const { excerpt: sourceExcerpt, resolvedSourcePath } = await readSourceExcerpt(
        ctx,
        parsed.fromFile,
      );
      if (parsed.fromFile && !resolvedSourcePath) return;

      const skillHint =
        parsed.topic || parsed.fromFile || parsed.fromUrl || "new-skill";
      const [packageSkillNames, learnedSkillNames] = await Promise.all([
        readReservedSkillNames(packageSkillsPath),
        readReservedSkillNames(paths.skillsDir),
      ]);
      const reservedNames = new Set([...packageSkillNames, ...learnedSkillNames]);
      const skillName = chooseAvailableSkillName({
        topic: parsed.topic,
        fromFile: parsed.fromFile,
        fromUrl: parsed.fromUrl,
        reservedNames,
        slugify,
      });
      const skillFile = path.join(paths.skillsDir, skillName, "SKILL.md");

      if (!parsed.dryRun) {
        const learnedSkill = await params.ensureLearnedSkillLayout(
          ctx.cwd,
          skillName,
        );
        if (!(await exists(learnedSkill.skillFile))) {
          await fs.writeFile(
            learnedSkill.skillFile,
            buildSkillTemplate(skillName, parsed.topic || skillHint),
            "utf8",
          );
        }
      }
      await runWorkflowCommand({
        ctx,
        type: "learn-skill",
        input: parsed.topic || skillHint,
        flags: {
          fromFile: parsed.fromFile ?? null,
          fromUrl: parsed.fromUrl ?? null,
          dryRun: parsed.dryRun,
          targetSkill: skillName,
          targetFile: skillFile,
        },
        sections: withFooter([
          `Topic: ${parsed.topic || "(derived from source)"}`,
          `Target skill: ${skillName}`,
          `Target file: ${skillFile}`,
          `Dry run: ${parsed.dryRun ? "yes" : "no"}`,
          resolvedSourcePath ? `Source file: ${resolvedSourcePath}` : "",
          parsed.fromUrl ? `Source URL: ${parsed.fromUrl}` : "",
          sourceExcerpt
            ? ["", "Source excerpt:", "```text", sourceExcerpt, "```"].join(
                "\n",
              )
            : "",
          "",
          "Instruction: Keep the skill concise and include explicit 'Use when' and 'Avoid when' sections.",
        ]),
        entry: {
          topic: parsed.topic || null,
          fromFile: parsed.fromFile ?? null,
          fromUrl: parsed.fromUrl ?? null,
          dryRun: parsed.dryRun,
          targetSkill: skillName,
          targetFile: skillFile,
        },
        startedMessage: parsed.dryRun
          ? `Started learn-skill dry run for ${skillName}.`
          : `Started learn-skill workflow for ${skillName} (${skillFile}).`,
      });
    },
  };
}
