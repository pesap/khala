import type { RunLedgerEvent } from "../extensions/runtime/run-ledger.ts";
import {
  createKhalaTranscript,
  stableKhalaJsonStringify,
  type KhalaEvent,
  type KhalaEventDraft,
  type KhalaEventType,
  type KhalaTranscript,
} from "./harness-events.ts";

export interface ScriptedKhalaStep {
  type:
    | "assistant_delta"
    | "assistant_final"
    | "tool_call"
    | "gate"
    | "tool_result"
    | "checkpoint"
    | "ledger_event"
    | "budget_sample"
    | "memory_gate"
    | "skill_routed"
    | "skill_loaded"
    | "skill_missing"
    | "policy_issue"
    | "harness_issue";
  text?: string;
  toolCall?: {
    id?: string;
    name: string;
    arguments?: unknown;
  };
  gate?: {
    decision: "allow" | "warn" | "block";
    code?: string;
    message?: string;
  };
  result?: {
    ok: boolean;
    text?: string;
    data?: unknown;
  };
  checkpoint?: {
    name?: string;
    reason?: string;
    state?: unknown;
  };
  ledgerEvent?: RunLedgerEvent;
  budgetSample?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    remainingTokens?: number;
    costUsd?: number;
  };
  memoryGate?: {
    decision: "blocked" | "fresh" | "required" | "satisfied" | "stale";
    toolName?: string;
    message?: string;
  };
  skill?: {
    name: string;
    reason?: string;
    path?: string;
    source?: string;
    attemptedSources?: string[];
  };
  issue?: {
    code: string;
    message?: string;
    block?: boolean;
    severity?: "error" | "warning";
  };
}

export interface KhalaHarnessEventAssertion {
  type: KhalaEventType;
  toolName?: string;
  textIncludes?: string | string[];
  dataIncludes?: string | string[];
  code?: string;
}

export interface KhalaHarnessRunnerInput {
  userText: string;
  bootstrapPayload?: string;
  workflowType?: string;
  script: ScriptedKhalaStep[];
  fakeTools?: Record<string, (args: unknown) => Promise<unknown> | unknown>;
  expectedEvents?: KhalaHarnessEventAssertion[];
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: unknown;
  blocked: boolean;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  return stableKhalaJsonStringify(value);
}

async function resolveToolResult(params: {
  fakeTools?: Record<string, (args: unknown) => Promise<unknown> | unknown>;
  pendingToolCall?: PendingToolCall;
  step: ScriptedKhalaStep;
}): Promise<{ ok: boolean; text?: string; data?: unknown }> {
  if (params.step.result) return params.step.result;
  if (params.step.text !== undefined) {
    return { ok: true, text: params.step.text };
  }
  if (!params.pendingToolCall) {
    return { ok: true, text: "" };
  }
  if (params.pendingToolCall.blocked) {
    return { ok: false, text: "tool call blocked" };
  }

  const fakeTool = params.fakeTools?.[params.pendingToolCall.name];
  if (!fakeTool) return { ok: true, text: "" };

  try {
    const data = await fakeTool(params.pendingToolCall.arguments);
    return {
      data,
      ok: true,
      text: typeof data === "string" ? data : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

function eventText(event: KhalaEvent): string {
  switch (event.type) {
    case "user_input":
    case "bootstrap_payload":
    case "assistant_delta":
    case "assistant_final":
      return event.text;
    case "tool_result":
      return event.text ?? stringFromUnknown(event.result ?? {});
    case "tool_call_allowed":
    case "tool_call_blocked":
    case "tool_call_warned":
    case "memory_gate":
    case "policy_issue":
    case "harness_issue":
      return event.message ?? "";
    case "checkpoint":
      return [event.name, event.reason].filter(Boolean).join("\n");
    case "ledger_event":
      return event.summary ?? event.ledgerEvent?.summary ?? "";
    default:
      return stableKhalaJsonStringify(event);
  }
}

function eventToolName(event: KhalaEvent): string | undefined {
  switch (event.type) {
    case "tool_call_requested":
    case "tool_call_allowed":
    case "tool_call_blocked":
    case "tool_call_warned":
      return event.name;
    case "tool_result":
      return event.name;
    default:
      return undefined;
  }
}

function eventCode(event: KhalaEvent): string | undefined {
  return "code" in event ? event.code : undefined;
}

export function assertKhalaTranscriptEvents(
  transcript: KhalaTranscript,
  assertions: readonly KhalaHarnessEventAssertion[],
): void {
  let cursor = 0;
  for (const [assertionIndex, assertion] of assertions.entries()) {
    const matchIndex = transcript.events.findIndex((event, index) => {
      if (index < cursor) return false;
      if (event.type !== assertion.type) return false;
      if (
        assertion.toolName !== undefined &&
        eventToolName(event) !== assertion.toolName
      ) {
        return false;
      }
      if (assertion.code !== undefined && eventCode(event) !== assertion.code) {
        return false;
      }

      const text = eventText(event);
      if (
        !asList(assertion.textIncludes).every((part) => text.includes(part))
      ) {
        return false;
      }

      const data = stableKhalaJsonStringify(event);
      return asList(assertion.dataIncludes).every((part) =>
        data.includes(part),
      );
    });

    if (matchIndex === -1) {
      throw new Error(
        `expected event assertion ${assertionIndex + 1} was not satisfied: ${stableKhalaJsonStringify(
          assertion,
        )}`,
      );
    }
    cursor = matchIndex + 1;
  }
}

export async function runKhalaHarnessScript(
  input: KhalaHarnessRunnerInput,
): Promise<KhalaTranscript> {
  const events: KhalaEventDraft[] = [
    { source: "script", text: input.userText, turn: 0, type: "user_input" },
  ];
  if (input.bootstrapPayload !== undefined) {
    events.push({
      text: input.bootstrapPayload,
      turn: 0,
      type: "bootstrap_payload",
    });
  }
  if (input.workflowType !== undefined) {
    events.push({
      turn: 0,
      type: "workflow_state",
      workflowType: input.workflowType,
    });
  }

  let pendingToolCall: PendingToolCall | undefined;
  for (const step of input.script) {
    switch (step.type) {
      case "assistant_delta":
        events.push({ text: step.text ?? "", type: "assistant_delta" });
        break;
      case "assistant_final":
        events.push({ text: step.text ?? "", type: "assistant_final" });
        break;
      case "tool_call": {
        if (!step.toolCall?.name) {
          throw new Error("tool_call steps require toolCall.name");
        }
        const callId =
          step.toolCall.id ?? `call-${events.length + 1}-${step.toolCall.name}`;
        pendingToolCall = {
          arguments: step.toolCall.arguments ?? {},
          blocked: false,
          id: callId,
          name: step.toolCall.name,
        };
        events.push({
          arguments: pendingToolCall.arguments,
          callId,
          name: pendingToolCall.name,
          type: "tool_call_requested",
        });
        break;
      }
      case "gate": {
        const decision = step.gate?.decision ?? "allow";
        const name = pendingToolCall?.name ?? "unknown";
        const callId = pendingToolCall?.id;
        if (decision === "allow") {
          events.push({
            callId,
            message: step.gate?.message,
            name,
            type: "tool_call_allowed",
          });
        } else if (decision === "warn") {
          events.push({
            callId,
            code: step.gate?.code,
            message: step.gate?.message,
            name,
            type: "tool_call_warned",
          });
        } else {
          if (pendingToolCall) pendingToolCall.blocked = true;
          events.push({
            callId,
            code: step.gate?.code,
            message: step.gate?.message,
            name,
            type: "tool_call_blocked",
          });
        }
        break;
      }
      case "tool_result": {
        const result = await resolveToolResult({
          fakeTools: input.fakeTools,
          pendingToolCall,
          step,
        });
        events.push({
          callId: pendingToolCall?.id,
          name: pendingToolCall?.name,
          ok: result.ok,
          result: result.data,
          text: result.text,
          type: "tool_result",
        });
        pendingToolCall = undefined;
        break;
      }
      case "checkpoint":
        events.push({
          name: step.checkpoint?.name,
          reason: step.checkpoint?.reason ?? step.text,
          state: step.checkpoint?.state,
          type: "checkpoint",
        });
        break;
      case "ledger_event":
        events.push({
          ledgerEvent: step.ledgerEvent,
          ledgerEventId: step.ledgerEvent?.id,
          ledgerEventType: step.ledgerEvent?.type,
          runLedgerId:
            typeof step.ledgerEvent?.data?.runLedgerId === "string"
              ? step.ledgerEvent.data.runLedgerId
              : undefined,
          summary: step.ledgerEvent?.summary ?? step.text,
          type: "ledger_event",
        });
        break;
      case "budget_sample":
        events.push({
          ...step.budgetSample,
          type: "budget_sample",
        });
        break;
      case "memory_gate":
        events.push({
          decision: step.memoryGate?.decision ?? "required",
          message: step.memoryGate?.message ?? step.text,
          toolName: step.memoryGate?.toolName,
          type: "memory_gate",
        });
        break;
      case "skill_routed":
        if (!step.skill?.name) {
          throw new Error("skill_routed steps require skill.name");
        }
        events.push({
          name: step.skill.name,
          reason: step.skill.reason ?? step.text,
          type: "skill_routed",
        });
        break;
      case "skill_loaded":
        if (!step.skill?.name) {
          throw new Error("skill_loaded steps require skill.name");
        }
        events.push({
          name: step.skill.name,
          path: step.skill.path,
          source: step.skill.source,
          type: "skill_loaded",
        });
        break;
      case "skill_missing":
        if (!step.skill?.name) {
          throw new Error("skill_missing steps require skill.name");
        }
        events.push({
          attemptedSources: step.skill.attemptedSources,
          name: step.skill.name,
          reason: step.skill.reason ?? step.text,
          type: "skill_missing",
        });
        break;
      case "policy_issue":
        if (!step.issue?.code) {
          throw new Error("policy_issue steps require issue.code");
        }
        events.push({
          block: step.issue.block,
          code: step.issue.code,
          message: step.issue.message ?? step.text ?? "",
          type: "policy_issue",
        });
        break;
      case "harness_issue":
        if (!step.issue?.code) {
          throw new Error("harness_issue steps require issue.code");
        }
        events.push({
          code: step.issue.code,
          message: step.issue.message ?? step.text ?? "",
          severity: step.issue.severity,
          type: "harness_issue",
        });
        break;
    }
  }

  const transcript = createKhalaTranscript(events, { source: "khala-runner" });
  if (input.expectedEvents) {
    assertKhalaTranscriptEvents(transcript, input.expectedEvents);
  }
  return transcript;
}
