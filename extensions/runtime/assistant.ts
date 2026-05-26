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

export interface ObligationLoopGuardState {
  key: string | null;
  count: number;
}

export interface ObligationLoopGuardDecision {
  block: boolean;
  next: ObligationLoopGuardState;
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
  /(?:^|[.!?;]\s+)(?:please\s+|go ahead and\s+|let'?s\s+|can you\s+|could you\s+|would you\s+)?(?:read|load|inspect|check|grep|find|locate|analyze|review|run|execute|test|verify|restore|edit|write|fix|implement|submit|deploy|add|address|commit|push|open|ship|create|draft|save|update|patch|modify|remove|delete)\b/;
const DESTRUCTIVE_REQUEST_REGEX =
  /(?:^|[.!?;]\s+)(?:please\s+|go ahead and\s+|can you\s+|could you\s+|would you\s+)?(?:(?:rm -rf|force push|reset --hard|rewrite history|drop table)|(?:(?:delete|remove)\s+(?:(?:the|all)\s+)?(?:[\w-]+\s+){0,3}(?:data|database|table|records?|history|repo|repository|branch|branches|files?|folders?|directories?)))\b/;
const DESTRUCTIVE_INLINE_REGEX =
  /\b(?:(?:rm -rf|force push|reset --hard|rewrite history|drop table)|(?:(?:delete|remove)\s+(?:(?:the|all)\s+)?(?:[\w-]+\s+){0,3}(?:data|database|table|records?|history|repo|repository|branch|branches|files?|folders?|directories?)))\b/;
const BLOCKING_CLARIFICATION_REGEX =
  /^(?:which|what|where|when|who|how)\b|\b(?:should i|should we|do you want|would you like|can you confirm|please confirm|confirm whether|can you share|can you provide|can you choose|can you clarify|can you send|can you paste)\b/;
const APPROVAL_QUESTION_REGEX =
  /\b(?:can i|may i|is it ok if i|is it okay if i|do you want me to|should i)\b/;
const GENERIC_PERMISSION_QUESTION_REGEX =
  /^\s*(?:can i|may i|should i|should we|do you want me to|would you like me to)\s+(?:proceed|continue|start|get started|begin|do (?:it|that|this)|work on (?:it|that|this))(?:\s*[?.!])?\s*$/;
const NO_QUESTION_CLARIFICATION_DIRECTIVE_REGEX =
  /\b(?:please confirm|confirm whether|can you confirm|can you clarify|can you choose|can you share|can you provide|can you send|can you paste)\b/;
const ARTIFACT_ACTION_VERB_REGEX =
  /\b(inspect|check|review|analyze|verify|confirm|open|read|load|grep|find|locate|test|run|execute|edit|write|fix|implement|update|patch|modify|create|draft|address)\b/;
const CONCEPTUAL_REQUEST_REGEX =
  /\b(?:idea|approach|plan|strategy|design|opinion|trade-?offs?|reasoning|architecture|concept|proposal)\b/;
const ARTIFACT_OR_COMMAND_TARGET_REGEX =
  /(?:\b(file|path|repo|repository|session|log|diff|branch|pr|issue|skill|docs?|command|script|test|build|typecheck|lint)\b|\/|\.[a-z0-9]{1,8}\b|`[^`]+`)/;

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
  if (assistantTurnHasToolCallSinceLatestUser(messages)) return false;

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

export function assistantTurnHasToolCallSinceLatestUser(
  messages: AgentEndEventMessages,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (
      message.role === "assistant" &&
      message.content.some((item) => item.type === "toolCall")
    ) {
      return true;
    }
  }
  return false;
}

export function shouldBlockUnsatisfiedTurnObligation(params: {
  mode: ResponseComplianceMode;
  obligation: TurnObligation;
}): boolean {
  if (params.mode !== "enforce") return false;
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

export function evaluateObligationLoopGuard(params: {
  current: ObligationLoopGuardState;
  key: string;
  blockThreshold: number;
}): ObligationLoopGuardDecision {
  const nextCount =
    params.current.key === params.key ? params.current.count + 1 : 1;
  return {
    block: nextCount < params.blockThreshold,
    next: { key: params.key, count: nextCount },
  };
}

export function normalizeLoopGuardText(text: string): string {
  let normalized = text.trim().toLowerCase();
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(/^["'`([{]+/, "")
      .replace(/["'`)\]}]+$/, "")
      .replace(/[.,!?;:]+$/g, "")
      .trim();
  }
  normalized = normalized.replace(/\s+/g, " ");
  return normalized || "_empty_";
}

export function inferTurnObligation(userText: string): TurnObligationResult {
  const text = userText.trim().toLowerCase();
  if (!text) return { obligation: "none", reason: "no user request text" };

  if (DESTRUCTIVE_REQUEST_REGEX.test(text) || DESTRUCTIVE_INLINE_REGEX.test(text)) {
    return {
      obligation: "approval_required",
      reason: "destructive or high-risk request",
    };
  }

  if (
    /\b(can you|could you|please)\b/.test(text) &&
    /\b(check|review|analyze|verify|confirm)\b/.test(text) &&
    CONCEPTUAL_REQUEST_REGEX.test(text) &&
    !ARTIFACT_OR_COMMAND_TARGET_REGEX.test(text)
  ) {
    return {
      obligation: "answer_allowed",
      reason: "conceptual request can be answered without tools",
    };
  }

  if (TOOL_ACTION_REQUEST_REGEX.test(text)) {
    return {
      obligation: "tool_required",
      reason: "user requested concrete tool-backed action",
    };
  }

  if (
    /\b(do it|run it|try it|make it|apply it|ship it)\b/.test(
      text,
    )
  ) {
    return {
      obligation: "tool_required",
      reason: "user confirmed a prior action request",
    };
  }

  if (
    /\b(keep going|keep working|continue working|make progress|work on (?:it|this|that)|clean (?:up )?(?:the )?(?:repo|repository|codebase)|improve (?:the )?(?:repo|repository|codebase|workflow|agent|skill|skills|runtime))\b/.test(
      text,
    )
  ) {
    return {
      obligation: "tool_required",
      reason: "user requested continued concrete work",
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
    ARTIFACT_ACTION_VERB_REGEX.test(text) &&
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
  if (!text) return false;
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some((sentence) => {
    const normalized = sentence.toLowerCase();
    const hasClarificationSignal =
      BLOCKING_CLARIFICATION_REGEX.test(normalized) ||
      APPROVAL_QUESTION_REGEX.test(normalized);
    if (!hasClarificationSignal) return false;
    const questionLike =
      sentence.includes("?") ||
      /^(?:which|what|where|when|who|how|can i|may i|is it ok if i|is it okay if i|do you want me to|should i|should we|would you like|please confirm|confirm whether|can you confirm|can you clarify|can you choose)\b/.test(
        normalized,
      ) ||
      NO_QUESTION_CLARIFICATION_DIRECTIVE_REGEX.test(normalized);
    if (!questionLike) return false;
    return true;
  });
}

export function isAssistantClarificationAllowedForObligation(
  message: AgentEndEventMessage | null,
  obligation: TurnObligation,
): boolean {
  if (!isAssistantClarification(message)) return false;
  if (obligation !== "tool_required") return true;

  const text = message ? extractTextFromMessageContent(message.content) : "";
  return !GENERIC_PERMISSION_QUESTION_REGEX.test(text.toLowerCase());
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
    if (message.role === "user" && blockedToolName !== null) {
      blockedToolName = null;
      sawMemoryRead = false;
      continue;
    }

    if (isMemoryReadRequiredToolResult(message)) {
      blockedToolName = isMemoryGateRetryToolName(message.toolName ?? "")
        ? (message.toolName ?? "mutation")
        : "mutation";
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

      const matchesBlockedTool = toolName === blockedToolName;
      const allowFallbackRetry = blockedToolName === "mutation";
      if (
        sawMemoryRead &&
        ((matchesBlockedTool && isMemoryGateRetryToolName(toolName)) ||
          (allowFallbackRetry && isMemoryGateRetryToolName(toolName)))
      ) {
        blockedToolName = null;
        sawMemoryRead = false;
        break;
      }
    }
  }

  if (blockedToolName === null || !sawMemoryRead) return null;
  const lastAssistantMessage = getLastAssistantMessage(messages);
  if (
    isAssistantClarificationAllowedForObligation(
      lastAssistantMessage,
      "tool_required",
    )
  ) {
    return null;
  }
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
