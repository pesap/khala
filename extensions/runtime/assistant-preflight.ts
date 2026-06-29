import type { TextContent } from "@earendil-works/pi-ai";
import {
  extractPreflightFromText,
  type PreflightRecord,
} from "../policy/first-principles.ts";

export interface AssistantPreflightStreamState {
  textByContentIndex: Map<number, string>;
  textSnapshot: string;
  appliedRaw: string | null;
}

type MessageLike = {
  role?: unknown;
  content?: unknown;
};

type MessageStartLike = {
  message: MessageLike;
};

type AssistantMessageEventLike = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: MessageLike;
  message?: MessageLike;
  error?: MessageLike;
};

type MessageUpdateLike = {
  message: MessageLike;
  assistantMessageEvent: AssistantMessageEventLike;
};

export function createAssistantPreflightStreamState(): AssistantPreflightStreamState {
  return {
    textByContentIndex: new Map(),
    textSnapshot: "",
    appliedRaw: null,
  };
}

export function resetAssistantPreflightStreamState(
  state: AssistantPreflightStreamState,
): void {
  state.textByContentIndex.clear();
  state.textSnapshot = "";
  state.appliedRaw = null;
}

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter(isTextContent)
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function updateFromMessageContent(
  state: AssistantPreflightStreamState,
  content: unknown,
): boolean {
  const text = textFromContent(content);
  if (!text) return false;
  state.textSnapshot = text;
  return true;
}

function fallbackTextFromIndexedParts(
  state: AssistantPreflightStreamState,
): string {
  return [...state.textByContentIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("\n")
    .trim();
}

export function currentAssistantPreflightText(
  state: AssistantPreflightStreamState,
): string {
  return state.textSnapshot || fallbackTextFromIndexedParts(state);
}

export function updateAssistantPreflightFromMessageStart(
  state: AssistantPreflightStreamState,
  event: MessageStartLike,
): void {
  if (event.message.role === "assistant") {
    resetAssistantPreflightStreamState(state);
    updateFromMessageContent(state, event.message.content);
  }
}

export function updateAssistantPreflightFromMessageUpdate(
  state: AssistantPreflightStreamState,
  event: MessageUpdateLike,
): void {
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent.type === "start") {
    resetAssistantPreflightStreamState(state);
  }

  const updatedFromPartial = updateFromMessageContent(
    state,
    assistantEvent.partial?.content,
  );

  if (!updatedFromPartial) {
    if (
      assistantEvent.type === "text_delta" &&
      typeof assistantEvent.contentIndex === "number" &&
      typeof assistantEvent.delta === "string"
    ) {
      const previous =
        state.textByContentIndex.get(assistantEvent.contentIndex) ?? "";
      state.textByContentIndex.set(
        assistantEvent.contentIndex,
        previous + assistantEvent.delta,
      );
    } else if (
      assistantEvent.type === "text_end" &&
      typeof assistantEvent.contentIndex === "number" &&
      typeof assistantEvent.content === "string"
    ) {
      state.textByContentIndex.set(
        assistantEvent.contentIndex,
        assistantEvent.content,
      );
    }
  }

  if (assistantEvent.type === "done" && assistantEvent.message) {
    updateFromMessageContent(state, assistantEvent.message.content);
  } else if (assistantEvent.type === "error" && assistantEvent.error) {
    updateFromMessageContent(state, assistantEvent.error.content);
  } else {
    updateFromMessageContent(state, event.message.content);
  }
}

export function getUnappliedAssistantPreflight(
  state: AssistantPreflightStreamState,
  nowIso: () => string,
): PreflightRecord | null {
  const preflight = extractPreflightFromText(
    currentAssistantPreflightText(state),
    nowIso,
    "assistant",
  );
  if (!preflight || preflight.raw === state.appliedRaw) return null;
  return preflight;
}

export function markAssistantPreflightApplied(
  state: AssistantPreflightStreamState,
  preflight: Pick<PreflightRecord, "raw">,
): void {
  state.appliedRaw = preflight.raw;
}
