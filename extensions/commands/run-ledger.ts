import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import {
  appendRunLedgerEvent,
  buildRunLedgerCheckpointEvent,
  buildRunLedgerResumeAttemptEvent,
  getGlobalRunLedgerDir,
  readRunLedger,
  resolveRunLedgerFile,
  summarizeRunRecovery,
  type RunLedgerEvent,
  type RunLedgerRecord,
} from "../runtime/run-ledger.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export interface RunLedgerCommandHandlers {
  runList: CommandHandler;
  runShow: CommandHandler;
  runResume: CommandHandler;
  runCheckpoint: CommandHandler;
}

function summarizeRunInput(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (!normalized) return "no input recorded";
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function searchableValueParts(value: unknown, depth = 0): string[] {
  if (depth > 2 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.slice(0, 20).flatMap((item) => searchableValueParts(item, depth + 1));
  if (!isRecord(value)) return [];

  return Object.entries(value)
    .slice(0, 40)
    .flatMap(([key, item]) => [key, ...searchableValueParts(item, depth + 1)]);
}

function formatEventInputSummary(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isRecord(value)) {
    const keys = Object.keys(value).slice(0, 6);
    return keys.length > 0 ? ` input_keys=${keys.join(",")}` : "";
  }
  if (Array.isArray(value)) return ` input_items=${value.length}`;
  if (typeof value === "string") return value.trim() ? ` input=${summarizeWorkflowText(value, 60)}` : "";
  if (typeof value === "number" || typeof value === "boolean") return ` input=${String(value)}`;
  return "";
}

function formatStructuredCompletionSummary(value: unknown): string[] {
  if (!isRecord(value)) return [];

  const outcome = typeof value.outcome === "string" ? value.outcome : "unknown";
  const confidence = typeof value.confidence === "number" ? ` confidence=${value.confidence.toFixed(2)}` : "";
  const lines = [`Completion: outcome=${outcome}${confidence}`];
  const validation = stringArray(value.validation);
  const openQuestions = stringArray(value.openQuestions);
  const learningCandidates = stringArray(value.learningCandidates);
  if (validation.length > 0) lines.push(`Validation: ${validation.join("; ")}`);
  if (openQuestions.length > 0) lines.push(`Open questions: ${openQuestions.join("; ")}`);
  if (learningCandidates.length > 0) lines.push(`Learning candidates: ${learningCandidates.join("; ")}`);
  return lines;
}

function formatStructuredCompletionListPart(value: unknown): string {
  if (!isRecord(value)) return "";

  const outcome = typeof value.outcome === "string" ? value.outcome.trim() : "";
  if (!outcome) return "";

  const confidence =
    typeof value.confidence === "number" ? ` confidence=${value.confidence.toFixed(2)}` : "";
  const validation = stringArray(value.validation);
  const openQuestions = stringArray(value.openQuestions);
  const learningCandidates = stringArray(value.learningCandidates);
  const validationCount = validation.length > 0 ? ` validation=${validation.length}` : "";
  const openQuestionCount =
    openQuestions.length > 0 ? ` open_questions=${openQuestions.length}` : "";
  const learningCount =
    learningCandidates.length > 0 ? ` learnings=${learningCandidates.length}` : "";
  return ` completion=${outcome}${confidence}${validationCount}${openQuestionCount}${learningCount}`;
}

function summarizeWorkflowText(value: unknown, maxLength = 120): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function formatWorkflowStateSummary(value: unknown): string[] {
  if (!isRecord(value)) return [];

  const objective = summarizeWorkflowText(value.objective);
  const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
  const currentStepIndex = Number.isInteger(value.currentStepIndex)
    ? (value.currentStepIndex as number)
    : null;
  if (!objective && steps.length === 0) return [];

  const lines: string[] = [];
  const currentStep = currentStepIndex === null ? null : steps[currentStepIndex];
  const currentStepLabel = currentStep
    ? `${currentStepIndex + 1}/${steps.length} ${summarizeWorkflowText(currentStep.id, 40)}`
    : currentStepIndex === null
      ? "none"
      : `${currentStepIndex + 1}/${steps.length}`;
  lines.push(`Workflow state: current_step=${currentStepLabel}`);
  if (objective) lines.push(`Workflow objective: ${objective}`);
  if (steps.length > 0) {
    const stepSummary = steps
      .map((step, index) => {
        const id = summarizeWorkflowText(step.id, 40) || `step-${index + 1}`;
        const status = summarizeWorkflowText(step.status, 24) || "unknown";
        return `${index + 1}.${id}=${status}`;
      })
      .join("; ");
    lines.push(`Workflow steps: ${stepSummary}`);
  }
  return lines;
}

function formatWorkflowStateListPart(value: unknown): string {
  if (!isRecord(value)) return "";

  const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
  const currentStepIndex = Number.isInteger(value.currentStepIndex)
    ? (value.currentStepIndex as number)
    : null;
  if (currentStepIndex === null || steps.length === 0) return "";

  const currentStep = steps[currentStepIndex];
  const currentStepId = currentStep
    ? summarizeWorkflowText(currentStep.id, 40) || `step-${currentStepIndex + 1}`
    : `step-${currentStepIndex + 1}`;
  return ` step=${currentStepIndex + 1}/${steps.length}:${currentStepId}`;
}

function searchableRunText(record: RunLedgerRecord): string {
  const parts = [
    record.id,
    record.status,
    record.workflow.type,
    record.resume.classification,
    record.resume.reason,
    ...record.resume.unsafeEventIds,
    record.input,
  ];
  if (isRecord(record.structuredCompletion)) {
    const completion = record.structuredCompletion;
    parts.push(
      typeof completion.outcome === "string" ? completion.outcome : "",
      ...stringArray(completion.validation),
      ...stringArray(completion.openQuestions),
      ...stringArray(completion.learningCandidates),
    );
  }
  if (isRecord(record.workflow.state)) {
    const state = record.workflow.state;
    parts.push(
      typeof state.name === "string" ? state.name : "",
      typeof state.objective === "string" ? state.objective : "",
    );
    if (Array.isArray(state.steps)) {
      for (const step of state.steps.filter(isRecord)) {
        parts.push(
          typeof step.id === "string" ? step.id : "",
          typeof step.action === "string" ? step.action : "",
          typeof step.status === "string" ? step.status : "",
        );
      }
    }
  }
  for (const event of record.events) {
    parts.push(event.id, event.at, event.type, event.summary, event.toolName ?? "");
    parts.push(...searchableValueParts(event.data?.input));
    const skill = isRecord(event.data?.skill) ? event.data.skill : null;
    if (skill) {
      parts.push(
        typeof skill.name === "string" ? skill.name : "",
        typeof skill.source === "string" ? skill.source : "",
        typeof skill.path === "string" ? skill.path : "",
      );
    }
    const metadata = isRecord(event.data?.metadata) ? event.data.metadata : null;
    if (metadata) {
      parts.push(
        typeof metadata.name === "string" ? metadata.name : "",
        typeof metadata.evidenceClass === "string" ? metadata.evidenceClass : "",
        typeof metadata.mutationClass === "string" ? metadata.mutationClass : "",
        typeof metadata.sideEffectClass === "string" ? metadata.sideEffectClass : "",
        typeof metadata.memoryRefreshRequirement === "string"
          ? metadata.memoryRefreshRequirement
          : "",
      );
    }
    if (typeof event.data?.reason === "string") parts.push(event.data.reason);
  }
  return parts.join(" ").toLowerCase();
}

function formatRunListHelp(): string {
  return [
    "Usage: /run-list [filter]",
    "",
    "Lists newest durable Khala runs first.",
    "Filter searches run id, status, workflow type, recovery classification, input, workflow state, structured completion text, ledger event ids/timestamps/text, skill metadata, and tool metadata.",
    "",
    "Examples:",
    "- /run-list needs_operator_review",
    "- /run-list npm test passed",
  ].join("\n");
}

function isHelpArg(value: string): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function formatRunShowHelp(): string {
  return [
    "Usage: /run-show <run-id|path>",
    "",
    "Shows a durable Khala run ledger summary, recovery classification, structured completion, and recent events.",
    "Use this before resuming runs that need operator review.",
  ].join("\n");
}

function formatRunResumeHelp(): string {
  return [
    "Usage: /run-resume <run-id|path>",
    "",
    "Queues a conservative resume prompt only when the run ledger is classified resumable.",
    "Runs with unsafe mutation, shell, forge, external, or unknown side effects require operator review first.",
  ].join("\n");
}

function formatRunCheckpointHelp(): string {
  return [
    "Usage: /run-checkpoint <run-id|path> [reason]",
    "",
    "Records an operator-verified replay-safe checkpoint in a durable Khala run ledger.",
    "Use checkpoints only after verifying that earlier unsafe side effects must not be repeated.",
  ].join("\n");
}

function formatUnsafeEventMetadata(eventData: Record<string, unknown> | undefined): string {
  const metadata = isRecord(eventData?.metadata) ? eventData.metadata : null;
  if (!metadata) return "";

  const evidence =
    typeof metadata.evidenceClass === "string" ? ` evidence=${metadata.evidenceClass}` : "";
  const mutation =
    typeof metadata.mutationClass === "string" ? ` mutation=${metadata.mutationClass}` : "";
  const sideEffect =
    typeof metadata.sideEffectClass === "string" ? ` side_effect=${metadata.sideEffectClass}` : "";
  const replay = typeof metadata.replaySafe === "boolean" ? ` replay_safe=${metadata.replaySafe}` : "";
  const memory =
    typeof metadata.memoryRefreshRequirement === "string"
      ? ` memory_refresh=${metadata.memoryRefreshRequirement}`
      : "";
  const gate = formatGateSatisfaction(metadata.gateSatisfaction);
  return `${evidence}${mutation}${sideEffect}${replay}${memory}${gate}`;
}

function formatGateSatisfaction(value: unknown): string {
  if (!isRecord(value)) return "";

  const gates = [
    value.countsTaskToolCall === true ? "counts_task_tool_call" : "",
    value.agesMemory === true ? "ages_memory" : "",
    value.satisfiesMemoryRead === true ? "satisfies_memory_read" : "",
    value.persistsMemory === true ? "persists_memory" : "",
  ].filter(Boolean);

  return gates.length > 0 ? ` gate=${gates.join(",")}` : "";
}

function formatEventSkillSummary(eventData: Record<string, unknown> | undefined): string {
  if (!eventData || !isRecord(eventData.skill)) return "";

  const skill = eventData.skill;
  const name = summarizeWorkflowText(skill.name, 60);
  const source = summarizeWorkflowText(skill.source, 40);
  const reason = summarizeWorkflowText(skill.reason, 80) || summarizeWorkflowText(eventData.reason, 80);
  const path = summarizeWorkflowText(skill.path, 80);
  return [
    name ? ` skill=${name}` : "",
    source ? ` skill_source=${source}` : "",
    reason ? ` skill_reason=${reason}` : "",
    path ? ` skill_path=${path}` : "",
  ].join("");
}

function formatUnsafeEventDetails(record: RunLedgerRecord): string {
  if (record.resume.unsafeEventIds.length === 0) return "";

  const eventsById = new Map(record.events.map((event) => [event.id, event]));
  const details = record.resume.unsafeEventIds.map((eventId) => {
    const event = eventsById.get(eventId);
    if (!event) return eventId;

    const tool = event.toolName ? ` tool=${event.toolName}` : "";
    const sideEffect = event.sideEffectClass ? ` side_effect=${event.sideEffectClass}` : "";
    const replay = typeof event.replaySafe === "boolean" ? ` replay_safe=${event.replaySafe}` : "";
    const input = formatEventInputSummary(event.data?.input);
    const metadata = formatUnsafeEventMetadata(event.data);
    const skill = formatEventSkillSummary(event.data);
    return `${eventId}${tool}${sideEffect}${replay}${input}${metadata}${skill}`;
  });
  return `\nUnsafe events: ${details.join("; ")}`;
}

function formatRunLedgerEventLine(event: RunLedgerEvent): string {
  const tool = event.toolName ? ` tool=${event.toolName}` : "";
  const sideEffect = event.sideEffectClass ? ` side_effect=${event.sideEffectClass}` : "";
  const replay = typeof event.replaySafe === "boolean" ? ` replay_safe=${event.replaySafe}` : "";
  const input = formatEventInputSummary(event.data?.input);
  const metadata = formatUnsafeEventMetadata(event.data);
  const skill = formatEventSkillSummary(event.data);
  return `- ${event.at} ${event.type}${tool}${sideEffect}${replay}${input}${metadata}${skill}: ${event.summary}`;
}

function formatCheckpointReason(event: RunLedgerEvent, maxLength: number): string {
  const structuredReason = isRecord(event.data)
    ? summarizeWorkflowText(event.data.reason, maxLength)
    : "";
  if (structuredReason) return structuredReason;

  if (!event.summary.startsWith("Checkpoint recorded:")) return "";
  return summarizeWorkflowText(event.summary.slice("Checkpoint recorded:".length), maxLength);
}

function formatCheckpointSummary(record: RunLedgerRecord): string {
  const checkpoints = record.events.filter((event) => event.type === "checkpoint");
  const latest = checkpoints.at(-1);
  if (!latest) return "";

  const reason = formatCheckpointReason(latest, 80);
  const reasonPart = reason ? ` reason=${reason}` : "";
  return `Checkpoints: count=${checkpoints.length} latest=${latest.id} at=${latest.at}${reasonPart}`;
}

function formatCheckpointListPart(record: RunLedgerRecord): string {
  const checkpoints = record.events.filter((event) => event.type === "checkpoint");
  const latest = checkpoints.at(-1);
  if (!latest) return "";

  const reason = formatCheckpointReason(latest, 60);
  const reasonPart = reason ? ` checkpoint_reason=${reason}` : "";
  return ` checkpoints=${checkpoints.length} latest_checkpoint=${latest.at}${reasonPart}`;
}

function formatSkillActivitySummary(record: RunLedgerRecord): string {
  const skillEvents = record.events.filter((event) =>
    event.type === "skill_routed" ||
    event.type === "skill_loaded" ||
    event.type === "skill_missing" ||
    event.type === "skill_used_without_load"
  );
  if (skillEvents.length === 0) return "";

  const counts = new Map<string, number>();
  const sources = new Set<string>();
  const missing = new Set<string>();
  const usedWithoutLoad = new Set<string>();

  for (const event of skillEvents) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (!isRecord(event.data?.skill)) continue;

    const skill = event.data.skill;
    if (typeof skill.source === "string" && skill.source.trim()) {
      sources.add(skill.source.trim());
    }
    if (typeof skill.name !== "string" || !skill.name.trim()) continue;

    const skillName = skill.name.trim();
    if (event.type === "skill_missing") {
      missing.add(skillName);
    } else if (event.type === "skill_used_without_load") {
      usedWithoutLoad.add(skillName);
    }
  }

  const countParts = [
    "skill_routed",
    "skill_loaded",
    "skill_missing",
    "skill_used_without_load",
  ].flatMap((type) => {
    const count = counts.get(type) ?? 0;
    return count > 0 ? [`${type}=${count}`] : [];
  });
  const sourcePart = sources.size > 0 ? ` sources=${[...sources].sort().join(",")}` : "";
  const missingPart = missing.size > 0 ? ` missing=${[...missing].sort().join(",")}` : "";
  const usedPart =
    usedWithoutLoad.size > 0
      ? ` used_without_load=${[...usedWithoutLoad].sort().join(",")}`
      : "";

  return `Skills: ${countParts.join(" ")}${sourcePart}${missingPart}${usedPart}`;
}

function formatRunLedgerSummary(record: RunLedgerRecord, runFile: string): string {
  const unsafe = formatUnsafeEventDetails(record);
  const recovery = summarizeRunRecovery(record);
  const events = record.events
    .slice(-8)
    .map(formatRunLedgerEventLine)
    .join("\n");
  return [
    `Run ${record.id}`,
    `File: ${runFile}`,
    `Status: ${record.status}`,
    `Workflow: ${record.type}`,
    record.repo ? `Repo: ${record.repo}` : "",
    record.cwd ? `Cwd: ${record.cwd}` : "",
    `Started: ${record.startedAt}`,
    record.finishedAt ? `Finished: ${record.finishedAt}` : "",
    `Input: ${summarizeRunInput(record.input)}`,
    `Recovery: ${recovery.classification} - ${recovery.reason}${unsafe}`,
    `Next action: ${recovery.recommendedAction}`,
    formatSkillActivitySummary(record),
    formatCheckpointSummary(record),
    ...formatWorkflowStateSummary(record.workflow.state),
    ...formatStructuredCompletionSummary(record.structuredCompletion),
    events ? `Recent events:\n${events}` : "Recent events: none",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildResumePrompt(record: RunLedgerRecord, runFile: string): string {
  const recovery = summarizeRunRecovery(record);
  return [
    `Resume Khala run \`${record.id}\` conservatively.`,
    "",
    "Run ledger:",
    runFile,
    "",
    `Next action: ${recovery.recommendedAction}`,
    "",
    "Recovery contract:",
    "- Read the run ledger before acting.",
    "- Resume only from recorded safe state and explicit checkpoints.",
    "- Do not repeat uncertain mutation, shell, forge, external, or tool side effects.",
    "- If the ledger does not prove a safe next action, stop and report the operator review needed.",
    "",
    "Run summary:",
    "```text",
    formatRunLedgerSummary(record, runFile),
    "```",
  ].join("\n");
}

async function listRuns(runLedgerDir: string): Promise<{
  runs: Array<{ runFile: string; record: RunLedgerRecord }>;
  skipped: number;
}> {
  let entries: string[];
  try {
    entries = await readdir(runLedgerDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], skipped: 0 };
    throw error;
  }

  const runs: Array<{ runFile: string; record: RunLedgerRecord }> = [];
  let skipped = 0;
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const runFile = resolveRunLedgerFile(entry, runLedgerDir);
    try {
      runs.push({ runFile, record: await readRunLedger(runFile) });
    } catch {
      skipped += 1;
      // Ignore corrupt partial records in the list view; run-show surfaces exact read errors.
    }
  }

  return {
    runs: runs.sort((left, right) => {
      const leftAt = left.record.finishedAt ?? left.record.startedAt;
      const rightAt = right.record.finishedAt ?? right.record.startedAt;
      return rightAt.localeCompare(leftAt) || right.record.id.localeCompare(left.record.id);
    }),
    skipped,
  };
}

export function createRunLedgerCommandHandlers(params: {
  pi: ExtensionAPI;
  runLedgerDir?: string;
  nowIso: () => string;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
}): RunLedgerCommandHandlers {
  async function loadRun(
    args: string | undefined,
    ctx: ExtensionCommandContext,
    usage: string,
    helpText = usage,
  ): Promise<{ runFile: string; record: RunLedgerRecord } | null> {
    const rawArgs = (args ?? "").trim();
    if (isHelpArg(rawArgs)) {
      params.notify(ctx, helpText, "info");
      return null;
    }

    const target = rawArgs.split(/\s+/)[0] ?? "";
    if (!target) {
      params.notify(ctx, usage, "error");
      return null;
    }

    const runFile = resolveRunLedgerFile(target, params.runLedgerDir);
    const record = await readRunLedger(runFile);
    if (!record) {
      params.notify(ctx, `Khala run ledger not found: ${target}`, "error");
      return null;
    }
    return { runFile, record };
  }

  return {
    runList: async (args, ctx) => {
      const rawArgs = (args ?? "").trim();
      if (rawArgs === "--help" || rawArgs === "-h" || rawArgs === "help") {
        params.notify(ctx, formatRunListHelp(), "info");
        return;
      }

      const runLedgerDir = params.runLedgerDir ?? getGlobalRunLedgerDir();
      const { runs, skipped } = await listRuns(runLedgerDir);
      const filter = rawArgs.toLowerCase();
      const visibleRuns = filter
        ? runs.filter(({ record }) => searchableRunText(record).includes(filter))
        : runs;
      if (visibleRuns.length === 0) {
        const skippedLine = skipped > 0 ? ` Skipped unreadable run files: ${skipped}.` : "";
        const filterLine = filter ? ` matching "${filter}"` : "";
        params.notify(ctx, `Khala run ledger: no runs found${filterLine}.${skippedLine}`, "info");
        return;
      }

      const lines = visibleRuns.map(({ record }) => {
        const at = record.finishedAt ?? record.startedAt;
        const completion = formatStructuredCompletionListPart(record.structuredCompletion);
        const workflowState = formatWorkflowStateListPart(record.workflow.state);
        const checkpoints = formatCheckpointListPart(record);
        const unsafe =
          record.resume.unsafeEventIds.length > 0
            ? ` unsafe=${record.resume.unsafeEventIds.length}`
            : "";
        const reviewReason =
          record.resume.classification === "needs_operator_review"
            ? ` review_reason=${summarizeWorkflowText(record.resume.reason, 80)}`
            : "";
        return `- ${record.id} ${record.status} ${record.workflow.type} at=${at} recovery=${record.resume.classification}${unsafe}${reviewReason}${completion}${workflowState}${checkpoints} input=${summarizeRunInput(record.input)}`;
      });
      if (skipped > 0) lines.push(`Skipped unreadable run files: ${skipped}`);
      const title = filter ? `Khala run ledger matching "${filter}":` : "Khala run ledger:";
      params.notify(ctx, `${title}\n${lines.join("\n")}`, "info");
    },
    runShow: async (args, ctx) => {
      const loaded = await loadRun(args, ctx, "Usage: /run-show <run-id|path>", formatRunShowHelp());
      if (!loaded) return;
      params.notify(
        ctx,
        formatRunLedgerSummary(loaded.record, loaded.runFile),
        "info",
      );
    },

    runResume: async (args, ctx) => {
      const loaded = await loadRun(args, ctx, "Usage: /run-resume <run-id|path>", formatRunResumeHelp());
      if (!loaded) return;
      const { record, runFile } = loaded;
      if (record.resume.classification !== "resumable") {
        const unsafe = formatUnsafeEventDetails(record);
        params.notify(
          ctx,
          `Run ${record.id} is not safe to resume automatically (${record.resume.classification}).${unsafe} Use /run-show ${record.id} and review operator context first.`,
          "error",
        );
        return;
      }

      const resumedAt = params.nowIso();
      await appendRunLedgerEvent({
        runFile,
        event: buildRunLedgerResumeAttemptEvent({
          runId: record.id,
          at: resumedAt,
        }),
      });

      const prompt = buildResumePrompt(record, runFile);
      if (ctx.isIdle()) {
        params.pi.sendUserMessage(prompt);
      } else {
        params.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        params.notify(ctx, `Queued conservative resume for run ${record.id}.`, "info");
      }
    },
    async runCheckpoint(args, ctx) {
      const loaded = await loadRun(
        args,
        ctx,
        "Usage: /run-checkpoint <run-id|path> [reason]",
        formatRunCheckpointHelp(),
      );
      if (!loaded) return;
      const reason = (args ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
      const event = buildRunLedgerCheckpointEvent({
        runId: loaded.record.id,
        at: params.nowIso(),
        reason,
      });
      const updated = await appendRunLedgerEvent({
        runFile: loaded.runFile,
        event,
      });
      params.notify(
        ctx,
        `Recorded checkpoint ${event.id}. Recovery: ${updated.resume.classification}. Unsafe events remaining: ${updated.resume.unsafeEventIds.length}.`,
        "success",
      );
    },
  };
}
