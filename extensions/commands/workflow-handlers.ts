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
type ParsedScopedTarget = Exclude<ReviewArgsResult, { error: string }>;

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
  parseAuditArgs: (args: string) => { claim: string };
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
  audit: CommandHandler;
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
    parseAuditArgs,
    parseTriageIssueArgs,
    parseTddArgs,
    parseAddressOpenIssuesArgs,
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
  const runToggleWorkflow = async (params: {
    ctx: ExtensionCommandContext;
    type: "debug" | "feature";
    value: string;
    enabled: boolean;
    usage: string;
    valueLabel: string;
    enabledLabel: string;
    instruction: string;
    entryKey: "problem" | "request";
    flagKey: "fix" | "ship";
  }): Promise<void> => {
    if (!ensureWorkflowSlotAvailable(params.ctx)) return;
    const value = requireInput(params.ctx, params.value, params.usage);
    if (!value) return;
    await runWorkflowCommand({
      ctx: params.ctx,
      type: params.type,
      input: value,
      flags: { [params.flagKey]: params.enabled },
      sections: withFooter([
        `${params.valueLabel}: ${value}`,
        `${params.enabledLabel}: ${params.enabled ? "yes" : "no"}`,
        "",
        params.instruction,
      ]),
      entry: { [params.entryKey]: value, [params.flagKey]: params.enabled },
      startedMessage: `Started ${params.type} workflow (${params.flagKey}=${params.enabled ? "on" : "off"}).`,
    });
  };
  return {
    debug: async (args, ctx) => {
      const parsed = parseDebugArgs(args ?? "");
      await runToggleWorkflow({
        ctx,
        type: "debug",
        value: parsed.problem,
        enabled: parsed.fix,
        usage: "Usage: /debug <problem> [--fix]",
        valueLabel: "User problem",
        enabledLabel: "Apply fix",
        instruction:
          "Instruction: Investigate hypotheses rigorously and converge on the highest-confidence root cause before applying changes.",
        entryKey: "problem",
        flagKey: "fix",
      });
    },

    feature: async (args, ctx) => {
      const parsed = parseFeatureArgs(args ?? "");
      await runToggleWorkflow({
        ctx,
        type: "feature",
        value: parsed.request,
        enabled: parsed.ship,
        usage: "Usage: /feature <request> [--ship]",
        valueLabel: "Feature request",
        enabledLabel: "Ship mode",
        instruction:
          "Instruction: Execute implementation, tests, and docs tracks in a disciplined sequence unless another extension orchestrates parallelism.",
        entryKey: "request",
        flagKey: "ship",
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
      await runRequiredSourceWorkflow({
        ctx,
        type: "plan",
        source: constants.PLAN_COMMAND_SOURCE,
        value: parsePlanArgs(args ?? "").plan,
        usage: "Usage: /plan <plan_or_topic>",
        sections: (plan) => [
          `Plan/topic: ${plan}`,
          "Instruction: Ask only blocking questions, one at a time; if enough evidence exists, produce the plan without waiting.",
          "Instruction: If a question can be answered from code/docs, inspect first and do not ask it.",
          "Instruction: Capture edge cases and trade-offs, then update CONTEXT.md/ADR docs lazily when terms/decisions are resolved.",
          "Instruction: When plan is complete, ask the user exactly once whether to create vertical-slice issues now.",
          "Instruction: If user says yes, produce a vertical-slice issue breakdown (AFK/HITL + dependencies) and then create issues.",
          "Instruction: Detect issue tracker platform first and use matching skill: github for GitHub, gitlab for GitLab.",
        ],
        entry: (plan) => ({ plan }),
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
          "Instruction: Follow the workflow order exactly: detect -> target -> sync -> validate -> publish -> PR/MR -> summarize.",
          "Instruction: Inspect Git state with bounded commands; identify the current branch and candidate ship target.",
          "Instruction: Select exactly one ship target branch/stack; if ambiguous, show a branch/change table and ask before shipping.",
          "Instruction: Treat other applied branches as parallel work; do not commit, push, or include their changes unless explicitly requested.",
          "Instruction: Sync the target with the latest base/default branch and stop if there is no unique unmerged work.",
          "Instruction: Simplify the selected scope, run project CI/test command(s), then create a signed commit if needed and push only after green validation.",
          "Instruction: Reuse an existing PR/MR when present; otherwise open one against the default branch and verify the real remote artifact.",
          extraInstruction ? `Additional instruction: ${extraInstruction}` : "",
        ],
        startedMessage: "Started ship workflow (detect -> target -> sync -> validate -> publish -> PR).",
      });
    },

    triageIssue: async (args, ctx) => {
      await runRequiredSourceWorkflow({
        ctx,
        type: "triage-issue",
        source: constants.TRIAGE_ISSUE_COMMAND_SOURCE,
        value: parseTriageIssueArgs(args ?? "").problem,
        usage: "Usage: /triage-issue <problem_statement>",
        sections: (problem) => [
          `Problem statement: ${problem}`,
          "Instruction: Ask at most one initial clarification question if needed, then investigate immediately.",
          "Instruction: Create a GitHub issue with durable root-cause analysis and RED/GREEN TDD fix plan.",
        ],
        entry: (problem) => ({ problem }),
        startedMessage: (problem) => `Started triage-issue workflow (${problem}).`,
      });
    },

    tdd: async (args, ctx) => {
      const parsed = parseTddArgs(args ?? "");
      await runRequiredSourceWorkflow({
        ctx,
        type: "tdd",
        source: constants.TDD_COMMAND_SOURCE,
        value: parsed.goal,
        usage: "Usage: /tdd <goal> [--lang auto|python|rust|c]",
        flags: () => ({
          language: parsed.language,
        }),
        sections: (goal) => [
          `TDD goal: ${goal}`,
          `Language hint: ${parsed.language}`,
          "Instruction: Use tdd-core doctrine and select language-specific adapter skill as needed.",
          "Instruction: Execute strict red-green-refactor in vertical slices only.",
        ],
        entry: (goal) => ({
          goal,
          language: parsed.language,
        }),
        startedMessage: (goal) =>
          `Started tdd workflow (goal=${goal}, lang=${parsed.language}).`,
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
          "Instruction: For well-described issues, run stages in order: triage-issue -> tdd -> review -> simplify -> review -> address review findings.",
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
      const reservedNames = await readReservedSkillNames(packageSkillsPath);
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
