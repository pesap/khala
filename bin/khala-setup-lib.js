import { existsSync, readFileSync } from "node:fs";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Permits any non-empty trimmed string except slashes (reserved for the
// `<provider>/<model>` prefix used by the workflow profile picker) and
// colons (reserved for the `:thinking` suffix). Whitespace is allowed inside
// because real LiteLLM hubs publish model ids with spaces (e.g. vendor
// catalog entries like "HALO Gemma 4").
const MODEL_PATTERN_RE = /^[^/:]+$/;

export const MALFORMED_PROFILE_MESSAGE =
  "Expected format: provider/model:thinking (example: github-copilot/gpt-5.4-mini:medium)";
export const LITELLM_PROVIDER_API = "openai-completions";
export const LITELLM_PROVIDER_APIS = new Set(["openai-completions", "openai-responses"]);

/**
 * Build the picker choices for one workflow profile.
 *
 * Returns every `provider/model` we know about, in a stable order:
 *   1. Everything pi reported via `pi --list-models`.
 *   2. Every explicitly-listed model on every LiteLLM provider in models.json.
 *   3. Preset fallback ids (without their thinking suffix) so the user can
 *      still pick recommended models when pi is unavailable.
 *
 * The picker no longer filters by profile, because the caller wants full
 * model freedom; the default highlighted entry is the responsibility of the
 * caller (see askProfile).
 */
export function buildProfileChoices(providers, discoveryRows, fallbackChoices) {
  const seen = new Set();
  const choices = [];

  for (const row of discoveryRows) {
    const id = `${row.provider}/${row.model}`;
    if (!seen.has(id)) { seen.add(id); choices.push(id); }
  }

  for (const provider of providers) {
    if (!provider.models.length) continue;
    for (const model of provider.models) {
      const id = `${provider.name}/${model}`;
      if (!seen.has(id)) { seen.add(id); choices.push(id); }
    }
  }

  for (const preset of fallbackChoices) {
    const id = preset.split(":")[0];
    if (!seen.has(id)) { seen.add(id); choices.push(id); }
  }

  return choices;
}

/**
 * Return whether pi's discovery rows say `provider/model` supports thinking.
 * Unknown rows (missing / no thinking column) default to true so the user
 * keeps control and pi validates at install time.
 */
export function modelSupportsThinking(discoveryRows, provider, model) {
  const match = discoveryRows.find((r) => r.provider === provider && r.model === model);
  if (!match || match.thinking === undefined) return true;
  return match.thinking === true;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

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

export function validateLiteLLMProviderId(raw) {
  const value = trimOrEmpty(raw);
  if (!PROVIDER_ID_RE.test(value)) {
    throw new Error(
      "Provider id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and may only contain letters, numbers, dot, underscore, and hyphen.",
    );
  }
  return value;
}

export function validateLiteLLMKeyEnv(raw) {
  const value = trimOrEmpty(raw);
  if (!ENV_VAR_RE.test(value)) {
    throw new Error(
      "Key environment variable must match ^[A-Za-z_][A-Za-z0-9_]*$.",
    );
  }
  return value;
}

export function normalizeLiteLLMBaseUrl(raw) {
  const value = trimOrEmpty(raw);
  if (!value) {
    throw new Error("LiteLLM base URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid LiteLLM base URL: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LiteLLM base URL must start with http:// or https://.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("LiteLLM base URL must not include a query string or fragment.");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return pathname ? `${parsed.origin}${pathname}` : parsed.origin;
}

export function normalizeLiteLLMModelPattern(raw) {
  const value = trimOrEmpty(raw);
  if (!MODEL_PATTERN_RE.test(value)) {
    throw new Error("LiteLLM model id must not contain '/' or ':' (those are reserved for the provider prefix and thinking suffix).");
  }
  return value;
}

/**
 * Reduce a list of raw model-name strings to the valid, dedup'd bare names
 * that can safely be offered in the LiteLLM model picker. Anything that fails
 * normalizeLiteLLMModelPattern (whitespace, slash, colon, empty, non-string)
 * is silently dropped so the picker can't surface a value that would later
 * fail validation when the user tried to pick it.
 */
export function filterValidLiteLLMModelNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    let valid;
    try { valid = normalizeLiteLLMModelPattern(name); } catch { continue; }
    if (seen.has(valid)) continue;
    seen.add(valid);
    result.push(valid);
  }
  return result;
}

function normalizeExistingBaseUrl(raw) {
  try {
    return normalizeLiteLLMBaseUrl(raw);
  } catch {
    return null;
  }
}

function mergeModelEntries(existingModels, modelId) {
  const models = Array.isArray(existingModels)
    ? existingModels.filter(isPlainObject).map((model) => ({ ...model }))
    : [];

  const index = models.findIndex((model) => trimOrEmpty(model.id) === modelId);
  if (index >= 0) {
    models[index] = { ...models[index], id: modelId };
    return models;
  }

  models.push({ id: modelId });
  return models;
}

function mergeEnabledModels(existingEnabledModels, modelId) {
  const enabledModels = Array.isArray(existingEnabledModels)
    ? existingEnabledModels.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];

  if (!enabledModels.includes(modelId)) {
    enabledModels.push(modelId);
  }

  return enabledModels;
}

/**
 * Compact-but-readable JSON serializer for models.json. Identical to
 * `JSON.stringify(value, null, 2)` for top-level structure, except each
 * `{ "id": "..." }` single-field object in a `models: [...]` array is
 * collapsed onto a single line. Pi parses JSON, so whitespace is
 * insignificant, but the file is human-edited often enough that a 23-entry
 * provider being 69 lines instead of 23 is a meaningful UX regression.
 *
 * Model entries with extra fields (e.g. `displayName`, `thinking`) keep the
 * default multi-line shape because the regex only matches single-`id`
 * objects.
 */
export function stringifyModelsJson(value) {
  const pretty = JSON.stringify(value, null, 2);
  // Match `{ \n <indent> "id": "..." \n <indent> }` and collapse to one line.
  // The id-string capture handles backslash-escaped characters so model names
  // with embedded quotes round-trip unchanged.
  return pretty.replace(
    /\{\n\s*"id":\s*("(?:[^"\\]|\\.)*")\n\s*\}/g,
    '{ "id": $1 }',
  );
}

export function readJsonObjectFile(filePath) {
  if (!existsSync(filePath)) return null;

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

/**
 * Normalize a list of LiteLLM model ids from caller options.
 *
 * Accepts either modelIds (array, preferred) or the legacy modelId (single
 * string). Returns at least one normalized bare model name; throws if no
 * valid id was supplied. Dedups while preserving the original order so the
 * first selected model remains the default in mergeLiteLLMProjectSettings.
 */
function normalizeModelIdList(options) {
  let raw;
  if (Array.isArray(options.modelIds)) raw = options.modelIds;
  else if (typeof options.modelId === "string") raw = [options.modelId];
  else raw = [];

  const seen = new Set();
  const result = [];
  for (const candidate of raw) {
    const normalized = normalizeLiteLLMModelPattern(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (!result.length) {
    throw new Error("LiteLLM merge requires at least one model id.");
  }
  return result;
}

export function mergeLiteLLMModelsJson(current, options) {
  const providerId = validateLiteLLMProviderId(options.providerId);
  const baseUrl = normalizeLiteLLMBaseUrl(options.baseUrl);
  const keyEnv = validateLiteLLMKeyEnv(options.keyEnv);
  const modelIds = normalizeModelIdList(options);

  const root = isPlainObject(current) ? { ...current } : {};
  const providers = isPlainObject(root.providers) ? { ...root.providers } : {};
  const existingProvider = isPlainObject(providers[providerId]) ? { ...providers[providerId] } : {};
  const existingApi = trimOrEmpty(existingProvider.api);
  const existingBaseUrl = typeof existingProvider.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const normalizedExistingBaseUrl = existingBaseUrl ? normalizeExistingBaseUrl(existingBaseUrl) : null;

  const conflict = Boolean(
    (existingApi && !LITELLM_PROVIDER_APIS.has(existingApi)) ||
    (normalizedExistingBaseUrl && normalizedExistingBaseUrl !== baseUrl),
  );

  let mergedModelEntries = existingProvider.models;
  for (const id of modelIds) mergedModelEntries = mergeModelEntries(mergedModelEntries, id);

  providers[providerId] = {
    ...existingProvider,
    baseUrl,
    api: LITELLM_PROVIDER_API,
    apiKey: `$${keyEnv}`,
    models: mergedModelEntries,
  };

  root.providers = providers;
  return { value: root, conflict };
}

export function mergeLiteLLMProjectSettings(current, options) {
  const providerId = validateLiteLLMProviderId(options.providerId);
  const modelIds = normalizeModelIdList(options);

  const root = isPlainObject(current) ? { ...current } : {};
  root.defaultProvider = providerId;
  root.defaultModel = modelIds[0];
  let mergedEnabled = root.enabledModels;
  for (const id of modelIds) mergedEnabled = mergeEnabledModels(mergedEnabled, id);
  root.enabledModels = mergedEnabled;

  return root;
}
