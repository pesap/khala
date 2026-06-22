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

export const TOOL_CONTEXT_INPUT_KEYS = [
  "path",
  "file",
  "cwd",
  "command",
  "cmd",
  "pattern",
  "query",
] as const;

const EVIDENCE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ast_search",
  "fff",
  "search",
  "web.run",
  "web_search",
  "khala_read_memory",
  "khala_search_memory",
]);
const LOCAL_EVIDENCE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "ast_search",
  "fff",
]);
const EXTERNAL_EVIDENCE_TOOL_NAMES = new Set([
  "search",
  "web.run",
  "web.search_query",
  "web_search",
  "browser_search",
  "browser_open",
  "fetch",
]);
const DEDUPE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ast_search",
  "fff",
  "search",
  "web.run",
  "web_search",
  "browser_search",
  "browser_open",
  "fetch",
  "khala_read_memory",
  "khala_search_memory",
  "bash",
]);
const TOOL_DEDUPE_RESET_NAMES = new Set([
  "edit",
  "write",
  "khala_learn",
]);
const READ_ONLY_LOCAL_EVIDENCE_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "grep",
  "find",
  "ls",
  "ast_search",
  "fff",
]);
const READ_ONLY_EXTERNAL_EVIDENCE_TOOL_NAMES = new Set([
  "search",
  "web.run",
  "web.search_query",
  "web_search",
  "browser_search",
  "browser_open",
  "fetch",
]);

export const LOCAL_FILE_READ_TOOL_NAMES = [
  "read",
  "read_file",
] as const;

export const KHALA_MEMORY_TOOL_NAMES = [
  "khala_read_memory",
  "khala_search_memory",
  "khala_learn",
] as const;

export const MEMORY_REFRESH_TOOL_NAMES = [
  "khala_read_memory",
] as const;

export const MEMORY_SEARCH_TOOL_NAMES = [
  "khala_search_memory",
] as const;

export const MEMORY_PERSISTENCE_TOOL_NAMES = [
  "khala_learn",
] as const;

export const EXTERNAL_SEARCH_TOOL_NAMES = [
  "search",
  "web.run",
  "web.search_query",
  "web_search",
  "browser_search",
] as const;

export const EXTERNAL_OPEN_TOOL_NAMES = [
  "browser_open",
  "fetch",
  "web.run",
] as const;

export const APPLY_PATCH_TOOL_NAMES = [
  "apply_patch",
  "functions.apply_patch",
] as const;

export const FILESYSTEM_MUTATION_TOOL_NAMES = [
  "edit",
  "functions.edit",
  "functions.write",
  "write",
] as const;

export const COMMAND_EXECUTION_TOOL_NAMES = [
  "bash",
  "exec",
  "exec_command",
  "functions.exec_command",
  "shell",
  "run",
] as const;

export const COMMAND_METADATA_TOOL_NAMES = [
  ...COMMAND_EXECUTION_TOOL_NAMES,
] as const;

export const MEMORY_GATE_RETRY_TOOL_NAMES = [
  ...FILESYSTEM_MUTATION_TOOL_NAMES,
  ...APPLY_PATCH_TOOL_NAMES,
  ...COMMAND_EXECUTION_TOOL_NAMES,
] as const;

const KHALA_MEMORY_TOOL_NAME_SET = new Set<string>(KHALA_MEMORY_TOOL_NAMES);
const MEMORY_REFRESH_TOOL_NAME_SET = new Set<string>(MEMORY_REFRESH_TOOL_NAMES);
const MEMORY_SEARCH_TOOL_NAME_SET = new Set<string>(MEMORY_SEARCH_TOOL_NAMES);
const MEMORY_PERSISTENCE_TOOL_NAME_SET = new Set<string>(MEMORY_PERSISTENCE_TOOL_NAMES);
const EXTERNAL_SEARCH_TOOL_NAME_SET = new Set<string>(EXTERNAL_SEARCH_TOOL_NAMES);
const EXTERNAL_OPEN_TOOL_NAME_SET = new Set<string>(EXTERNAL_OPEN_TOOL_NAMES);
const LOCAL_FILE_READ_TOOL_NAME_SET = new Set<string>(LOCAL_FILE_READ_TOOL_NAMES);
const APPLY_PATCH_TOOL_NAME_SET = new Set<string>(APPLY_PATCH_TOOL_NAMES);
const FILESYSTEM_MUTATION_TOOL_NAME_SET = new Set<string>(FILESYSTEM_MUTATION_TOOL_NAMES);
const COMMAND_EXECUTION_TOOL_NAME_SET = new Set<string>(COMMAND_EXECUTION_TOOL_NAMES);
const COMMAND_METADATA_TOOL_NAME_SET = new Set<string>(COMMAND_METADATA_TOOL_NAMES);
const MEMORY_GATE_RETRY_TOOL_NAME_SET = new Set<string>(MEMORY_GATE_RETRY_TOOL_NAMES);

const CONSERVATIVE_UNSAFE_SIDE_EFFECTS = new Set<ToolSideEffectClass>([
  "mutation",
  "shell",
  "forge",
  "external",
  "tool_side_effect",
  "unknown",
]);

export function isMutationCapableBash(command: string): boolean {
  return (
    MUTATION_BASH_PATTERN.test(command) ||
    SCRIPTED_WRITE_PATTERN.test(command) ||
    ADDITIONAL_SHELL_MUTATION_PATTERN.test(command)
  );
}

const SCRIPTED_WRITE_PATTERN =
  /\b(?:python3?|uv\s+run\s+python|node|bun|deno)\b[\s\S]*\b(?:Path\s*\([^)]*\)\.(?:write_text|write_bytes)|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|Deno\.writeTextFile(?:Sync)?|Deno\.writeFile(?:Sync)?)\b/i;
const ADDITIONAL_SHELL_MUTATION_PATTERN =
  /\b(?:npm\s+pkg\s+set|cargo\s+(?:add|remove|update)|go\s+get|rsync\s+\S+|tar\s+[\s\S]*\s-C\s+\S+|unzip\s+[\s\S]*\s-d\s+\S+|install\s+(?:-[\w=]+\s+)*\S+)\b/i;

function eventCommand(event: ToolCallLike): string {
  const input = event.input as { command?: unknown; cmd?: unknown } | undefined;
  if (typeof input?.command === "string") return input.command;
  return typeof input?.cmd === "string" ? input.cmd : "";
}

export function toolCallContextParts(event: ToolCallLike): string[] {
  const input = event.input as Record<string, unknown> | undefined;
  const parts = [event.toolName];
  for (const key of TOOL_CONTEXT_INPUT_KEYS) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}:${value.trim().slice(0, 180)}`);
    }
  }
  return parts;
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

  if (READ_ONLY_LOCAL_EVIDENCE_TOOL_NAMES.has(toolName)) {
    return metadata({
      name: toolName,
      evidenceClass: "local",
      mutationClass: "none",
      sideEffectClass: "read_only",
      replaySafe: true,
      memoryRefreshRequirement: "not_required",
    });
  }

  if (isSkillLoaderToolName(toolName)) {
    return metadata({
      name: toolName,
      evidenceClass: "local",
      mutationClass: "none",
      sideEffectClass: "read_only",
      replaySafe: true,
      memoryRefreshRequirement: "not_required",
    });
  }

  if (READ_ONLY_EXTERNAL_EVIDENCE_TOOL_NAMES.has(toolName)) {
    return metadata({
      name: toolName,
      evidenceClass: "external",
      mutationClass: "none",
      sideEffectClass: "external",
      replaySafe: false,
      memoryRefreshRequirement: "not_required",
    });
  }

  if (APPLY_PATCH_TOOL_NAME_SET.has(toolName)) {
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

  if (FILESYSTEM_MUTATION_TOOL_NAME_SET.has(toolName)) {
    return metadata({
      name: toolName,
      evidenceClass: "none",
      mutationClass: "filesystem",
      sideEffectClass: "mutation",
      replaySafe: false,
      memoryRefreshRequirement: "required_before_mutation",
    });
  }

  if (COMMAND_METADATA_TOOL_NAME_SET.has(toolName)) {
    const command = eventCommand(event);
    const mutating = !command.trim() || isMutationCapableBash(command);
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
  return KHALA_MEMORY_TOOL_NAME_SET.has(toolName);
}

export function isMemoryRefreshToolName(toolName: string): boolean {
  return MEMORY_REFRESH_TOOL_NAME_SET.has(toolName);
}

export function isMemorySearchToolName(toolName: string): boolean {
  return MEMORY_SEARCH_TOOL_NAME_SET.has(toolName);
}

export function isMemoryPersistenceToolName(toolName: string): boolean {
  return MEMORY_PERSISTENCE_TOOL_NAME_SET.has(toolName);
}

export function isExternalSearchToolName(toolName: string): boolean {
  return EXTERNAL_SEARCH_TOOL_NAME_SET.has(toolName);
}

export function isExternalOpenToolName(toolName: string): boolean {
  return EXTERNAL_OPEN_TOOL_NAME_SET.has(toolName);
}

export function isKnownMemoryGateRetryToolName(toolName: string): boolean {
  return MEMORY_GATE_RETRY_TOOL_NAME_SET.has(toolName);
}

export function isCommandExecutionToolName(toolName: string): boolean {
  return COMMAND_EXECUTION_TOOL_NAME_SET.has(toolName);
}

export function isLocalFileReadToolName(toolName: string): boolean {
  return LOCAL_FILE_READ_TOOL_NAME_SET.has(toolName);
}

export function isSkillLoaderToolName(toolName: string): boolean {
  return /(?:^|[_.:-])(?:readSkill|loadSkill|skill_read|skill_load)(?:$|[_.:-])/i.test(
    toolName,
  );
}

export function toolNameLooksLikeExternalEvidence(toolName: string): boolean {
  if (isKhalaMemoryToolName(toolName)) return false;
  return /(?:^|[_:.-])(?:research|search|browse|source|doc|docs|web)(?:$|[_:.-])/i.test(
    toolName,
  );
}

export function isLocalEvidenceToolCall(event: ToolCallLike): boolean {
  if (LOCAL_EVIDENCE_TOOL_NAMES.has(event.toolName)) return true;
  const metadata = getToolMetadata(event);
  return (
    metadata.evidenceClass === "local" &&
    metadata.sideEffectClass === "read_only"
  );
}

export function isExternalEvidenceToolCall(event: ToolCallLike): boolean {
  if (EXTERNAL_EVIDENCE_TOOL_NAMES.has(event.toolName)) return true;
  const metadata = getToolMetadata(event);
  return (
    metadata.evidenceClass === "external" ||
    metadata.sideEffectClass === "external" ||
    toolNameLooksLikeExternalEvidence(event.toolName)
  );
}

export function isEvidenceToolCall(event: ToolCallLike): boolean {
  if (EVIDENCE_TOOL_NAMES.has(event.toolName)) return true;
  const metadata = getToolMetadata(event);
  if (
    metadata.sideEffectClass !== "read_only" &&
    metadata.sideEffectClass !== "external"
  ) {
    return false;
  }
  return (
    metadata.evidenceClass === "local" ||
    metadata.evidenceClass === "external" ||
    metadata.evidenceClass === "memory" ||
    toolNameLooksLikeExternalEvidence(event.toolName)
  );
}

export function isDuplicateEvidenceCandidateToolCall(event: ToolCallLike): boolean {
  return (
    DEDUPE_TOOL_NAMES.has(event.toolName) ||
    isExternalEvidenceToolCall(event)
  );
}

export function resetsDuplicateEvidenceWindowToolCall(event: ToolCallLike): boolean {
  return (
    TOOL_DEDUPE_RESET_NAMES.has(event.toolName) ||
    isMutationToolCall(event)
  );
}

export function isSkillMemoryReadToolCall(event: {
  name?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  input?: unknown;
}): boolean {
  const name = event.name ?? event.toolName;
  if (!name || !isLocalFileReadToolName(name)) return false;
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

export function isMutationToolCall(event: ToolCallLike): boolean {
  const metadata = getToolMetadata(event);
  return (
    metadata.memoryRefreshRequirement === "required_before_mutation" &&
    metadata.mutationClass !== "none"
  );
}

export function requiresFreshMemoryToolCall(event: ToolCallLike): boolean {
  return getToolMetadata(event).memoryRefreshRequirement === "required_before_mutation";
}

export function isMemoryGateRetryToolCall(event: ToolCallLike): boolean {
  return isKnownMemoryGateRetryToolName(event.toolName) || isMutationToolCall(event);
}

export function isUnsafeForConservativeReplay(params: {
  replaySafe?: boolean;
  sideEffectClass?: ToolSideEffectClass;
}): boolean {
  return (
    params.replaySafe === false ||
    (params.sideEffectClass
      ? CONSERVATIVE_UNSAFE_SIDE_EFFECTS.has(params.sideEffectClass)
      : false)
  );
}
