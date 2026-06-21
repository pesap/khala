import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { MUTATION_BASH_PATTERN } from "../lib/constants.ts";

export interface ToolCallLike {
  toolName: string;
  input?: unknown;
}

export type ToolEvidenceClass =
  | "memory"
  | "local"
  | "external"
  | "forge"
  | "none"
  | "unknown";

export type ToolMutationClass =
  | "none"
  | "filesystem"
  | "shell"
  | "forge"
  | "memory"
  | "unknown";

export type ToolSideEffectClass =
  | "read_only"
  | "mutation"
  | "shell"
  | "forge"
  | "external"
  | "tool_side_effect"
  | "unknown";

export type MemoryRefreshRequirement =
  | "exempt"
  | "required_before_mutation"
  | "not_required";

export interface ToolGateSatisfaction {
  countsTaskToolCall: boolean;
  agesMemory: boolean;
  satisfiesMemoryRead: boolean;
  persistsMemory: boolean;
}

export interface ToolMetadata {
  name: string;
  evidenceClass: ToolEvidenceClass;
  mutationClass: ToolMutationClass;
  sideEffectClass: ToolSideEffectClass;
  replaySafe: boolean;
  memoryRefreshRequirement: MemoryRefreshRequirement;
  gateSatisfaction: ToolGateSatisfaction;
}

export function isMutationCapableBash(command: string): boolean {
  return MUTATION_BASH_PATTERN.test(command);
}

function eventCommand(event: ToolCallLike): string {
  const input = event.input as { command?: unknown; cmd?: unknown } | undefined;
  if (typeof input?.command === "string") return input.command;
  return typeof input?.cmd === "string" ? input.cmd : "";
}

function fallbackEvidenceClass(toolName: string): ToolEvidenceClass {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("github") ||
    normalized === "gh" ||
    normalized.includes("gitlab") ||
    normalized.includes("forge")
  ) {
    return "forge";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("fetch") ||
    normalized.includes("search") ||
    normalized.includes("http")
  ) {
    return "external";
  }
  if (
    normalized.includes("read") ||
    normalized.includes("list") ||
    normalized.includes("view") ||
    normalized.includes("stat")
  ) {
    return "local";
  }
  return "unknown";
}

function fallbackSideEffectClass(toolName: string): ToolSideEffectClass {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell")) return "shell";
  if (
    normalized.includes("github") ||
    normalized === "gh" ||
    normalized.includes("gitlab") ||
    normalized.includes("forge")
  ) {
    return "forge";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("fetch") ||
    normalized.includes("search") ||
    normalized.includes("http")
  ) {
    return "external";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("apply")
  ) {
    return "mutation";
  }
  if (
    normalized.includes("read") ||
    normalized.includes("list") ||
    normalized.includes("view") ||
    normalized.includes("stat")
  ) {
    return "read_only";
  }
  return "unknown";
}

function requiresMemoryRefreshForSideEffect(
  sideEffectClass: ToolSideEffectClass,
): boolean {
  return (
    sideEffectClass === "mutation" ||
    sideEffectClass === "shell" ||
    sideEffectClass === "forge" ||
    sideEffectClass === "tool_side_effect" ||
    sideEffectClass === "unknown"
  );
}

function metadata(params: {
  name: string;
  evidenceClass: ToolEvidenceClass;
  mutationClass: ToolMutationClass;
  sideEffectClass: ToolSideEffectClass;
  replaySafe: boolean;
  memoryRefreshRequirement: MemoryRefreshRequirement;
  gateSatisfaction?: Partial<ToolGateSatisfaction>;
}): ToolMetadata {
  return {
    name: params.name,
    evidenceClass: params.evidenceClass,
    mutationClass: params.mutationClass,
    sideEffectClass: params.sideEffectClass,
    replaySafe: params.replaySafe,
    memoryRefreshRequirement: params.memoryRefreshRequirement,
    gateSatisfaction: {
      countsTaskToolCall: true,
      agesMemory: true,
      satisfiesMemoryRead: false,
      persistsMemory: false,
      ...params.gateSatisfaction,
    },
  };
}

export function getToolMetadata(event: ToolCallLike): ToolMetadata {
  const { toolName } = event;

  if (toolName === "functions.apply_patch" || toolName === "apply_patch") {
    return metadata({
      name: toolName,
      evidenceClass: "local",
      mutationClass: "filesystem",
      sideEffectClass: "mutation",
      replaySafe: false,
      memoryRefreshRequirement: "required_before_mutation",
      gateSatisfaction: {
        agesMemory: true,
      },
    });
  }

  if (toolName === "khala_read_memory") {
    return metadata({
      name: toolName,
      evidenceClass: "memory",
      mutationClass: "none",
      sideEffectClass: "read_only",
      replaySafe: true,
      memoryRefreshRequirement: "exempt",
      gateSatisfaction: {
        countsTaskToolCall: false,
        agesMemory: false,
        satisfiesMemoryRead: true,
      },
    });
  }

  if (toolName === "khala_search_memory") {
    return metadata({
      name: toolName,
      evidenceClass: "memory",
      mutationClass: "none",
      sideEffectClass: "read_only",
      replaySafe: true,
      memoryRefreshRequirement: "exempt",
      gateSatisfaction: {
        agesMemory: false,
      },
    });
  }

  if (toolName === "khala_learn") {
    return metadata({
      name: toolName,
      evidenceClass: "memory",
      mutationClass: "memory",
      sideEffectClass: "tool_side_effect",
      replaySafe: false,
      memoryRefreshRequirement: "exempt",
      gateSatisfaction: {
        agesMemory: false,
        persistsMemory: true,
      },
    });
  }

  const piEvent = event as ToolCallEvent;
  if (isToolCallEventType("edit", piEvent) || isToolCallEventType("write", piEvent)) {
    return metadata({
      name: toolName,
      evidenceClass: "none",
      mutationClass: "filesystem",
      sideEffectClass: "mutation",
      replaySafe: false,
      memoryRefreshRequirement: "required_before_mutation",
    });
  }

  if (
    isToolCallEventType("bash", piEvent) ||
    toolName === "functions.exec_command" ||
    toolName === "exec_command"
  ) {
    const mutating = isMutationCapableBash(eventCommand(event));
    return metadata({
      name: toolName,
      evidenceClass: mutating ? "none" : "local",
      mutationClass: mutating ? "shell" : "none",
      sideEffectClass: mutating ? "shell" : "read_only",
      replaySafe: !mutating,
      memoryRefreshRequirement: mutating
        ? "required_before_mutation"
        : "not_required",
    });
  }

  const sideEffectClass = fallbackSideEffectClass(toolName);
  return metadata({
    name: toolName,
    evidenceClass: fallbackEvidenceClass(toolName),
    mutationClass:
      sideEffectClass === "mutation"
        ? "unknown"
        : sideEffectClass === "forge"
          ? "forge"
          : "none",
    sideEffectClass,
    replaySafe: sideEffectClass === "read_only",
    memoryRefreshRequirement: requiresMemoryRefreshForSideEffect(sideEffectClass)
      ? "required_before_mutation"
      : "not_required",
  });
}

export function isKhalaMemoryToolName(toolName: string): boolean {
  return (
    toolName === "khala_read_memory" ||
    toolName === "khala_search_memory" ||
    toolName === "khala_learn"
  );
}

export function isMemoryRefreshToolName(toolName: string): boolean {
  return toolName === "khala_read_memory";
}

export function isMemoryPersistenceToolName(toolName: string): boolean {
  return toolName === "khala_learn";
}

export function isSkillMemoryReadToolCall(event: {
  name?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  input?: unknown;
}): boolean {
  const name = event.name ?? event.toolName;
  if (name !== "read") return false;
  const input =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>)
      : {};
  const path = typeof event.args?.path === "string" ? event.args.path : typeof input.path === "string" ? input.path : "";
  if (!path) return false;

  const normalizedPath = path.replace(/\\/g, "/");
  return (
    normalizedPath.startsWith("skills/") ||
    normalizedPath.startsWith(".agents/skills/") ||
    normalizedPath.startsWith(".pi/khala/skills/") ||
    normalizedPath.includes("/skills/") ||
    normalizedPath.includes("/.agents/skills/") ||
    normalizedPath.includes("/.pi/khala/skills/")
  );
}

export function isMutationToolCall(event: ToolCallEvent): boolean {
  const metadata = getToolMetadata(event);
  return (
    metadata.memoryRefreshRequirement === "required_before_mutation" &&
    metadata.mutationClass !== "none"
  );
}

export function requiresFreshMemoryToolCall(event: ToolCallEvent): boolean {
  return getToolMetadata(event).memoryRefreshRequirement === "required_before_mutation";
}
