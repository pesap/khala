import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { load as loadYaml } from "js-yaml";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isRecord } from "../lib/io.ts";
import type { LearningObservation, WorkflowFlags } from "../learning/store.ts";
import type {
  PostflightRecord,
  PreflightRecord,
} from "../policy/first-principles.ts";
import type { RuntimeState } from "../state/runtime.ts";

export type NotifyType = "info" | "error" | "warning" | "success";

export interface PendingWorkflowCompletionWait {
  kind: "missing_footer";
  awaitingUserAction: boolean;
}

export interface PendingWorkflow<
  TWorkflowType extends string = string,
  TWorkflowFlags extends WorkflowFlags = WorkflowFlags,
> {
  id: string;
  type: TWorkflowType;
  input: string;
  flags: TWorkflowFlags;
  startedAt: string;
  runFile: string;
  loadedSkills: string[];
  mutationCount: number;
  policyWarnings: string[];
  completionWait?: PendingWorkflowCompletionWait;
}

export interface LearningPathsLike {
  runsDir: string;
  learningJsonl: string;
  memoryMd: string;
  promotionQueue: string;
  stateJson: string;
  workflowsDir: string;
  promptsDir: string;
}

export interface WorkflowInference<TWorkflowOutcome extends string = string> {
  outcome: TWorkflowOutcome;
  confidence: number;
  strictViolation?: string;
}

function describeBlockedWorkflowSlot<TWorkflowType extends string>(
  pendingWorkflow: PendingWorkflow<TWorkflowType>,
): string {
  if (pendingWorkflow.completionWait?.kind === "missing_footer") {
    const action = pendingWorkflow.completionWait.awaitingUserAction
      ? "It appears to be waiting for your approval or clarification before it can finish. Reply in the current workflow to continue, or include the required Bias Check plus Result/Confidence footer to complete it."
      : "It stopped without the required Bias Check plus Result/Confidence footer, so khala cannot record it as complete yet. Continue the current workflow with the footer, or rerun the final response with the footer.";
    return `Workflow ${pendingWorkflow.type} is still occupying the workflow slot because its last response is missing the required Bias Check plus Result/Confidence footer. ${action} To cancel the pending workflow, run /end-agent before starting another workflow.`;
  }

  return `Workflow already running (${pendingWorkflow.type}). Wait for completion before starting another.`;
}

export function markWorkflowWaitingForFooter<TWorkflowType extends string>(
  workflow: PendingWorkflow<TWorkflowType>,
  awaitingUserAction: boolean,
): void {
  workflow.completionWait = {
    kind: "missing_footer",
    awaitingUserAction,
  };
}

export function ensureWorkflowSlotAvailable<TWorkflowType extends string>(
  ctx: ExtensionCommandContext,
  pendingWorkflow: PendingWorkflow<TWorkflowType> | null,
  notify: (
    ctx: ExtensionCommandContext,
    message: string,
    type: NotifyType,
  ) => void,
): boolean {
  if (!pendingWorkflow) return true;
  notify(ctx, describeBlockedWorkflowSlot(pendingWorkflow), "error");
  return false;
}

function normalizeSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const validSkills = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(
      (entry) => entry.length > 0 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry),
    );
  return [...new Set(validSkills)];
}

type SkillContextMode = "none" | "manifest" | "full";

function normalizeSkillContextMode(raw: unknown): SkillContextMode {
  return raw === "none" || raw === "full" ? raw : "manifest";
}

function parseWorkflowMetadata(rawWorkflowYaml: string): {
  skills: string[];
  skillContext: SkillContextMode;
} {
  try {
    const parsed = loadYaml(rawWorkflowYaml);
    if (!isRecord(parsed)) return { skills: [], skillContext: "manifest" };
    return {
      skills: normalizeSkills(parsed.skills),
      skillContext: normalizeSkillContextMode(parsed.skillContext),
    };
  } catch {
    return { skills: [], skillContext: "manifest" };
  }
}

function parsePromptFrontmatter(rawPrompt: string): {
  template: string;
  skills: string[];
  skillContext: SkillContextMode;
} {
  const frontmatterMatch = rawPrompt.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return { template: rawPrompt, skills: [], skillContext: "manifest" };
  }

  const [, frontmatter] = frontmatterMatch;
  try {
    const parsed = loadYaml(frontmatter);
    const skills = isRecord(parsed) ? normalizeSkills(parsed.skills) : [];
    return {
      template: rawPrompt.slice(frontmatterMatch[0].length),
      skills,
      skillContext: isRecord(parsed)
        ? normalizeSkillContextMode(parsed.skillContext)
        : "manifest",
    };
  } catch {
    return { template: rawPrompt, skills: [], skillContext: "manifest" };
  }
}

function extractSkillDescription(skillMarkdown: string): string {
  const frontmatterMatch = skillMarkdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) return "No description available.";
  try {
    const parsed = loadYaml(frontmatterMatch[1]);
    if (!isRecord(parsed) || typeof parsed.description !== "string")
      return "No description available.";
    return parsed.description.trim().replace(/\s+/g, " ");
  } catch {
    return "No description available.";
  }
}

function scalarSummary(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function parseWorkflowStepSummary(step: unknown): string | null {
  const scalar = scalarSummary(step);
  if (scalar) return scalar;
  if (!isRecord(step)) return null;

  const id = scalarSummary(step.id);
  const action = scalarSummary(step.action);
  if (id && action) return `${id}: ${action}`;
  if (id) return id;
  if (action) return action;

  const entries = Object.entries(step);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0] ?? [];
  const valueSummary = scalarSummary(value);
  return valueSummary ? `${key}: ${valueSummary}` : key;
}

function parseWorkflowControlSummary(rawWorkflowYaml: string): {
  name: string | null;
  objective: string | null;
  steps: string[];
} {
  try {
    const parsed = loadYaml(rawWorkflowYaml);
    if (!isRecord(parsed)) return { name: null, objective: null, steps: [] };

    const steps = Array.isArray(parsed.steps)
      ? parsed.steps
          .map(parseWorkflowStepSummary)
          .filter((step): step is string => Boolean(step))
      : [];

    return {
      name: scalarSummary(parsed.name),
      objective: scalarSummary(parsed.objective),
      steps,
    };
  } catch {
    return { name: null, objective: null, steps: [] };
  }
}

export function buildDeterministicWorkflowContract(params: {
  workflowSpec: string;
  workflowName?: string;
}): string {
  const summary = parseWorkflowControlSummary(params.workflowSpec);
  const workflowName = summary.name ?? params.workflowName ?? "workflow";
  const stepText =
    summary.steps.length > 0
      ? summary.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
      : "1. Use the ordered `steps` list in the workflow spec.";

  return [
    "Deterministic workflow contract:",
    `- Workflow: ${workflowName}`,
    summary.objective ? `- Objective: ${summary.objective}` : "",
    "- Treat the YAML workflow spec as the state machine. Execute steps in order, keep exactly one current step active, and do not reorder, restart, or skip a step unless current evidence proves it is impossible or irrelevant.",
    "- For each loop, choose the next unfinished step, name the evidence needed, take the smallest action that advances that step, record the result, then move to the next step.",
    "- Prefer deterministic command, file, memory, and guide evidence before model-only reasoning. Use bounded reads/searches and avoid repeating equivalent evidence calls.",
    "- When the workflow or prompt lists skills, guides, project rules, or review guidelines, load the required guide before that track and convert its concrete constraints into the active step checklist.",
    "- If creating or improving a reusable workflow, skill, prompt, or guide, do not call it done until the artifact has clear triggers/use-when conditions, ordered steps, expected inputs/outputs, validation or eval prompts, and reuse instructions.",
    "- If mutating files, identify target paths before editing, run focused khala_search_memory before the first mutation, apply the smallest scoped edit, and run targeted validation or explain the exact blocker.",
    "- If blocked, ask one concrete blocking question or report the external blocker. Otherwise continue through the ordered steps.",
    "Ordered workflow steps:",
    stepText,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function enqueueWorkflow(params: {
  pi: ExtensionAPI;
  workflowPromptName: string;
  workflowFileName: string;
  sections: string[];
  readCommandPrompt: (name: string) => Promise<string>;
  readWorkflow: (name: string) => Promise<string>;
  readSkill?: (name: string) => Promise<string>;
}): Promise<{ loadedSkills: string[] }> {
  const [promptTemplateRaw, workflowSpec] = await Promise.all([
    params.readCommandPrompt(params.workflowPromptName),
    params.readWorkflow(params.workflowFileName),
  ]);

  const prompt = parsePromptFrontmatter(promptTemplateRaw);
  const workflowMetadata = parseWorkflowMetadata(workflowSpec);
  const workflowSkills =
    prompt.skills.length > 0 ? prompt.skills : workflowMetadata.skills;
  const skillContext =
    prompt.skills.length > 0
      ? prompt.skillContext
      : workflowMetadata.skillContext;
  const skillSections = await Promise.all(
    workflowSkills.map(async (skillName) => {
      if (!params.readSkill) {
        return `- ${skillName}: Skill loading unavailable in this runtime. File: skills/${skillName}/SKILL.md`;
      }
      const content = (await params.readSkill(skillName)).trim();
      if (!content) {
        throw new Error(
          `Workflow prompt ${params.workflowPromptName} requires missing skill: ${skillName}`,
        );
      }
      if (skillContext === "full") return `[SKILL:${skillName}]\n${content}`;
      return `- ${skillName}: ${extractSkillDescription(content)} File: skills/${skillName}/SKILL.md`;
    }),
  );
  const shouldIncludeSkills =
    skillContext !== "none" && skillSections.length > 0;

  const payload = [
    prompt.template.trim(),
    "",
    shouldIncludeSkills
      ? skillContext === "full"
        ? "Workflow skills context:"
        : "Workflow skills manifest:"
      : "",
    ...(shouldIncludeSkills
      ? skillContext === "full"
        ? skillSections.map((section) =>
            ["```markdown", section, "```"].join("\n"),
          )
        : [
            ...skillSections,
            "Load full skill docs only when needed for a concrete analysis track or edit.",
          ]
      : []),
    shouldIncludeSkills ? "" : "",
    "Workflow spec:",
    "```yaml",
    workflowSpec.trim(),
    "```",
    "",
    buildDeterministicWorkflowContract({
      workflowSpec,
      workflowName: params.workflowFileName,
    }),
    "",
    ...params.sections,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  params.pi.sendUserMessage(payload);
  return { loadedSkills: workflowSkills };
}

export async function beginWorkflowTracking<
  TWorkflowType extends string,
  TWorkflowFlags extends WorkflowFlags,
>(params: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  type: TWorkflowType;
  input: string;
  flags: TWorkflowFlags;
  learningVersion: number;
  ensureLearningStore: (cwd: string) => Promise<LearningPathsLike>;
  makeId: (prefix: string) => string;
  nowIso: () => string;
  summarizeEvidence: (text: string, max?: number) => string;
  runtimeState: RuntimeState;
  appendPreflightEntry: (pi: ExtensionAPI, record: PreflightRecord) => void;
}): Promise<PendingWorkflow<TWorkflowType, TWorkflowFlags>> {
  const paths = await params.ensureLearningStore(params.ctx.cwd);
  const id = params.makeId(params.type);
  const startedAt = params.nowIso();
  const runFile = path.join(paths.runsDir, `${id}.json`);

  const record = {
    version: params.learningVersion,
    id,
    type: params.type,
    input: params.input,
    flags: params.flags,
    status: "started",
    startedAt,
  };

  await fs.writeFile(runFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  params.pi.appendEntry("khala-workflow-start", {
    id,
    type: params.type,
    input: params.input,
    flags: params.flags,
    startedAt,
  });

  const pending: PendingWorkflow<TWorkflowType, TWorkflowFlags> = {
    id,
    type: params.type,
    input: params.input,
    flags: params.flags,
    startedAt,
    runFile,
    loadedSkills: [],
    mutationCount: 0,
    policyWarnings: [],
  };

  params.runtimeState.latestPostflight = null;

  const autoPreflightReason =
    params.summarizeEvidence(params.input, 120).replace(/"/g, "'") ||
    "workflow requested";
  params.runtimeState.activePreflight = {
    at: startedAt,
    skill: params.type,
    reason: autoPreflightReason,
    clarify: "no",
    raw: `Preflight: skill=${params.type} reason="${autoPreflightReason}" clarify=no`,
    source: "auto",
    workflowId: id,
  };
  params.appendPreflightEntry(params.pi, params.runtimeState.activePreflight);

  return pending;
}

export async function completeWorkflowTracking<
  TWorkflowType extends string,
  TWorkflowFlags extends WorkflowFlags,
  TWorkflowOutcome extends string,
>(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  workflow: PendingWorkflow<TWorkflowType, TWorkflowFlags>;
  assistantText: string;
  learningVersion: number;
  lowConfidenceThreshold: number;
  runtimeState: RuntimeState;
  inferOutcomeFromText: (text: string) => WorkflowInference<TWorkflowOutcome>;
  nowIso: () => string;
  extractPostflightFromAssistantText: (
    text: string,
    nowIso: () => string,
  ) => PostflightRecord | null;
  modeOutcome: (
    mode: RuntimeState["firstPrinciplesConfig"]["postflightMode"],
    violation: boolean,
  ) => RuntimeState["policyEvents"][number]["outcome"];
  addPolicyEvent: (
    pi: ExtensionAPI,
    event: RuntimeState["policyEvents"][number],
  ) => void;
  appendPostflightEntry: (pi: ExtensionAPI, record: PostflightRecord) => void;
  summarizeEvidence: (text: string, max?: number) => string;
  appendLine: (filePath: string, content: string) => Promise<void>;
  ensureLearningStore: (cwd: string) => Promise<LearningPathsLike>;
  maybeEmitPromotionHint: (
    paths: LearningPathsLike,
    observation: LearningObservation<TWorkflowType, TWorkflowOutcome>,
    ctx: ExtensionContext,
  ) => Promise<void>;
  notify: (ctx: ExtensionContext, message: string, type: NotifyType) => void;
  onLowConfidence: (event: {
    at: string;
    workflowId: string;
    workflowType: TWorkflowType;
    confidence: number;
    outcome: TWorkflowOutcome;
  }) => void;
}): Promise<void> {
  const inference = params.inferOutcomeFromText(params.assistantText);
  const paths = await params.ensureLearningStore(params.ctx.cwd);
  const finishedAt = params.nowIso();

  const postflightFromOutput =
    params.extractPostflightFromAssistantText(
      params.assistantText,
      params.nowIso,
    ) ?? params.runtimeState.latestPostflight;
  const postflightMissing =
    params.workflow.mutationCount > 0 && !postflightFromOutput;
  const postflightDecision = params.modeOutcome(
    params.runtimeState.firstPrinciplesConfig.postflightMode,
    postflightMissing,
  );

  params.addPolicyEvent(params.pi, {
    at: finishedAt,
    phase: "postflight",
    mode: params.runtimeState.firstPrinciplesConfig.postflightMode,
    outcome: postflightDecision,
    detail: postflightMissing
      ? "Missing postflight evidence after mutation."
      : `Postflight evidence present (${postflightFromOutput?.result ?? "unknown"}).`,
  });

  if (postflightDecision === "warn") {
    const warning =
      "Policy warning: Missing postflight evidence after mutation.";
    params.workflow.policyWarnings.push(warning);
    params.notify(params.ctx, warning, "warning");
  }

  if (postflightFromOutput) {
    params.runtimeState.latestPostflight = postflightFromOutput;
    params.appendPostflightEntry(params.pi, postflightFromOutput);
  }

  const hasPreflightWarning = params.workflow.policyWarnings.some((line) =>
    line.includes("Missing valid preflight"),
  );
  const qualityScore = Math.max(
    0,
    100 - (hasPreflightWarning ? 50 : 0) - (postflightMissing ? 20 : 0),
  );

  const strictViolations: string[] = [];
  if (inference.strictViolation)
    strictViolations.push(inference.strictViolation);
  if (
    postflightMissing &&
    params.runtimeState.firstPrinciplesConfig.postflightMode === "enforce"
  ) {
    strictViolations.push("Missing required postflight evidence.");
  }

  const strictViolation =
    strictViolations.length > 0 ? strictViolations.join(" ") : null;
  const outcome = (
    strictViolation ? "failed" : inference.outcome
  ) as TWorkflowOutcome;
  const confidence = inference.confidence;

  const evidenceSnippet = strictViolation
    ? params.summarizeEvidence(`${strictViolation} ${params.assistantText}`)
    : params.summarizeEvidence(params.assistantText);

  const runRecord = {
    version: params.learningVersion,
    id: params.workflow.id,
    type: params.workflow.type,
    input: params.workflow.input,
    flags: params.workflow.flags,
    startedAt: params.workflow.startedAt,
    finishedAt,
    outcome,
    confidence,
    strictViolation,
    evidenceSnippet,
    policy: {
      preflightMode: params.runtimeState.firstPrinciplesConfig.preflightMode,
      postflightMode: params.runtimeState.firstPrinciplesConfig.postflightMode,
      mutationCount: params.workflow.mutationCount,
      warnings: params.workflow.policyWarnings,
      postflightMissing,
      qualityScore,
      postflight: postflightFromOutput,
    },
  };

  await fs.writeFile(
    params.workflow.runFile,
    `${JSON.stringify(runRecord, null, 2)}\n`,
    "utf8",
  );

  const observation: LearningObservation<TWorkflowType, TWorkflowOutcome> = {
    version: params.learningVersion,
    id: params.workflow.id,
    timestamp: finishedAt,
    taskType: params.workflow.type,
    input: params.workflow.input,
    flags: params.workflow.flags,
    outcome,
    confidence,
    evidenceSnippet: runRecord.evidenceSnippet,
    workflowId: params.workflow.id,
  };

  await params.appendLine(paths.learningJsonl, JSON.stringify(observation));
  await params.appendLine(
    paths.memoryMd,
    `- ${finishedAt.slice(0, 10)} [${params.workflow.type}/${outcome}] ${params.summarizeEvidence(params.workflow.input, 180)} (confidence=${confidence.toFixed(2)}, q=${qualityScore})`,
  );

  params.pi.appendEntry("khala-workflow-complete", {
    id: params.workflow.id,
    type: params.workflow.type,
    outcome,
    confidence,
    strictViolation,
    qualityScore,
    mutationCount: params.workflow.mutationCount,
    postflightMissing,
    at: finishedAt,
  });

  if (confidence < params.lowConfidenceThreshold) {
    params.onLowConfidence({
      at: finishedAt,
      workflowId: params.workflow.id,
      workflowType: params.workflow.type,
      confidence,
      outcome,
    });
  }

  await params.maybeEmitPromotionHint(paths, observation, params.ctx);

  params.notify(
    params.ctx,
    strictViolation
      ? `Workflow ${params.workflow.type} completed with strict-output violation (${strictViolation}). Marked failed.`
      : `Workflow ${params.workflow.type} completed (${outcome}, confidence=${confidence.toFixed(2)}, q=${qualityScore}).`,
    strictViolation ? "error" : "info",
  );

  if (params.workflow.mutationCount > 0) {
    params.runtimeState.activePreflight = null;
    params.runtimeState.latestPostflight = null;
  }
}
