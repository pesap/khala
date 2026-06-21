import {
  getToolMetadata,
  type ToolMetadata,
} from "./tool-registry.ts";

export type ToolRegistryToolName =
  | "apply_patch"
  | "bash"
  | "bun"
  | "edit"
  | "forge"
  | "github"
  | "khala_search_memory"
  | "memory_search"
  | "read"
  | "search"
  | "write";

export interface ToolRegistryEntry {
  toolName: ToolRegistryToolName;
  metadata: ToolMetadata;
}

export const TOOL_REGISTRY_TOOL_NAMES: readonly ToolRegistryToolName[] = [
  "apply_patch",
  "bash",
  "bun",
  "edit",
  "forge",
  "github",
  "khala_search_memory",
  "memory_search",
  "read",
  "search",
  "write",
];

export function listToolRegistryEntries(): readonly ToolRegistryEntry[] {
  return TOOL_REGISTRY_TOOL_NAMES.map((toolName) => ({
    toolName,
    metadata: getToolMetadata({ toolName } as never),
  }));
}

export function getRegisteredToolMetadata(
  toolName: ToolRegistryToolName,
): ToolMetadata {
  return getToolMetadata({ toolName } as never);
}
