import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkflowCommandConfig, WorkflowType } from "../runtime/profile.ts";
import type { PendingWorkflow } from "../workflows/engine.ts";

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
  ) => Promise<{ loadedSkills: string[] }>;
  notifyWorkflowStarted: (
    ctx: ExtensionCommandContext,
    message: string,
    notify: (
      ctx: ExtensionCommandContext,
      message: string,
      type: NotifyType,
    ) => void,
  ) => void;
  parseDebugArgs: (args: string) => { problem: string; fix: boolean };
  parseFeatureArgs: (args: string) => { request: string; ship: boolean };
  parseReviewArgs: (
    args: string,
    cwd: string,
    commandName?: string,
  ) => ReviewArgsResult;
  buildReviewTarget: (
    parsed: Exclude<ReviewArgsResult, { error: string }>,
  ) => ScopedTarget;
  loadProjectReviewGuidelines: (cwd: string) => Promise<string | null>;
  parsePlanArgs: (args: string) => { plan: string };
  parseTriageIssueArgs: (args: string) => { problem: string };
  parseTddArgs: (args: string) => { goal: string; language: string };
  parseAddressOpenIssuesArgs: (args: string) => { limit: number; repo: string };
  parseLearnSkillArgs: (args: string) => {
    topic: string;
    fromFile?: string;
    fromUrl?: string;
    dryRun: boolean;
  };
  ensureLearningStore: (cwd: string) => Promise<{ skillsDir: string }>;
  ensureLearnedSkillLayout: (
    cwd: string,
    skillName: string,
    sourceRunId?: string | null,
  ) => Promise<{ dir: string; skillFile: string; metadataFile: string }>;
  exists: (filePath: string) => Promise<boolean>;
  readText: (filePath: string) => Promise<string>;
  buildSkillTemplate: (skillName: string, topic: string) => string;
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
    SHIP_COMMAND_SOURCE: string;
    TRIAGE_ISSUE_COMMAND_SOURCE: string;
    TDD_COMMAND_SOURCE: string;
    ADDRESS_OPEN_ISSUES_COMMAND_SOURCE: string;
  };
}): {
  debug: CommandHandler;
  feature: CommandHandler;
  review: CommandHandler;
  gitReview: CommandHandler;
  simplify: CommandHandler;
  ship: CommandHandler;
  plan: CommandHandler;
  triageIssue: CommandHandler;
  tdd: CommandHandler;
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
    parseDebugArgs,
    parseFeatureArgs,
    parseReviewArgs,
    buildReviewTarget,
    loadProjectReviewGuidelines,
    parsePlanArgs,
    parseTriageIssueArgs,
    parseTddArgs,
    parseAddressOpenIssuesArgs,
    parseLearnSkillArgs,
    ensureLearningStore,
    exists,
    readText,
    buildSkillTemplate,
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
    );
    pending.loadedSkills = queued.loadedSkills;

    pi.appendEntry(runtime.entryType, {
      ...config.entry,
      at: nowIso(),
    });

    notifyWorkflowStarted(config.ctx, config.startedMessage, notify);
  }

  return {
    debug: async (args, ctx) => {
      const parsed = parseDebugArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;
      if (!parsed.problem) {
        notify(ctx, "Usage: /debug <problem> [--fix]", "error");
        return;
      }

      const applyFixMode = parsed.fix ? "yes" : "no";

      await runWorkflowCommand({
        ctx,
        type: "debug",
        input: parsed.problem,
        flags: {
          fix: parsed.fix,
        },
        sections: [
          `User problem: ${parsed.problem}`,
          `Apply fix: ${applyFixMode}`,
          "",
          "Instruction: Investigate hypotheses rigorously and converge on the highest-confidence root cause before applying changes.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          problem: parsed.problem,
          fix: parsed.fix,
        },
        startedMessage: `Started debug workflow (fix=${parsed.fix ? "on" : "off"}).`,
      });
    },

    feature: async (args, ctx) => {
      const parsed = parseFeatureArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;
      if (!parsed.request) {
        notify(ctx, "Usage: /feature <request> [--ship]", "error");
        return;
      }

      await runWorkflowCommand({
        ctx,
        type: "feature",
        input: parsed.request,
        flags: {
          ship: parsed.ship,
        },
        sections: [
          `Feature request: ${parsed.request}`,
          `Ship mode: ${parsed.ship ? "yes" : "no"}`,
          "",
          "Instruction: Execute implementation, tests, and docs tracks in a disciplined sequence unless another extension orchestrates parallelism.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          request: parsed.request,
          ship: parsed.ship,
        },
        startedMessage: `Started feature workflow (ship=${parsed.ship ? "on" : "off"}).`,
      });
    },

    review: async (args, ctx) => {
      const parsed = parseReviewArgs(args ?? "", ctx.cwd);
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      if ("error" in parsed) {
        notify(ctx, parsed.error, "error");
        return;
      }

      const target = buildReviewTarget(parsed);
      const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

      await runWorkflowCommand({
        ctx,
        type: "review",
        input: target.summary,
        flags: {
          ...target.flags,
          extraInstruction: parsed.extraInstruction ?? null,
          source: constants.REVIEW_COMMAND_SOURCE,
        },
        sections: [
          `Review target: ${target.summary}`,
          `Target mode: ${parsed.mode}`,
          `Source reference: ${constants.REVIEW_COMMAND_SOURCE}`,
          "",
          `Instruction: ${target.instruction}`,
          parsed.extraInstruction
            ? `Additional focus: ${parsed.extraInstruction}`
            : "",
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
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          mode: parsed.mode,
          ...target.flags,
          extraInstruction: parsed.extraInstruction ?? null,
          source: constants.REVIEW_COMMAND_SOURCE,
        },
        startedMessage: `Started review workflow (${target.summary}).`,
      });
    },

    gitReview: async (args, ctx) => {
      const extraFocus = normalizeWhitespace(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      const summary = extraFocus
        ? `current repository (${extraFocus})`
        : "current repository";

      await runWorkflowCommand({
        ctx,
        type: "git-review",
        input: summary,
        flags: {
          extraFocus: extraFocus || null,
          source: constants.GIT_REVIEW_COMMAND_SOURCE,
        },
        sections: [
          "Repository scope: current working tree",
          `Source reference: ${constants.GIT_REVIEW_COMMAND_SOURCE}`,
          "",
          "Instruction: Run the git diagnostics from the prompt before reading code.",
          extraFocus ? `Additional focus: ${extraFocus}` : "",
          "Instruction: Compare churn, authorship, bug clusters, velocity, and firefighting signals.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          extraFocus: extraFocus || null,
          source: constants.GIT_REVIEW_COMMAND_SOURCE,
        },
        startedMessage: `Started git-review workflow${extraFocus ? ` (${extraFocus})` : ""}.`,
      });
    },

    simplify: async (args, ctx) => {
      const parsed = parseReviewArgs(args ?? "", ctx.cwd, "simplify");
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      if ("error" in parsed) {
        notify(ctx, parsed.error, "error");
        return;
      }

      const target = buildSimplifyTarget(parsed);

      await runWorkflowCommand({
        ctx,
        type: "simplify",
        input: target.summary,
        flags: {
          ...target.flags,
          extraInstruction: parsed.extraInstruction ?? null,
          source: constants.SIMPLIFY_COMMAND_SOURCE,
        },
        sections: [
          `Simplify target: ${target.summary}`,
          `Target mode: ${parsed.mode}`,
          `Source reference: ${constants.SIMPLIFY_COMMAND_SOURCE}`,
          "",
          `Instruction: ${target.instruction}`,
          parsed.extraInstruction
            ? `Additional focus: ${parsed.extraInstruction}`
            : "",
          "Instruction: Preserve exact behavior, API shape, and outputs. Ask before any semantic change.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          mode: parsed.mode,
          ...target.flags,
          extraInstruction: parsed.extraInstruction ?? null,
          source: constants.SIMPLIFY_COMMAND_SOURCE,
        },
        startedMessage: `Started simplify workflow (${target.summary}).`,
      });
    },

    plan: async (args, ctx) => {
      const parsed = parsePlanArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      const plan = parsed.plan;
      if (!plan) {
        notify(ctx, "Usage: /plan <plan_or_topic>", "error");
        return;
      }

      await runWorkflowCommand({
        ctx,
        type: "plan",
        input: plan,
        flags: {
          source: constants.PLAN_COMMAND_SOURCE,
        },
        sections: [
          `Plan/topic: ${plan}`,
          `Source reference: ${constants.PLAN_COMMAND_SOURCE}`,
          "",
          "Instruction: Ask one question at a time and wait for user feedback before continuing.",
          "Instruction: If a question can be answered from code/docs, inspect first and continue with the next unresolved question.",
          "Instruction: Capture edge cases and trade-offs, then update CONTEXT.md/ADR docs lazily when terms/decisions are resolved.",
          "Instruction: When plan is complete, ask the user exactly once whether to create vertical-slice issues now.",
          "Instruction: If user says yes, produce a vertical-slice issue breakdown (AFK/HITL + dependencies) and then create issues.",
          "Instruction: Detect issue tracker platform first and use matching skill: github for GitHub, gitlab for GitLab.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          plan,
          source: constants.PLAN_COMMAND_SOURCE,
        },
        startedMessage: `Started plan workflow (${plan}).`,
      });
    },

    ship: async (args, ctx) => {
      const extraInstruction = normalizeWhitespace(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      await runWorkflowCommand({
        ctx,
        type: "ship",
        input: extraInstruction || "GitButler workspace",
        flags: {
          extraInstruction: extraInstruction || null,
          source: constants.SHIP_COMMAND_SOURCE,
        },
        sections: [
          "Scope: publish one focused branch/stack safely",
          `Source reference: ${constants.SHIP_COMMAND_SOURCE}`,
          "",
          "Instruction: Follow the workflow order exactly: detect -> target -> sync -> validate -> publish -> PR/MR -> summarize.",
          "Instruction: Start with `but status -fv`; identify the current VCS mode and the candidate ship target.",
          "Instruction: Select exactly one ship target branch/stack; if ambiguous, show a branch/change table and ask before shipping.",
          "Instruction: Treat other applied branches as parallel work; do not commit, push, or include their changes unless explicitly requested.",
          "Instruction: Sync the target with the latest base/default branch and stop if there is no unique unmerged work.",
          "Instruction: Simplify the selected scope, run project CI/test command(s), then create a signed commit if needed and push only after green validation.",
          "Instruction: Reuse an existing PR/MR when present; otherwise open one against the default branch and verify the real remote artifact.",
          extraInstruction ? `Additional instruction: ${extraInstruction}` : "",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          extraInstruction: extraInstruction || null,
          source: constants.SHIP_COMMAND_SOURCE,
        },
        startedMessage: "Started ship workflow (detect -> target -> sync -> validate -> publish -> PR).",
      });
    },

    triageIssue: async (args, ctx) => {
      const parsed = parseTriageIssueArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;
      if (!parsed.problem) {
        notify(ctx, "Usage: /triage-issue <problem_statement>", "error");
        return;
      }

      await runWorkflowCommand({
        ctx,
        type: "triage-issue",
        input: parsed.problem,
        flags: {
          source: constants.TRIAGE_ISSUE_COMMAND_SOURCE,
        },
        sections: [
          `Problem statement: ${parsed.problem}`,
          `Source reference: ${constants.TRIAGE_ISSUE_COMMAND_SOURCE}`,
          "",
          "Instruction: Ask at most one initial clarification question if needed, then investigate immediately.",
          "Instruction: Create a GitHub issue with durable root-cause analysis and RED/GREEN TDD fix plan.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          problem: parsed.problem,
          source: constants.TRIAGE_ISSUE_COMMAND_SOURCE,
        },
        startedMessage: `Started triage-issue workflow (${parsed.problem}).`,
      });
    },

    tdd: async (args, ctx) => {
      const parsed = parseTddArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;
      if (!parsed.goal) {
        notify(ctx, "Usage: /tdd <goal> [--lang auto|python|rust|c]", "error");
        return;
      }

      await runWorkflowCommand({
        ctx,
        type: "tdd",
        input: parsed.goal,
        flags: {
          language: parsed.language,
          source: constants.TDD_COMMAND_SOURCE,
        },
        sections: [
          `TDD goal: ${parsed.goal}`,
          `Language hint: ${parsed.language}`,
          `Source reference: ${constants.TDD_COMMAND_SOURCE}`,
          "",
          "Instruction: Use tdd-core doctrine and select language-specific adapter skill as needed.",
          "Instruction: Execute strict red-green-refactor in vertical slices only.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          goal: parsed.goal,
          language: parsed.language,
          source: constants.TDD_COMMAND_SOURCE,
        },
        startedMessage: `Started tdd workflow (goal=${parsed.goal}, lang=${parsed.language}).`,
      });
    },

    addressOpenIssues: async (args, ctx) => {
      const parsed = parseAddressOpenIssuesArgs(args ?? "");
      if (!ensureWorkflowSlotAvailable(ctx)) return;

      await runWorkflowCommand({
        ctx,
        type: "address-open-issues",
        input: `open issues by me (limit=${parsed.limit})`,
        flags: {
          limit: parsed.limit,
          repo: parsed.repo || null,
          source: constants.ADDRESS_OPEN_ISSUES_COMMAND_SOURCE,
        },
        sections: [
          "Issue query: author:@me state:open",
          `Limit: ${parsed.limit}`,
          `Repo override: ${parsed.repo || "(current repo)"}`,
          `Source reference: ${constants.ADDRESS_OPEN_ISSUES_COMMAND_SOURCE}`,
          "",
          "Instruction: Skip issues labeled blocked (or equivalent blocked label) and mark them skipped-blocked.",
          "Instruction: If an issue description is unclear/incomplete, post a clarification comment tagging the issue creator and abort remaining stages for that issue.",
          "Instruction: For well-described issues, run stages in order: triage-issue -> tdd -> review -> simplify -> review -> address review findings.",
          "Instruction: Re-review after remediation up to 2 loops per issue, then mark blocked if unresolved.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
        entry: {
          limit: parsed.limit,
          repo: parsed.repo || null,
          source: constants.ADDRESS_OPEN_ISSUES_COMMAND_SOURCE,
        },
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

      let sourceExcerpt = "";
      if (parsed.fromFile) {
        const resolvedSourcePath = path.resolve(ctx.cwd, parsed.fromFile);
        if (!(await exists(resolvedSourcePath))) {
          notify(ctx, `Source file not found: ${resolvedSourcePath}`, "error");
          return;
        }
        const raw = await readText(resolvedSourcePath);
        sourceExcerpt = raw.slice(0, 4000);
      }

      const skillHint =
        parsed.topic || parsed.fromFile || parsed.fromUrl || "new-skill";
      const skillName = slugify(skillHint);
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
        sections: [
          `Topic: ${parsed.topic || "(derived from source)"}`,
          `Target skill: ${skillName}`,
          `Target file: ${skillFile}`,
          `Dry run: ${parsed.dryRun ? "yes" : "no"}`,
          parsed.fromFile
            ? `Source file: ${path.resolve(ctx.cwd, parsed.fromFile)}`
            : "",
          parsed.fromUrl ? `Source URL: ${parsed.fromUrl}` : "",
          sourceExcerpt
            ? ["", "Source excerpt:", "```text", sourceExcerpt, "```"].join(
                "\n",
              )
            : "",
          "",
          "Instruction: Keep the skill concise and include explicit 'Use when' and 'Avoid when' sections.",
          constants.POSTFLIGHT_INSTRUCTION,
          constants.REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
        ],
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
