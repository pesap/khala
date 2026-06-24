import { existsSync, readFileSync } from "node:fs";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// LiteLLM portal key labels are user-facing and often include dashes or dots
// (e.g. `reeds-maint`, `team.litellm.prod`). Allow the same shape we accept
// for provider ids — leading alnum or underscore, then alnum/[._-]. The shell
// env var name is *derived* from this; users don't have to invent two names.
const KEY_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
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

export function buildLiteLLMApiKeyCommand(providerId) {
  const provider = validateLiteLLMProviderId(providerId);
  return `!khala litellm print-key --provider ${provider}`;
}

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
  if (KEY_NAME_RE.test(value)) return value;
  // Historical name kept for module-level imports; this validates a key
  // *name* (portal label), not a shell identifier. The actual shell env
  // var is derived from this via deriveEnvVarFromKeyName(). Reject only
  // shapes we can't safely round-trip — empty, whitespace, slashes, etc.
  const detail = !value
    ? "got empty input"
    : `'${value}' must start with a letter, digit, or '_' and use only [A-Za-z0-9._-]`;
  throw new Error(
    `Key name is invalid: ${detail}. It will be derived to a shell env var (e.g. 'reeds-maint' → $REEDS_MAINT).`,
  );
}

/**
 * Derive a POSIX shell env var name from a LiteLLM portal key label.
 *
 * Users name keys on the LiteLLM admin portal with friendly labels like
 * `reeds-maint` or `team.litellm.prod`. Forcing them to invent a separate
 * shell-identifier name (REEDS_MAINT) and remember the mapping is the UX
 * regression #235 surfaced. Instead, we accept the portal label verbatim,
 * and at every shell-touching point (export instructions, process.env
 * lookups in print-key) we derive the env name from it deterministically:
 * non-identifier runs collapse to '_', leading digits are dropped, then
 * uppercase. The derivation is idempotent on already-valid identifiers,
 * so users who type `LITELLM_API_KEY` get exactly that back.
 *
 * Returns null only when the input normalizes to empty (e.g. `'!!!'`).
 */
export function deriveEnvVarFromKeyName(raw) {
  const value = trimOrEmpty(raw);
  if (!value) return null;
  if (ENV_VAR_RE.test(value)) return value; // already a valid identifier; preserve case
  const cleaned = value
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[0-9]+/, "")  // identifiers can't start with a digit; strip first
    .replace(/^_+|_+$/g, "") // then strip any underscore the digit-strip exposed
    .toUpperCase();
  if (!cleaned || !ENV_VAR_RE.test(cleaned)) return null;
  return cleaned;
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

// Thinking level map written verbatim into every enriched reasoning-capable
// entry. Mirrors pi's six internal levels and the strings the upstream
// OpenAI-style reasoning APIs accept. LiteLLM doesn't surface this mapping,
// so we provide a sane default that the user can hand-edit if a specific
// model needs a different shape.
export const DEFAULT_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
});

function costPerMillion(perToken) {
  if (typeof perToken !== "number" || !Number.isFinite(perToken)) return null;
  // Round to 6 decimal places. JS floating-point makes 0.0000025 * 1_000_000
  // come back as 2.4999999999999996 without rounding, which would write ugly
  // long tails into models.json.
  return Math.round(perToken * 1e12) / 1e6;
}

/**
 * Parse a LiteLLM `/model/info` response body into a Map keyed by model_name
 * whose values are pi-shaped enriched entries (id, name, reasoning,
 * thinkingLevelMap, input, contextWindow, maxTokens, cost).
 *
 * Returns an empty Map on a missing or malformed response — never throws on
 * shape mismatch, so callers don't have to wrap every call in try/catch.
 * Network and HTTP-status errors are the caller's responsibility.
 */
export function parseLiteLLMModelInfoResponse(json) {
  const map = new Map();
  if (!isPlainObject(json) || !Array.isArray(json.data)) return map;
  for (const item of json.data) {
    if (!isPlainObject(item)) continue;
    const modelName = trimOrEmpty(item.model_name);
    if (!modelName) continue;
    const info = isPlainObject(item.model_info) ? item.model_info : {};
    const entry = { id: modelName, name: modelName };

    if (info.supports_reasoning === true) {
      entry.reasoning = true;
      entry.thinkingLevelMap = { ...DEFAULT_THINKING_LEVEL_MAP };
    }

    const inputs = ["text"];
    if (info.supports_vision === true) inputs.push("image");
    if (info.supports_audio_input === true) inputs.push("audio");
    entry.input = inputs;

    if (Number.isFinite(info.max_input_tokens)) entry.contextWindow = info.max_input_tokens;
    if (Number.isFinite(info.max_output_tokens)) entry.maxTokens = info.max_output_tokens;

    const cost = {};
    const input = costPerMillion(info.input_cost_per_token);
    const output = costPerMillion(info.output_cost_per_token);
    const cacheRead = costPerMillion(info.cache_read_input_token_cost);
    const cacheWrite = costPerMillion(info.cache_creation_input_token_cost);
    if (input != null) cost.input = input;
    if (output != null) cost.output = output;
    if (cacheRead != null) cost.cacheRead = cacheRead;
    if (cacheWrite != null) cost.cacheWrite = cacheWrite;
    if (Object.keys(cost).length > 0) entry.cost = cost;

    map.set(modelName, entry);
  }
  return map;
}

/**
 * Build the per-id model entry list for a provider, in canonical `modelIds`
 * order. For each id, prefer (in order):
 *   1. Freshly-fetched data from `infoMap` (richest, most up-to-date).
 *   2. Existing models.json entry with the same id (preserves fields the
 *      user hand-edited and survives a transient /model/info outage).
 *   3. A bare `{ id, name }` stub.
 *
 * Fresh fields win on overlap; the existing entry only carries forward
 * fields LiteLLM didn't return.
 */
export function buildEnrichedModelEntries(modelIds, infoMap, existingModels) {
  const existingById = new Map();
  if (Array.isArray(existingModels)) {
    for (const entry of existingModels) {
      if (!isPlainObject(entry)) continue;
      const id = trimOrEmpty(entry.id);
      if (id) existingById.set(id, entry);
    }
  }
  return modelIds.map((id) => {
    const fetched = infoMap?.get?.(id);
    const existing = existingById.get(id);
    if (fetched && existing) return { ...existing, ...fetched };
    if (fetched) return { ...fetched };
    if (existing) return { ...existing };
    return { id };
  });
}

export function liteLLMProviderExists(current, providerId) {
  if (!isPlainObject(current)) return false;
  if (!isPlainObject(current.providers)) return false;
  return isPlainObject(current.providers[providerId]);
}

// ── auth.json (pi-canonical key storage) ────────────────────────────────────
//
// Pi's own ~/.pi/agent/auth.json schema, replicated for custom providers like
// LiteLLM. Each entry is one of:
//   { type: "api_key", key: "<literal | $ENV | !command>", env?: {...} }
//   { type: "oauth",   refresh, access, expires }
// Pi's getApiKey(providerId) chain is: --api-key flag > auth.json > env var.
// Writing here means a provider that uses `apiKey: "$NLR_KEY"` in models.json
// can resolve without the env var ever being exported at runtime.

const AUTH_COMMAND_PREFIX = "!";

export function validateAuthCommand(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.startsWith(AUTH_COMMAND_PREFIX) || trimmed.length < 2) {
    throw new Error(
      "Auth command must start with '!' followed by a shell command, e.g.\n" +
      "  !security find-generic-password -ws nlr\n" +
      "  !op read 'op://Personal/NLR/credential'\n" +
      "Pi executes the value after the leading '!' and uses stdout as the key.",
    );
  }
  return trimmed;
}

export function validateAuthLiteral(value) {
  if (typeof value !== "string") {
    throw new Error("Auth key value must be a non-empty string.");
  }
  // Don't .trim() here — a leading/trailing space in a pasted secret is the
  // user's problem and silently fixing it can mask paste errors. We only
  // reject the all-whitespace case so the prompt doesn't store "".
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error("Auth key value must be a non-empty string.");
  }
  // Defense-in-depth: reject obviously corrupted clipboard content like a
  // pasted multi-line block. Real API keys are single-line.
  if (/[\r\n]/.test(value)) {
    throw new Error("Auth key value must be a single line (no embedded newlines). Paste only the key.");
  }
  return value;
}

/**
 * Merge an api_key entry for `providerId` into existing auth.json data.
 * Other providers (api_key OR oauth) are preserved verbatim — only the
 * matching entry is replaced. Returns:
 *   value:    the new root object to write
 *   conflict: true when an existing entry has a different shape (an oauth
 *             entry, or an api_key whose stored key string differs from
 *             the new one) — the caller should require explicit confirm.
 *   isUpdate: true when an entry already existed under that id.
 */
export function mergeAuthJsonApiKey(current, providerId, keyValue) {
  if (typeof providerId !== "string" || !providerId.trim()) {
    throw new Error("providerId is required for auth.json merge");
  }
  if (typeof keyValue !== "string" || !keyValue) {
    throw new Error("key value is required for auth.json merge");
  }
  const id = providerId.trim();
  const root = isPlainObject(current) ? { ...current } : {};
  const existing = isPlainObject(root[id]) ? root[id] : null;
  const conflict = Boolean(
    existing && (existing.type !== "api_key" || (typeof existing.key === "string" && existing.key !== keyValue)),
  );
  // Preserve a pre-existing `env` block if the user set one (e.g. for
  // Cloudflare-style provider-scoped env values); only the `key` field is
  // authoritative from our flow.
  const preserved = existing && existing.type === "api_key" && isPlainObject(existing.env) ? { env: { ...existing.env } } : {};
  root[id] = { type: "api_key", key: keyValue, ...preserved };
  return { value: root, conflict, isUpdate: Boolean(existing) };
}

function mergeEnabledModelList(existingEnabledModels, modelIds) {
  const enabledModels = Array.isArray(existingEnabledModels)
    ? existingEnabledModels.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const seen = new Set(enabledModels);
  for (const id of modelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    enabledModels.push(id);
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
  const modelIds = normalizeModelIdList(options);

  const root = isPlainObject(current) ? { ...current } : {};
  const providers = isPlainObject(root.providers) ? { ...root.providers } : {};
  const isUpdate = isPlainObject(providers[providerId]);
  const existingProvider = isUpdate ? { ...providers[providerId] } : {};
  const existingApi = trimOrEmpty(existingProvider.api);
  const existingBaseUrl = typeof existingProvider.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const normalizedExistingBaseUrl = existingBaseUrl ? normalizeExistingBaseUrl(existingBaseUrl) : null;
  const previousModelCount = Array.isArray(existingProvider.models) ? existingProvider.models.length : 0;

  const conflict = Boolean(
    (existingApi && !LITELLM_PROVIDER_APIS.has(existingApi)) ||
    (normalizedExistingBaseUrl && normalizedExistingBaseUrl !== baseUrl),
  );

  // REPLACE semantics: the new list IS the source of truth. The picker
  // shows every currently-registered model pre-selected; whatever the user
  // submits is what gets written, so deselected models must be dropped
  // rather than silently preserved. Rich fields are pulled from `infoMap`
  // first (freshest), then from the existing entry (so /model/info outages
  // don't strip hand-edited fields), then fall back to a bare stub.
  const mergedModelEntries = buildEnrichedModelEntries(
    modelIds,
    options.infoMap ?? null,
    existingProvider.models,
  );

  providers[providerId] = {
    ...existingProvider,
    baseUrl,
    api: LITELLM_PROVIDER_API,
    apiKey: buildLiteLLMApiKeyCommand(providerId),
    models: mergedModelEntries,
  };

  root.providers = providers;
  return { value: root, conflict, isUpdate, previousModelCount };
}

export function mergeLiteLLMProjectSettings(current, options) {
  const providerId = validateLiteLLMProviderId(options.providerId);
  const modelIds = normalizeModelIdList(options);

  const root = isPlainObject(current) ? { ...current } : {};
  root.defaultProvider = providerId;
  root.defaultModel = modelIds[0];
  root.enabledModels = mergeEnabledModelList(root.enabledModels, modelIds);

  return root;
}

export function mergeLiteLLMProjectKeyConfig(current, options) {
  const providerId = validateLiteLLMProviderId(options.providerId);
  const keyEnv = validateLiteLLMKeyEnv(options.keyEnv);

  const root = isPlainObject(current) ? { ...current } : {};
  const providers = isPlainObject(root.providers) ? { ...root.providers } : {};
  const existingProvider = isPlainObject(providers[providerId]) ? { ...providers[providerId] } : {};

  providers[providerId] = {
    ...existingProvider,
    keyEnv,
  };
  root.providers = providers;
  return root;
}
