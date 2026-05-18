import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

export type WorkflowOutcome = "success" | "partial" | "failed";

type AgentEndEventMessage = {
  role: "assistant" | "user" | "toolResult" | "system" | string;
  content: AssistantMessage["content"];
  stopReason?: string;
  toolName?: string;
};

interface PendingMemoryGateRecovery {
  blockedToolName: string;
}

export type TurnObligation =
  | "none"
  | "answer_allowed"
  | "tool_required"
  | "clarify_required"
  | "approval_required";

export type ResponseComplianceMode = "monitor" | "warn" | "enforce";

interface TurnObligationResult {
  obligation: TurnObligation;
  reason: string;
}

const TOOL_ACTION_REQUEST_REGEX =
  /(?:^|[.!?;]\s+)(?:please\s+|go ahead and\s+|let'?s\s+|can you\s+|could you\s+|would you\s+)?(?:read|load|inspect|check|grep|find|locate|analyze|review|run|execute|test|verify|restore|edit|write|fix|implement|submit|deploy|add|address|commit|push|open|ship|create|draft|save|update|patch|modify)\b/;
const DESTRUCTIVE_REQUEST_REGEX =
  /(?:^|[.!?;]\s+)(?:please\s+|go ahead and\s+|can you\s+|could you\s+|would you\s+)?(?:delete|remove|rm -rf|force push|reset --hard|rewrite history|drop table)\b/;
const BLOCKING_CLARIFICATION_REGEX =
  /^(?:which|what|where|when|who|how)\b|\b(?:should i|should we|do you want|would you like|can you confirm|please confirm|confirm whether|can you share|can you provide|can you choose|can you clarify|can you send|can you paste)\b/;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isWorkflowOutcome(value: unknown): value is WorkflowOutcome {
  return value === "success" || value === "partial" || value === "failed";
}

function extractTextFromMessageContent(
  content: AssistantMessage["content"],
): string {
  const parts = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text);
  return parts.join("\n").trim();
}

export function getLastAssistantMessage(
  messages: AgentEndEventMessages,
): AgentEndEventMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant") return message;
  }
  return null;
}

export function extractLastAssistantText(
  messages: AgentEndEventMessages,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;

    const text = extractTextFromMessageContent(message.content);
    if (text) return text;
  }
  return "";
}

export function extractLastUserText(messages: AgentEndEventMessages): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;

    const text = extractTextFromMessageContent(message.content);
    if (text) return text;
  }
  return "";
}

export function hasRequiredWorkflowFooter(text: string): boolean {
  return (
    /(?:^|\n)\s*Result\s*:\s*(success|partial|failed)\b/i.test(text) &&
    /(?:^|\n)\s*Confidence\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?%?)/i.test(text)
  );
}

export function isEmptyTerminalAssistantResponse(
  messages: AgentEndEventMessages,
): boolean {
  const lastAssistant = getLastAssistantMessage(messages);
  if (!lastAssistant || lastAssistant.stopReason !== "stop") return false;

  return !lastAssistant.content.some((item) => {
    if (item.type === "toolCall") return true;
    if (item.type === "text") return item.text.trim().length > 0;
    return false;
  });
}

export function assistantMessageHasToolCall(
  message: AgentEndEventMessage | null,
): boolean {
  return Boolean(message?.content.some((item) => item.type === "toolCall"));
}

export function shouldBlockUnsatisfiedTurnObligation(params: {
  mode: ResponseComplianceMode;
  obligation: TurnObligation;
}): boolean {
  if (params.mode === "monitor") return false;
  return (
    params.obligation === "tool_required" ||
    params.obligation === "approval_required"
  );
}

export function isActionOrApprovalObligation(
  obligation: TurnObligation,
): boolean {
  return obligation === "tool_required" || obligation === "approval_required";
}

export function inferTurnObligation(userText: string): TurnObligationResult {
  const text = userText.trim().toLowerCase();
  if (!text) return { obligation: "none", reason: "no user request text" };

  if (DESTRUCTIVE_REQUEST_REGEX.test(text)) {
    return {
      obligation: "approval_required",
      reason: "destructive or high-risk request",
    };
  }

  if (TOOL_ACTION_REQUEST_REGEX.test(text)) {
    return {
      obligation: "tool_required",
      reason: "user requested concrete tool-backed action",
    };
  }

  if (
    /\b(do it|run it|try it|make it|apply it|ship it|continue|proceed)\b/.test(
      text,
    )
  ) {
    return {
      obligation: "tool_required",
      reason: "user confirmed a prior action request",
    };
  }

  if (
    /\b(where (did|do)|source|citation|from source|from docs|is this true|confirm from|verify from)\b/.test(
      text,
    )
  ) {
    return {
      obligation: "tool_required",
      reason: "user requested evidence from source material",
    };
  }

  if (
    /\b(can you|could you|please)\b/.test(text) &&
    /(?:\b(file|path|repo|session|log|diff|branch|pr|issue|skill|docs?)\b|\/|\.[a-z0-9]{1,8}\b)/.test(
      text,
    )
  ) {
    return {
      obligation: "tool_required",
      reason: "user referenced an artifact that should be inspected",
    };
  }

  return {
    obligation: "answer_allowed",
    reason: "request can be answered without tools",
  };
}

export function isAssistantClarification(
  message: AgentEndEventMessage | null,
): boolean {
  if (!message) return false;
  const text = extractTextFromMessageContent(message.content);
  if (!text || text.length > 1200) return false;
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const lastSentence = sentences.at(-1) ?? text.trim();
  return (
    lastSentence.includes("?") &&
    BLOCKING_CLARIFICATION_REGEX.test(lastSentence.toLowerCase())
  );
}

function isMemoryGateRetryToolName(name: string): boolean {
  return name === "edit" || name === "write" || name === "bash" || name === "khala_learn";
}

function extractToolCallNames(message: AgentEndEventMessage): string[] {
  return message.content.flatMap((item) => {
    if (item.type !== "toolCall") return [];
    return typeof item.name === "string" ? [item.name] : [];
  });
}

function isMemoryReadRequiredToolResult(
  message: AgentEndEventMessage,
): boolean {
  if (message.role !== "toolResult") return false;
  return /^MEMORY READ REQUIRED\b/.test(
    extractTextFromMessageContent(message.content),
  );
}

export function findPendingMemoryGateRecovery(
  messages: AgentEndEventMessages,
): PendingMemoryGateRecovery | null {
  let blockedToolName: string | null = null;
  let sawMemoryRead = false;

  for (const message of messages) {
    if (isMemoryReadRequiredToolResult(message)) {
      blockedToolName = message.toolName ?? "mutation";
      sawMemoryRead = false;
      continue;
    }

    if (blockedToolName === null) continue;

    if (message.role !== "assistant") continue;
    for (const toolName of extractToolCallNames(message)) {
      if (toolName === "khala_read_memory") {
        sawMemoryRead = true;
        continue;
      }

      if (sawMemoryRead && isMemoryGateRetryToolName(toolName)) {
        blockedToolName = null;
        sawMemoryRead = false;
        break;
      }
    }
  }

  if (blockedToolName === null || !sawMemoryRead) return null;
  return { blockedToolName };
}

export function inferOutcomeFromText(text: string): {
  outcome: WorkflowOutcome;
  confidence: number;
  strictViolation?: string;
} {
  const resultMatch = text.match(
    /(?:^|\n)\s*Result\s*:\s*(success|partial|failed)\b/i,
  );
  const confidenceMatch = text.match(
    /(?:^|\n)\s*Confidence\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?%?)/i,
  );

  if (!resultMatch || !confidenceMatch) {
    const missingFields: string[] = [];
    if (!resultMatch) missingFields.push("Result");
    if (!confidenceMatch) missingFields.push("Confidence");

    return {
      outcome: "failed",
      confidence: 0,
      strictViolation: `Missing required footer field(s): ${missingFields.join(", ")}.`,
    };
  }

  const outcomeCandidate = resultMatch[1].toLowerCase();
  if (!isWorkflowOutcome(outcomeCandidate)) {
    return {
      outcome: "failed",
      confidence: 0,
      strictViolation: `Invalid Result value '${resultMatch[1]}'. Use success|partial|failed.`,
    };
  }

  const outcome = outcomeCandidate;
  const raw = confidenceMatch[1] ?? "";
  let confidence: number;
  if (raw.endsWith("%")) {
    confidence = Number(raw.slice(0, -1)) / 100;
  } else {
    const numeric = Number(raw);
    confidence = numeric > 1 ? numeric / 100 : numeric;
  }

  if (!Number.isFinite(confidence)) {
    return {
      outcome: "failed",
      confidence: 0,
      strictViolation:
        "Invalid Confidence value. Use a numeric value like `0.82`.",
    };
  }

  return { outcome, confidence: clampConfidence(confidence) };
}

type AgentEndEventMessages = AgentEndEventMessage[];
