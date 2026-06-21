import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LEARNING_STORE_DIRNAME } from "../lib/constants.ts";
import { formatErrorMessage, isRecord, readTextIfExists } from "../lib/io.ts";
import type { WorkflowFlags } from "../learning/store.ts";
import type { ToolMetadata, ToolSideEffectClass } from "./tool-registry.ts";
import type { SkillRegistryEvent } from "./skill-registry.ts";

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

export type { ToolSideEffectClass } from "./tool-registry.ts";

export interface RunLedgerEvent {
  id: string;
  at: string;
  type: RunLedgerEventType;
  summary: string;
  toolName?: string;
  sideEffectClass?: ToolSideEffectClass;
  replaySafe?: boolean;
  data?: Record<string, unknown>;
}

export function buildRunLedgerToolCallEvent(params: {
  workflowId: string;
  workflowMutationCount: number;
  toolName: string;
  at: string;
  mutation: boolean;
  metadata: ToolMetadata;
  input?: unknown;
}): RunLedgerEvent {
  return {
    id: `${params.workflowId}:tool:${params.at}:${params.toolName}:${params.workflowMutationCount}`,
    at: params.at,
    type: params.mutation ? "mutation" : "tool_call",
    summary: params.mutation ? `Mutation tool call: ${params.toolName}.` : `Tool call: ${params.toolName}.`,
    toolName: params.toolName,
    sideEffectClass: params.metadata.sideEffectClass,
    replaySafe: params.mutation ? false : params.metadata.replaySafe,
    data: {
      metadata: params.metadata,
      ...(params.input === undefined ? {} : { input: params.input }),
    },
  };
}

export function buildRunLedgerSkillEvent(params: {
  workflowId: string;
  event: SkillRegistryEvent;
  at: string;
}): RunLedgerEvent {
  const source = params.event.skill.source ? ` source=${params.event.skill.source}` : "";
  const path = params.event.skill.path ? ` path=${params.event.skill.path}` : "";
  const reason = params.event.reason ? ` reason=${params.event.reason}` : "";
  return {
    id: `${params.workflowId}:${params.event.type}:${params.event.skill.name}:${params.at}`,
    at: params.at,
    type: params.event.type,
    summary: `${params.event.type}: ${params.event.skill.name}${source}${path}.${reason}`,
    replaySafe: true,
    data: {
      skill: params.event.skill,
      reason: params.event.reason,
    },
  };
}

export function buildRunLedgerResumeAttemptEvent(params: {
  runId: string;
  at: string;
}): RunLedgerEvent {
  return {
    id: `${params.runId}:resume_attempted:${params.at}`,
    at: params.at,
    type: "resume_attempted",
    summary: "Operator requested conservative run resume.",
    replaySafe: true,
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
    replaySafe: true,
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
}): RunLedgerEvent {
  return {
    id: `${params.workflowId}:workflow_started`,
    at: params.at,
    type: "workflow_started",
    summary: `Workflow ${params.workflowType} started.`,
    replaySafe: true,
  };
}

export function buildRunLedgerInterruptedEvent(params: {
  eventId: string;
  at: string;
  reason: string;
}): RunLedgerEvent {
  return {
    id: params.eventId,
    at: params.at,
    type: "interrupted",
    summary: params.reason,
    replaySafe: true,
  };
}

export function buildRunLedgerCheckpointEvent(params: {
  runId: string;
  at: string;
  reason?: string;
}): RunLedgerEvent {
  const reason = params.reason?.trim();
  return {
    id: `${params.runId}:checkpoint:${params.at}`,
    at: params.at,
    type: "checkpoint",
    summary: reason ? `Checkpoint recorded: ${reason}` : "Checkpoint recorded.",
    replaySafe: true,
    data: reason ? { reason } : undefined,
  };
}

export interface RunLedgerWorkflow {
  type: string;
  input: string;
  flags: WorkflowFlags;
  state?: unknown;
}

export interface RunLedgerRecord {
  version: number;
  id: string;
  type: string;
  input: string;
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
  };
  [key: string]: unknown;
}

export interface ResumeClassification {
  classification: "not_interrupted" | "resumable" | "needs_operator_review";
  reason: string;
  unsafeEventIds: string[];
}

const UNCERTAIN_SIDE_EFFECTS = new Set<ToolSideEffectClass>([
  "mutation",
  "shell",
  "forge",
  "external",
  "tool_side_effect",
  "unknown",
]);

function eventMetadata(event: RunLedgerEvent): Record<string, unknown> | null {
  const metadata = isRecord(event.data?.metadata) ? event.data.metadata : null;
  return metadata;
}

function eventReplaySafe(event: RunLedgerEvent): boolean | undefined {
  if (typeof event.replaySafe === "boolean") return event.replaySafe;
  const metadata = eventMetadata(event);
  return typeof metadata?.replaySafe === "boolean" ? metadata.replaySafe : undefined;
}

function eventSideEffectClass(event: RunLedgerEvent): ToolSideEffectClass | undefined {
  if (event.sideEffectClass) return event.sideEffectClass;
  const metadata = eventMetadata(event);
  return typeof metadata?.sideEffectClass === "string"
    ? (metadata.sideEffectClass as ToolSideEffectClass)
    : undefined;
}

export function getGlobalRunLedgerDir(): string {
  return path.join(homedir(), ".pi", LEARNING_STORE_DIRNAME, "runs");
}

function defaultResumeClassification(
  status: RunLedgerStatus,
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
    reason: "No uncertain side effects recorded after the latest checkpoint.",
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
  const unsafeEvents = replayWindow.filter(
    (event) => {
      const sideEffectClass = eventSideEffectClass(event);
      return (
        eventReplaySafe(event) === false ||
        (sideEffectClass ? UNCERTAIN_SIDE_EFFECTS.has(sideEffectClass) : false)
      );
    },
  );

  if (unsafeEvents.length > 0) {
    return {
      classification: "needs_operator_review",
      reason:
        "Run has uncertain mutation, shell, forge, external, or tool side effects after the latest checkpoint.",
      unsafeEventIds: unsafeEvents.map((event) => event.id),
    };
  }

  return defaultResumeClassification("interrupted");
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
  events?: RunLedgerEvent[];
}): RunLedgerRecord {
  const events = params.events ?? [];
  return {
    version: params.version,
    id: params.id,
    type: params.type,
    input: params.input,
    flags: params.flags,
    cwd: params.cwd,
    repo: params.repo,
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
  return {
    ...(parsed as unknown as RunLedgerRecord),
    events,
    workflow: isRecord(parsed.workflow)
      ? (parsed.workflow as unknown as RunLedgerWorkflow)
      : {
          type: typeof parsed.type === "string" ? parsed.type : "workflow",
          input: typeof parsed.input === "string" ? parsed.input : "",
          flags: isRecord(parsed.flags) ? (parsed.flags as WorkflowFlags) : {},
        },
    structuredCompletion: parsed.structuredCompletion,
    resume: isRecord(parsed.resume)
      ? (parsed.resume as RunLedgerRecord["resume"])
      : defaultResumeClassification(
          parsed.status === "completed" ? "completed" : "started",
        ),
  };
}

function parseRunLedgerEvent(value: unknown): RunLedgerEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.at !== "string" ||
    typeof value.type !== "string" ||
    typeof value.summary !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    at: value.at,
    type: value.type as RunLedgerEventType,
    summary: value.summary,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    sideEffectClass:
      typeof value.sideEffectClass === "string"
        ? (value.sideEffectClass as ToolSideEffectClass)
        : undefined,
    replaySafe:
      typeof value.replaySafe === "boolean" ? value.replaySafe : undefined,
    data: isRecord(value.data) ? value.data : undefined,
  };
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
  await fs.mkdir(path.dirname(runFile), { recursive: true });
  await fs.writeFile(runFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function appendRunLedgerEvent(params: {
  runFile: string;
  event: RunLedgerEvent;
}): Promise<RunLedgerRecord> {
  const existing = await readRunLedger(params.runFile);
  if (!existing) {
    throw new Error(`Cannot append run ledger event; missing ${params.runFile}.`);
  }
  const events = [...existing.events, params.event];
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
  const record: RunLedgerRecord = {
    ...existing,
    status,
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
  const structuredCompletion =
    params.patch.structuredCompletion ??
    params.event.data?.structuredCompletion ??
    findLatestStructuredCompletionEvent(existing.events) ??
    existing.structuredCompletion;
  const record: RunLedgerRecord = {
    ...existing,
    ...params.patch,
    status: "completed",
    finishedAt: params.finishedAt,
    outcome: params.outcome,
    confidence: params.confidence,
    structuredCompletion,
    events: [...existing.events, params.event],
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
}): Promise<RunLedgerRecord> {
  const existing = await readRunLedger(params.runFile);
  if (!existing) {
    throw new Error(`Cannot interrupt run ledger; missing ${params.runFile}.`);
  }
  const interruptedEvent = buildRunLedgerInterruptedEvent({
    eventId: params.eventId,
    at: params.at,
    reason: params.reason,
  });
  const events = [...existing.events, interruptedEvent];
  const resume = classifyInterruptedRun(events);
  const status =
    resume.classification === "resumable"
      ? "resumable"
      : "needs_operator_review";
  const record: RunLedgerRecord = {
    ...existing,
    status,
    events,
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

export function summarizeRunRecovery(
  record: RunLedgerRecord,
): RunRecoverySummary {
  const latestCheckpoint = findLastRunEvent(record, "checkpoint");
  const latestCompletion = findLastRunEvent(record, "workflow_completed");
  const latestResumeAttempt = findLastRunEvent(record, "resume_attempted");

  let recommendedAction: string;
  if (record.status === "completed") {
    recommendedAction =
      "Inspect structured completion and validation before starting follow-up work.";
  } else if (record.resume.classification === "needs_operator_review") {
    recommendedAction =
      "Review unsafe events before resuming; do not repeat uncertain side effects.";
  } else if (record.resume.classification === "resumable") {
    recommendedAction =
      "Resume from the latest safe checkpoint and skip already recorded side effects.";
  } else {
    recommendedAction =
      "Continue the active run and record a checkpoint before risky side effects.";
  }

  return {
    classification: record.resume.classification,
    reason: record.resume.reason,
    recommendedAction,
    latestCheckpoint: latestCheckpoint
      ? {
          id: latestCheckpoint.id,
          at: latestCheckpoint.at,
          reason: eventStringData(latestCheckpoint, "reason"),
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
          reason: eventStringData(latestResumeAttempt, "reason"),
        }
      : undefined,
    unsafeEventIds: [...record.resume.unsafeEventIds],
  };
}
