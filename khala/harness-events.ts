import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunLedgerEvent,
  RunLedgerEventType,
} from "../extensions/runtime/run-ledger.ts";

export const KHALA_TRANSCRIPT_VERSION = 1 as const;

export type KhalaEventType =
  | "user_input"
  | "bootstrap_payload"
  | "workflow_state"
  | "tool_call_requested"
  | "tool_call_allowed"
  | "tool_call_blocked"
  | "tool_call_warned"
  | "tool_result"
  | "policy_issue"
  | "skill_routed"
  | "skill_loaded"
  | "skill_missing"
  | "memory_gate"
  | "assistant_delta"
  | "assistant_final"
  | "harness_issue"
  | "ledger_event"
  | "checkpoint"
  | "budget_sample";

export type KhalaToolGateDecision = "allow" | "warn" | "block";

interface KhalaEventBase<T extends KhalaEventType> {
  type: T;
  seq: number;
  id: string;
  turn?: number;
  at?: string;
  data?: Record<string, unknown>;
}

export interface KhalaUserInputEvent extends KhalaEventBase<"user_input"> {
  text: string;
  source?: "fixture" | "pi" | "script" | "user";
}

export interface KhalaBootstrapPayloadEvent
  extends KhalaEventBase<"bootstrap_payload"> {
  text: string;
}

export interface KhalaWorkflowStateEvent
  extends KhalaEventBase<"workflow_state"> {
  workflowType?: string;
  state?: unknown;
}

export interface KhalaToolCallRequestedEvent
  extends KhalaEventBase<"tool_call_requested"> {
  callId: string;
  name: string;
  arguments?: unknown;
}

export interface KhalaToolCallAllowedEvent
  extends KhalaEventBase<"tool_call_allowed"> {
  callId?: string;
  name: string;
  message?: string;
}

export interface KhalaToolCallBlockedEvent
  extends KhalaEventBase<"tool_call_blocked"> {
  callId?: string;
  name: string;
  code?: string;
  message?: string;
}

export interface KhalaToolCallWarnedEvent
  extends KhalaEventBase<"tool_call_warned"> {
  callId?: string;
  name: string;
  code?: string;
  message?: string;
}

export interface KhalaToolResultEvent extends KhalaEventBase<"tool_result"> {
  callId?: string;
  name?: string;
  ok?: boolean;
  text?: string;
  result?: unknown;
}

export interface KhalaPolicyIssueEvent extends KhalaEventBase<"policy_issue"> {
  code: string;
  message: string;
  block?: boolean;
}

export interface KhalaSkillRoutedEvent extends KhalaEventBase<"skill_routed"> {
  name: string;
  reason?: string;
}

export interface KhalaSkillLoadedEvent extends KhalaEventBase<"skill_loaded"> {
  name: string;
  path?: string;
  source?: string;
}

export interface KhalaSkillMissingEvent
  extends KhalaEventBase<"skill_missing"> {
  name: string;
  attemptedSources?: string[];
  reason?: string;
}

export interface KhalaMemoryGateEvent extends KhalaEventBase<"memory_gate"> {
  decision: "blocked" | "fresh" | "required" | "satisfied" | "stale";
  toolName?: string;
  message?: string;
}

export interface KhalaAssistantDeltaEvent
  extends KhalaEventBase<"assistant_delta"> {
  text: string;
}

export interface KhalaAssistantFinalEvent
  extends KhalaEventBase<"assistant_final"> {
  text: string;
}

export interface KhalaHarnessIssueEvent
  extends KhalaEventBase<"harness_issue"> {
  code: string;
  message: string;
  severity?: "error" | "warning";
}

export interface KhalaLedgerEventEvent extends KhalaEventBase<"ledger_event"> {
  ledgerEventId?: string;
  runLedgerId?: string;
  ledgerEventType?: RunLedgerEventType;
  ledgerEvent?: RunLedgerEvent;
  summary?: string;
}

export interface KhalaCheckpointEvent extends KhalaEventBase<"checkpoint"> {
  name?: string;
  reason?: string;
  state?: unknown;
}

export interface KhalaBudgetSampleEvent
  extends KhalaEventBase<"budget_sample"> {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  remainingTokens?: number;
  costUsd?: number;
}

export type KhalaEvent =
  | KhalaUserInputEvent
  | KhalaBootstrapPayloadEvent
  | KhalaWorkflowStateEvent
  | KhalaToolCallRequestedEvent
  | KhalaToolCallAllowedEvent
  | KhalaToolCallBlockedEvent
  | KhalaToolCallWarnedEvent
  | KhalaToolResultEvent
  | KhalaPolicyIssueEvent
  | KhalaSkillRoutedEvent
  | KhalaSkillLoadedEvent
  | KhalaSkillMissingEvent
  | KhalaMemoryGateEvent
  | KhalaAssistantDeltaEvent
  | KhalaAssistantFinalEvent
  | KhalaHarnessIssueEvent
  | KhalaLedgerEventEvent
  | KhalaCheckpointEvent
  | KhalaBudgetSampleEvent;

type KhalaEventWithOptionalSequence<T extends KhalaEvent> = Omit<
  T,
  "id" | "seq"
> &
  Partial<Pick<T, "id" | "seq">>;

export type KhalaEventDraft = {
  [Event in KhalaEvent as Event["type"]]: KhalaEventWithOptionalSequence<Event>;
}[KhalaEvent["type"]];

export interface KhalaTranscript {
  version: typeof KHALA_TRANSCRIPT_VERSION;
  events: KhalaEvent[];
  metadata?: Record<string, unknown>;
}

export interface KhalaTranscriptJsonlStartLine {
  kind: "khala_transcript_start";
  version: typeof KHALA_TRANSCRIPT_VERSION;
  metadata?: Record<string, unknown>;
}

export interface KhalaTranscriptJsonlEventLine {
  kind: "khala_event";
  event: KhalaEvent;
}

export type KhalaTranscriptJsonlLine =
  | KhalaTranscriptJsonlStartLine
  | KhalaTranscriptJsonlEventLine;

export interface KhalaBenchmarkToolCallLike {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface KhalaBenchmarkMessageLike {
  role: string;
  text?: string;
  content?: unknown;
  toolCall?: KhalaBenchmarkToolCallLike;
  toolCallId?: string;
  toolName?: string;
}

export interface KhalaHarnessMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
}

export interface PiAgentEndMessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
}

const KHALA_EVENT_TYPES = new Set<string>([
  "user_input",
  "bootstrap_payload",
  "workflow_state",
  "tool_call_requested",
  "tool_call_allowed",
  "tool_call_blocked",
  "tool_call_warned",
  "tool_result",
  "policy_issue",
  "skill_routed",
  "skill_loaded",
  "skill_missing",
  "memory_gate",
  "assistant_delta",
  "assistant_final",
  "harness_issue",
  "ledger_event",
  "checkpoint",
  "budget_sample",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry) ?? null);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalized = stableJsonValue(record[key]);
    if (normalized !== undefined) sorted[key] = normalized;
  }
  return sorted;
}

export function stableKhalaJsonStringify(
  value: unknown,
  space?: number,
): string {
  return JSON.stringify(stableJsonValue(value), null, space) ?? "null";
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const rendered = stableKhalaJsonStringify(value);
  return rendered === undefined ? "" : rendered;
}

export function khalaEventId(seq: number, type: KhalaEventType): string {
  return `ev-${String(seq).padStart(6, "0")}-${type}`;
}

export function isKhalaEventType(value: unknown): value is KhalaEventType {
  return typeof value === "string" && KHALA_EVENT_TYPES.has(value);
}

function normalizeKhalaEvent(value: unknown, fallbackSeq: number): KhalaEvent {
  if (!isRecord(value) || !isKhalaEventType(value.type)) {
    throw new Error("event must be an object with a known type");
  }
  const seq =
    typeof value.seq === "number" &&
    Number.isInteger(value.seq) &&
    value.seq > 0
      ? value.seq
      : fallbackSeq;
  const id =
    typeof value.id === "string" ? value.id : khalaEventId(seq, value.type);
  return {
    ...value,
    id,
    seq,
  } as KhalaEvent;
}

export function createKhalaTranscript(
  events: readonly KhalaEventDraft[] = [],
  metadata?: Record<string, unknown>,
): KhalaTranscript {
  return {
    events: events.map((event, index) => normalizeKhalaEvent(event, index + 1)),
    ...(metadata ? { metadata } : {}),
    version: KHALA_TRANSCRIPT_VERSION,
  };
}

export function appendKhalaEvent(
  transcript: KhalaTranscript,
  event: KhalaEventDraft,
): KhalaTranscript {
  return createKhalaTranscript(
    [...transcript.events, event],
    transcript.metadata,
  );
}

export function normalizeKhalaTranscript(value: unknown): KhalaTranscript {
  const rawEvents = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.events
      : undefined;
  if (!Array.isArray(rawEvents)) {
    throw new Error("transcript must include an events array");
  }

  const metadata =
    isRecord(value) && isRecord(value.metadata) ? value.metadata : undefined;
  return {
    events: rawEvents.map((event, index) =>
      normalizeKhalaEvent(event, index + 1),
    ),
    ...(metadata ? { metadata } : {}),
    version: KHALA_TRANSCRIPT_VERSION,
  };
}

export function hashKhalaEvents(events: readonly KhalaEvent[]): string {
  return createHash("sha256")
    .update(stableKhalaJsonStringify(events))
    .digest("hex");
}

export function hashKhalaTranscript(transcript: KhalaTranscript): string {
  return createHash("sha256")
    .update(stableKhalaJsonStringify(normalizeKhalaTranscript(transcript)))
    .digest("hex");
}

export function transcriptToJsonlLines(transcript: KhalaTranscript): string[] {
  const normalized = normalizeKhalaTranscript(transcript);
  const startLine: KhalaTranscriptJsonlStartLine = {
    kind: "khala_transcript_start",
    ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
    version: KHALA_TRANSCRIPT_VERSION,
  };
  return [
    stableKhalaJsonStringify(startLine),
    ...normalized.events.map((event) =>
      stableKhalaJsonStringify({ event, kind: "khala_event" }),
    ),
  ];
}

export function transcriptFromJsonlLines(
  lines: readonly string[],
  fallbackMetadata?: Record<string, unknown>,
): KhalaTranscript {
  const events: unknown[] = [];
  let metadata = fallbackMetadata;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed) && parsed.kind === "khala_transcript_start") {
      if (
        parsed.version !== undefined &&
        parsed.version !== KHALA_TRANSCRIPT_VERSION
      ) {
        throw new Error(
          `JSONL line ${index + 1} has unsupported transcript version: ${String(
            parsed.version,
          )}`,
        );
      }
      if (parsed.metadata !== undefined && !isRecord(parsed.metadata)) {
        throw new Error(`JSONL line ${index + 1} metadata must be an object`);
      }
      metadata = parsed.metadata as Record<string, unknown> | undefined;
      continue;
    }

    if (isRecord(parsed) && parsed.kind === "khala_event") {
      events.push(parsed.event);
      continue;
    }

    events.push(parsed);
  }

  return createKhalaTranscript(events as KhalaEventDraft[], metadata);
}

export function khalaTranscriptToJsonl(transcript: KhalaTranscript): string {
  return `${transcriptToJsonlLines(transcript).join("\n")}\n`;
}

export function khalaTranscriptFromJsonl(
  jsonl: string,
  metadata?: Record<string, unknown>,
): KhalaTranscript {
  return transcriptFromJsonlLines(jsonl.split(/\r?\n/), metadata);
}

export async function writeKhalaTranscriptJsonl(
  filePath: string,
  transcript: KhalaTranscript,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, khalaTranscriptToJsonl(transcript), "utf8");
  await rename(tempPath, filePath);
}

export async function readKhalaTranscriptJsonl(
  filePath: string,
): Promise<KhalaTranscript> {
  return khalaTranscriptFromJsonl(await readFile(filePath, "utf8"));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (!isRecord(part) || part.type !== "text") return [];
        return typeof part.text === "string" ? [part.text] : [];
      })
      .join("");
  }
  if (isRecord(content) && content.type === "text") {
    return typeof content.text === "string" ? content.text : "";
  }
  return content === undefined ? "" : stringifyUnknown(content);
}

function toolCallsFromContent(
  content: unknown,
  toolNameMap: (name: string) => string,
): KhalaBenchmarkToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "toolCall") return [];
    if (typeof part.name !== "string") return [];
    return [
      {
        arguments: part.arguments,
        id: typeof part.id === "string" ? part.id : undefined,
        name: toolNameMap(part.name),
      },
    ];
  });
}

function defaultToolNameMap(name: string): string {
  return name;
}

function defaultPiToolNameMap(name: string): string {
  return name === "bash" ? "exec_command" : name;
}

function messageText(message: KhalaBenchmarkMessageLike): string {
  if (typeof message.text === "string") return message.text;
  return textFromContent(message.content);
}

function callIdForToolCall(
  toolCall: KhalaBenchmarkToolCallLike,
  eventIndex: number,
): string {
  return toolCall.id ?? `call-${eventIndex + 1}-${toolCall.name}`;
}

export function benchmarkMessagesToKhalaTranscript(params: {
  messages: readonly KhalaBenchmarkMessageLike[];
  userText?: string;
  assistantText?: string;
  metadata?: Record<string, unknown>;
  toolNameMap?: (name: string) => string;
}): KhalaTranscript {
  const events: KhalaEventDraft[] = [];
  const toolNameMap = params.toolNameMap ?? defaultToolNameMap;
  let sawUserInput = false;
  let latestToolCall:
    | {
        callId: string;
        name: string;
      }
    | undefined;

  for (const message of params.messages) {
    const role = message.role;
    const text = messageText(message);

    if (role === "user") {
      sawUserInput = true;
      events.push({ source: "fixture", text, type: "user_input" });
      continue;
    }

    if (role === "system") {
      events.push({
        data: text ? { text } : undefined,
        state: message.content ?? text,
        type: "workflow_state",
      });
      continue;
    }

    if (role === "assistant") {
      if (text) events.push({ text, type: "assistant_delta" });
      const toolCalls = [
        ...(message.toolCall
          ? [
              {
                ...message.toolCall,
                name: toolNameMap(message.toolCall.name),
              },
            ]
          : []),
        ...toolCallsFromContent(message.content, toolNameMap),
      ];
      for (const toolCall of toolCalls) {
        const callId = callIdForToolCall(toolCall, events.length);
        latestToolCall = { callId, name: toolCall.name };
        events.push({
          arguments: toolCall.arguments ?? {},
          callId,
          name: toolCall.name,
          type: "tool_call_requested",
        });
      }
      continue;
    }

    if (role === "toolResult") {
      events.push({
        callId: message.toolCallId ?? latestToolCall?.callId,
        name: message.toolName ?? latestToolCall?.name,
        text,
        type: "tool_result",
      });
      continue;
    }

    if (text) {
      events.push({
        data: { role, text },
        message: text,
        severity: "warning",
        code: "unknown_message_role",
        type: "harness_issue",
      });
    }
  }

  if (!sawUserInput && params.userText?.trim()) {
    events.unshift({
      source: "fixture",
      text: params.userText,
      type: "user_input",
    });
  }
  if (params.assistantText?.trim()) {
    events.push({
      text: params.assistantText,
      type: "assistant_final",
    });
  }

  return createKhalaTranscript(events, params.metadata);
}

export function piAgentEndMessagesToKhalaTranscript(
  messages: readonly PiAgentEndMessageLike[],
  params: {
    assistantText?: string;
    metadata?: Record<string, unknown>;
    toolNameMap?: (name: string) => string;
    userText?: string;
  } = {},
): KhalaTranscript {
  return benchmarkMessagesToKhalaTranscript({
    assistantText: params.assistantText,
    messages: messages.map((message) => ({
      content: message.content,
      role: message.role ?? "unknown",
      toolCallId: message.toolCallId,
      toolName:
        typeof message.toolName === "string"
          ? (params.toolNameMap ?? defaultPiToolNameMap)(message.toolName)
          : undefined,
    })),
    metadata: params.metadata,
    toolNameMap: params.toolNameMap ?? defaultPiToolNameMap,
    userText: params.userText,
  });
}

function textContent(text: string): Array<{ text: string; type: "text" }> {
  return [{ text, type: "text" }];
}

export function khalaTranscriptToHarnessMessages(
  transcript: KhalaTranscript,
): KhalaHarnessMessage[] {
  const messages: KhalaHarnessMessage[] = [];
  for (const event of normalizeKhalaTranscript(transcript).events) {
    switch (event.type) {
      case "user_input":
        messages.push({ content: textContent(event.text), role: "user" });
        break;
      case "bootstrap_payload":
        messages.push({ content: textContent(event.text), role: "system" });
        break;
      case "workflow_state":
        messages.push({
          content: textContent(
            event.workflowType ??
              (event.state === undefined ? "" : stringifyUnknown(event.state)),
          ),
          role: "system",
        });
        break;
      case "assistant_delta":
      case "assistant_final":
        messages.push({ content: textContent(event.text), role: "assistant" });
        break;
      case "tool_call_requested":
        messages.push({
          content: [
            {
              arguments: event.arguments ?? {},
              id: event.callId,
              name: event.name,
              type: "toolCall" as const,
            },
          ],
          role: "assistant",
        });
        break;
      case "tool_result":
        messages.push({
          content: textContent(
            event.text ??
              (event.result === undefined
                ? ""
                : stringifyUnknown(event.result)),
          ),
          role: "toolResult",
          toolCallId: event.callId,
          toolName: event.name,
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

export function khalaTranscriptToBenchmarkMessages(
  transcript: KhalaTranscript,
): KhalaBenchmarkMessageLike[] {
  const messages: KhalaBenchmarkMessageLike[] = [];
  for (const event of normalizeKhalaTranscript(transcript).events) {
    switch (event.type) {
      case "user_input":
        messages.push({ role: "user", text: event.text });
        break;
      case "bootstrap_payload":
        messages.push({ role: "system", text: event.text });
        break;
      case "workflow_state":
        messages.push({
          role: "system",
          text:
            event.workflowType ??
            (event.state === undefined ? "" : stringifyUnknown(event.state)),
        });
        break;
      case "assistant_delta":
      case "assistant_final":
        messages.push({ role: "assistant", text: event.text });
        break;
      case "tool_call_requested":
        messages.push({
          role: "assistant",
          toolCall: {
            arguments: event.arguments ?? {},
            id: event.callId,
            name: event.name,
          },
        });
        break;
      case "tool_result":
        messages.push({
          role: "toolResult",
          text:
            event.text ??
            (event.result === undefined ? "" : stringifyUnknown(event.result)),
          toolCallId: event.callId,
          toolName: event.name,
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

export function latestKhalaAssistantText(transcript: KhalaTranscript): string {
  for (const event of [
    ...normalizeKhalaTranscript(transcript).events,
  ].reverse()) {
    if (event.type === "assistant_final" || event.type === "assistant_delta") {
      return event.text;
    }
  }
  return "";
}

export function khalaTranscriptToolCalls(
  transcript: KhalaTranscript,
): KhalaToolCallRequestedEvent[] {
  return normalizeKhalaTranscript(transcript).events.filter(
    (event): event is KhalaToolCallRequestedEvent =>
      event.type === "tool_call_requested",
  );
}

export function khalaTranscriptSearchText(transcript: KhalaTranscript): string {
  const parts: string[] = [];
  for (const event of normalizeKhalaTranscript(transcript).events) {
    parts.push(event.type);
    switch (event.type) {
      case "user_input":
      case "bootstrap_payload":
      case "assistant_delta":
      case "assistant_final":
        parts.push(event.text);
        break;
      case "tool_call_requested":
        parts.push(event.name, stringifyUnknown(event.arguments ?? {}));
        break;
      case "tool_call_allowed":
      case "tool_call_blocked":
      case "tool_call_warned":
        parts.push(
          event.name,
          event.callId ?? "",
          "code" in event ? (event.code ?? "") : "",
          event.message ?? "",
        );
        break;
      case "tool_result":
        parts.push(
          event.name ?? "",
          event.callId ?? "",
          event.text ?? stringifyUnknown(event.result ?? {}),
        );
        break;
      case "policy_issue":
      case "harness_issue":
        parts.push(event.code, event.message);
        break;
      case "skill_routed":
      case "skill_loaded":
      case "skill_missing":
        parts.push(
          event.name,
          "reason" in event ? (event.reason ?? "") : "",
          "path" in event ? (event.path ?? "") : "",
        );
        break;
      case "memory_gate":
        parts.push(event.decision, event.toolName ?? "", event.message ?? "");
        break;
      case "workflow_state":
        parts.push(event.workflowType ?? "", stringifyUnknown(event.state));
        break;
      case "ledger_event":
        parts.push(
          event.ledgerEventId ?? event.ledgerEvent?.id ?? "",
          event.runLedgerId ?? "",
          event.ledgerEventType ?? "",
          event.summary ?? "",
        );
        break;
      case "checkpoint":
        parts.push(
          event.name ?? "",
          event.reason ?? "",
          stringifyUnknown(event.state),
        );
        break;
      case "budget_sample":
        parts.push(
          event.model ?? "",
          stringifyUnknown({
            costUsd: event.costUsd,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            remainingTokens: event.remainingTokens,
            totalTokens: event.totalTokens,
          }),
        );
        break;
    }
    if (event.data) parts.push(stringifyUnknown(event.data));
  }
  return parts.filter(Boolean).join("\n");
}
