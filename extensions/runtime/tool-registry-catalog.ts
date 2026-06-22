import {
  APPLY_PATCH_TOOL_NAMES,
  COMMAND_METADATA_TOOL_NAMES,
  FILESYSTEM_MUTATION_TOOL_NAMES,
  getToolMetadata,
  KHALA_MEMORY_TOOL_NAMES,
  type ToolCallLike,
  type ToolMetadata,
} from "./tool-registry.ts";

export interface ToolRegistryEntry {
  toolName: ToolRegistryToolName;
  metadata: ToolMetadata;
}

export const TOOL_REGISTRY_TOOL_NAMES = [
  ...APPLY_PATCH_TOOL_NAMES,
  "ast_search",
  "browser_open",
  "browser_search",
  "bun",
  "fetch",
  "fff",
  "find",
  "forge",
  ...FILESYSTEM_MUTATION_TOOL_NAMES,
  "grep",
  "github",
  "github.create_pull_request",
  ...KHALA_MEMORY_TOOL_NAMES,
  "loadSkill",
  ...COMMAND_METADATA_TOOL_NAMES,
  "ls",
  "memory_search",
  "read",
  "readSkill",
  "search",
  "skill_load",
  "skill_read",
  "web.run",
  "web.search_query",
  "web_search",
] as const;

export type ToolRegistryToolName = (typeof TOOL_REGISTRY_TOOL_NAMES)[number];

export function listToolRegistryEntries(): readonly ToolRegistryEntry[] {
  return TOOL_REGISTRY_TOOL_NAMES.map((toolName) => ({
    toolName,
    metadata: getToolMetadata({ toolName } satisfies ToolCallLike),
  }));
}

export function getRegisteredToolMetadata(
  toolName: ToolRegistryToolName,
): ToolMetadata {
  return getToolMetadata({ toolName } satisfies ToolCallLike);
}
