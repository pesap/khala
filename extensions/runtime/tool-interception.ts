import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isMutationToolCall } from "../policy/first-principles.ts";

export interface ToolInterceptionCounters {
  incrementTaskToolCall: boolean;
  incrementMemoryToolCallsSinceRead: boolean;
  isMemoryRead: boolean;
}

export function isMemoryPersistenceToolName(toolName: string): boolean {
  return toolName === "khala_learn";
}

export function requiresFreshMemoryToolCall(event: ToolCallEvent): boolean {
  return isMutationToolCall(event) || isMemoryPersistenceToolName(event.toolName);
}

export function isSkillMemoryReadToolCall(event: {
  toolName: string;
  input?: unknown;
}): boolean {
  if (event.toolName !== "read") return false;
  const input = event.input as { path?: unknown } | undefined;
  if (typeof input?.path !== "string") return false;

  const normalizedPath = input.path.replaceAll("\\", "/");
  return (
    normalizedPath.startsWith("skills/") ||
    normalizedPath.startsWith(".agents/skills/") ||
    normalizedPath.startsWith(".pi/khala/skills/") ||
    normalizedPath.includes("/skills/") ||
    normalizedPath.includes("/.agents/skills/") ||
    normalizedPath.includes("/.pi/khala/skills/")
  );
}

export function getToolInterceptionCounters(event: {
  toolName: string;
  input?: unknown;
}): ToolInterceptionCounters {
  const isMemoryRead = event.toolName === "khala_read_memory";
  return {
    incrementTaskToolCall: !isMemoryRead,
    incrementMemoryToolCallsSinceRead:
      !isMemoryRead && !isSkillMemoryReadToolCall(event),
    isMemoryRead,
  };
}
