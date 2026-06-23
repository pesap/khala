const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const MALFORMED_PROFILE_MESSAGE =
  "Expected format: provider/model:thinking (example: github-copilot/gpt-5.4-mini:medium)";

export function parseProfileEntry(entry) {
  if (typeof entry !== "string") return null;

  const trimmed = entry.trim();
  if (!trimmed) return null;

  const lastColonIndex = trimmed.lastIndexOf(":");
  const modelId = lastColonIndex > 0 ? trimmed.slice(0, lastColonIndex).trim() : trimmed;
  const thinkingLevel = lastColonIndex > 0 ? trimmed.slice(lastColonIndex + 1).trim() : "medium";

  if (!modelId || !/^\S+\/\S+$/.test(modelId)) return null;
  if (!THINKING_LEVELS.has(thinkingLevel)) return null;

  return { modelId, thinkingLevel };
}

export function normalizeCustomProfileEntry(entry, fallback) {
  const parsed = parseProfileEntry(entry);
  if (!parsed) {
    return { value: fallback, errorMessage: MALFORMED_PROFILE_MESSAGE };
  }

  return { value: `${parsed.modelId}:${parsed.thinkingLevel}` };
}
