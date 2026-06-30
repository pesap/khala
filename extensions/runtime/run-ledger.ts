import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LEARNING_STORE_DIRNAME } from "../lib/constants.ts";
import { formatErrorMessage, isRecord, readTextIfExists } from "../lib/io.ts";
import type { WorkflowFlags } from "../learning/store.ts";
import {
  getToolMetadata,
  isUnsafeForConservativeReplay,
  type MemoryRefreshRequirement,
  type ToolEvidenceClass,
  type ToolGateSatisfaction,
  type ToolMetadata,
  type ToolMutationClass,
  type ToolSideEffectClass,
} from "./tool-registry.ts";
import {
  isSkillSourceKind,
  normalizeAttemptedSkillSources,
  normalizeSkillName,
  normalizeSkillMetadata,
  type SkillRegistryEvent,
} from "./skill-registry.ts";

export type RunLedgerStatus =
  | "started"
  | "completed"
  | "interrupted"
  | "resumable"
  | "needs_operator_review";

export type RunLedgerEventType =
  | "workflow_started"
  | "workflow_completed"
  | "tool_call"
  | "mutation"
  | "checkpoint"
  | "interrupted"
  | "resume_attempted"
  | "skill_routed"
  | "skill_loaded"
  | "skill_missing"
  | "skill_used_without_load";

const RUN_LEDGER_EVENT_TYPES = new Set<string>([
  "workflow_started",
  "workflow_completed",
  "tool_call",
  "mutation",
  "checkpoint",
  "interrupted",
  "resume_attempted",
  "skill_routed",
  "skill_loaded",
  "skill_missing",
  "skill_used_without_load",
]);

const TOOL_EVIDENCE_CLASSES = new Set<string>([
  "memory",
  "local",
  "external",
  "forge",
  "none",
  "unknown",
]);

const TOOL_MUTATION_CLASSES = new Set<string>([
  "none",
  "filesystem",
  "shell",
  "forge",
  "memory",
  "unknown",
]);

const TOOL_SIDE_EFFECT_CLASSES = new Set<string>([
  "read_only",
  "mutation",
  "shell",
  "forge",
  "external",
  "tool_side_effect",
  "unknown",
]);

const MEMORY_REFRESH_REQUIREMENTS = new Set<string>([
  "exempt",
  "required_before_mutation",
  "not_required",
]);
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RUN_LEDGER_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

export type { ToolSideEffectClass } from "./tool-registry.ts";
export type { ToolEvidenceClass } from "./tool-registry.ts";

export interface RunLedgerEvent {
  id: string;
  at: string;
  type: RunLedgerEventType;
  summary: string;
  toolName?: string;
  evidenceClass?: ToolEvidenceClass;
  mutationClass?: ToolMutationClass;
  sideEffectClass?: ToolSideEffectClass;
  replaySafe?: boolean;
  memoryRefreshRequirement?: MemoryRefreshRequirement;
  gateSatisfaction?: ToolGateSatisfaction;
  data?: Record<string, unknown>;
}

const READ_ONLY_LEDGER_EVENT_METADATA = {
  evidenceClass: "local" as const,
  sideEffectClass: "read_only" as const,
  replaySafe: true,
};

export function buildRunLedgerToolCallEvent(params: {
  workflowId: string;
  workflowMutationCount: number;
  workflowToolCallCount?: number;
  toolName: string;
  at: string;
  mutation: boolean;
  metadata: ToolMetadata;
  input?: unknown;
  workflowStep?: unknown;
}): RunLedgerEvent {
  const sequence = params.workflowToolCallCount ?? params.workflowMutationCount;
  return {
    id: `${params.workflowId}:tool:${params.at}:${params.toolName}:${sequence}`,
    at: params.at,
    type: params.mutation ? "mutation" : "tool_call",
    summary: params.mutation ? `Mutation tool call: ${params.toolName}.` : `Tool call: ${params.toolName}.`,
    toolName: params.toolName,
    evidenceClass: params.metadata.evidenceClass,
    mutationClass: params.metadata.mutationClass,
    sideEffectClass: params.metadata.sideEffectClass,
    replaySafe: params.mutation ? false : params.metadata.replaySafe,
    memoryRefreshRequirement: params.metadata.memoryRefreshRequirement,
    gateSatisfaction: params.metadata.gateSatisfaction,
    data: {
      metadata: params.metadata,
      workflowMutationCount: params.workflowMutationCount,
      workflowToolCallCount: sequence,
      ...(params.input === undefined ? {} : { input: params.input }),
      ...(params.workflowStep === undefined ? {} : { workflowStep: params.workflowStep }),
    },
  };
}

export function buildRunLedgerToolCallEventFromRegistry(params: {
  workflowId: string;
  workflowMutationCount: number;
  workflowToolCallCount?: number;
  toolName: string;
  at: string;
  input?: unknown;
  workflowStep?: unknown;
}): RunLedgerEvent {
  const metadata = getToolMetadata({
    toolName: params.toolName,
    input: params.input,
  });
  return buildRunLedgerToolCallEvent({
    ...params,
    mutation: metadata.mutationClass !== "none",
    metadata,
  });
}

export function buildRunLedgerSkillEvent(params: {
  workflowId: string;
  event: SkillRegistryEvent;
  at: string;
}): RunLedgerEvent {
  const source = params.event.skill.source ? ` source=${params.event.skill.source}` : "";
  const path = params.event.skill.path ? ` path=${params.event.skill.path}` : "";
  const reason = params.event.reason ? ` reason=${params.event.reason}` : "";
  const attemptedSources =
    params.event.attemptedSources && params.event.attemptedSources.length > 0
      ? ` attempted_sources=${params.event.attemptedSources.join(",")}`
      : "";
  return {
    id: `${params.workflowId}:${params.event.type}:${params.event.skill.name}:${params.at}`,
    at: params.at,
    type: params.event.type,
    summary: `${params.event.type}: ${params.event.skill.name}${source}${path}${attemptedSources}.${reason}`,
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data: {
      skill: params.event.skill,
      reason: params.event.reason,
      ...(params.event.attemptedSources && params.event.attemptedSources.length > 0
        ? { attemptedSources: params.event.attemptedSources }
        : {}),
    },
  };
}

export function buildRunLedgerResumeAttemptEvent(params: {
  runId: string;
  at: string;
  recovery?: Pick<
    RunRecoverySummary,
    "classification" | "reason" | "recommendedAction" | "unsafeEventIds"
  > &
    Partial<Pick<RunRecoverySummary, "unsafeEvents">>;
}): RunLedgerEvent {
  return {
    id: `${params.runId}:resume_attempted:${params.at}`,
    at: params.at,
    type: "resume_attempted",
    summary: "Operator requested conservative run resume.",
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data: params.recovery
      ? {
          recovery: {
            classification: params.recovery.classification,
            reason: params.recovery.reason,
            recommendedAction: params.recovery.recommendedAction,
            unsafeEventIds: [...params.recovery.unsafeEventIds],
            ...(params.recovery.unsafeEvents && params.recovery.unsafeEvents.length > 0
              ? {
                  unsafeEvents: params.recovery.unsafeEvents.map((event) => ({
                    ...event,
                  })),
                }
              : {}),
          },
        }
      : undefined,
  };
}

export function buildRunLedgerWorkflowCompletedEvent(params: {
  workflowId: string;
  at: string;
  outcome: string;
  confidence: number;
  structuredCompletion: unknown;
  data?: Record<string, unknown>;
}): RunLedgerEvent {
  return {
    id: `${params.workflowId}:workflow_completed:${params.at}`,
    at: params.at,
    type: "workflow_completed",
    summary: `Workflow completed with outcome ${params.outcome}.`,
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data: {
      ...(params.data ?? {}),
      outcome: params.outcome,
      confidence: params.confidence,
      structuredCompletion: params.structuredCompletion,
    },
  };
}

export function buildRunLedgerWorkflowStartedEvent(params: {
  workflowId: string;
  workflowType: string;
  at: string;
  workflowState?: unknown;
}): RunLedgerEvent {
  return {
    id: `${params.workflowId}:workflow_started`,
    at: params.at,
    type: "workflow_started",
    summary: `Workflow ${params.workflowType} started.`,
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data:
      params.workflowState === undefined
        ? undefined
        : { workflowState: params.workflowState },
  };
}

export function buildRunLedgerInterruptedEvent(params: {
  eventId: string;
  at: string;
  reason: string;
  workflowState?: unknown;
}): RunLedgerEvent {
  return {
    id: params.eventId,
    at: params.at,
    type: "interrupted",
    summary: params.reason,
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data:
      params.workflowState === undefined
        ? undefined
        : { workflowState: params.workflowState },
  };
}

export function buildRunLedgerCheckpointEvent(params: {
  runId: string;
  at: string;
  reason?: string;
  workflowState?: unknown;
}): RunLedgerEvent {
  const reason = params.reason?.trim();
  const data = {
    ...(reason ? { reason } : {}),
    ...(params.workflowState === undefined ? {} : { workflowState: params.workflowState }),
  };
  return {
    id: `${params.runId}:checkpoint:${params.at}`,
    at: params.at,
    type: "checkpoint",
    summary: reason ? `Checkpoint recorded: ${reason}` : "Checkpoint recorded.",
    ...READ_ONLY_LEDGER_EVENT_METADATA,
    data: Object.keys(data).length > 0 ? data : undefined,
  };
}

export interface RunLedgerWorkflow {
  type: string;
  input: string;
  flags: WorkflowFlags;
  state?: unknown;
}

export interface RunLedgerSourceContext {
  issue?: string | number;
  pr?: string | number;
  url?: string;
}

export interface RunLedgerLocalContext {
  worktreePath?: string;
  capsulePath?: string;
  ledgerPath?: string;
}

export interface RunLedgerRecord {
  version: number;
  id: string;
  type: string;
  input: string;
  source?: RunLedgerSourceContext;
  local?: RunLedgerLocalContext;
  flags: WorkflowFlags;
  cwd?: string;
  repo?: string;
  status: RunLedgerStatus;
  startedAt: string;
  finishedAt?: string;
  workflow: RunLedgerWorkflow;
  structuredCompletion?: unknown;
  events: RunLedgerEvent[];
  resume: {
    classification: "not_interrupted" | "resumable" | "needs_operator_review";
    reason: string;
    unsafeEventIds: string[];
    unsafeEvents?: RunLedgerUnsafeEvent[];
  };
  [key: string]: unknown;
}

export interface RunLedgerUnsafeEvent {
  id: string;
  reason: string;
  toolName?: string;
  sideEffectClass?: ToolSideEffectClass;
  replaySafe?: boolean;
  mutationClass?: ToolMutationClass;
  memoryRefreshRequirement?: MemoryRefreshRequirement;
}

export interface ResumeClassification {
  classification: "not_interrupted" | "resumable" | "needs_operator_review";
  reason: string;
  unsafeEventIds: string[];
  unsafeEvents?: RunLedgerUnsafeEvent[];
}

function eventMetadata(event: RunLedgerEvent): Record<string, unknown> | null {
  const metadata = isRecord(event.data?.metadata) ? event.data.metadata : null;
  return metadata;
}

function eventInput(event: RunLedgerEvent): unknown {
  return event.data?.input;
}

function fallbackToolMetadata(toolName: string, input: unknown): ToolMetadata {
  return getToolMetadata({ toolName, input });
}

function parsedToolMetadata(
  toolName: string | undefined,
  data: Record<string, unknown> | undefined,
): ToolMetadata | undefined {
  return toolName ? fallbackToolMetadata(toolName, data?.input) : undefined;
}

function eventReplaySafe(event: RunLedgerEvent): boolean | undefined {
  if (typeof event.replaySafe === "boolean") return event.replaySafe;
  const metadata = eventMetadata(event);
  if (typeof metadata?.replaySafe === "boolean") return metadata.replaySafe;
  return event.toolName
    ? fallbackToolMetadata(event.toolName, eventInput(event)).replaySafe
    : undefined;
}

function eventSideEffectClass(event: RunLedgerEvent): ToolSideEffectClass | undefined {
  if (event.sideEffectClass) return event.sideEffectClass;
  const metadata = eventMetadata(event);
  if (typeof metadata?.sideEffectClass === "string") {
    return metadata.sideEffectClass as ToolSideEffectClass;
  }
  return event.toolName
    ? fallbackToolMetadata(event.toolName, eventInput(event)).sideEffectClass
    : undefined;
}

function eventMutationClass(event: RunLedgerEvent): ToolMutationClass | undefined {
  if (event.mutationClass) return event.mutationClass;
  const metadata = eventMetadata(event);
  if (typeof metadata?.mutationClass === "string") {
    return metadata.mutationClass as ToolMutationClass;
  }
  return event.toolName
    ? fallbackToolMetadata(event.toolName, eventInput(event)).mutationClass
    : undefined;
}

function eventMemoryRefreshRequirement(
  event: RunLedgerEvent,
): MemoryRefreshRequirement | undefined {
  if (event.memoryRefreshRequirement) return event.memoryRefreshRequirement;
  const metadata = eventMetadata(event);
  if (typeof metadata?.memoryRefreshRequirement === "string") {
    return metadata.memoryRefreshRequirement as MemoryRefreshRequirement;
  }
  return event.toolName
    ? fallbackToolMetadata(event.toolName, eventInput(event)).memoryRefreshRequirement
    : undefined;
}

function unsafeReplayReason(params: {
  replaySafe?: boolean;
  sideEffectClass?: ToolSideEffectClass;
}): string {
  const reasons = [];
  if (params.replaySafe !== true) {
    reasons.push("not explicitly replay-safe");
  }
  if (
    params.sideEffectClass &&
    params.sideEffectClass !== "read_only"
  ) {
    reasons.push(`${params.sideEffectClass} side effect`);
  }
  return reasons.length > 0
    ? reasons.join("; ")
    : "uncertain replay safety";
}

function unsafeEventDetail(event: RunLedgerEvent): RunLedgerUnsafeEvent {
  const replaySafe = eventReplaySafe(event);
  const sideEffectClass = eventSideEffectClass(event);
  const mutationClass = eventMutationClass(event);
  const memoryRefreshRequirement = eventMemoryRefreshRequirement(event);
  return {
    id: event.id,
    reason: unsafeReplayReason({ replaySafe, sideEffectClass }),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(sideEffectClass ? { sideEffectClass } : {}),
    ...(replaySafe === undefined ? {} : { replaySafe }),
    ...(mutationClass ? { mutationClass } : {}),
    ...(memoryRefreshRequirement ? { memoryRefreshRequirement } : {}),
  };
}

function eventUnsafeForConservativeReplay(event: RunLedgerEvent): boolean {
  const replaySafe = eventReplaySafe(event);
  const sideEffectClass = eventSideEffectClass(event);
  if (event.type === "mutation") {
    return replaySafe !== true || sideEffectClass !== "read_only";
  }
  return isUnsafeForConservativeReplay({
    replaySafe,
    sideEffectClass,
  });
}

function parseToolGateSatisfaction(value: unknown): ToolGateSatisfaction | undefined {
  if (!isRecord(value)) return undefined;
  return {
    countsTaskToolCall: value.countsTaskToolCall === true,
    agesMemory: value.agesMemory === true,
    satisfiesMemoryRead: value.satisfiesMemoryRead === true,
    persistsMemory: value.persistsMemory === true,
  };
}

export function getGlobalRunLedgerDir(): string {
  return path.join(homedir(), ".pi", LEARNING_STORE_DIRNAME, "runs");
}

function defaultResumeClassification(
  status: RunLedgerStatus,
  hasCheckpoint = false,
): ResumeClassification {
  if (status === "completed") {
    return {
      classification: "not_interrupted",
      reason: "Run completed.",
      unsafeEventIds: [],
    };
  }
  return {
    classification: "resumable",
    reason: hasCheckpoint
      ? "No uncertain side effects recorded after the latest checkpoint."
      : "No uncertain side effects recorded in the run ledger.",
    unsafeEventIds: [],
  };
}

export function classifyInterruptedRun(
  events: readonly RunLedgerEvent[],
): ResumeClassification {
  const latestCheckpointIndex = events.findLastIndex(
    (event) => event.type === "checkpoint",
  );
  const replayWindow =
    latestCheckpointIndex >= 0 ? events.slice(latestCheckpointIndex + 1) : events;
  const unsafeEvents = replayWindow.filter(eventUnsafeForConservativeReplay);

  if (unsafeEvents.length > 0) {
    const unsafeDetails = unsafeEvents.map(unsafeEventDetail);
    return {
      classification: "needs_operator_review",
      reason: latestCheckpointIndex >= 0
        ? "Run has uncertain mutation, shell, forge, external, or tool side effects after the latest checkpoint."
        : "Run has uncertain mutation, shell, forge, external, or tool side effects in the run ledger.",
      unsafeEventIds: unsafeDetails.map((event) => event.id),
      unsafeEvents: unsafeDetails,
    };
  }

  return defaultResumeClassification("interrupted", latestCheckpointIndex >= 0);
}

export function buildRunLedgerRecord(params: {
  version: number;
  id: string;
  type: string;
  input: string;
  flags: WorkflowFlags;
  cwd?: string;
  repo?: string;
  startedAt: string;
  workflowState?: unknown;
  source?: RunLedgerSourceContext;
  local?: RunLedgerLocalContext;
  events?: RunLedgerEvent[];
}): RunLedgerRecord {
  const events = params.events ?? [];
  const source = normalizeRunLedgerSource(params.source);
  const local = normalizeRunLedgerLocal(params.local);
  return {
    version: params.version,
    id: params.id,
    type: params.type,
    input: params.input,
    flags: params.flags,
    cwd: params.cwd,
    repo: params.repo,
    ...(source ? { source } : {}),
    ...(local ? { local } : {}),
    status: "started",
    startedAt: params.startedAt,
    workflow: {
      type: params.type,
      input: params.input,
      flags: params.flags,
      state: params.workflowState,
    },
    events,
    resume: defaultResumeClassification("started"),
  };
}

function firstRunContextScalar(...values: readonly unknown[]): string | number | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstRunContextString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeRunLedgerSource(value: unknown): RunLedgerSourceContext | undefined {
  if (!isRecord(value)) return undefined;
  const issueRecord = isRecord(value.issue) ? value.issue : undefined;
  const prRecord = isRecord(value.pr) ? value.pr : undefined;
  const pullRequestRecord = isRecord(value.pullRequest) ? value.pullRequest : undefined;
  const pullRequestSnakeRecord = isRecord(value.pull_request) ? value.pull_request : undefined;
  const issue = firstRunContextScalar(
    typeof value.issue === "object" ? undefined : value.issue,
    value.issueNumber,
    value.issue_number,
    value.sourceIssue,
    value.source_issue,
    issueRecord?.number,
    issueRecord?.id,
  );
  const pr = firstRunContextScalar(
    typeof value.pr === "object" ? undefined : value.pr,
    value.pullRequest,
    value.pull_request,
    value.sourcePr,
    value.source_pr,
    prRecord?.number,
    prRecord?.id,
    pullRequestRecord?.number,
    pullRequestRecord?.id,
    pullRequestSnakeRecord?.number,
    pullRequestSnakeRecord?.id,
  );
  const url = firstRunContextString(
    value.url,
    value.sourceUrl,
    value.source_url,
    issueRecord?.url,
    prRecord?.url,
    pullRequestRecord?.url,
    pullRequestSnakeRecord?.url,
  );
  const source = {
    ...(issue !== undefined ? { issue } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(url ? { url } : {}),
  };
  return Object.keys(source).length > 0 ? source : undefined;
}

function normalizeRunLedgerLocal(value: unknown): RunLedgerLocalContext | undefined {
  if (!isRecord(value)) return undefined;
  const worktreePath = firstRunContextString(value.worktreePath, value.worktree, value.worktree_path);
  const capsulePath = firstRunContextString(value.capsulePath, value.capsule, value.capsule_path);
  const ledgerPath = firstRunContextString(value.ledgerPath, value.ledger, value.ledger_path);
  const local = {
    ...(worktreePath ? { worktreePath } : {}),
    ...(capsulePath ? { capsulePath } : {}),
    ...(ledgerPath ? { ledgerPath } : {}),
  };
  return Object.keys(local).length > 0 ? local : undefined;
}

function parseRunLedgerRecord(raw: string, filePath: string): RunLedgerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid run ledger JSON in ${filePath}: ${formatErrorMessage(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid run ledger in ${filePath}: expected object.`);
  }
  const events = Array.isArray(parsed.events)
    ? parsed.events
        .map(parseRunLedgerEvent)
        .filter((event): event is RunLedgerEvent => Boolean(event))
    : [];
  const parsedWorkflow = isRecord(parsed.workflow)
    ? (parsed.workflow as unknown as RunLedgerWorkflow)
    : {
        type: typeof parsed.type === "string" ? parsed.type : "workflow",
        input: typeof parsed.input === "string" ? parsed.input : "",
        flags: isRecord(parsed.flags) ? (parsed.flags as WorkflowFlags) : {},
      };
  const workflow =
    Object.hasOwn(parsedWorkflow, "state") && parsedWorkflow.state !== undefined
      ? {
          ...parsedWorkflow,
          state: normalizeWorkflowStateSnapshot(parsedWorkflow.state),
        }
      : {
          ...parsedWorkflow,
          state: findLatestWorkflowStateEvent(events),
        };
  const structuredCompletion = normalizeStructuredCompletion(
    parsed.structuredCompletion ?? findLatestStructuredCompletionEvent(events),
  );
  const completedEventData = findLatestWorkflowCompletedEventData(events);
  const outcome =
    typeof parsed.outcome === "string"
      ? parsed.outcome.trim()
      : typeof structuredCompletion?.outcome === "string"
        ? structuredCompletion.outcome
      : typeof completedEventData?.outcome === "string"
        ? completedEventData.outcome.trim()
        : undefined;
  const confidence =
    typeof parsed.confidence === "number"
      ? parsed.confidence
      : typeof structuredCompletion?.confidence === "number"
        ? structuredCompletion.confidence
      : typeof completedEventData?.confidence === "number"
        ? completedEventData.confidence
        : undefined;
  const policy = completionPolicyFromParsedRecord(parsed, completedEventData);
  const parsedStatus = parseRunLedgerStatus(parsed.status);
  const parsedResume = parseRunLedgerResume(parsed.resume);
  const resume = parsedRunLedgerResumeClassification({
    status: parsedStatus,
    parsedResume,
    events,
  });
  const status = statusFromParsedResume(parsedStatus, resume);
  const source = normalizeRunLedgerSource(parsed.source);
  const local = normalizeRunLedgerLocal(parsed.local);
  const record: RunLedgerRecord = {
    ...(parsed as unknown as RunLedgerRecord),
    status,
    events,
    workflow,
    structuredCompletion,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(policy ? { policy } : {}),
    resume,
  };
  if (source) {
    record.source = source;
  } else {
    delete record.source;
  }
  if (local) {
    record.local = local;
  } else {
    delete record.local;
  }
  return record;
}

function parsedRunLedgerResumeClassification(params: {
  status: RunLedgerStatus;
  parsedResume: RunLedgerRecord["resume"] | null;
  events: readonly RunLedgerEvent[];
}): RunLedgerRecord["resume"] {
  if (params.status === "resumable" || params.status === "interrupted") {
    return classifyInterruptedRun(params.events);
  }
  return (
    params.parsedResume ??
    defaultParsedResumeClassification(params.status, params.events)
  );
}

function completionPolicyFromParsedRecord(
  parsed: Record<string, unknown>,
  completedEventData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const parsedPolicy = isRecord(parsed.policy) ? parsed.policy : {};
  const reason =
    firstPolicyString(
      parsedPolicy.strictViolationReason,
      parsed.strictViolationReason,
      completedEventData?.strictViolationReason,
      typeof parsed.strictViolation === "string" ? parsed.strictViolation : undefined,
    );
  const strictViolation =
    typeof parsedPolicy.strictViolation === "boolean"
      ? parsedPolicy.strictViolation
      : typeof parsed.strictViolation === "boolean"
        ? parsed.strictViolation
        : typeof completedEventData?.strictViolation === "boolean"
          ? completedEventData.strictViolation
          : reason
            ? true
            : undefined;
  const qualityScore =
    typeof parsedPolicy.qualityScore === "number"
      ? parsedPolicy.qualityScore
      : typeof parsed.qualityScore === "number"
        ? parsed.qualityScore
        : typeof completedEventData?.qualityScore === "number"
          ? completedEventData.qualityScore
          : undefined;
  const mutationCount =
    typeof parsedPolicy.mutationCount === "number"
      ? parsedPolicy.mutationCount
      : typeof parsed.mutationCount === "number"
        ? parsed.mutationCount
        : typeof completedEventData?.mutationCount === "number"
          ? completedEventData.mutationCount
          : undefined;
  const postflightMissing =
    typeof parsedPolicy.postflightMissing === "boolean"
      ? parsedPolicy.postflightMissing
      : typeof completedEventData?.postflightMissing === "boolean"
        ? completedEventData.postflightMissing
        : undefined;
  const warnings =
    stringPolicyArray(parsedPolicy.warnings).length > 0
      ? stringPolicyArray(parsedPolicy.warnings)
      : stringPolicyArray(parsed.policyWarnings).length > 0
        ? stringPolicyArray(parsed.policyWarnings)
        : stringPolicyArray(completedEventData?.policyWarnings);
  const policy = {
    ...parsedPolicy,
    ...(strictViolation !== undefined ? { strictViolation } : {}),
    ...(reason ? { strictViolationReason: reason } : {}),
    ...(qualityScore !== undefined ? { qualityScore } : {}),
    ...(mutationCount !== undefined ? { mutationCount } : {}),
    ...(postflightMissing !== undefined ? { postflightMissing } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function firstPolicyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function stringPolicyArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeStructuredCompletion(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const {
    outcome: rawOutcome,
    confidence: rawConfidence,
    validation: rawValidation,
    openQuestions: rawOpenQuestions,
    learningCandidates: rawLearningCandidates,
    ...rest
  } = value;
  const outcome = firstPolicyString(rawOutcome);
  const confidence = structuredCompletionConfidence(rawConfidence);
  const validation = structuredCompletionStringList(rawValidation);
  const openQuestions = structuredCompletionStringList(rawOpenQuestions);
  const learningCandidates = structuredCompletionStringList(rawLearningCandidates);
  const completion = {
    ...rest,
    ...(outcome ? { outcome } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(openQuestions !== undefined ? { openQuestions } : {}),
    ...(learningCandidates !== undefined ? { learningCandidates } : {}),
  };
  return Object.keys(completion).length > 0 ? completion : undefined;
}

function structuredCompletionConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const percent = trimmed.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (percent) {
    const parsed = Number(percent[1]);
    return Number.isFinite(parsed) ? parsed / 100 : undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function structuredCompletionStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return uniqueTrimmedStrings(value);
  if (typeof value !== "string") return undefined;
  return uniqueTrimmedStrings(value.split("\n").map(stripListMarker));
}

function uniqueTrimmedStrings(value: readonly unknown[]): string[] {
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function stripListMarker(value: string): string {
  return value.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
}

function parseRunLedgerStatus(value: unknown): RunLedgerStatus {
  return value === "completed" ||
    value === "interrupted" ||
    value === "resumable" ||
    value === "needs_operator_review"
    ? value
    : "started";
}

function parseRunLedgerEventType(value: unknown): RunLedgerEventType | null {
  return typeof value === "string" && RUN_LEDGER_EVENT_TYPES.has(value)
    ? (value as RunLedgerEventType)
    : null;
}

function parseToolEvidenceClass(value: unknown): ToolEvidenceClass | undefined {
  return typeof value === "string" && TOOL_EVIDENCE_CLASSES.has(value)
    ? (value as ToolEvidenceClass)
    : undefined;
}

function parseToolMutationClass(value: unknown): ToolMutationClass | undefined {
  return typeof value === "string" && TOOL_MUTATION_CLASSES.has(value)
    ? (value as ToolMutationClass)
    : undefined;
}

function parseToolSideEffectClass(value: unknown): ToolSideEffectClass | undefined {
  return typeof value === "string" && TOOL_SIDE_EFFECT_CLASSES.has(value)
    ? (value as ToolSideEffectClass)
    : undefined;
}

function parseMemoryRefreshRequirement(value: unknown): MemoryRefreshRequirement | undefined {
  return typeof value === "string" && MEMORY_REFRESH_REQUIREMENTS.has(value)
    ? (value as MemoryRefreshRequirement)
    : undefined;
}

function parseRunLedgerResume(value: unknown): RunLedgerRecord["resume"] | null {
  if (!isRecord(value)) return null;
  if (
    value.classification !== "not_interrupted" &&
    value.classification !== "resumable" &&
    value.classification !== "needs_operator_review"
  ) {
    return null;
  }
  if (typeof value.reason !== "string") return null;
  if (!Array.isArray(value.unsafeEventIds)) return null;
  const unsafeEvents = parseRunLedgerUnsafeEvents(value.unsafeEvents);
  return {
    classification: value.classification,
    reason: value.reason,
    unsafeEventIds: value.unsafeEventIds.filter(
      (eventId): eventId is string => typeof eventId === "string",
    ),
    ...(unsafeEvents.length > 0 ? { unsafeEvents } : {}),
  };
}

function parseRunLedgerUnsafeEvents(value: unknown): RunLedgerUnsafeEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RunLedgerUnsafeEvent[] => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      return [];
    }
    const sideEffectClass = parseToolSideEffectClass(item.sideEffectClass);
    const mutationClass = parseToolMutationClass(item.mutationClass);
    const memoryRefreshRequirement = parseMemoryRefreshRequirement(
      item.memoryRefreshRequirement,
    );
    return [
      {
        id: item.id.trim(),
        reason:
          typeof item.reason === "string" && item.reason.trim()
            ? item.reason.trim()
            : "uncertain replay safety",
        ...(typeof item.toolName === "string" && item.toolName.trim()
          ? { toolName: item.toolName.trim() }
          : {}),
        ...(sideEffectClass ? { sideEffectClass } : {}),
        ...(typeof item.replaySafe === "boolean" ? { replaySafe: item.replaySafe } : {}),
        ...(mutationClass ? { mutationClass } : {}),
        ...(memoryRefreshRequirement ? { memoryRefreshRequirement } : {}),
      },
    ];
  });
}

function defaultParsedResumeClassification(
  status: RunLedgerStatus,
  events: readonly RunLedgerEvent[],
): RunLedgerRecord["resume"] {
  if (status === "completed" || status === "started") {
    return defaultResumeClassification(status);
  }
  if (status === "needs_operator_review") {
    const classified = classifyInterruptedRun(events);
    return classified.classification === "needs_operator_review"
      ? classified
      : {
          classification: "needs_operator_review",
          reason: "Run was previously marked as needing operator review.",
          unsafeEventIds: classified.unsafeEventIds,
        };
  }
  return classifyInterruptedRun(events);
}

function statusFromParsedResume(
  status: RunLedgerStatus,
  resume: RunLedgerRecord["resume"],
): RunLedgerStatus {
  if (status === "completed" || status === "started") return status;
  return resume.classification === "needs_operator_review"
    ? "needs_operator_review"
    : "resumable";
}

function parseRunLedgerEvent(value: unknown): RunLedgerEvent | null {
  if (!isRecord(value)) return null;
  const type = parseRunLedgerEventType(value.type);
  if (
    typeof value.id !== "string" ||
    typeof value.at !== "string" ||
    !type ||
    typeof value.summary !== "string"
  ) {
    return null;
  }
  const id = value.id.trim();
  const at = value.at.trim();
  const summary = value.summary.trim();
  if (!id || !at || !summary) return null;
  const data = parseRunLedgerEventData(value.data);
  const metadata = isRecord(data?.metadata) ? data.metadata : undefined;
  const toolName =
    typeof value.toolName === "string" && value.toolName.trim()
      ? value.toolName.trim()
      : typeof data?.toolName === "string" && data.toolName.trim()
        ? data.toolName.trim()
        : typeof metadata?.name === "string" && metadata.name.trim()
          ? metadata.name.trim()
          : undefined;
  const toolMetadata = parsedToolMetadata(toolName, data);
  const eventData =
    toolMetadata ? { ...(data ?? {}), metadata: toolMetadata } : data;
  const gateSatisfaction =
    toolMetadata?.gateSatisfaction ??
    parseToolGateSatisfaction(value.gateSatisfaction) ??
    parseToolGateSatisfaction(metadata?.gateSatisfaction);
  return {
    id,
    at,
    type,
    summary,
    toolName,
    evidenceClass:
      toolMetadata?.evidenceClass ??
      parseToolEvidenceClass(value.evidenceClass) ??
      parseToolEvidenceClass(metadata?.evidenceClass),
    mutationClass:
      toolMetadata?.mutationClass ??
      parseToolMutationClass(value.mutationClass) ??
      parseToolMutationClass(metadata?.mutationClass),
    sideEffectClass:
      toolMetadata?.sideEffectClass ??
      parseToolSideEffectClass(value.sideEffectClass) ??
      parseToolSideEffectClass(metadata?.sideEffectClass),
    replaySafe:
      toolMetadata?.replaySafe ??
      (typeof value.replaySafe === "boolean"
        ? value.replaySafe
        : typeof metadata?.replaySafe === "boolean"
          ? metadata.replaySafe
          : undefined),
    memoryRefreshRequirement:
      toolMetadata?.memoryRefreshRequirement ??
      parseMemoryRefreshRequirement(value.memoryRefreshRequirement) ??
      parseMemoryRefreshRequirement(metadata?.memoryRefreshRequirement),
    ...(gateSatisfaction ? { gateSatisfaction } : {}),
    data: eventData,
  };
}

function normalizeRunLedgerEvent(event: RunLedgerEvent): RunLedgerEvent {
  return parseRunLedgerEvent(event) ?? event;
}

function parseRunLedgerEventData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const {
    skill: rawSkill,
    attemptedSources: rawAttemptedSources,
    loadedSkills: rawLoadedSkills,
    skillMetadata: rawSkillMetadata,
    structuredCompletion: rawStructuredCompletion,
    workflowStep: rawWorkflowStep,
    workflowState: rawWorkflowState,
    reason: rawReason,
    ...rest
  } = value;

  const skill = isRecord(rawSkill)
    ? {
        ...rawSkill,
        ...normalizeSkillMetadata({
          name: typeof rawSkill.name === "string" ? rawSkill.name : "",
          source: isSkillSourceKind(rawSkill.source) ? rawSkill.source : "unknown",
          path: typeof rawSkill.path === "string" ? rawSkill.path : undefined,
        }),
      }
    : undefined;
  const attemptedSources = normalizeAttemptedSkillSources(rawAttemptedSources);
  const loadedSkills = parseSkillNameArray(rawLoadedSkills);
  const skillMetadata = parseSkillMetadataArray(rawSkillMetadata);
  const structuredCompletion = normalizeStructuredCompletion(rawStructuredCompletion);
  const workflowStep = normalizeWorkflowStepSnapshot(rawWorkflowStep);
  const workflowState = normalizeWorkflowStateSnapshot(rawWorkflowState);
  const reason = typeof rawReason === "string" && rawReason.trim()
    ? rawReason.trim()
    : undefined;
  return {
    ...rest,
    ...(reason ? { reason } : {}),
    ...(skill ? { skill } : {}),
    ...(loadedSkills.length > 0 ? { loadedSkills } : {}),
    ...(skillMetadata.length > 0 ? { skillMetadata } : {}),
    ...(attemptedSources.length > 0 ? { attemptedSources } : {}),
    ...(structuredCompletion ? { structuredCompletion } : {}),
    ...(workflowStep ? { workflowStep } : {}),
    ...(workflowState ? { workflowState } : {}),
  };
}

function scalarWorkflowStateText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeWorkflowStateStep(
  value: unknown,
  index: number,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    const action = scalarWorkflowStateText(value);
    if (!action) return null;
    return {
      index,
      id: `step-${index + 1}`,
      action,
      status: "pending",
    };
  }

  const id = scalarWorkflowStateText(value.id) ?? `step-${index + 1}`;
  const action = scalarWorkflowStateText(value.action) ?? id;
  const status = scalarWorkflowStateText(value.status);
  return {
    index,
    id,
    action,
    status:
      status === "active" ||
      status === "completed" ||
      status === "skipped" ||
      status === "pending"
        ? status
        : "pending",
  };
}

function normalizeWorkflowStateCurrentStepIndex(
  value: Record<string, unknown>,
  steps: readonly Record<string, unknown>[],
): number | null {
  if (steps.length === 0) return null;
  if (Object.hasOwn(value, "currentStepIndex") && value.currentStepIndex === null) {
    return null;
  }
  if (
    Number.isInteger(value.currentStepIndex) &&
    (value.currentStepIndex as number) >= 0 &&
    (value.currentStepIndex as number) < steps.length
  ) {
    return value.currentStepIndex as number;
  }

  const currentStepId = scalarWorkflowStateText(value.currentStepId ?? value.currentStep);
  if (currentStepId) {
    const index = steps.findIndex((step) => step.id === currentStepId);
    if (index >= 0) return index;
  }

  const activeIndex = steps.findIndex((step) => step.status === "active");
  if (activeIndex >= 0) return activeIndex;
  const pendingIndex = steps.findIndex((step) => step.status === "pending");
  return pendingIndex >= 0 ? pendingIndex : null;
}

function normalizeWorkflowStateSteps(
  steps: readonly Record<string, unknown>[],
  currentStepIndex: number | null,
): Record<string, unknown>[] {
  if (currentStepIndex === null) return [...steps];
  return steps.map((step, index) => {
    if (currentStepIndex === index) return { ...step, status: "active" };
    if (step.status === "active") return { ...step, status: "pending" };
    return step;
  });
}

function normalizeWorkflowStateSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const name = scalarWorkflowStateText(value.name);
  const objective = scalarWorkflowStateText(value.objective);
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map(normalizeWorkflowStateStep)
        .filter((step): step is Record<string, unknown> => Boolean(step))
    : [];
  const currentStepIndex = normalizeWorkflowStateCurrentStepIndex(value, steps);
  const state = {
    ...(name !== null ? { name } : {}),
    ...(objective !== null ? { objective } : {}),
    currentStepIndex,
    steps: normalizeWorkflowStateSteps(steps, currentStepIndex),
  };
  return state.steps.length > 0 || name !== null || objective !== null
    ? state
    : undefined;
}

function normalizeWorkflowStepSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const index = Number.isInteger(value.index) ? value.index : undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const action = typeof value.action === "string" ? value.action.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const totalSteps = Number.isInteger(value.totalSteps) ? value.totalSteps : undefined;
  if (index === undefined && !id && !action && !status && totalSteps === undefined) {
    return undefined;
  }
  return {
    ...(index === undefined ? {} : { index }),
    ...(id ? { id } : {}),
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(totalSteps === undefined ? {} : { totalSteps }),
  };
}

function parseSkillNameArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((skill) => {
    return typeof skill === "string" ? normalizeSkillName(skill) : "";
  }))].filter((skill) => skill.length > 0);
}

function parseSkillMetadataArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((skill) => ({
      ...skill,
      ...normalizeSkillMetadata({
        name: typeof skill.name === "string" ? skill.name : "",
        source: isSkillSourceKind(skill.source) ? skill.source : "unknown",
        path: typeof skill.path === "string" ? skill.path : undefined,
      }),
    }))
    .filter((skill) => typeof skill.name === "string" && skill.name.length > 0);
}

export async function readRunLedger(
  runFile: string,
): Promise<RunLedgerRecord | null> {
  const raw = await readTextIfExists(runFile);
  if (!raw.trim()) return null;
  return parseRunLedgerRecord(raw, runFile);
}

export function resolveRunLedgerFile(
  runIdOrPath: string,
  runLedgerDir = getGlobalRunLedgerDir(),
): string {
  const trimmed = runIdOrPath.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(trimmed);
  }
  return path.join(runLedgerDir, `${trimmed.replace(/\.json$/, "")}.json`);
}

export async function writeRunLedger(
  runFile: string,
  record: RunLedgerRecord,
): Promise<void> {
  const runDir = path.dirname(runFile);
  await fs.mkdir(runDir, { recursive: true });
  const persistedRecord = normalizeRunLedgerRecordForWrite(record);
  const tempFile = path.join(
    runDir,
    `.${path.basename(runFile)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(persistedRecord, null, 2)}\n`, "utf8");
    await renameWithTransientRetry(tempFile, runFile);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithTransientRetry(
  source: string,
  target: string,
): Promise<void> {
  for (const retryDelayMs of [
    ...RUN_LEDGER_RENAME_RETRY_DELAYS_MS,
    undefined,
  ]) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string"
        ? error.code
        : undefined;
      if (!code || !TRANSIENT_RENAME_ERROR_CODES.has(code) || retryDelayMs === undefined) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }
}

function normalizeRunLedgerRecordForWrite(record: RunLedgerRecord): RunLedgerRecord {
  const source = normalizeRunLedgerSource(record.source);
  const local = normalizeRunLedgerLocal(record.local);
  const parsedStatus = parseRunLedgerStatus(record.status);
  const events = record.events.map(normalizeRunLedgerEvent);
  const completedEventData = findLatestWorkflowCompletedEventData(events);
  const structuredCompletion = normalizeStructuredCompletion(
    record.structuredCompletion ?? findLatestStructuredCompletionEvent(events),
  );
  const outcome =
    typeof record.outcome === "string" && record.outcome.trim()
      ? record.outcome.trim()
      : typeof structuredCompletion?.outcome === "string"
        ? structuredCompletion.outcome
        : typeof completedEventData?.outcome === "string" && completedEventData.outcome.trim()
          ? completedEventData.outcome.trim()
          : undefined;
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : typeof structuredCompletion?.confidence === "number"
        ? structuredCompletion.confidence
        : typeof completedEventData?.confidence === "number" &&
            Number.isFinite(completedEventData.confidence)
          ? completedEventData.confidence
          : undefined;
  const resume = parsedRunLedgerResumeClassification({
    status: parsedStatus,
    parsedResume: parseRunLedgerResume(record.resume),
    events,
  });
  const status = statusFromParsedResume(parsedStatus, resume);
  const normalized: RunLedgerRecord = {
    ...record,
    status,
    events,
    resume,
    workflow: {
      ...record.workflow,
      ...(Object.hasOwn(record.workflow, "state")
        ? { state: normalizeWorkflowStateSnapshot(record.workflow.state) }
        : {}),
    },
  };
  if (structuredCompletion) {
    normalized.structuredCompletion = structuredCompletion;
  } else {
    delete normalized.structuredCompletion;
  }
  if (outcome !== undefined) {
    normalized.outcome = outcome;
  } else {
    delete normalized.outcome;
  }
  if (confidence !== undefined) {
    normalized.confidence = confidence;
  } else {
    delete normalized.confidence;
  }
  if (source) {
    normalized.source = source;
  } else {
    delete normalized.source;
  }
  if (local) {
    normalized.local = local;
  } else {
    delete normalized.local;
  }
  return normalized;
}

export async function appendRunLedgerEvent(params: {
  runFile: string;
  event: RunLedgerEvent;
}): Promise<RunLedgerRecord> {
  const existing = await readRunLedger(params.runFile);
  if (!existing) {
    throw new Error(`Cannot append run ledger event; missing ${params.runFile}.`);
  }
  const event = normalizeRunLedgerEvent(params.event);
  const events = [...existing.events, event];
  const resume =
    existing.status === "completed"
      ? existing.resume
      : classifyInterruptedRun(events);
  const status =
    existing.status === "started" || existing.status === "completed"
      ? existing.status
      : resume.classification === "resumable"
        ? "resumable"
        : "needs_operator_review";
  const nextWorkflow =
    eventCarriesWorkflowState(event)
      ? {
          ...existing.workflow,
          state: event.data.workflowState,
        }
      : existing.workflow;
  const record: RunLedgerRecord = {
    ...existing,
    status,
    workflow: nextWorkflow,
    resume,
    events,
  };
  await writeRunLedger(params.runFile, record);
  return record;
}

function findLatestStructuredCompletionEvent(events: RunLedgerEvent[]): unknown {
  for (const event of events.slice().reverse()) {
    if (event.type !== "workflow_completed" || !isRecord(event.data)) continue;
    if (event.data.structuredCompletion !== null && event.data.structuredCompletion !== undefined) {
      return event.data.structuredCompletion;
    }
  }
  return undefined;
}

function findLatestWorkflowCompletedEventData(
  events: RunLedgerEvent[],
): Record<string, unknown> | undefined {
  for (const event of events.slice().reverse()) {
    if (event.type === "workflow_completed" && isRecord(event.data)) {
      return event.data;
    }
  }
  return undefined;
}

function findLatestWorkflowStateEvent(events: RunLedgerEvent[]): unknown {
  for (const event of events.slice().reverse()) {
    if (eventCarriesWorkflowState(event)) {
      return event.data.workflowState;
    }
  }
  return undefined;
}

function eventCarriesWorkflowState(
  event: RunLedgerEvent,
): event is RunLedgerEvent & { data: { workflowState: unknown } } {
  return (
    (event.type === "workflow_started" ||
      event.type === "checkpoint" ||
      event.type === "interrupted" ||
      event.type === "workflow_completed") &&
    isRecord(event.data) &&
    Object.hasOwn(event.data, "workflowState")
  );
}

export async function completeRunLedger(params: {
  runFile: string;
  finishedAt: string;
  outcome: string;
  confidence: number;
  event: RunLedgerEvent;
  patch: Record<string, unknown>;
}): Promise<RunLedgerRecord> {
  const existing = await readRunLedger(params.runFile);
  if (!existing) {
    throw new Error(`Cannot complete run ledger; missing ${params.runFile}.`);
  }
  const event = normalizeRunLedgerEvent(params.event);
  const structuredCompletion =
    params.patch.structuredCompletion ??
    event.data?.structuredCompletion ??
    findLatestStructuredCompletionEvent(existing.events) ??
    existing.structuredCompletion;
  const patchedWorkflow = isRecord(params.patch.workflow)
    ? (params.patch.workflow as unknown as RunLedgerWorkflow)
    : undefined;
  const workflow =
    patchedWorkflow && Object.hasOwn(patchedWorkflow, "state")
      ? patchedWorkflow
      : {
            ...existing.workflow,
          ...(patchedWorkflow ?? {}),
          state:
            patchedWorkflow?.state ??
            event.data?.workflowState ??
            findLatestWorkflowStateEvent(existing.events) ??
            existing.workflow.state,
        };
  const mergedRecord = {
    ...existing,
    ...params.patch,
  };
  const policy = completionPolicyFromParsedRecord(
    mergedRecord,
    isRecord(event.data) ? event.data : undefined,
  );
  const record: RunLedgerRecord = {
    ...mergedRecord,
    workflow,
    status: "completed",
    finishedAt: params.finishedAt,
    outcome: params.outcome,
    confidence: params.confidence,
    structuredCompletion: normalizeStructuredCompletion(structuredCompletion),
    ...(policy ? { policy } : {}),
    events: [...existing.events, event],
    resume: defaultResumeClassification("completed"),
  };
  await writeRunLedger(params.runFile, record);
  return record;
}

export async function markRunInterrupted(params: {
  runFile: string;
  at: string;
  eventId: string;
  reason: string;
  workflowState?: unknown;
}): Promise<RunLedgerRecord> {
  const existing = await readRunLedger(params.runFile);
  if (!existing) {
    throw new Error(`Cannot interrupt run ledger; missing ${params.runFile}.`);
  }
  const interruptedEvent = buildRunLedgerInterruptedEvent({
    eventId: params.eventId,
    at: params.at,
    reason: params.reason,
    workflowState: params.workflowState,
  });
  const event = normalizeRunLedgerEvent(interruptedEvent);
  const events = [...existing.events, event];
  const resume = classifyInterruptedRun(events);
  const status =
    resume.classification === "resumable"
      ? "resumable"
      : "needs_operator_review";
  const record: RunLedgerRecord = {
    ...existing,
    status,
    events,
    workflow:
      params.workflowState === undefined
        ? existing.workflow
        : {
            ...existing.workflow,
            state: params.workflowState,
          },
    resume,
  };
  await writeRunLedger(params.runFile, record);
  return record;
}
export interface RunRecoverySummary {
  classification: RunLedgerRecord["resume"]["classification"];
  reason: string;
  recommendedAction: string;
  latestCheckpoint?: {
    id: string;
    at: string;
    reason?: string;
  };
  latestCompletion?: {
    id: string;
    at: string;
    outcome?: string;
  };
  latestResumeAttempt?: {
    id: string;
    at: string;
    reason?: string;
  };
  unsafeEventIds: string[];
  unsafeEvents: RunLedgerUnsafeEvent[];
}

function findLastRunEvent(
  record: RunLedgerRecord,
  type: RunLedgerEvent["type"],
): RunLedgerEvent | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event?.type === type) {
      return event;
    }
  }
  return undefined;
}

function eventStringData(
  event: RunLedgerEvent | undefined,
  key: string,
): string | undefined {
  if (!event || !isRecord(event.data)) {
    return undefined;
  }
  const value = event.data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function checkpointReason(event: RunLedgerEvent | undefined): string | undefined {
  const structuredReason = eventStringData(event, "reason");
  if (structuredReason) return structuredReason;
  if (!event?.summary.startsWith("Checkpoint recorded:")) return undefined;
  const summaryReason = event.summary.slice("Checkpoint recorded:".length).trim();
  return summaryReason || undefined;
}

function resumeAttemptReason(event: RunLedgerEvent | undefined): string | undefined {
  const directReason = eventStringData(event, "reason");
  if (directReason) return directReason;
  if (!event || !isRecord(event.data) || !isRecord(event.data.recovery)) {
    return undefined;
  }
  const reason = event.data.recovery.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

function normalizeRunLedgerResume(record: RunLedgerRecord): RunLedgerRecord["resume"] {
  return (
    parseRunLedgerResume(record.resume) ??
    defaultParsedResumeClassification(record.status, record.events)
  );
}

function summarizeUnsafeEvents(
  resume: RunLedgerRecord["resume"],
  events: readonly RunLedgerEvent[],
): RunLedgerUnsafeEvent[] {
  if (resume.unsafeEvents && resume.unsafeEvents.length > 0) {
    return [...resume.unsafeEvents];
  }
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return resume.unsafeEventIds.map((id) => {
    const event = eventsById.get(id);
    return event
      ? unsafeEventDetail(event)
      : {
          id,
          reason: "unsafe event requires operator review",
        };
  });
}

export function summarizeRunRecovery(
  record: RunLedgerRecord,
): RunRecoverySummary {
  const latestCheckpoint = findLastRunEvent(record, "checkpoint");
  const latestCompletion = findLastRunEvent(record, "workflow_completed");
  const latestResumeAttempt = findLastRunEvent(record, "resume_attempted");
  const resume = normalizeRunLedgerResume(record);

  let recommendedAction: string;
  if (record.status === "completed") {
    recommendedAction =
      "Inspect structured completion and validation before starting follow-up work.";
  } else if (record.status === "started") {
    recommendedAction =
      "Continue the active run and record a checkpoint before risky side effects.";
  } else if (resume.classification === "needs_operator_review") {
    recommendedAction =
      "Review unsafe events before resuming; do not repeat uncertain side effects.";
  } else if (resume.classification === "resumable") {
    recommendedAction = latestCheckpoint
      ? "Resume from the latest safe checkpoint and skip already recorded side effects."
      : "Resume from the recorded workflow state and skip already recorded replay-safe events.";
  } else {
    recommendedAction =
      "Continue the active run and record a checkpoint before risky side effects.";
  }

  return {
    classification: resume.classification,
    reason: resume.reason,
    recommendedAction,
    latestCheckpoint: latestCheckpoint
      ? {
          id: latestCheckpoint.id,
          at: latestCheckpoint.at,
          reason: checkpointReason(latestCheckpoint),
        }
      : undefined,
    latestCompletion: latestCompletion
      ? {
          id: latestCompletion.id,
          at: latestCompletion.at,
          outcome: eventStringData(latestCompletion, "outcome"),
        }
      : undefined,
    latestResumeAttempt: latestResumeAttempt
      ? {
          id: latestResumeAttempt.id,
          at: latestResumeAttempt.at,
          reason: resumeAttemptReason(latestResumeAttempt),
        }
      : undefined,
    unsafeEventIds: [...resume.unsafeEventIds],
    unsafeEvents: summarizeUnsafeEvents(resume, record.events),
  };
}
