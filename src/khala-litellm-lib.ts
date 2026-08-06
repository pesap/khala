// biome-ignore-all lint/style/noExcessiveLinesPerFile: LiteLLM provider registration keeps its merge/validation logic in one module.
// biome-ignore-all lint/security/noSecrets: Field and error-message text resembles credential identifiers but contains no secrets.
// biome-ignore-all lint/complexity/useLiteralKeys: Untrusted dynamic JSON records (models.json, auth.json, key registry) use explicit index keys.
// biome-ignore-all lint/style/noTernary: Provider/model normalization keeps small fallback expressions inline.
// biome-ignore-all lint/style/noContinue: Catalog and registry parsing uses bounded early skips over untrusted entries.
// biome-ignore-all lint/performance/useTopLevelRegex: Small one-off replace regexes stay next to the normalization they support.
// biome-ignore-all lint/style/noProcessEnv: Resolving a portal key from the shell environment is this module's job.
// biome-ignore-all lint/style/useErrorCause: Preserve ES2020 compatibility.
// biome-ignore-all lint/complexity/noUselessReturn: TypeScript's noImplicitReturns requires an explicit return on every code path, including bare early exits.
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, delimiter as pathDelimiter, resolve } from "node:path";
import process from "node:process";

type JsonRecord = Record<string, unknown>;
type JsonValue = JsonRecord | null;

interface LitellmProvider {
	name: string;
	baseUrl: string;
	api: string;
	models: string[];
}

interface LitellmKeyRegistryEntry {
	provider: string;
	keyEnv: string;
	baseUrl: string;
	modelIds: string[];
}

interface MergeModelsJsonOptions {
	providerId: string;
	baseUrl: string;
	modelIds?: readonly string[];
	modelId?: string;
	infoMap?: ReadonlyMap<string, JsonRecord> | null;
	apiKeyResolverCommand?: string;
}

interface MergeModelsJsonResult {
	value: JsonRecord;
	conflict: boolean;
	isUpdate: boolean;
	previousModelCount: number;
}

interface MergeAuthResult {
	value: JsonRecord;
	conflict: boolean;
	isUpdate: boolean;
}

interface LitellmCatalog {
	infoMap: Map<string, JsonRecord>;
	modelNames: string[];
	metadataError: Error | undefined;
	modelListError: Error | undefined;
}

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// LiteLLM portal key labels are user-facing and often include dashes or dots
// (e.g. `reeds-maint`, `team.litellm.prod`). The shell env var is *derived*
// from this via deriveEnvVarFromKeyName(), so users don't invent two names.
const KEY_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const LITELLM_PROVIDER_API = "openai-completions";
const LITELLM_PROVIDER_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses"]);
const DEFAULT_LITELLM_RESOLVER_COMMAND = "khala";
const LITELLM_NPX_RESOLVER_COMMAND = "npx --yes --silent github:pesap/khala";
const LITELLM_RESOLVER_OVERRIDE_ENV = "KHALA_LITELLM_RESOLVER_COMMAND";
const AUTH_COMMAND_PREFIX = "!";
const LITELLM_AUTH_MODES: ReadonlySet<string> = new Set(["skip", "literal", "command"]);

function isPlainObject(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOrEmpty(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function validateLitellmProviderId(raw: unknown): string {
	const value = trimOrEmpty(raw);
	if (!PROVIDER_ID_RE.test(value)) {
		throw new Error(
			"Provider id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and may only contain letters, numbers, dot, underscore, and hyphen.",
		);
	}
	return value;
}

function validateLitellmKeyEnv(raw: unknown): string {
	const value = trimOrEmpty(raw);
	if (KEY_NAME_RE.test(value)) {
		return value;
	}
	const detail =
		value.length === 0
			? "got empty input"
			: `'${value}' must start with a letter, digit, or '_' and use only [A-Za-z0-9._-]`;
	throw new Error(
		`Key name is invalid: ${detail}. It will be derived to a shell env var (e.g. 'reeds-maint' -> $REEDS_MAINT).`,
	);
}

/**
 * Derive a POSIX shell env var name from a LiteLLM portal key label
 * (e.g. `reeds-maint` -> `REEDS_MAINT`). Idempotent on already-valid
 * identifiers. Returns undefined only when the input normalizes to empty.
 */
function deriveEnvVarFromKeyName(raw: unknown): string | undefined {
	const value = trimOrEmpty(raw);
	if (value.length === 0) {
		return;
	}
	if (ENV_VAR_RE.test(value)) {
		return value;
	}
	const cleaned = value
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[0-9]+/, "")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	if (cleaned.length === 0 || !ENV_VAR_RE.test(cleaned)) {
		return;
	}
	return cleaned;
}

function normalizeLitellmBaseUrl(raw: unknown): string {
	const value = trimOrEmpty(raw);
	if (value.length === 0) {
		throw new Error("LiteLLM base URL is required.");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Invalid LiteLLM base URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("LiteLLM base URL must start with http:// or https://.");
	}
	if (parsed.search.length > 0 || parsed.hash.length > 0) {
		throw new Error("LiteLLM base URL must not include a query string or fragment.");
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return pathname.length > 0 ? `${parsed.origin}${pathname}` : parsed.origin;
}

// A malformed existing base URL is treated as absent rather than fatal.
function normalizeExistingBaseUrl(raw: unknown): string | undefined {
	try {
		return normalizeLitellmBaseUrl(raw);
	} catch {
		return;
	}
}

function normalizeLitellmModelPattern(raw: unknown): string {
	const value = trimOrEmpty(raw);
	if (value.length === 0) {
		throw new Error("LiteLLM model id must be non-empty.");
	}
	// Pi resolves a provider at the first slash and tries exact model matches
	// before treating a trailing colon as a thinking suffix, so both are valid
	// in LiteLLM model IDs.
	return value;
}

function filterValidLitellmModelNames(names: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		let valid: string;
		try {
			valid = normalizeLitellmModelPattern(name);
		} catch {
			continue;
		}
		if (seen.has(valid)) {
			continue;
		}
		seen.add(valid);
		result.push(valid);
	}
	return result;
}

function isSuspiciousLitellmModelId(modelId: string): boolean {
	return modelId.trim().length < 2;
}

function modelSummary(modelIds: readonly string[]): string {
	if (modelIds.length === 1) {
		return modelIds[0] ?? "";
	}
	const preview = 3;
	if (modelIds.length <= preview + 1) {
		return `${modelIds.length} models (${modelIds.join(", ")})`;
	}
	const shown = modelIds.slice(0, preview).join(", ");
	return `${modelIds.length} models (${shown}, +${modelIds.length - preview} more)`;
}

function shellQuoteCommandArg(value: string): string {
	if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function executablePathExists(filePath: string): boolean {
	if (!existsSync(filePath)) {
		return false;
	}
	if (process.platform === "win32") {
		return true;
	}
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Minimal cross-platform `which`. Only used to decide whether the LiteLLM
 * key resolver written into models.json can say plain `khala` or needs an
 * `npx` fallback for ad hoc `npx github:pesap/khala` installs.
 */
function resolveCommandOnPath(command: string): string | undefined {
	const trimmed = trimOrEmpty(command);
	if (trimmed.length === 0) {
		return;
	}
	if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
		const resolved = resolve(trimmed);
		return executablePathExists(resolved) ? resolved : undefined;
	}
	const pathValue = trimOrEmpty(process.env["PATH"]);
	if (pathValue.length === 0) {
		return;
	}
	const dirs = pathValue.split(pathDelimiter).filter((entry) => entry.length > 0);
	const candidates =
		process.platform === "win32" && extname(trimmed).length === 0
			? [`${trimmed}.CMD`, `${trimmed}.EXE`, `${trimmed}.BAT`, trimmed]
			: [trimmed];
	for (const dir of dirs) {
		for (const candidate of candidates) {
			const resolved = join(dir, candidate);
			if (executablePathExists(resolved)) {
				return resolved;
			}
		}
	}
	return;
}

/**
 * Choose the command Pi writes into models.json's `apiKey` field to resolve
 * the LiteLLM key at runtime (`!<resolver> litellm print-key --provider X`).
 * Prefers an explicit override, then a `khala` binary actually on PATH
 * (global/checkout installs), then falls back to the documented ad hoc
 * `npx` invocation so the resolver keeps working after an `npx` install
 * that never put `khala` on PATH.
 */
function resolveLitellmApiKeyResolverCommand(overrideCommand?: string): string {
	const override = trimOrEmpty(overrideCommand);
	if (override.length > 0) {
		return override;
	}
	if (resolveCommandOnPath(DEFAULT_LITELLM_RESOLVER_COMMAND) !== undefined) {
		return DEFAULT_LITELLM_RESOLVER_COMMAND;
	}
	return LITELLM_NPX_RESOLVER_COMMAND;
}

function buildLitellmApiKeyCommand(
	providerId: string,
	resolverCommand: string = DEFAULT_LITELLM_RESOLVER_COMMAND,
): string {
	const provider = validateLitellmProviderId(providerId);
	const resolver = trimOrEmpty(resolverCommand);
	if (resolver.length === 0) {
		throw new Error("LiteLLM API key resolver command is required.");
	}
	return `!${resolver} litellm print-key --provider ${provider}`;
}

function isLitellmApiKeyCommand(providerId: string, raw: unknown): boolean {
	const provider = validateLitellmProviderId(providerId);
	const value = trimOrEmpty(raw);
	return value.startsWith("!") && value.endsWith(` litellm print-key --provider ${provider}`);
}

function modelIdFromModelsJsonEntry(entry: unknown): string {
	if (typeof entry === "string") {
		return entry.trim();
	}
	if (isPlainObject(entry) && typeof entry["id"] === "string") {
		return entry["id"].trim();
	}
	return "";
}

function extractLitellmProvidersFromModelsJson(
	modelsJson: unknown,
	options: { managedOnly?: boolean } = {},
): LitellmProvider[] {
	const managedOnly = options.managedOnly !== false;
	const providersRoot =
		isPlainObject(modelsJson) && isPlainObject(modelsJson["providers"]) ? modelsJson["providers"] : {};
	const providers: LitellmProvider[] = [];
	for (const [name, config] of Object.entries(providersRoot)) {
		if (!isPlainObject(config)) {
			continue;
		}
		try {
			validateLitellmProviderId(name);
		} catch {
			continue;
		}
		const baseUrl = trimOrEmpty(config["baseUrl"]);
		const api = trimOrEmpty(config["api"]);
		if (baseUrl.length === 0 || !LITELLM_PROVIDER_APIS.has(api)) {
			continue;
		}
		if (managedOnly && !isLitellmApiKeyCommand(name, config["apiKey"])) {
			continue;
		}
		const models = Array.isArray(config["models"])
			? config["models"].map(modelIdFromModelsJsonEntry).filter((id) => id.length > 0)
			: [];
		providers.push({ name, baseUrl, api, models });
	}
	return providers;
}

// Thinking level map written verbatim into every enriched reasoning-capable
// entry. Mirrors pi's six internal levels; LiteLLM doesn't surface this
// mapping, so this is a sane default the user can hand-edit per model.
const DEFAULT_THINKING_LEVEL_MAP: Readonly<Record<string, string>> = Object.freeze({
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
});

const COST_TOKENS_PER_MILLION = 1_000_000;
const COST_ROUNDING_PRECISION = 1_000_000; // 6 decimal places

function costPerMillion(perToken: unknown): number | undefined {
	if (typeof perToken !== "number" || !Number.isFinite(perToken)) {
		return;
	}
	// Round to 6 decimals: JS float math makes 0.0000025 * 1e6 come back as
	// 2.4999999999999996 without rounding, which writes ugly long tails.
	const perMillion = perToken * COST_TOKENS_PER_MILLION;
	return Math.round(perMillion * COST_ROUNDING_PRECISION) / COST_ROUNDING_PRECISION;
}

function modelInfoCost(info: JsonRecord): JsonRecord {
	const cost: JsonRecord = {};
	const input = costPerMillion(info["input_cost_per_token"]);
	const output = costPerMillion(info["output_cost_per_token"]);
	const cacheRead = costPerMillion(info["cache_read_input_token_cost"]);
	const cacheWrite = costPerMillion(info["cache_creation_input_token_cost"]);
	if (input !== undefined) {
		cost["input"] = input;
	}
	if (output !== undefined) {
		cost["output"] = output;
	}
	if (cacheRead !== undefined) {
		cost["cacheRead"] = cacheRead;
	}
	if (cacheWrite !== undefined) {
		cost["cacheWrite"] = cacheWrite;
	}
	return cost;
}

function modelInfoInputs(info: JsonRecord): string[] {
	const inputs: string[] = ["text"];
	if (info["supports_vision"] === true) {
		inputs.push("image");
	}
	return inputs;
}

function buildModelInfoEntry(modelName: string, info: JsonRecord): JsonRecord {
	const entry: JsonRecord = { id: modelName, name: modelName, input: modelInfoInputs(info) };
	if (info["supports_reasoning"] === true) {
		entry["reasoning"] = true;
		entry["thinkingLevelMap"] = { ...DEFAULT_THINKING_LEVEL_MAP };
	}
	const maxInputTokens = info["max_input_tokens"];
	if (typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens)) {
		entry["contextWindow"] = maxInputTokens;
	}
	const maxOutputTokens = info["max_output_tokens"];
	if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
		entry["maxTokens"] = maxOutputTokens;
	}
	const cost = modelInfoCost(info);
	if (Object.keys(cost).length > 0) {
		entry["cost"] = cost;
	}
	return entry;
}

/**
 * Parse a LiteLLM `/model/info` response into a Map keyed by model_name,
 * with pi-shaped enriched entries. Returns an empty Map on a missing or
 * malformed response rather than throwing.
 */
function parseLitellmModelInfoResponse(json: unknown): Map<string, JsonRecord> {
	const map = new Map<string, JsonRecord>();
	if (!(isPlainObject(json) && Array.isArray(json["data"]))) {
		return map;
	}
	for (const item of json["data"]) {
		if (!isPlainObject(item)) {
			continue;
		}
		const modelName = trimOrEmpty(item["model_name"]);
		if (modelName.length === 0) {
			continue;
		}
		const info = isPlainObject(item["model_info"]) ? item["model_info"] : {};
		map.set(modelName, buildModelInfoEntry(modelName, info));
	}
	return map;
}

/**
 * Build the per-id model entry list for a provider, in `modelIds` order.
 * For each id, prefer freshly-fetched `/model/info` data, then an existing
 * models.json entry with the same id (preserves hand-edited fields), then a
 * bare `{ id }` stub.
 */
function buildEnrichedModelEntries(
	modelIds: readonly string[],
	infoMap: ReadonlyMap<string, JsonRecord> | null | undefined,
	existingModels: unknown,
): JsonRecord[] {
	const existingById = new Map<string, JsonRecord>();
	if (Array.isArray(existingModels)) {
		for (const entry of existingModels) {
			if (!isPlainObject(entry)) {
				continue;
			}
			const id = trimOrEmpty(entry["id"]);
			if (id.length > 0) {
				existingById.set(id, entry);
			}
		}
	}
	return modelIds.map((id) => {
		const fetched = infoMap?.get(id);
		const existing = existingById.get(id);
		if (fetched !== undefined && existing !== undefined) {
			return { ...existing, ...fetched };
		}
		if (fetched !== undefined) {
			return { ...fetched };
		}
		if (existing !== undefined) {
			return { ...existing };
		}
		return { id };
	});
}

function litellmProviderExists(current: unknown, providerId: string): boolean {
	if (!(isPlainObject(current) && isPlainObject(current["providers"]))) {
		return false;
	}
	return isPlainObject(current["providers"][providerId]);
}

function validateAuthCommand(value: unknown): string {
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

function validateAuthLiteral(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
		throw new Error("Auth key value must be a non-empty string.");
	}
	if (/[\r\n]/.test(value)) {
		throw new Error("Auth key value must be a single line (no embedded newlines). Paste only the key.");
	}
	return value;
}

/**
 * Merge an api_key entry for `providerId` into existing auth.json data.
 * Other providers (api_key or oauth) are preserved verbatim.
 */
function mergeAuthJsonApiKey(current: unknown, providerId: string, keyValue: string): MergeAuthResult {
	const id = trimOrEmpty(providerId);
	if (id.length === 0) {
		throw new Error("providerId is required for auth.json merge");
	}
	if (typeof keyValue !== "string" || keyValue.length === 0) {
		throw new Error("key value is required for auth.json merge");
	}
	const root: JsonRecord = isPlainObject(current) ? { ...current } : {};
	const existingRaw = root[id];
	const existing = isPlainObject(existingRaw) ? existingRaw : null;
	const conflict = Boolean(
		existing &&
			(existing["type"] !== "api_key" || (typeof existing["key"] === "string" && existing["key"] !== keyValue)),
	);
	const preserved: JsonRecord =
		existing !== null && existing["type"] === "api_key" && isPlainObject(existing["env"])
			? { env: { ...existing["env"] } }
			: {};
	root[id] = { type: "api_key", key: keyValue, ...preserved };
	return { value: root, conflict, isUpdate: existing !== null };
}

/**
 * Compact-but-readable JSON serializer for models.json: collapses each
 * single-field `{ "id": "..." }` model entry onto one line. Model entries
 * with extra fields keep the default multi-line shape.
 */
function stringifyModelsJson(value: unknown): string {
	const pretty = JSON.stringify(value, null, 2);
	return pretty.replace(/\{\n\s*"id":\s*("(?:[^"\\]|\\.)*")\n\s*\}/g, '{ "id": $1 }');
}

function readJsonObjectFile(filePath: string): JsonValue {
	if (!existsSync(filePath)) {
		return null;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error("Expected a JSON object.");
		}
		return parsed;
	} catch (error) {
		throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const OWNER_READ_WRITE_ONLY_MODE = 0o600;

function writeJsonFile(filePath: string, value: unknown, options: { compactModelEntries?: boolean } = {}): boolean {
	mkdirSync(dirname(filePath), { recursive: true });
	const content = `${options.compactModelEntries === true ? stringifyModelsJson(value) : JSON.stringify(value, null, 2)}\n`;
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
	if (existing === content) {
		return false;
	}
	writeFileSync(filePath, content, { mode: OWNER_READ_WRITE_ONLY_MODE });
	try {
		chmodSync(filePath, OWNER_READ_WRITE_ONLY_MODE);
	} catch {
		// Non-POSIX filesystems may not support chmod; the mode at create time still applies where it can.
	}
	return true;
}

/** Auth files must repair overly permissive modes even when their JSON bytes already match. */
function writeSecureJsonFile(filePath: string, value: unknown): void {
	writeJsonFile(filePath, value);
	try {
		chmodSync(filePath, OWNER_READ_WRITE_ONLY_MODE);
	} catch {
		// Non-POSIX filesystems may not support chmod.
	}
}

function normalizeModelIdList(options: { modelIds?: readonly string[]; modelId?: string }): string[] {
	let raw: readonly string[] = [];
	if (Array.isArray(options.modelIds)) {
		raw = options.modelIds;
	} else if (typeof options.modelId === "string") {
		raw = [options.modelId];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of raw) {
		const normalized = normalizeLitellmModelPattern(candidate);
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	if (result.length === 0) {
		throw new Error("LiteLLM merge requires at least one model id.");
	}
	return result;
}

// REPLACE semantics: the caller's model list IS the source of truth for a
// provider write. The picker shows every currently-registered model
// pre-selected, so whatever the user submits is what gets written.
function mergeLitellmModelsJson(current: unknown, options: MergeModelsJsonOptions): MergeModelsJsonResult {
	const providerId = validateLitellmProviderId(options.providerId);
	const baseUrl = normalizeLitellmBaseUrl(options.baseUrl);
	const modelIds = normalizeModelIdList(options);

	const root: JsonRecord = isPlainObject(current) ? { ...current } : {};
	const providers: JsonRecord = isPlainObject(root["providers"]) ? { ...root["providers"] } : {};
	const existingProviderRaw = providers[providerId];
	const isUpdate = isPlainObject(existingProviderRaw);
	const existingProvider: JsonRecord = isUpdate ? { ...existingProviderRaw } : {};
	const existingApi = trimOrEmpty(existingProvider["api"]);
	const existingBaseUrl = typeof existingProvider["baseUrl"] === "string" ? existingProvider["baseUrl"].trim() : "";
	const normalizedExistingBaseUrl = existingBaseUrl.length > 0 ? normalizeExistingBaseUrl(existingBaseUrl) : undefined;
	const previousModelCount = Array.isArray(existingProvider["models"]) ? existingProvider["models"].length : 0;

	const conflict = Boolean(
		(existingApi.length > 0 && !LITELLM_PROVIDER_APIS.has(existingApi)) ||
			(normalizedExistingBaseUrl !== undefined && normalizedExistingBaseUrl !== baseUrl),
	);

	const mergedModelEntries = buildEnrichedModelEntries(modelIds, options.infoMap, existingProvider["models"]);
	providers[providerId] = {
		...existingProvider,
		baseUrl,
		api: LITELLM_PROVIDER_API,
		apiKey: buildLitellmApiKeyCommand(providerId, options.apiKeyResolverCommand),
		models: mergedModelEntries,
	};
	root["providers"] = providers;
	return { value: root, conflict, isUpdate, previousModelCount };
}

function mergeLitellmProjectSettings(
	current: unknown,
	options: { providerId: string; modelIds?: readonly string[]; modelId?: string },
): JsonRecord {
	const providerId = validateLitellmProviderId(options.providerId);
	const modelIds = normalizeModelIdList(options);
	const enabledModels = modelIds.map((id) => `${providerId}/${id}`);
	const root: JsonRecord = isPlainObject(current) ? { ...current } : {};
	root["defaultProvider"] = providerId;
	root["defaultModel"] = modelIds[0];
	root["enabledModels"] = enabledModels;
	return root;
}

function mergeLitellmProjectKeyConfig(current: unknown, options: { providerId: string; keyEnv: string }): JsonRecord {
	const providerId = validateLitellmProviderId(options.providerId);
	const keyEnv = validateLitellmKeyEnv(options.keyEnv);
	const root: JsonRecord = isPlainObject(current) ? { ...current } : {};
	const providers: JsonRecord = isPlainObject(root["providers"]) ? { ...root["providers"] } : {};
	const existingProviderRaw = providers[providerId];
	const existingProvider: JsonRecord = isPlainObject(existingProviderRaw) ? { ...existingProviderRaw } : {};
	providers[providerId] = { ...existingProvider, keyEnv };
	root["providers"] = providers;
	return root;
}

function litellmKeyAuthId(provider: string, keyEnv: string): string {
	return `${provider}:${keyEnv}`;
}

function isStoredLitellmAuthEntry(entry: unknown): entry is { type: "api_key"; key: string } {
	return (
		isPlainObject(entry) && entry["type"] === "api_key" && typeof entry["key"] === "string" && entry["key"].length > 0
	);
}

function litellmKeyAuthParts(authId: string): { provider: string; keyEnv: string } | undefined {
	const separator = authId.indexOf(":");
	if (separator <= 0 || separator === authId.length - 1) {
		return;
	}
	try {
		const provider = validateLitellmProviderId(authId.slice(0, separator));
		const keyEnv = validateLitellmKeyEnv(authId.slice(separator + 1));
		return { provider, keyEnv };
	} catch {
		// An auth.json key beyond our own provider:keyEnv convention is not a candidate.
		return;
	}
}

function providerModelIdsFromValue(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const modelIds: string[] = [];
	for (const model of value) {
		if (typeof model !== "string") {
			continue;
		}
		const id = model.trim();
		if (id.length === 0 || seen.has(id)) {
			continue;
		}
		seen.add(id);
		modelIds.push(id);
	}
	return modelIds;
}

function normalizeLitellmKeyRegistryEntry(entry: unknown): LitellmKeyRegistryEntry | undefined {
	if (!isPlainObject(entry)) {
		return;
	}
	let provider: string;
	let keyEnv: string;
	try {
		provider = typeof entry["provider"] === "string" ? validateLitellmProviderId(entry["provider"]) : "";
		keyEnv = typeof entry["keyEnv"] === "string" ? validateLitellmKeyEnv(entry["keyEnv"]) : "";
	} catch {
		return;
	}
	if (provider.length === 0 || keyEnv.length === 0) {
		return;
	}
	const baseUrl =
		typeof entry["baseUrl"] === "string" && entry["baseUrl"].trim().length > 0
			? (normalizeExistingBaseUrl(entry["baseUrl"]) ?? "")
			: "";
	const modelIds = providerModelIdsFromValue(entry["modelIds"]);
	return { provider, keyEnv, baseUrl, modelIds };
}

function mergeLitellmKeyRegistry(
	current: unknown,
	entry: { provider: string; keyEnv: string; baseUrl?: string; modelIds?: readonly string[] },
): JsonRecord {
	const normalized = normalizeLitellmKeyRegistryEntry(entry);
	if (normalized === undefined) {
		throw new Error("LiteLLM key registry entry needs provider and keyEnv.");
	}
	const root: JsonRecord = isPlainObject(current) ? { ...current } : {};
	const existingRaw = Array.isArray(root["keys"]) ? root["keys"] : [];
	const existing: LitellmKeyRegistryEntry[] = [];
	for (const item of existingRaw) {
		const normalizedItem = normalizeLitellmKeyRegistryEntry(item);
		if (normalizedItem !== undefined) {
			existing.push(normalizedItem);
		}
	}
	const filtered = existing.filter(
		(item) => !(item.provider === normalized.provider && item.keyEnv === normalized.keyEnv),
	);
	root["keys"] = [...filtered, normalized].sort((a, b) =>
		`${a.provider}\0${a.keyEnv}`.localeCompare(`${b.provider}\0${b.keyEnv}`),
	);
	return root;
}

function registryLitellmKeyCandidates(registry: unknown): LitellmKeyRegistryEntry[] {
	const keys = isPlainObject(registry) && Array.isArray(registry["keys"]) ? registry["keys"] : [];
	const result: LitellmKeyRegistryEntry[] = [];
	for (const item of keys) {
		const normalized = normalizeLitellmKeyRegistryEntry(item);
		if (normalized !== undefined) {
			result.push(normalized);
		}
	}
	return result;
}

function resolveKeyCommand(rawValue: string): string | undefined {
	const cmd = rawValue.slice(1).trim();
	if (cmd.length === 0) {
		return;
	}
	const result = spawnSync(cmd, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.status !== 0) {
		return;
	}
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	return stdout.length > 0 ? stdout : undefined;
}

function resolveKeyEnvReference(rawValue: string): string | undefined {
	if (rawValue.startsWith("$$")) {
		return rawValue.slice(1);
	}
	const match = rawValue.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (!match?.[1]) {
		return rawValue;
	}
	return process.env[match[1]] || undefined;
}

/**
 * Resolve a key reference (literal, `$ENV`, or `!command`) to the actual
 * string used as a bearer token for `/model/info` enrichment or for
 * `print-key`. Returns undefined on an empty source or a failing command;
 * never logs or includes the value in an Error message.
 */
function resolveKeyForFetch(rawValue: unknown): string | undefined {
	if (typeof rawValue !== "string" || rawValue.length === 0) {
		return;
	}
	if (rawValue.startsWith("!")) {
		return resolveKeyCommand(rawValue);
	}
	if (rawValue.startsWith("$")) {
		return resolveKeyEnvReference(rawValue);
	}
	return rawValue;
}

/**
 * Resolve a runtime API key from a portal-style key name. Users may export
 * the env var under either the literal label they typed or its derived
 * shell-canonical form; the derived form wins on tie because that's what
 * setup tells them to export.
 */
function lookupKeyValueByName(keyName: string): string | undefined {
	if (keyName.length === 0) {
		return;
	}
	const derived = deriveEnvVarFromKeyName(keyName);
	if (derived !== undefined && process.env[derived] !== undefined) {
		return process.env[derived];
	}
	if (process.env[keyName] !== undefined) {
		return process.env[keyName];
	}
	return;
}

// LiteLLM mounts /model/info at the proxy root; the /v1 segment of the base
// URL is only for the OpenAI-compatible chat/completions surface.
function litellmModelInfoUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/model/info`;
}

function litellmModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function warnIfInsecureBaseUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return;
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
	if (parsed.protocol === "http:" && !loopback) {
		return `${parsed.origin} is plain HTTP - the LiteLLM API key will be sent unencrypted.`;
	}
	return;
}

function parseLitellmModelsResponse(json: unknown): string[] {
	if (!(isPlainObject(json) && Array.isArray(json["data"]))) {
		return [];
	}
	const names: string[] = [];
	for (const item of json["data"]) {
		let rawName: unknown = item;
		if (isPlainObject(item)) {
			rawName = item["id"];
		}
		if (typeof rawName !== "string") {
			continue;
		}
		try {
			names.push(normalizeLitellmModelPattern(rawName));
		} catch {
			// Skip catalog entries whose id can't round-trip through our model-pattern validation.
		}
	}
	return [...new Set(names)];
}

async function fetchJsonWithBearer(url: string, apiKey: string, timeoutMs = 10_000): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			// biome-ignore lint/style/useNamingConvention: HTTP header names are not camelCase identifiers.
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		let reason = error instanceof Error ? error.message : "network error";
		if (name === "TimeoutError" || name === "AbortError") {
			reason = `timed out after ${timeoutMs}ms`;
		}
		throw new Error(`${url}: ${reason}`);
	}
	if (!response.ok) {
		throw new Error(`${url}: HTTP ${response.status}`);
	}
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`${url}: invalid JSON body (${error instanceof Error ? error.message : String(error)})`);
	}
}

async function fetchLitellmModelInfo(baseUrl: string, apiKey: string): Promise<Map<string, JsonRecord>> {
	const body = await fetchJsonWithBearer(litellmModelInfoUrl(baseUrl), apiKey);
	return parseLitellmModelInfoResponse(body);
}

async function fetchLitellmModels(baseUrl: string, apiKey: string): Promise<string[]> {
	const body = await fetchJsonWithBearer(litellmModelsUrl(baseUrl), apiKey);
	return parseLitellmModelsResponse(body);
}

function litellmModelCatalogEntries(infoMap: ReadonlyMap<string, JsonRecord>): string[] {
	return [...infoMap.keys()].sort((a, b) => a.localeCompare(b));
}

async function fetchLitellmCatalog(baseUrl: string, apiKey: string): Promise<LitellmCatalog> {
	let modelNames: string[] = [];
	let modelListError: Error | undefined;
	try {
		modelNames = await fetchLitellmModels(baseUrl, apiKey);
	} catch (error) {
		modelListError = error instanceof Error ? error : new Error(String(error));
	}
	let metadataError: Error | undefined;
	let infoMap = new Map<string, JsonRecord>();
	try {
		infoMap = await fetchLitellmModelInfo(baseUrl, apiKey);
		if (modelNames.length === 0) {
			modelNames = litellmModelCatalogEntries(infoMap);
		}
	} catch (error) {
		metadataError = error instanceof Error ? error : new Error(String(error));
	}
	return { infoMap, modelNames, metadataError, modelListError };
}

export type {
	JsonRecord,
	LitellmCatalog,
	LitellmKeyRegistryEntry,
	LitellmProvider,
	MergeAuthResult,
	MergeModelsJsonResult,
};
export {
	buildLitellmApiKeyCommand,
	deriveEnvVarFromKeyName,
	extractLitellmProvidersFromModelsJson,
	fetchLitellmCatalog,
	fetchLitellmModelInfo,
	filterValidLitellmModelNames,
	isLitellmApiKeyCommand,
	isStoredLitellmAuthEntry,
	isSuspiciousLitellmModelId,
	LITELLM_AUTH_MODES,
	LITELLM_PROVIDER_API,
	LITELLM_PROVIDER_APIS,
	LITELLM_RESOLVER_OVERRIDE_ENV,
	litellmKeyAuthId,
	litellmKeyAuthParts,
	litellmProviderExists,
	lookupKeyValueByName,
	mergeAuthJsonApiKey,
	mergeLitellmKeyRegistry,
	mergeLitellmModelsJson,
	mergeLitellmProjectKeyConfig,
	mergeLitellmProjectSettings,
	modelSummary,
	normalizeLitellmBaseUrl,
	normalizeLitellmKeyRegistryEntry,
	normalizeLitellmModelPattern,
	parseLitellmModelInfoResponse,
	readJsonObjectFile,
	registryLitellmKeyCandidates,
	resolveKeyForFetch,
	resolveLitellmApiKeyResolverCommand,
	shellQuoteCommandArg,
	stringifyModelsJson,
	validateAuthCommand,
	validateAuthLiteral,
	validateLitellmKeyEnv,
	validateLitellmProviderId,
	warnIfInsecureBaseUrl,
	writeJsonFile,
	writeSecureJsonFile,
};
