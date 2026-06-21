import {
  getToolMetadata,
  isSkillMemoryReadToolCall as isRegistrySkillMemoryReadToolCall,
} from "./tool-registry.ts";

export interface ToolInterceptionCounters {
  incrementTaskToolCall: boolean;
  incrementMemoryToolCallsSinceRead: boolean;
  isMemoryRead: boolean;
}

export {
  isKhalaMemoryToolName,
  isMemoryPersistenceToolName,
  requiresFreshMemoryToolCall,
} from "./tool-registry.ts";

export function isSkillMemoryReadToolCall(event: {
  toolName: string;
  input?: unknown;
}): boolean {
  return isRegistrySkillMemoryReadToolCall(event);
}

export function getToolInterceptionCounters(event: {
  toolName: string;
  input?: unknown;
}): ToolInterceptionCounters {
  const metadata = getToolMetadata(event);
  return {
    incrementTaskToolCall: metadata.gateSatisfaction.countsTaskToolCall,
    incrementMemoryToolCallsSinceRead:
      metadata.gateSatisfaction.agesMemory && !isSkillMemoryReadToolCall(event),
    isMemoryRead: metadata.gateSatisfaction.satisfiesMemoryRead,
  };
}
