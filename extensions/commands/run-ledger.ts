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

function formatReplayEventInputSummary(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (!isRecord(value)) return formatEventInputSummary(value);

  const parts = Object.entries(value)
    .flatMap(([key, item]) => {
      if (typeof item === "string") {
        const summary = summarizeWorkflowText(item, 80);
        return summary ? [`${key}=${summary}`] : [];
      }
      if (typeof item === "number" || typeof item === "boolean") {
        return [`${key}=${String(item)}`];
      }
      return [];
    })
    .slice(0, 4);
  return parts.length > 0 ? ` input=${parts.join(",")}` : formatEventInputSummary(value);
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

function latestWorkflowCompletedData(record: RunLedgerRecord): Record<string, unknown> | null {
  const event = record.events.findLast((item) => item.type === "workflow_completed");
  return isRecord(event?.data) ? event.data : null;
}

function strictViolationMetadata(
  record: RunLedgerRecord,
  policy: Record<string, unknown>,
  completedData: Record<string, unknown>,
): { strictViolation?: boolean; strictViolationReason?: string } {
  const reason = firstString(
    policy.strictViolationReason,
    record.strictViolationReason,
    completedData.strictViolationReason,
    typeof record.strictViolation === "string" ? record.strictViolation : undefined,
  );
  const flag =
    typeof policy.strictViolation === "boolean"
      ? policy.strictViolation
      : typeof record.strictViolation === "boolean"
        ? record.strictViolation
        : typeof completedData.strictViolation === "boolean"
          ? completedData.strictViolation
          : reason
            ? true
            : undefined;
  return {
    strictViolation: flag,
    ...(reason ? { strictViolationReason: reason } : {}),
  };
}

function completionPolicyMetadata(record: RunLedgerRecord): Record<string, unknown> {
  const policy = isRecord(record.policy) ? record.policy : {};
  const completedData = latestWorkflowCompletedData(record) ?? {};
  const strictViolation = strictViolationMetadata(record, policy, completedData);
  return {
    ...policy,
    ...strictViolation,
    qualityScore: policy.qualityScore ?? record.qualityScore ?? completedData.qualityScore,
    mutationCount: policy.mutationCount ?? record.mutationCount ?? completedData.mutationCount,
    postflightMissing: policy.postflightMissing ?? completedData.postflightMissing,
    warnings: policy.warnings ?? record.policyWarnings ?? completedData.policyWarnings,
  };
}

function formatCompletionPolicySummary(record: RunLedgerRecord): string[] {
  const policy = completionPolicyMetadata(record);
  const parts = [
    typeof policy.strictViolation === "boolean"
      ? `strict_violation=${policy.strictViolation}`
      : "",
    typeof policy.qualityScore === "number" && Number.isFinite(policy.qualityScore)
      ? `quality=${policy.qualityScore}`
      : "",
    typeof policy.mutationCount === "number" && Number.isFinite(policy.mutationCount)
      ? `mutations=${policy.mutationCount}`
      : "",
    typeof policy.postflightMissing === "boolean"
      ? `postflight_missing=${policy.postflightMissing}`
      : "",
  ].filter(Boolean);
  const warnings = stringArray(policy.warnings);
  if (parts.length === 0 && warnings.length === 0) return [];

  const lines = [`Policy: ${parts.join(" ")}`.trim()];
  if (typeof policy.strictViolationReason === "string") {
    lines.push(`Policy strict violation: ${policy.strictViolationReason}`);
  }
  if (warnings.length > 0) lines.push(`Policy warnings: ${warnings.join("; ")}`);
  return lines;
}

function formatCompletionPolicyListPart(record: RunLedgerRecord): string {
  const policy = completionPolicyMetadata(record);
  const parts = [
    typeof policy.strictViolation === "boolean"
      ? `strict_violation=${policy.strictViolation}`
      : "",
    typeof policy.qualityScore === "number" && Number.isFinite(policy.qualityScore)
      ? `quality=${policy.qualityScore}`
      : "",
    typeof policy.postflightMissing === "boolean"
      ? `postflight_missing=${policy.postflightMissing}`
      : "",
  ].filter(Boolean);
  const warnings = stringArray(policy.warnings);
  if (warnings.length > 0) parts.push(`policy_warnings=${warnings.length}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstStringFromRecord(value: unknown, ...keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  return firstString(...keys.map((key) => value[key]));
}

function formatRunSourceListPart(sourceContext: unknown): string {
  if (!isRecord(sourceContext)) return "";
  const issue =
    firstString(
      sourceContext.issue,
      sourceContext.issueNumber,
      sourceContext.issue_number,
      sourceContext.sourceIssue,
      sourceContext.source_issue,
    ) ?? firstStringFromRecord(sourceContext.issue, "number", "id", "url");
  const pr =
    firstString(
      sourceContext.pr,
      sourceContext.pullRequest,
      sourceContext.pull_request,
      sourceContext.sourcePr,
      sourceContext.source_pr,
    ) ??
    firstStringFromRecord(sourceContext.pr, "number", "id", "url") ??
    firstStringFromRecord(sourceContext.pullRequest, "number", "id", "url") ??
    firstStringFromRecord(sourceContext.pull_request, "number", "id", "url");
  const source = firstString(sourceContext.source, sourceContext.sourceUrl, sourceContext.source_url, sourceContext.url);
  const parts = [
    issue ? `issue=${summarizeWorkflowText(issue, 40)}` : "",
    pr ? `pr=${summarizeWorkflowText(pr, 40)}` : "",
    source ? `source=${summarizeWorkflowText(source, 60)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function formatRunSourceSummary(sourceContext: unknown): string[] {
  const summary = formatRunSourceListPart(sourceContext).trim();
  return summary.length > 0 ? [`Source: ${summary}`] : [];
}

function formatRunLocalListPart(localContext: unknown): string {
  if (!isRecord(localContext)) return "";
  const worktree = firstString(localContext.worktreePath, localContext.worktree, localContext.worktree_path);
  const capsule = firstString(localContext.capsulePath, localContext.capsule, localContext.capsule_path);
  const ledger = firstString(localContext.ledgerPath, localContext.ledger, localContext.ledger_path);
  const parts = [
    worktree ? `worktree=${summarizeWorkflowText(worktree, 80)}` : "",
    capsule ? `capsule=${summarizeWorkflowText(capsule, 80)}` : "",
    ledger ? `ledger=${summarizeWorkflowText(ledger, 80)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function formatRunLocalSummary(localContext: unknown): string[] {
  const summary = formatRunLocalListPart(localContext).trim();
  return summary.length > 0 ? [`Local: ${summary}`] : [];
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
  if (steps.length === 0) return "";
  if (currentStepIndex === null) {
    const completed = steps.filter((step) => step.status === "completed").length;
    if (completed === steps.length) return ` step=completed:${completed}/${steps.length}`;
    const statusCounts = new Map<string, number>();
    for (const step of steps) {
      const status = typeof step.status === "string" ? step.status : "unknown";
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
    const counts = ["completed", "active", "pending", "skipped", "unknown"]
      .flatMap((status) => {
        const count = statusCounts.get(status) ?? 0;
        return count > 0 ? [`${status}=${count}`] : [];
      })
      .join(",");
    return ` step=incomplete:${counts || `total=${steps.length}`}`;
  }

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
    record.resume.classification === "resumable" ? "resume" : "",
    record.resume.reason,
    summarizeRunRecovery(record).recommendedAction,
    ...record.resume.unsafeEventIds,
    ...unsafeEventSearchParts(record),
    record.input,
    ...searchableValueParts(record.source),
    ...searchableValueParts(record.local),
    ...searchableValueParts(completionPolicyMetadata(record)),
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
    parts.push(
      event.evidenceClass ?? "",
      event.mutationClass ?? "",
      event.sideEffectClass ?? "",
      event.memoryRefreshRequirement ?? "",
    );
    if (event.gateSatisfaction) {
      parts.push(
        event.gateSatisfaction.countsTaskToolCall ? "counts_task_tool_call" : "",
        event.gateSatisfaction.agesMemory ? "ages_memory" : "",
        event.gateSatisfaction.satisfiesMemoryRead ? "satisfies_memory_read" : "",
        event.gateSatisfaction.persistsMemory ? "persists_memory" : "",
      );
    }
    parts.push(...searchableValueParts(event.data?.input));
    const skill = isRecord(event.data?.skill) ? event.data.skill : null;
    if (skill) {
      parts.push(
        typeof skill.name === "string" ? skill.name : "",
        typeof skill.source === "string" ? skill.source : "",
        typeof skill.path === "string" ? skill.path : "",
      );
    }
    const workflowStep = isRecord(event.data?.workflowStep)
      ? event.data.workflowStep
      : null;
    if (workflowStep) {
      parts.push(
        formatEventWorkflowStepSummary(event.data),
        typeof workflowStep.id === "string" ? workflowStep.id : "",
        typeof workflowStep.action === "string" ? workflowStep.action : "",
        typeof workflowStep.status === "string" ? workflowStep.status : "",
      );
    }
    if (Array.isArray(event.data?.attemptedSources)) {
      parts.push(
        ...event.data.attemptedSources.filter(
          (source): source is string => typeof source === "string",
        ),
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
    if (Array.isArray(event.data?.loadedSkills)) {
      parts.push(
        ...event.data.loadedSkills.filter(
          (skill): skill is string => typeof skill === "string",
        ),
      );
    }
    if (Array.isArray(event.data?.skillMetadata)) {
      for (const skill of event.data.skillMetadata.filter(isRecord)) {
        parts.push(
          typeof skill.name === "string" ? skill.name : "",
          typeof skill.source === "string" ? skill.source : "",
          typeof skill.path === "string" ? skill.path : "",
        );
      }
    }
    if (typeof event.data?.reason === "string") parts.push(event.data.reason);
    if (isRecord(event.data?.recovery)) {
      const recovery = event.data.recovery;
      parts.push(
        typeof recovery.classification === "string" ? recovery.classification : "",
        typeof recovery.reason === "string" ? recovery.reason : "",
        typeof recovery.recommendedAction === "string" ? recovery.recommendedAction : "",
      );
      if (Array.isArray(recovery.unsafeEventIds)) {
        parts.push(
          ...recovery.unsafeEventIds.filter(
            (eventId): eventId is string => typeof eventId === "string",
          ),
        );
      }
      if (Array.isArray(recovery.unsafeEvents)) {
        for (const unsafeEvent of recovery.unsafeEvents.filter(isRecord)) {
          parts.push(
            typeof unsafeEvent.id === "string" ? unsafeEvent.id : "",
            typeof unsafeEvent.reason === "string" ? unsafeEvent.reason : "",
            typeof unsafeEvent.toolName === "string" ? unsafeEvent.toolName : "",
            typeof unsafeEvent.sideEffectClass === "string" ? unsafeEvent.sideEffectClass : "",
            typeof unsafeEvent.mutationClass === "string" ? unsafeEvent.mutationClass : "",
            typeof unsafeEvent.memoryRefreshRequirement === "string"
              ? unsafeEvent.memoryRefreshRequirement
              : "",
          );
        }
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

function matchesRunListFilter(record: RunLedgerRecord, filter: string): boolean {
  if (filter === "active") return record.status !== "completed";
  if (filter === "resumable" || filter === "needs_operator_review") return record.resume.classification === filter;
  return searchableRunText(record).includes(filter);
}

function formatRunListHelp(): string {
  return [
    "Usage: /run-list [filter]",
    "",
    "Lists newest durable Khala runs first.",
    `Default ledger: ${getGlobalRunLedgerDir()}`,
    "Filter searches run id, status, workflow type, recovery classification and unsafe review details, source issue/PR/url, local worktree/capsule/ledger paths, input, next action, workflow state, structured completion text, completion policy metadata, ledger event ids/timestamps/text, skill metadata, skill attempted sources, tool metadata, and tool workflow-step context.",
    "Named views: active, resumable, needs_operator_review.",
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

function formatEventRegistryMetadata(event: RunLedgerEvent): string {
  const evidence = event.evidenceClass ? ` evidence=${event.evidenceClass}` : "";
  const mutation = event.mutationClass ? ` mutation=${event.mutationClass}` : "";
  const sideEffect = event.sideEffectClass ? ` side_effect=${event.sideEffectClass}` : "";
  const replay = typeof event.replaySafe === "boolean" ? ` replay_safe=${event.replaySafe}` : "";
  const memory = event.memoryRefreshRequirement
    ? ` memory_refresh=${event.memoryRefreshRequirement}`
    : "";
  const gate = formatGateSatisfaction(event.gateSatisfaction);
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
  const attemptedSources = Array.isArray(eventData.attemptedSources)
    ? eventData.attemptedSources.filter(
        (source): source is string => typeof source === "string" && source.trim().length > 0,
      )
    : [];
  const attemptedSourcesPart =
    attemptedSources.length > 0 ? ` skill_attempted_sources=${attemptedSources.join(",")}` : "";
  return [
    name ? ` skill=${name}` : "",
    source ? ` skill_source=${source}` : "",
    reason ? ` skill_reason=${reason}` : "",
    path ? ` skill_path=${path}` : "",
    attemptedSourcesPart,
  ].join("");
}

function formatResumeRecoverySummary(eventData: Record<string, unknown> | undefined): string {
  if (!isRecord(eventData?.recovery)) return "";

  const recovery = eventData.recovery;
  const classification =
    typeof recovery.classification === "string" && recovery.classification.trim()
      ? ` resume_recovery=${summarizeWorkflowText(recovery.classification, 40)}`
      : "";
  const unsafeCount = Array.isArray(recovery.unsafeEventIds)
    ? ` resume_unsafe=${recovery.unsafeEventIds.length}`
    : "";
  const firstUnsafeReason = Array.isArray(recovery.unsafeEvents)
    ? recovery.unsafeEvents
        .filter(isRecord)
        .map((event) => summarizeWorkflowText(event.reason, 80))
        .find((reason) => reason.length > 0)
    : "";
  const unsafeReason = firstUnsafeReason ? ` resume_unsafe_reason=${firstUnsafeReason}` : "";
  const action =
    typeof recovery.recommendedAction === "string" && recovery.recommendedAction.trim()
      ? ` resume_next=${summarizeWorkflowText(recovery.recommendedAction, 80)}`
      : "";

  return `${classification}${unsafeCount}${unsafeReason}${action}`;
}

function formatEventWorkflowStepSummary(eventData: Record<string, unknown> | undefined): string {
  if (!isRecord(eventData?.workflowStep)) return "";

  const step = eventData.workflowStep;
  const index = Number.isInteger(step.index) ? (step.index as number) : null;
  const totalSteps = Number.isInteger(step.totalSteps) ? (step.totalSteps as number) : null;
  const id = summarizeWorkflowText(step.id, 40);
  const status = summarizeWorkflowText(step.status, 24);
  const action = summarizeWorkflowText(step.action, 80);
  const stepLabel =
    index === null
      ? id
      : `${index + 1}${totalSteps === null ? "" : `/${totalSteps}`}${id ? `:${id}` : ""}`;

  return [
    stepLabel ? ` step=${stepLabel}` : "",
    status ? ` step_status=${status}` : "",
    action ? ` step_action=${action}` : "",
  ].join("");
}

function unsafeEventSearchParts(record: RunLedgerRecord): string[] {
  return summarizeRunRecovery(record).unsafeEvents.flatMap((event) => [
    event.id,
    event.reason,
    event.toolName ?? "",
    event.sideEffectClass ?? "",
    event.mutationClass ?? "",
    event.memoryRefreshRequirement ?? "",
    typeof event.replaySafe === "boolean" ? String(event.replaySafe) : "",
  ]);
}

function formatUnsafeReviewDetail(record: RunLedgerRecord, eventId: string): string {
  const detail = summarizeRunRecovery(record).unsafeEvents.find((event) => event.id === eventId);
  if (!detail) return "";
  const reason = summarizeWorkflowText(detail.reason, 100);
  const mutation = detail.mutationClass ? ` review_mutation=${detail.mutationClass}` : "";
  const sideEffect = detail.sideEffectClass ? ` review_side_effect=${detail.sideEffectClass}` : "";
  const replay = typeof detail.replaySafe === "boolean" ? ` review_replay_safe=${detail.replaySafe}` : "";
  const memory = detail.memoryRefreshRequirement
    ? ` review_memory_refresh=${detail.memoryRefreshRequirement}`
    : "";
  return `${reason ? ` review_reason=${reason}` : ""}${mutation}${sideEffect}${replay}${memory}`;
}

function formatUnsafeEventDetails(record: RunLedgerRecord): string {
  if (record.resume.unsafeEventIds.length === 0) return "";

  const eventsById = new Map(record.events.map((event) => [event.id, event]));
  const details = record.resume.unsafeEventIds.map((eventId) => {
    const review = formatUnsafeReviewDetail(record, eventId);
    const event = eventsById.get(eventId);
    if (!event) return `${eventId}${review}`;

    const tool = event.toolName ? ` tool=${event.toolName}` : "";
    const input = formatEventInputSummary(event.data?.input);
    const metadata = formatEventRegistryMetadata(event) || formatUnsafeEventMetadata(event.data);
    const skill = formatEventSkillSummary(event.data);
    const workflowStep = formatEventWorkflowStepSummary(event.data);
    return `${eventId}${review}${tool}${metadata}${input}${skill}${workflowStep}`;
  });
  return `\nUnsafe events: ${details.join("; ")}`;
}

function formatRunLedgerEventLine(event: RunLedgerEvent): string {
  const tool = event.toolName ? ` tool=${event.toolName}` : "";
  const input = formatEventInputSummary(event.data?.input);
  const metadata = formatEventRegistryMetadata(event) || formatUnsafeEventMetadata(event.data);
  const skill = formatEventSkillSummary(event.data);
  const workflowStep = formatEventWorkflowStepSummary(event.data);
  const resume = formatResumeRecoverySummary(event.data);
  return `- ${event.at} ${event.type}${tool}${metadata}${input}${skill}${workflowStep}${resume}: ${event.summary}`;
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

function formatRecommendedActionListPart(recovery: ReturnType<typeof summarizeRunRecovery>): string {
  const action = summarizeWorkflowText(recovery.recommendedAction, 100);
  return action ? ` next_action=${action}` : "";
}

function formatUnsafeReviewListPart(recovery: ReturnType<typeof summarizeRunRecovery>): string {
  const firstReason = recovery.unsafeEvents
    .map((event) => summarizeWorkflowText(event.reason, 80))
    .find((reason) => reason.length > 0);
  return firstReason ? ` unsafe_reason=${firstReason}` : "";
}

function formatSkillActivitySummary(record: RunLedgerRecord): string {
  const skillEvents = record.events.filter((event) =>
    event.type === "skill_routed" ||
    event.type === "skill_loaded" ||
    event.type === "skill_missing" ||
    event.type === "skill_used_without_load"
  );
  if (skillEvents.length === 0) return formatCompletionSkillSummary(record);

  const counts = new Map<string, number>();
  const sources = new Set<string>();
  const routed = new Set<string>();
  const loaded = new Set<string>();
  const missing = new Set<string>();
  const usedWithoutLoad = new Set<string>();
  const attemptedSources = new Set<string>();

  for (const event of skillEvents) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (Array.isArray(event.data?.attemptedSources)) {
      for (const source of event.data.attemptedSources) {
        if (typeof source === "string" && source.trim()) {
          attemptedSources.add(source.trim());
        }
      }
    }
    if (!isRecord(event.data?.skill)) continue;

    const skill = event.data.skill;
    if (typeof skill.source === "string" && skill.source.trim()) {
      sources.add(skill.source.trim());
    }
    if (typeof skill.name !== "string" || !skill.name.trim()) continue;

    const skillName = skill.name.trim();
    if (event.type === "skill_routed") {
      routed.add(skillName);
    } else if (event.type === "skill_loaded") {
      loaded.add(skillName);
    } else if (event.type === "skill_missing") {
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
  const attemptedSourcesPart =
    attemptedSources.size > 0
      ? ` attempted_sources=${[...attemptedSources].sort().join(",")}`
      : "";
  const routedPart = routed.size > 0 ? ` routed=${[...routed].sort().join(",")}` : "";
  const loadedPart = loaded.size > 0 ? ` loaded=${[...loaded].sort().join(",")}` : "";
  const missingPart = missing.size > 0 ? ` missing=${[...missing].sort().join(",")}` : "";
  const usedPart =
    usedWithoutLoad.size > 0
      ? ` used_without_load=${[...usedWithoutLoad].sort().join(",")}`
      : "";

  return `Skills: ${countParts.join(" ")}${sourcePart}${attemptedSourcesPart}${routedPart}${loadedPart}${missingPart}${usedPart}`;
}

function formatCompletionSkillSummary(record: RunLedgerRecord): string {
  const loaded = new Set<string>();
  const sources = new Set<string>();

  for (const event of record.events) {
    if (event.type !== "workflow_completed" || !isRecord(event.data)) continue;
    if (Array.isArray(event.data.loadedSkills)) {
      for (const skill of event.data.loadedSkills) {
        if (typeof skill === "string" && skill.trim()) loaded.add(skill.trim());
      }
    }
    if (!Array.isArray(event.data.skillMetadata)) continue;
    for (const skill of event.data.skillMetadata.filter(isRecord)) {
      if (typeof skill.name === "string" && skill.name.trim()) {
        loaded.add(skill.name.trim());
      }
      if (typeof skill.source === "string" && skill.source.trim()) {
        sources.add(skill.source.trim());
      }
    }
  }

  if (loaded.size === 0) return "";

  const sourcePart = sources.size > 0 ? ` sources=${[...sources].sort().join(",")}` : "";
  return `Skills: completion_loaded=${loaded.size}${sourcePart} loaded=${[...loaded].sort().join(",")}`;
}

function formatResumeAttemptSummary(recovery: ReturnType<typeof summarizeRunRecovery>): string {
  if (!recovery.latestResumeAttempt) return "";

  const reason = recovery.latestResumeAttempt.reason
    ? ` reason=${summarizeWorkflowText(recovery.latestResumeAttempt.reason, 80)}`
    : "";
  return `Resume attempts: latest=${recovery.latestResumeAttempt.at}${reason}`;
}

function formatResumeAttemptListPart(recovery: ReturnType<typeof summarizeRunRecovery>): string {
  if (!recovery.latestResumeAttempt) return "";

  const reason = recovery.latestResumeAttempt.reason
    ? ` resume_reason=${summarizeWorkflowText(recovery.latestResumeAttempt.reason, 70)}`
    : "";
  return ` resume_attempted=${recovery.latestResumeAttempt.at}${reason}`;
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
    ...formatRunSourceSummary(record.source),
    ...formatRunLocalSummary(record.local),
    `Recovery: ${recovery.classification} - ${recovery.reason}${unsafe}`,
    `Next action: ${recovery.recommendedAction}`,
    formatResumeAttemptSummary(recovery),
    formatSkillActivitySummary(record),
    formatCheckpointSummary(record),
    ...formatWorkflowStateSummary(record.workflow.state),
    ...formatStructuredCompletionSummary(record.structuredCompletion),
    ...formatCompletionPolicySummary(record),
    events ? `Recent events:\n${events}` : "Recent events: none",
  ]
    .filter(Boolean)
    .join("\n");
}

function latestCheckpointEvent(record: RunLedgerRecord): RunLedgerEvent | undefined {
  return record.events.findLast((event) => event.type === "checkpoint");
}

function latestWorkflowStartedEvent(record: RunLedgerRecord): RunLedgerEvent | undefined {
  return record.events.findLast((event) => event.type === "workflow_started");
}

function workflowStateSnapshot(
  event: RunLedgerEvent | undefined,
): { event: RunLedgerEvent; state: unknown } | undefined {
  if (!event || !isRecord(event.data) || !Object.hasOwn(event.data, "workflowState")) {
    return undefined;
  }
  return { event, state: event.data.workflowState };
}

function latestWorkflowStateSnapshot(
  record: RunLedgerRecord,
  checkpoint: RunLedgerEvent | undefined,
): { sourceLine: string; state: unknown } {
  const checkpointSnapshot = workflowStateSnapshot(checkpoint);
  if (checkpointSnapshot) {
    return {
      sourceLine: "Workflow state source: latest checkpoint snapshot",
      state: checkpointSnapshot.state,
    };
  }

  const latestSnapshot = record.events
    .slice()
    .reverse()
    .map(workflowStateSnapshot)
    .find((snapshot) => snapshot !== undefined);
  if (latestSnapshot) {
    return {
      sourceLine:
        latestSnapshot.event.type === "workflow_started"
          ? "Workflow state source: initial workflow_started snapshot"
          : `Workflow state source: latest ${latestSnapshot.event.type} snapshot`,
      state: latestSnapshot.state,
    };
  }

  return {
    sourceLine: "Workflow state source: run record",
    state: record.workflow.state,
  };
}

function checkpointReason(event: RunLedgerEvent | undefined): string {
  if (!event) return "";
  const reason = isRecord(event.data) && typeof event.data.reason === "string"
    ? event.data.reason.trim()
    : "";
  return reason || event.summary;
}

export function isReplaySafeResumeHistoryEvent(
  event: Pick<RunLedgerEvent, "replaySafe" | "type">,
): boolean {
  return event.type !== "resume_attempted" && event.replaySafe === true;
}

function formatReplayBoundaryContext(
  record: RunLedgerRecord,
  checkpoint: RunLedgerEvent | undefined,
  workflowStarted: RunLedgerEvent | undefined,
): string {
  const boundary = checkpoint ?? workflowStarted;
  const boundaryKind = checkpoint ? "checkpoint" : workflowStarted ? "workflow_started" : "";
  const boundaryIndex = boundary
    ? record.events.findIndex((event) => event.id === boundary.id)
    : -1;
  const boundaryLine = boundary
    ? `- Boundary: ${boundaryKind} ${boundary.id} at=${boundary.at}`
    : "- Boundary: none recorded; use the full ledger as history";
  const replayWindow = record.events
    .slice(boundaryIndex + 1)
    .filter((event) => event.id !== boundary?.id && event.type !== "resume_attempted");
  const replaySafeEvents = replayWindow
    .filter(isReplaySafeResumeHistoryEvent)
    .map((event) => {
      const tool = event.toolName ? ` tool=${event.toolName}` : "";
      const evidence = event.evidenceClass ? ` evidence=${event.evidenceClass}` : "";
      const mutation = event.mutationClass ? ` mutation=${event.mutationClass}` : "";
      const sideEffect = event.sideEffectClass ? ` side_effect=${event.sideEffectClass}` : "";
      const replay = typeof event.replaySafe === "boolean" ? ` replay_safe=${event.replaySafe}` : "";
      const memory = event.memoryRefreshRequirement
        ? ` memory_refresh=${event.memoryRefreshRequirement}`
        : "";
      const input = formatReplayEventInputSummary(event.data?.input);
      const workflowStep = formatEventWorkflowStepSummary(event.data);
      return `${event.id} ${event.type}${tool}${evidence}${mutation}${sideEffect}${replay}${memory}${input}${workflowStep}`;
    });
  const visibleEvents = replaySafeEvents.slice(-8);
  const omitted = replaySafeEvents.length - visibleEvents.length;
  const omittedUnproven = replayWindow.length - replaySafeEvents.length;
  const historyLine = visibleEvents.length > 0
    ? `- Replay-safe history after boundary: ${visibleEvents.join("; ")}${omitted > 0 ? `; ... ${omitted} older omitted` : ""}`
    : "- Replay-safe history after boundary: none recorded";
  const omittedLine =
    omittedUnproven > 0
      ? `- Events omitted from replay-safe history: ${omittedUnproven} not explicitly replay-safe`
      : "";

  return [
    "Replay boundary:",
    boundaryLine,
    historyLine,
    omittedLine,
    "- Treat boundary and replay-safe history as already observed; only continue from the next unproven action.",
  ].filter(Boolean).join("\n");
}

function formatResumeBoundarySourceLine(
  checkpoint: RunLedgerEvent | undefined,
  workflowStarted: RunLedgerEvent | undefined,
): string {
  if (checkpoint) {
    return `Resume boundary source: checkpoint ${checkpoint.id} at=${checkpoint.at}`;
  }
  if (workflowStarted) {
    return `Resume boundary source: workflow_started ${workflowStarted.id} at=${workflowStarted.at}`;
  }
  return "Resume boundary source: full ledger history";
}

function formatResumeContext(record: RunLedgerRecord): string {
  const checkpoint = latestCheckpointEvent(record);
  const workflowStarted = latestWorkflowStartedEvent(record);
  const checkpointLine = checkpoint
    ? `Latest checkpoint: ${checkpoint.id} at=${checkpoint.at} reason=${summarizeWorkflowText(checkpointReason(checkpoint), 140)}`
    : "Latest checkpoint: none recorded";
  const runContextLines = [
    `- Type: ${record.workflow.type}`,
    `- Input: ${summarizeRunInput(record.input)}`,
    ...formatRunSourceSummary(record.source).map((line) => `- ${line}`),
    ...formatRunLocalSummary(record.local).map((line) => `- ${line}`),
  ];
  const skillActivity = formatSkillActivitySummary(record);
  const skillContext = skillActivity
    ? ["Skill context:", `- ${skillActivity}`].join("\n")
    : "Skill context: none recorded";
  const workflowStateSnapshot = latestWorkflowStateSnapshot(record, checkpoint);
  const workflowState = formatWorkflowStateSummary(workflowStateSnapshot.state);
  return [
    "Safe resume context:",
    ["Run context:", ...runContextLines].join("\n"),
    skillContext,
    checkpointLine,
    formatResumeBoundarySourceLine(checkpoint, workflowStarted),
    formatReplayBoundaryContext(record, checkpoint, workflowStarted),
    workflowState.length > 0
      ? ["Workflow resume state:", `- ${workflowStateSnapshot.sourceLine}`, ...workflowState.map((line) => `- ${line}`)].join("\n")
      : "Workflow resume state: none recorded",
  ].join("\n");
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
    formatResumeContext(record),
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
      const visibleRuns = filter ? runs.filter(({ record }) => matchesRunListFilter(record, filter)) : runs;
      if (visibleRuns.length === 0) {
        const skippedLine = skipped > 0 ? ` Skipped unreadable run files: ${skipped}.` : "";
        const filterLine = filter ? ` matching "${filter}"` : "";
        params.notify(ctx, `Khala run ledger: no runs found${filterLine}.${skippedLine}`, "info");
        return;
      }

      const lines = visibleRuns.map(({ record }) => {
        const at = record.finishedAt ?? record.startedAt;
        const completion = formatStructuredCompletionListPart(record.structuredCompletion);
        const policy = formatCompletionPolicyListPart(record);
        const source = formatRunSourceListPart(record.source);
        const local = formatRunLocalListPart(record.local);
        const workflowState = formatWorkflowStateListPart(record.workflow.state);
        const checkpoints = formatCheckpointListPart(record);
        const recovery = summarizeRunRecovery(record);
        const resumeAttempt = formatResumeAttemptListPart(recovery);
        const nextAction = formatRecommendedActionListPart(recovery);
        const unsafeReason = formatUnsafeReviewListPart(recovery);
        const unsafe =
          record.resume.unsafeEventIds.length > 0
            ? ` unsafe=${record.resume.unsafeEventIds.length}`
            : "";
        const reviewReason =
          record.resume.classification === "needs_operator_review"
            ? ` review_reason=${summarizeWorkflowText(record.resume.reason, 80)}`
            : "";
        return `- ${record.id} ${record.status} ${record.workflow.type} at=${at}${source}${local} recovery=${record.resume.classification}${unsafe}${unsafeReason}${reviewReason}${completion}${policy}${workflowState}${resumeAttempt}${checkpoints} input=${summarizeRunInput(record.input)}${nextAction}`;
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
      if (record.status === "started") {
        const recovery = summarizeRunRecovery(record);
        params.notify(
          ctx,
          `Run ${record.id} is still active. ${recovery.recommendedAction} Use /run-show ${record.id} for context instead of queuing a resume.`,
          "error",
        );
        return;
      }
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
      const recovery = summarizeRunRecovery(record);
      const updatedRecord = await appendRunLedgerEvent({
        runFile,
        event: buildRunLedgerResumeAttemptEvent({
          runId: record.id,
          at: resumedAt,
          recovery,
        }),
      });

      const prompt = buildResumePrompt(updatedRecord, runFile);
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
        workflowState: loaded.record.workflow.state,
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
