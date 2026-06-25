#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import {
  LITELLM_PROVIDER_API,
  LITELLM_RESOLVER_OVERRIDE_ENV,
  buildLiteLLMApiKeyCommand,
  buildProfileChoices,
  buildPiCommandInvocation,
  isLiteLLMApiKeyCommand,
  mergeAuthJsonApiKey,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectKeyConfig,
  mergeLiteLLMProjectSettings,
  modelSupportsThinking,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  parseLiteLLMModelInfoResponse,
  readJsonObjectFile,
  resolveLiteLLMApiKeyResolverCommand,
  stringifyModelsJson,
  validateAuthCommand,
  validateAuthLiteral,
  validateLiteLLMKeyEnv,
  deriveEnvVarFromKeyName,
  validateLiteLLMProviderId,
  parsePiModelListOutput,
  PI_CLI_REQUIRED_MESSAGE,
} from "./khala-setup-lib.js";

const PI_PACKAGE_SPEC = "https://github.com/pesap/khala";
const WORKFLOW_CONFIG_FILE = "workflow-model.yaml";
const LITELLM_APIS = new Set(["openai-completions", "openai-responses"]);
const MODEL_PRESETS = {
  planning:    ["NLR/HALO Nemotron 3 Super:off"],
  development: ["NLR/HALO Devstral 123B:off"],
  peerReview:  ["NLR/HALO GPT OSS 120b:off"],
  triage:      ["NLR/HALO Llama 4 Scout:off"],
  knowledge:   ["NLR/HALO Gemma 4:off"],
  lightweight: ["NLR/HALO Nemotron 3 Nano:off"],
};
const DEFAULT_MODELS = {
  planning:   MODEL_PRESETS.planning[0],
  development: MODEL_PRESETS.development[0],
  peerReview:  MODEL_PRESETS.peerReview[0],
  triage: MODEL_PRESETS.triage[0],
  knowledge: MODEL_PRESETS.knowledge[0],
  lightweight: MODEL_PRESETS.lightweight[0],
};

// ── ANSI (TTY + NO_COLOR aware) ────────────────────────────────────────────
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim    = (s) => COLOR ? `\x1b[2m${s}\x1b[0m`  : s;
const bold   = (s) => COLOR ? `\x1b[1m${s}\x1b[0m`  : s;
const muted  = (s) => COLOR ? `\x1b[90m${s}\x1b[0m` : s;
const check  = (s) => COLOR ? `\x1b[32m${s}\x1b[0m` : s;
const warn   = (s) => COLOR ? `\x1b[33m${s}\x1b[0m` : s;
const cyan   = (s) => COLOR ? `\x1b[36m${s}\x1b[0m` : s;
const green  = (s) => COLOR ? `\x1b[32m${s}\x1b[0m` : s;

// Glyphs degrade to ASCII when color (and thus a capable terminal) is absent,
// keeping plain/redirected output clean and grep-friendly.
const GLYPH = COLOR
  ? { tick: "\u2713", dot: "\u2022", arrow: "\u203a", plus: "+", swap: "\u21ba", dash: "\u2014" }
  : { tick: "[ok]", dot: "-", arrow: ">", plus: "+", swap: "~", dash: "-" };

// A section header: a bold accent title with a small leading marker to break
// the wizard into scannable sections.
function stepHeading(title) {
  return `\n${cyan(GLYPH.dot)} ${bold(title)}`;
}

// Dim helper text shown under a heading or prompt.
const hint = (s) => dim(s);

function titleLine(title, { dryRun = false } = {}) {
  return bold(`${title}${dryRun ? " [dry-run]" : ""}:`);
}

function planRow(kind, message) {
  if (kind === "add") return `  ${green(GLYPH.plus)} ${message}`;
  if (kind === "swap") return `  ${warn(GLYPH.swap)} ${message}`;
  return `  ${dim(GLYPH.dash)} ${dim(message)}`;
}

const rowAdd  = (message) => planRow("add", message);
const rowSwap = (message) => planRow("swap", message);
const rowKeep = (message) => planRow("keep", message);

function wroteLine(message) {
  return `${check(GLYPH.tick)} ${check("Wrote")} ${message}`;
}

function nextStep(message) {
  return `${dim(GLYPH.arrow)} ${message}`;
}

// Whether the wizard may collapse a finished prompt section in place.
const CAN_COLLAPSE = COLOR && process.stdout.isTTY;

// Run an interactive prompt "section" (heading + hints + the prompt and its
// echoed input/retries), then collapse everything it printed into a single
// confirmed line: "✓ <title>  <value>".
//
// On a capable TTY we tally the physical rows the section painted — wrapping
// included — by intercepting stdout writes, then move the cursor up and erase
// before printing the summary. On non-TTY (or NO_COLOR) we skip all of that:
// the section prints linearly and we append the confirmation line, which keeps
// redirected/CI output (and the test transcripts) grep-friendly.
async function collapseSection(title, run, { redactValue = false, formatValue = null } = {}) {
  if (!CAN_COLLAPSE) {
    const value = await run();
    return value;
  }
  const realWrite = process.stdout.write.bind(process.stdout);
  let rows = 0;
  let pending = "";
  // Count newline-terminated physical rows (accounting for wrap) as bytes are
  // written. Partial trailing text (the prompt line awaiting input) is counted
  // when we collapse.
  process.stdout.write = (chunk, ...rest) => {
    pending += typeof chunk === "string" ? chunk : String(chunk);
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      rows += paintedRowCount([pending.slice(0, nl)]);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
    return realWrite(chunk, ...rest);
  };
  let value;
  try {
    value = await run();
  } finally {
    if (pending.length) rows += paintedRowCount([pending]);
    process.stdout.write = realWrite;
  }
  if (rows > 0) realWrite(`\x1b[${rows}A\x1b[0J`);
  const shown = typeof formatValue === "function"
    ? formatValue(value)
    : (redactValue ? dim("••••••••") : dim(String(value)));
  realWrite(`${check(GLYPH.tick)} ${bold(title)}  ${shown}\n`);
  return value;
}

// ── CLI boilerplate ─────────────────────────────────────────────────────────
function usage() {
  return `khala - configure workflow models for Pi

Usage:
  khala [flags]
  khala <command> [flags]

Commands:
  litellm     Configure a LiteLLM-compatible Pi provider

Flags:
  -l, --project       Write to .pi/settings.json in the current project
      --global        Write to ~/.pi/agent/settings.json (default)
  -y, --yes           Use recommended models and skip prompts
      --no-input      Alias for --yes (use in scripts and CI)
      --dry-run       Print decisions without writing or running pi
  -h, --help          Show help
  -v, --version       Show version

Examples:
  khala --project                    Interactive setup for the current project
  khala --global --yes               Headless setup with recommended models
  khala litellm --help               LiteLLM provider setup options

Environment:
  PI_CODING_AGENT_DIR  Override the Pi agent directory (default: ~/.pi/agent)
  NO_COLOR             Disable ANSI color in output

Learn more:
  https://github.com/pesap/khala
`;
}

function version() { return "0.1.0"; }

function parseArgs(args) {
  const options = { dryRun: false, help: false, project: false, global: false, version: false, yes: false };
  for (const arg of args) {
    if      (arg === "--dry-run")            options.dryRun   = true;
    else if (arg === "--global")             options.global   = true;
    else if (arg === "--help"   || arg === "-h") options.help = true;
    else if (arg === "--project"|| arg === "-l") options.project = true;
    else if (arg === "--version"|| arg === "-v") options.version = true;
    else if (arg === "--yes"    || arg === "-y" || arg === "--no-input") options.yes  = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.global && options.project) throw new Error("Choose either --global or --project, not both.");
  return options;
}

function installArgs(scope) {
  return scope === "project" ? ["install", "-l", PI_PACKAGE_SPEC] : ["install", PI_PACKAGE_SPEC];
}

function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(homedir(), ".pi", "agent");
}

function configPath(scope) {
  const base = scope === "project" ? path.join(process.cwd(), ".pi") : piAgentDir();
  return path.join(base, "khala", WORKFLOW_CONFIG_FILE);
}

function settingsPath(scope) {
  const base = scope === "project" ? path.join(process.cwd(), ".pi") : piAgentDir();
  return path.join(base, "settings.json");
}

function litellmProjectConfigPath(dir = process.cwd()) {
  return path.join(dir, ".pi", "khala", "litellm.json");
}

function litellmKeyRegistryPath() {
  return path.join(piAgentDir(), "khala", "litellm-keys.json");
}

function workflowConfig(models) {
  return [
    "# Khala workflow model config",
    "# Profile format: provider/model:thinking",
    "# thinking: off|minimal|low|medium|high|xhigh",
    "",
    "profiles:",
    `  planning: "${models.planning}"`,
    `  development: "${models.development}"`,
    `  peer-review: "${models.peerReview}"`,
    `  triage: "${models.triage}"`,
    `  knowledge: "${models.knowledge}"`,
    `  lightweight: "${models.lightweight}"`,
    "",
    "routes:",
    '  plan: "planning"',
    '  debug: "planning"',
    '  triage: "triage"',
    '  workon: "development"',
    '  review: "peer-review"',
    '  git-review: "knowledge"',
    '  simplify: "development"',
    '  ship: "development"',
    '  inbox: "lightweight"',
    '  audit: "planning"',
    '  address-open-issues: "planning"',
    '  learn-skill: "knowledge"',
    '  peer-review: "peer-review"',
    "",
  ].join("\n");
}

function writeWorkflowConfig(targetPath, models) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, workflowConfig(models), "utf8");
}

function khalaResolverCommand() {
  const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  let resolvedPath = invokedPath;
  if (invokedPath) {
    try {
      resolvedPath = realpathSync(invokedPath);
    } catch {
      resolvedPath = invokedPath;
    }
  }
  return resolveLiteLLMApiKeyResolverCommand({
    overrideCommand: process.env[LITELLM_RESOLVER_OVERRIDE_ENV],
    npmCommand: process.env.npm_command,
    npmPackage: process.env.npm_config_package,
    execPath: process.execPath,
    invokedPath,
    resolvedInvokedPath: resolvedPath,
  });
}

function defaultScope(options) {
  if (options.project) return "project";
  if (options.global)  return "global";
  return "global";
}

function canPrompt() { return process.stdin.isTTY && process.stdout.isTTY; }

// ── Discovery helpers ───────────────────────────────────────────────────────
function parseModelListOutput(stdout) {
  return parsePiModelListOutput(stdout);
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch { return null; }
}

function modelsJsonPath() { return path.join(piAgentDir(), "models.json"); }
function authJsonPath()   { return path.join(piAgentDir(), "auth.json"); }

// ── secret prompt + key resolution ─────────────────────────────────────────
//
// Pi stores api keys in ~/.pi/agent/auth.json with `{ type, key, env }` and
// resolves the `key` field using literal / $ENV / !command syntax. We need:
//   1. A masked prompt to capture literal values without echoing.
//   2. A one-shot resolver that turns the user's choice into an actual
//      string we can pass as `Authorization: Bearer ...` to /model/info.
// The resolver never logs or returns the key in error messages.

async function promptSecret(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Secret prompts require a TTY. Pass --auth-key=<value> for non-interactive runs.");
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw === true;
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) {                  // Ctrl+C
          cleanup();
          reject(makeAbortError());
          return;
        }
        if (code === 0x0d || code === 0x0a) { // Enter
          cleanup();
          resolve(buf);
          return;
        }
        if (code === 0x7f || code === 0x08) { // Backspace / Delete
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code >= 0x20) {                   // ignore non-printable controls
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
    process.stdout.write(question);
  });
}

/**
 * Resolve a key reference (literal, `$ENV`, or `!command`) into the actual
 * string to send as a bearer token for /model/info enrichment. Mirrors the
 * surface of pi's resolveConfigValue but only handles the three top-level
 * forms we need; anything more exotic (e.g. interpolated `${VAR}_suffix`)
 * is left to pi at runtime.
 *
 * Returns the resolved string on success or `undefined` if the source is
 * empty / a `!command` exits non-zero. Never logs or returns the value in
 * an Error message — callers handle their own user-facing messaging.
 */
function resolveKeyForFetch(rawValue) {
  if (typeof rawValue !== "string" || rawValue.length === 0) return undefined;
  if (rawValue.startsWith("!")) {
    const cmd = rawValue.slice(1).trim();
    if (!cmd) return undefined;
    const result = spawnSync(cmd, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) return undefined;
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stdout || undefined;
  }
  if (rawValue.startsWith("$")) {
    if (rawValue.startsWith("$$")) return rawValue.slice(1);
    const m = rawValue.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (!m) return rawValue;
    return process.env[m[1]] || undefined;
  }
  return rawValue;
}

/**
 * Write JSON with 0600 file mode (owner read/write only). Used for auth.json
 * so a pasted API key isn't world-readable. writeFileSync's `mode` only
 * applies when creating, so chmod explicitly after to cover the update case.
 */
function writeSecureJsonFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function findLiteLLMProjectConfigPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = litellmProjectConfigPath(dir);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Cache the full pi --list-models result for the process lifetime so one Khala
// setup run pays Pi's model-list startup cost only once.
let _piModelListCache = null;

function piModelList() {
  if (_piModelListCache !== null) return _piModelListCache;

  const invocation = buildPiCommandInvocation(["--list-models"], {
    spawnOptions: { encoding: "utf8" },
  });
  if (!invocation) {
    _piModelListCache = { skipped: true, reason: PI_CLI_REQUIRED_MESSAGE, rows: [] };
  } else {
    const result = spawnSync(invocation.command, invocation.args, invocation.spawnOptions);
    if (result.error || result.status !== 0) {
      _piModelListCache = { skipped: true, reason: result.error?.message ?? `exit ${result.status ?? 1}`, rows: [] };
    } else {
      _piModelListCache = { skipped: false, rows: parseModelListOutput(result.stdout ?? "") };
    }
  }

  return _piModelListCache;
}

function piDiscoveryRows() {
  const cached = piModelList();
  return cached.skipped ? [] : cached.rows;
}

// Cache provider list for the process lifetime (reads models.json once).
let _providersCache = null;

function liteLLMProvidersFromModelsJson() {
  if (_providersCache !== null) return _providersCache;
  const modelsJson = readJsonFile(modelsJsonPath());
  const providers = [];
  for (const [name, config] of Object.entries(modelsJson?.providers ?? {})) {
    if (!config || typeof config !== "object") continue;
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
    const api     = typeof config.api     === "string" ? config.api.trim()     : "";
    if (!baseUrl || !LITELLM_APIS.has(api) || !isKhalaLiteLLMProviderConfig(name, config)) continue;
    const models = Array.isArray(config.models)
      ? config.models.map((m) => (m && typeof m.id === "string" ? m.id.trim() : "")).filter(Boolean)
      : [];
    providers.push({ name, baseUrl, api, models });
  }
  _providersCache = providers;
  return providers;
}

function isKhalaLiteLLMProviderConfig(providerId, config) {
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  return isLiteLLMApiKeyCommand(providerId, apiKey);
}

function rememberedLiteLLMBaseUrl(providerId) {
  const providers = liteLLMProvidersFromModelsJson();
  const exact = providers.find((provider) => provider.name === providerId);
  if (exact?.baseUrl) return exact.baseUrl;

  const uniqueBaseUrls = [...new Set(providers.map((provider) => provider.baseUrl).filter(Boolean))];
  return uniqueBaseUrls.length === 1 ? uniqueBaseUrls[0] : "";
}

function reusableLiteLLMKeyCandidates() {
  const providers = liteLLMProvidersFromModelsJson();
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const auth = readJsonObjectFile(authJsonPath());
  const projectConfigPath = findLiteLLMProjectConfigPath();
  const projectConfig = projectConfigPath ? readJsonObjectFile(projectConfigPath) : null;
  const projectProviders = isPlainObject(projectConfig?.providers) ? projectConfig.providers : {};

  const seeded = [];
  for (const entry of registryLiteLLMKeyCandidates()) seeded.push({ ...entry, source: "label" });
  if (isPlainObject(auth)) {
    for (const [authId, authEntry] of Object.entries(auth)) {
      if (!isStoredLiteLLMAuthEntry(authEntry)) continue;
      const parts = liteLLMKeyAuthParts(authId);
      if (!parts || !providerByName.has(parts.provider)) continue;
      const provider = providerByName.get(parts.provider);
      seeded.push({
        provider: parts.provider,
        baseUrl: provider.baseUrl,
        keyEnv: parts.keyEnv,
        modelIds: [...provider.models],
        source: "label",
      });
    }
  }
  for (const provider of providers) {
    const projectEntry = isPlainObject(projectProviders[provider.name]) ? projectProviders[provider.name] : null;
    const projectKeyEnv = typeof projectEntry?.keyEnv === "string" && projectEntry.keyEnv.trim()
      ? validateLiteLLMKeyEnv(projectEntry.keyEnv)
      : "";
    seeded.push({
      provider: provider.name,
      baseUrl: provider.baseUrl,
      keyEnv: projectKeyEnv || provider.name,
      modelIds: [...provider.models],
      source: projectKeyEnv ? "label" : "provider-fallback",
    });
  }

  const seen = new Set();
  return seeded
    .map((entry) => {
      const provider = providerByName.get(entry.provider);
      const baseUrl = entry.baseUrl || provider?.baseUrl || "";
      const modelIds = entry.modelIds.length ? entry.modelIds : [...(provider?.models ?? [])];
      const keySpecificAuth = isPlainObject(auth) && isPlainObject(auth[liteLLMKeyAuthId(entry.provider, entry.keyEnv)]) ? auth[liteLLMKeyAuthId(entry.provider, entry.keyEnv)] : null;
      const providerAuth = isPlainObject(auth) && isPlainObject(auth[entry.provider]) ? auth[entry.provider] : null;
      const hasStoredAuth = isStoredLiteLLMAuthEntry(keySpecificAuth) || isStoredLiteLLMAuthEntry(providerAuth);
      return {
        provider: entry.provider,
        baseUrl,
        keyEnv: entry.keyEnv,
        modelIds,
        hasStoredAuth,
        needsKeyLabel: entry.source === "provider-fallback",
      };
    })
    .filter((candidate) => candidate.baseUrl && candidate.modelIds.length > 0)
    .filter((candidate) => {
      const key = `${candidate.provider}\0${candidate.keyEnv}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.provider}\0${a.keyEnv}`.localeCompare(`${b.provider}\0${b.keyEnv}`));
}

function isStoredLiteLLMAuthEntry(entry) {
  return isPlainObject(entry) && entry.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0;
}

function liteLLMKeyAuthParts(authId) {
  if (typeof authId !== "string") return null;
  const separator = authId.indexOf(":");
  if (separator <= 0 || separator === authId.length - 1) return null;
  try {
    const provider = validateLiteLLMProviderId(authId.slice(0, separator));
    const keyEnv = validateLiteLLMKeyEnv(authId.slice(separator + 1));
    return provider && keyEnv ? { provider, keyEnv } : null;
  } catch {
    return null;
  }
}

function reusableLiteLLMKeyLabelChoice(candidate) {
  const keySource = candidate.hasStoredAuth ? "stored key" : `env $${deriveEnvVarFromKeyName(candidate.keyEnv) ?? candidate.keyEnv}`;
  const modelSummaryText = modelSummary(candidate.modelIds);
  return `${candidate.keyEnv} (${keySource}; ${modelSummaryText})`;
}

function providerModelIdsFromConfig(config) {
  if (!Array.isArray(config?.models)) return [];
  const seen = new Set();
  const modelIds = [];
  for (const model of config.models) {
    const raw = typeof model === "string" ? model : model?.id;
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    modelIds.push(id);
  }
  return modelIds;
}

function liteLLMKeyAuthId(provider, keyEnv) {
  return `${provider}:${keyEnv}`;
}

function readLiteLLMKeyRegistry() {
  return readJsonObjectFile(litellmKeyRegistryPath()) ?? { keys: [] };
}

function normalizeLiteLLMKeyRegistryEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const provider = typeof entry.provider === "string" ? validateLiteLLMProviderId(entry.provider) : "";
  const keyEnv = typeof entry.keyEnv === "string" ? validateLiteLLMKeyEnv(entry.keyEnv) : "";
  if (!provider || !keyEnv) return null;
  const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl.trim()
    ? normalizeLiteLLMBaseUrl(entry.baseUrl)
    : "";
  const modelIds = providerModelIdsFromConfig({ models: entry.modelIds });
  return { provider, keyEnv, baseUrl, modelIds };
}

function mergeLiteLLMKeyRegistry(current, entry) {
  const normalized = normalizeLiteLLMKeyRegistryEntry(entry);
  if (!normalized) {
    throw new Error("LiteLLM key registry entry needs provider and keyEnv.");
  }
  const root = isPlainObject(current) ? { ...current } : {};
  const existing = Array.isArray(root.keys) ? root.keys.map(normalizeLiteLLMKeyRegistryEntry).filter(Boolean) : [];
  const filtered = existing.filter((item) => !(item.provider === normalized.provider && item.keyEnv === normalized.keyEnv));
  root.keys = [...filtered, normalized].sort((a, b) => `${a.provider}\0${a.keyEnv}`.localeCompare(`${b.provider}\0${b.keyEnv}`));
  return root;
}

function registryLiteLLMKeyCandidates() {
  const registry = readLiteLLMKeyRegistry();
  return (Array.isArray(registry.keys) ? registry.keys : [])
    .map(normalizeLiteLLMKeyRegistryEntry)
    .filter(Boolean);
}

// ── Inline interactive prompts ──────────────────────────────────────────────
function makeAbortError() {
  const err = new Error("Aborted with Ctrl+C");
  err.code = "ABORT_ERR";
  return err;
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR");
}

function rawMode(on) {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(on);
  }
}

// Visible (printable) width of a string after stripping CSI SGR color/style
// escapes. The picker's buildLines() output only uses SGR escapes, so this
// regex is sufficient.
const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
function visibleWidth(s) {
  return s.replace(ANSI_SGR_RE, "").length;
}

// Number of *physical* terminal rows that `lines` will occupy after auto-wrap
// at the current terminal width. Each logical line wraps to ceil(width / cols)
// rows, minimum 1. When stdout has no known column count we fall back to the
// logical line count (best effort; matches old behavior).
function paintedRowCount(lines) {
  const cols = process.stdout.columns || 0;
  if (!cols) return lines.length;
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil(visibleWidth(line) / cols));
  }
  return total;
}

const PICKER_WINDOW = 10;
const PICKER_LABEL_GAP = "  ";
const PICKER_FILTER_THRESHOLD = 7;

// Safety net: always restore the terminal cursor on process exit so a crashed
// or signaled picker can't leave the cursor hidden. No-op on non-TTY stdout.
if (process.stdout.isTTY) {
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
}

function pickerViewport(total, selIdx) {
  if (total <= PICKER_WINDOW) return { start: 0, end: total };
  let start = Math.max(0, selIdx - Math.floor(PICKER_WINDOW / 2));
  const end = Math.min(total, start + PICKER_WINDOW);
  start = Math.max(0, end - PICKER_WINDOW);
  return { start, end };
}

async function askFilteredPicker(title, initialChoices, options = {}) {
  const multi = options.multi === true;
  const allowCustom = options.allowCustom === true;
  if (!canPrompt() || (!initialChoices.length && !(multi && allowCustom))) {
    return multi ? [...initialChoices] : options.fallback;
  }

  const choices = [...initialChoices];
  const choiceSet = new Set(choices);
  const filterEnabled = choices.length > PICKER_FILTER_THRESHOLD;
  const queryEnabled = filterEnabled || allowCustom;
  const selected = multi
    ? new Set(Array.isArray(options.defaultSelected) ? options.defaultSelected.filter((choice) => choiceSet.has(choice)) : choices)
    : null;
  let query = "";
  let filtered = [...choices];

  const buildItems = () => {
    const items = filtered.map((c) => ({ value: c, display: c, custom: false }));
    const trimmed = query.trim();
    if (allowCustom && trimmed && !choiceSet.has(trimmed)) {
      items.unshift({ value: trimmed, display: trimmed, custom: true });
    }
    return items;
  };

  let items = buildItems();
  const fallbackIdx = items.findIndex((it) => it.value === options.fallback);
  let selIdx = multi || fallbackIdx < 0 ? 0 : fallbackIdx;
  let hovered = items[selIdx]?.value ?? null;

  const applyFilter = () => {
    const q = query.trim().toLowerCase();
    filtered = filterEnabled && q ? choices.filter((c) => c.toLowerCase().includes(q)) : [...choices];
    items = buildItems();
    const next = hovered ? items.findIndex((it) => it.value === hovered) : -1;
    selIdx = next >= 0 ? next : 0;
    hovered = items[selIdx]?.value ?? null;
  };

  const queryPlaceholder = () => {
    if (allowCustom && filterEnabled) return "type to filter or add…";
    if (allowCustom) return "type to add…";
    return "type to filter…";
  };

  const controlHint = () => {
    const clearHint = queryEnabled ? "  Esc clear" : "";
    return multi
      ? `  Up/Down move  Space toggle  Ctrl+A all/none  Enter accept${clearHint}  Ctrl+C cancel`
      : `  Up/Down select  Enter accept${clearHint}  Ctrl+C cancel`;
  };

  const buildLines = () => {
    const lines = [];
    const count = multi
      ? `${selected.size}/${choices.length} selected`
      : (filtered.length === choices.length ? `${choices.length}` : `${filtered.length}/${choices.length}`);
    lines.push(`${bold(title)}  ${dim(`(${count})`)}`);
    if (queryEnabled) {
      lines.push(`${dim("›")} ${query.trim() ? query : dim(queryPlaceholder())}`);
    }
    if (!items.length) {
      lines.push(dim(controlHint()));
      lines.push(dim("  no matches"));
      return lines;
    }
    const { start, end } = pickerViewport(items.length, selIdx);
    lines.push(dim(controlHint()));
    for (let i = start; i < end; i++) {
      const sel = i === selIdx;
      const item = items[i];
      if (item.custom) {
        const label = `add "${item.value}"`;
        const text = sel ? bold(label) : dim(label);
        lines.push(`  ${sel ? check("+") : "+"}${PICKER_LABEL_GAP}${text}`);
      } else {
        const text = sel ? bold(item.display) : dim(item.display);
        if (multi) {
          const checked = selected.has(item.value);
          const box = checked ? "[x]" : "[ ]";
          const glyph = sel ? bold(box) : (checked ? box : muted(box));
          lines.push(`  ${glyph}${PICKER_LABEL_GAP}${text}`);
        } else {
          lines.push(`  ${sel ? "◉" : muted("◯")}${PICKER_LABEL_GAP}${text}`);
        }
      }
    }
    return lines;
  };

  let drawnLines = 0;

  const paint = () => {
    const lines = buildLines();
    if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
    process.stdout.write(`${lines.join("\n")}\n`);
    drawnLines = paintedRowCount(lines);
  };

  process.stdout.write("\x1b[?25l"); // hide cursor while drawing the picker
  paint();

  return new Promise((resolve, reject) => {
    let onKey;

    const settle = () => {
      process.stdin.off("keypress", onKey);
      rawMode(false);
      process.stdin.pause();
      if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
      process.stdout.write("\x1b[?25h");
    };

    onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { settle(); reject(makeAbortError()); return; }
      if (multi && key.ctrl && key.name === "a") {
        if (!filtered.length) return;
        const anyUnselected = filtered.some((c) => !selected.has(c));
        for (const c of filtered) {
          if (anyUnselected) selected.add(c);
          else selected.delete(c);
        }
        paint();
        return;
      }
      if (key.name === "up") {
        if (!items.length) return;
        selIdx = (selIdx - 1 + items.length) % items.length;
        hovered = items[selIdx]?.value ?? null;
        paint();
        return;
      }
      if (key.name === "down") {
        if (!items.length) return;
        selIdx = (selIdx + 1) % items.length;
        hovered = items[selIdx]?.value ?? null;
        paint();
        return;
      }
      if (key.name === "return") {
        if (!multi && !items.length) return;
        const chosen = multi
          ? choices.filter((c) => selected.has(c))
          : (items[selIdx]?.value ?? options.fallback);
        settle();
        resolve(chosen);
        return;
      }
      if (key.name === "escape") {
        if (!queryEnabled) return;
        if (query) { query = ""; applyFilter(); paint(); }
        return;
      }
      if (key.name === "backspace") {
        if (!queryEnabled) return;
        if (query) { query = query.slice(0, -1); applyFilter(); paint(); }
        return;
      }
      if (multi && key.name === "space") {
        if (!items.length) return;
        const item = items[selIdx];
        if (!item) return;
        if (item.custom) {
          choices.push(item.value);
          choiceSet.add(item.value);
          selected.add(item.value);
          hovered = item.value;
          query = "";
          applyFilter();
        } else if (selected.has(item.value)) {
          selected.delete(item.value);
        } else {
          selected.add(item.value);
        }
        paint();
        return;
      }
      if (typeof str === "string" && str.length === 1 && !key.ctrl && !key.meta) {
        if (!queryEnabled) return;
        const code = str.charCodeAt(0);
        if ((multi ? code > 32 : code >= 32) && code < 127) {
          query += str;
          applyFilter();
          paint();
        }
      }
    };
    emitKeypressEvents(process.stdin);
    rawMode(true);
    process.stdin.on("keypress", onKey);
    process.stdin.resume();
  });
}

function askChoice(title, choices, fallback, options = {}) {
  return askFilteredPicker(title, choices, { ...options, fallback });
}

function askMultiChoice(title, choices, options = {}) {
  return askFilteredPicker(title, choices, { ...options, multi: true });
}

/** Single-keypress confirmation. No readline needed. */
async function askConfirmation(promptText, { defaultYes = true } = {}) {
  if (!canPrompt()) return false;

  return new Promise((resolve, reject) => {
    process.stdout.write(`${bold(promptText)} ${dim(defaultYes ? "[Y/n]" : "[y/N]")} `);
    let onKey;

    const settle = (accepted, echo) => {
      process.stdin.off("keypress", onKey);
      rawMode(false);
      process.stdin.pause();
      process.stdout.write(`${echo}\n`);
      if (accepted === null) reject(makeAbortError());
      else resolve(accepted);
    };

    onKey = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { settle(null, "");  return; }
      if (key.name === "return")        { settle(defaultYes, defaultYes ? "y" : "n"); return; }
      const ch = (_str ?? "").toLowerCase();
      if (ch === "y") { settle(true,  "y"); return; }
      if (ch === "n") { settle(false, "n"); return; }
    };

    emitKeypressEvents(process.stdin);
    rawMode(true);
    process.stdin.on("keypress", onKey);
    process.stdin.resume();
  });
}

async function confirmInstall(options) {
  if (options.yes) return true;
  return askConfirmation(`${GLYPH.arrow} Install now?`);
}

function litellmUsage() {
  return `khala litellm - configure a LiteLLM-compatible Pi provider

Usage:
  khala litellm
  khala litellm --provider <id> --base-url <url> --key-env <name> --model <patterns> [flags]
  khala litellm print-key --provider <id>
  khala litellm --help

Commands:
  print-key                 Print the selected LiteLLM API key for Pi's provider resolver

Flags:
      --provider <id>        LiteLLM provider id  (e.g. team-litellm)
      --base-url <url>       LiteLLM base URL     (e.g. https://lite.example/v1)
      --key-env <name>       LiteLLM key name (matches your portal label, e.g. reeds-maint).
                             Shell env var is derived: 'reeds-maint' → $REEDS_MAINT.
      --model <patterns>     One bare model name or comma-separated list to register and enable
      --auth-mode <mode>     How to store the key: skip | literal | command
                             (TTY default: ask; non-interactive default: skip)
      --auth-key <value>     Literal key value for --auth-mode=literal
      --auth-command <!cmd>  Shell command for --auth-mode=command (must start with '!')
      --project-settings     Also update .pi/settings.json default/enabled models
      --no-project-settings  Do not update .pi/settings.json (non-interactive default)
  -l, --project              Configure the current project (default)
  -y, --yes                  Skip the write confirmation
      --no-input             Alias for --yes (use in scripts and CI)
      --dry-run              Print the planned config changes without writing files
      --verbose              Show full file paths and implementation details
  -h, --help                 Show help
  -v, --version              Show version

Examples:
  # Interactive: add a provider/key, add a key to an existing provider, or reuse a key.
  khala litellm

  # Fully specified new-key setup:
  khala litellm --provider team-litellm --base-url https://lite.example/v1 --key-env reeds-maint

  # Store the key directly in auth.json (paste once, kept at 0600):
  khala litellm --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env reeds-maint --model gpt-5.4-mini --auth-mode=literal --auth-key="$KEY" --yes

  # Store a keychain/1Password lookup instead of a literal:
  khala litellm --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env reeds-maint --model gpt-5.4-mini \\
    --auth-mode=command --auth-command="!op read 'op://Personal/team-litellm/credential'" --yes

  # Non-interactive project defaults are explicit:
  khala litellm --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env reeds-maint --model gpt-5.4-mini --project-settings --yes

Project model scope:
  --project-settings writes this project's .pi/settings.json defaultProvider,
  defaultModel, and enabledModels from the selected --model list. enabledModels
  is written as provider-qualified entries like team-litellm/gpt-5.4-mini so Pi
  does not resolve a same-named model from another provider. Pi's --list-models
  command still lists the global registry from models.json; it is not a
  project-scoped view.

Key name vs. shell env var:
  --key-env stores a friendly label (often the name you assigned the key in the
  LiteLLM portal). When pi falls back to env-var resolution, it reads the
  *derived* shell name: portal label 'reeds-maint' → 'export REEDS_MAINT=...'.
  If you typed a valid shell identifier directly (e.g. 'LITELLM_API_KEY'),
  derivation is a no-op and the export name is identical.

Key resolution at runtime:
  models.json calls !khala litellm print-key --provider <id>. Khala reads this
  project's selected key label, then checks env vars, key-specific auth entries
  (<provider>:<key-label>), and legacy provider auth entries. New literal/command
  keys are recorded in key-specific auth entries. New providers also get a
  provider-compatible auth entry; adding another key to an existing provider
  preserves that provider-compatible entry for older projects. That flow shows
  the exact project .pi config path and asks before configuring the current
  project; answering no only saves the reusable key.
  If the provider/key-label pair already has a stored key, Khala asks before
  overwriting it.
  Khala also keeps a non-secret global key-label registry so the reuse picker can
  list multiple labels for the same LiteLLM provider.

Environment:
  PI_CODING_AGENT_DIR              Override the Pi agent directory (default: ~/.pi/agent)
  KHALA_LITELLM_RESOLVER_COMMAND   Override the command written into models.json for key lookup
  NO_COLOR                         Disable ANSI color in output
`;
}

function parseLitellmArgs(args) {
  const options = { baseUrl: "", dryRun: false, global: false, help: false, keyEnv: "", model: "", noInput: false, project: false, projectSettings: null, provider: "", verbose: false, version: false, yes: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--global") options.global = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--project" || arg === "-l") options.project = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--no-input") { options.yes = true; options.noInput = true; }
    else if (arg.startsWith("--provider=")) options.provider = arg.slice("--provider=".length);
    else if (arg === "--provider") options.provider = args[++i] ?? "";
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--base-url") options.baseUrl = args[++i] ?? "";
    else if (arg.startsWith("--key-env=")) options.keyEnv = arg.slice("--key-env=".length);
    else if (arg === "--key-env") options.keyEnv = args[++i] ?? "";
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else if (arg === "--model") options.model = args[++i] ?? "";
    else if (arg.startsWith("--auth-mode=")) options.authMode = arg.slice("--auth-mode=".length);
    else if (arg === "--auth-mode") options.authMode = args[++i] ?? "";
    else if (arg.startsWith("--auth-key=")) options.authKey = arg.slice("--auth-key=".length);
    else if (arg === "--auth-key") options.authKey = args[++i] ?? "";
    else if (arg.startsWith("--auth-command=")) options.authCommand = arg.slice("--auth-command=".length);
    else if (arg === "--auth-command") options.authCommand = args[++i] ?? "";
    else if (arg === "--project-settings" || arg === "--configure-project-settings") options.projectSettings = true;
    else if (arg === "--no-project-settings") options.projectSettings = false;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.global) throw new Error("khala litellm only supports project setup; use --project.");
  if (!options.project) options.project = true;
  return options;
}

function litellmPrintKeyUsage() {
  return `khala litellm print-key - print the selected LiteLLM API key for Pi

Usage:
  khala litellm print-key --provider <id>
  khala litellm print-key --help

Flags:
      --provider <id>  LiteLLM provider id to resolve from the nearest project config
  -h, --help           Show help
  -v, --version        Show version

Output:
  On success, writes only the resolved key value to stdout. Diagnostics and
  errors are written to stderr.
`;
}

function parseLitellmPrintKeyArgs(args) {
  const options = { help: false, provider: "", version: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg.startsWith("--provider=")) options.provider = arg.slice("--provider=".length);
    else if (arg === "--provider") options.provider = args[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function describeLocation(label, filePath, verbose) {
  return verbose ? `${label} (${filePath})` : label;
}

function httpStatusFromMessage(message) {
  const match = String(message ?? "").match(/\bHTTP\s+(\d{3})\b/);
  return match ? `HTTP ${match[1]}` : null;
}

function formatMetadataFailure(error, verbose) {
  if (verbose) return `Could not fetch model metadata: ${error.message}. Models will still work if the ids are correct.`;
  const status = httpStatusFromMessage(error.message);
  const reason = status ?? "request failed";
  return `Could not fetch model metadata: ${reason}. Models will still work if the ids are correct.`;
}

function formatCatalogFailure(error, verbose) {
  if (verbose) return `Could not fetch model list: ${error.message}. Enter model ids manually.`;
  const status = httpStatusFromMessage(error.message);
  const reason = status ?? "request failed";
  return `Could not fetch model list: ${reason}. Enter model ids manually.`;
}

function modelSummary(modelIds) {
  if (modelIds.length === 1) return modelIds[0];
  // Cap the inline preview so a large catalog doesn't flood the summary; the
  // exact set is always recoverable from the written settings file.
  const PREVIEW = 3;
  if (modelIds.length <= PREVIEW + 1) return `${modelIds.length} models (${modelIds.join(", ")})`;
  const shown = modelIds.slice(0, PREVIEW).join(", ");
  return `${modelIds.length} models (${shown}, +${modelIds.length - PREVIEW} more)`;
}

function validateNonInteractiveLiteLLMModelIds(modelIds) {
  const suspicious = modelIds.find(isSuspiciousLiteLLMModelId);
  if (suspicious) {
    throw new Error(`${suspiciousModelMessage(suspicious)} Re-run in a TTY to confirm it, or pass a longer model id.`);
  }
}

function promptLine(question, { defaultValue = "" } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    const onSigint = () => {
      rl.off("SIGINT", onSigint);
      rl.close();
      reject(makeAbortError());
    };

    rl.once("SIGINT", onSigint);
    rl.question(question, (answer) => {
      rl.off("SIGINT", onSigint);
      rl.close();
      resolve(String(answer).trim() ? answer : defaultValue);
    });
  });
}

async function promptValidated(question, normalizer, formatError = null, promptOptions = {}) {
  while (true) {
    const answer = String(await promptLine(question, promptOptions)).trim();
    try {
      return normalizer(answer);
    } catch (error) {
      const message = typeof formatError === "function" ? formatError(error) : error.message;
      console.log(warn(`  ${message}`));
    }
  }
}

function liteLLMPromptError(kind) {
  return (error) => {
    if (kind === "provider") {
      return "Use a short id with letters, numbers, dots, underscores, or hyphens. Start with a letter or number.";
    }
    if (kind === "baseUrl") {
      return "Enter the LiteLLM proxy URL, including http:// or https:// and no query string.";
    }
    if (kind === "keyLabel") {
      return "Use the project key label from LiteLLM. It may contain letters, numbers, dots, underscores, or hyphens.";
    }
    if (kind === "model") {
      return "Use bare LiteLLM model ids only. Do not include provider prefixes, slashes, or thinking suffixes.";
    }
    return error.message;
  };
}

function isSuspiciousLiteLLMModelId(modelId) {
  return typeof modelId === "string" && modelId.trim().length < 2;
}

function suspiciousModelMessage(modelId) {
  return `LiteLLM model id '${modelId}' is very short. Enter the full model id from your LiteLLM catalog.`;
}

function liteLLMModelCatalogEntries(infoMap) {
  if (!(infoMap instanceof Map) || infoMap.size === 0) return [];
  return [...infoMap.keys()].sort((a, b) => a.localeCompare(b));
}

async function confirmModelIdIfSuspicious(modelId) {
  if (!isSuspiciousLiteLLMModelId(modelId)) return true;
  console.log(warn(`  ${suspiciousModelMessage(modelId)}`));
  return askConfirmation("Use this model id anyway?", { defaultYes: false });
}

async function promptLiteLLMModelIds(modelNames = []) {
  if (modelNames.length) {
    // The picker draws its own title, selection count, and keybinding hints,
    // and clears them on exit. Printing a separate static header here would
    // be left stranded above the next prompt after the picker erases itself.
    console.log("");
    while (true) {
      const picked = await askMultiChoice("LiteLLM models", modelNames, { allowCustom: true, defaultSelected: [] });
      if (!picked.length) {
        console.log(warn("  Select at least one model, or type a custom model id and press Space."));
        continue;
      }
      try {
        const modelIds = picked.map(normalizeLiteLLMModelPattern);
        const suspicious = modelIds.filter(isSuspiciousLiteLLMModelId);
        if (suspicious.length) {
          let accepted = true;
          for (const modelId of suspicious) {
            accepted = await confirmModelIdIfSuspicious(modelId);
            if (!accepted) break;
          }
          if (!accepted) continue;
        }
        return modelIds;
      } catch (error) {
        console.log(warn(`  ${liteLLMPromptError("model")(error)}`));
      }
    }
  }

  console.log(`\n${bold("Models")}`);
  console.log(hint("  Use the model ids from your LiteLLM admin catalog."));
  console.log(hint("  Separate multiple ids with commas. Example: gpt-4.1, gpt-4.1-mini"));
  while (true) {
    const answer = String(await promptLine(`  ${GLYPH.arrow} Model ids: `)).trim();
    const raw = answer.split(",").map((s) => s.trim()).filter(Boolean);
    if (!raw.length) {
      console.log(warn("  Enter at least one model id. Use commas if you have more than one."));
      continue;
    }
    try {
      const modelIds = raw.map(normalizeLiteLLMModelPattern);
      const suspicious = modelIds.filter(isSuspiciousLiteLLMModelId);
      if (suspicious.length) {
        let accepted = true;
        for (const modelId of suspicious) {
          accepted = await confirmModelIdIfSuspicious(modelId);
          if (!accepted) break;
        }
        if (!accepted) continue;
      }
      return modelIds;
    } catch (error) {
      console.log(warn(`  ${liteLLMPromptError("model")(error)}`));
    }
  }
}

/**
 * Resolve a runtime API key from a portal-style key name.
 *
 * Users may have actually exported the env var under either the literal
 * name they typed (`reeds-maint` — via `env reeds-maint=val node …`) or
 * the shell-canonical derived form (`REEDS_MAINT` — via `export
 * REEDS_MAINT=val`). The shell-canonical case is overwhelmingly more
 * common but we don't want to break the rare-but-legitimate exotic case.
 * Derived wins on tie because that's what we tell users to export.
 */
function lookupKeyValueByName(keyName) {
  if (!keyName) return undefined;
  const derived = deriveEnvVarFromKeyName(keyName);
  if (derived && process.env[derived] !== undefined) return process.env[derived];
  if (process.env[keyName] !== undefined) return process.env[keyName];
  return undefined;
}

const AUTH_MODES = new Set(["skip", "literal", "command"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// LiteLLM mounts /model/info at the proxy root; the /v1 segment of the
// base URL is only for the OpenAI-compatible chat/completions/embeddings
// surface. Strip a trailing /v1 (case-insensitive) before appending.
function liteLLMModelInfoUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/model/info`;
}

function liteLLMModelsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function parseLiteLLMModelsResponse(json) {
  if (!isPlainObject(json) || !Array.isArray(json.data)) return [];
  const names = [];
  for (const item of json.data) {
    const rawName = typeof item === "string" ? item : item?.id;
    if (typeof rawName !== "string") continue;
    try {
      names.push(normalizeLiteLLMModelPattern(rawName));
    } catch {
    }
  }
  return [...new Set(names)];
}

async function fetchJsonWithBearer(url, apiKey, { timeoutMs = 10_000, metadataEndpoint = false } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : (error?.message ?? "network error");
    throw new Error(`${url}: ${reason}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const raw = (await response.text()).slice(0, 512).trim();
      if (raw) {
        try {
          const j = JSON.parse(raw);
          detail =
            j?.error?.message ??
            (typeof j?.detail === "string" ? j.detail : null) ??
            j?.detail?.error ??
            j?.detail?.message ??
            j?.message ??
            raw;
        } catch {
          detail = raw;
        }
      }
    } catch {
      // body read failed; fall through with no detail
    }
    const hint =
      metadataEndpoint && (response.status === 401 || response.status === 403)
        ? " — your LiteLLM key may not have admin access to /model/info; this only disables auto-enrichment, the provider itself will still work"
        : "";
    throw new Error(`${url}: HTTP ${response.status}${detail ? `: ${detail}` : ""}${hint}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${url}: invalid JSON body (${error.message})`);
  }
}

/**
 * Best-effort fetch of LiteLLM `/model/info` for the given proxy. The API
 * key is taken from the caller (read from `process.env[keyEnv]` upstream)
 * and is never logged or persisted. Throws a short, key-free Error on
 * timeout / non-2xx / parse failure so the CLI can degrade gracefully.
 */
async function fetchLiteLLMModelInfo(baseUrl, apiKey, { timeoutMs = 10_000 } = {}) {
  const body = await fetchJsonWithBearer(liteLLMModelInfoUrl(baseUrl), apiKey, { timeoutMs, metadataEndpoint: true });
  return parseLiteLLMModelInfoResponse(body);
}

async function fetchLiteLLMModels(baseUrl, apiKey, { timeoutMs = 10_000 } = {}) {
  const body = await fetchJsonWithBearer(liteLLMModelsUrl(baseUrl), apiKey, { timeoutMs });
  return parseLiteLLMModelsResponse(body);
}

async function fetchLiteLLMCatalog(baseUrl, apiKey) {
  let modelNames = [];
  let modelListError = null;
  try {
    modelNames = await fetchLiteLLMModels(baseUrl, apiKey);
  } catch (error) {
    modelListError = error;
  }

  let metadataError = null;
  let infoMap = new Map();
  try {
    infoMap = await fetchLiteLLMModelInfo(baseUrl, apiKey);
    if (!modelNames.length) {
      modelNames = liteLLMModelCatalogEntries(infoMap);
    }
  } catch (error) {
    metadataError = error;
  }

  return { infoMap, modelNames, metadataError, modelListError };
}

function writeJsonFile(filePath, value, { compactModelEntries = false } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${compactModelEntries ? stringifyModelsJson(value) : JSON.stringify(value, null, 2)}\n`;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  if (existing === content) return false;
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures on non-POSIX filesystems
  }
  return true;
}

async function mainLiteLLMPrintKey(argv) {
  let options;
  try {
    options = parseLitellmPrintKeyArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Run `khala litellm --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(litellmPrintKeyUsage());
    return;
  }
  if (options.version) { console.log(version()); return; }

  try {
    if (!options.provider) {
      throw new Error("Missing required LiteLLM option: --provider.");
    }
    const provider = validateLiteLLMProviderId(options.provider);
    const configPath = findLiteLLMProjectConfigPath();
    if (!configPath) {
      throw new Error(`No project LiteLLM key config found for provider '${provider}'. Run khala litellm --project first.`);
    }
    const config = readJsonObjectFile(configPath);
    const providerConfig = config?.providers?.[provider];
    if (!providerConfig || typeof providerConfig.keyEnv !== "string") {
      throw new Error(`No project LiteLLM key env is configured for provider '${provider}'. Run khala litellm --project --provider ${provider} --key-env <env-var>.`);
    }
    const keyEnv = validateLiteLLMKeyEnv(providerConfig.keyEnv);
    const value = lookupKeyValueByName(keyEnv);
    if (!value) {
      const auth = readJsonObjectFile(authJsonPath());
      const keyAuthId = liteLLMKeyAuthId(provider, keyEnv);
      const authEntry = isPlainObject(auth) && isPlainObject(auth[keyAuthId]) ? auth[keyAuthId] : null;
      const providerAuthEntry = isPlainObject(auth) && isPlainObject(auth[provider]) ? auth[provider] : null;
      if (authEntry?.type === "api_key" && typeof authEntry.key === "string") {
        const authValue = resolveKeyForFetch(authEntry.key);
        if (authValue) {
          process.stdout.write(authValue);
          return;
        }
      }
      if (providerAuthEntry?.type === "api_key" && typeof providerAuthEntry.key === "string") {
        const authValue = resolveKeyForFetch(providerAuthEntry.key);
        if (authValue) {
          process.stdout.write(authValue);
          return;
        }
      }
      // Tell the user which env var to actually export. With portal-style
      // labels (e.g. `reeds-maint`) the literal isn't a valid shell ident,
      // so we name the derived form they'd type into `export`.
      const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;
      const authHint = authEntry || providerAuthEntry ? ` Stored auth.json entry for provider '${provider}' could not be resolved either.` : "";
      throw new Error(`Project LiteLLM key '${keyEnv}' has no exported value (expected $${envVar}).${authHint}`);
    }
    process.stdout.write(value);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function mainLiteLLM(argv) {
  if (argv[0] === "print-key") {
    await mainLiteLLMPrintKey(argv.slice(1));
    return;
  }
  if (argv[0] && !argv[0].startsWith("-")) {
    console.error(`Unknown command: ${argv[0]}`);
    console.error("Run `khala litellm --help` for usage.");
    process.exitCode = 2;
    return;
  }

  let options;
  try {
    options = parseLitellmArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Run `khala litellm --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help) { console.log(litellmUsage()); return; }
  if (options.version) { console.log(version()); return; }

  try {
    const promptAvailable = canPrompt();
    const inputAvailable = promptAvailable && !options.noInput;
    const missing = [];
    let provider = options.provider;
    let baseUrl = options.baseUrl;
    let keyEnv = options.keyEnv;
    let reusedKeyDefaults = null;
    let newKeyProviderDefaults = null;

    if (inputAvailable && !options.yes && !options.dryRun) {
      console.log(cyan(bold("Khala")) + dim(" · LiteLLM provider setup"));
      console.log(hint("Connect Pi to a LiteLLM-compatible proxy. Press Ctrl-C any time to cancel."));
    }

    const hasExplicitLiteLLMSetupInput = Boolean(provider || baseUrl || keyEnv || options.model || options.authMode || options.authKey || options.authCommand);
    if (inputAvailable && !options.yes && !options.dryRun && !hasExplicitLiteLLMSetupInput) {
      const ADD_KEY = "New provider and key";
      const ADD_KEY_TO_EXISTING_PROVIDER = "New key for existing provider";
      const REUSE_KEY = "Reuse existing key";
      const existingProviders = liteLLMProvidersFromModelsJson();
      const setupChoices = existingProviders.length
        ? [ADD_KEY, ADD_KEY_TO_EXISTING_PROVIDER, REUSE_KEY]
        : [ADD_KEY, REUSE_KEY];
      const setupMode = await collapseSection("Key setup", async () => {
        console.log(stepHeading("Key setup"));
        console.log(hint("  Create a provider, add a key label, or reuse one from another project."));
        return askChoice("LiteLLM key setup", setupChoices, ADD_KEY);
      }, {
        formatValue: (value) => {
          if (value === REUSE_KEY) return dim("reuse existing key");
          if (value === ADD_KEY_TO_EXISTING_PROVIDER) return dim("add key to existing provider");
          return dim("add provider and key");
        },
      });

      if (setupMode === ADD_KEY_TO_EXISTING_PROVIDER) {
        if (!existingProviders.length) {
          throw new Error("No existing Khala LiteLLM providers found. Add a provider first, then rerun khala litellm to add another key.");
        }
        const providerChoices = existingProviders.map((candidate) => candidate.name);
        const selectedProvider = await collapseSection("Existing provider", async () => {
          console.log(stepHeading("Existing provider"));
          console.log(hint("  Choose the LiteLLM provider that should receive another key label."));
          return askChoice("LiteLLM provider", providerChoices, providerChoices[0]);
        }, { formatValue: (value) => dim(value) });
        newKeyProviderDefaults = existingProviders.find((candidate) => candidate.name === selectedProvider) ?? existingProviders[0];
        provider = newKeyProviderDefaults.name;
        baseUrl = newKeyProviderDefaults.baseUrl;
      } else if (setupMode === REUSE_KEY) {
        const candidates = reusableLiteLLMKeyCandidates();
        if (!candidates.length) {
          throw new Error("No reusable LiteLLM keys found. Add a new key first, then rerun khala litellm in another project to reuse it.");
        }
        const providerChoices = [...new Set(candidates.map((candidate) => candidate.provider))];
        const selectedProvider = await collapseSection("Reuse provider", async () => {
          console.log(stepHeading("Reuse provider"));
          console.log(hint("  Choose the LiteLLM provider this project should use."));
          return askChoice("LiteLLM provider", providerChoices, providerChoices[0]);
        }, { formatValue: (value) => dim(value) });
        const providerCandidates = candidates.filter((candidate) => candidate.provider === selectedProvider);
        const labeledCandidates = providerCandidates.filter((candidate) => !candidate.needsKeyLabel);
        if (labeledCandidates.length > 0) {
          const keyChoices = labeledCandidates.map(reusableLiteLLMKeyLabelChoice);
          const selectedKey = await collapseSection("Key name", async () => {
            console.log(stepHeading("Key name"));
            console.log(hint("  Choose the key label to reuse for this provider."));
            return askChoice("Key name", keyChoices, keyChoices[0]);
          }, { formatValue: (value) => dim(value) });
          const pickedIndex = keyChoices.indexOf(selectedKey);
          reusedKeyDefaults = labeledCandidates[pickedIndex] ?? labeledCandidates[0];
        } else {
          const providerFallback = providerCandidates[0];
          const selectedKeyEnv = await collapseSection("Key name", async () => {
            console.log(stepHeading("Key name"));
            console.log(hint("  This provider has stored auth but no saved key label yet. Name it once so future projects can select it."));
            return promptValidated(`  ${GLYPH.arrow} Key label: `, validateLiteLLMKeyEnv, liteLLMPromptError("keyLabel"));
          });
          reusedKeyDefaults = { ...providerFallback, keyEnv: selectedKeyEnv, needsKeyLabel: true };
        }
        provider = reusedKeyDefaults.provider;
        baseUrl = reusedKeyDefaults.baseUrl;
        keyEnv = reusedKeyDefaults.keyEnv;
        options.model = reusedKeyDefaults.modelIds.join(",");
        if (!options.authMode && !options.authKey && !options.authCommand) {
          options.authMode = "skip";
        }
      }
    }

    if (!provider) {
      if (!inputAvailable) missing.push("--provider");
      else {
        provider = await collapseSection("Provider", async () => {
          console.log(stepHeading("Provider"));
          console.log(hint("  The LiteLLM proxy Pi will call. Use a short id for Pi config, e.g. NLR."));
          return promptValidated(`  ${GLYPH.arrow} Provider id: `, validateLiteLLMProviderId, liteLLMPromptError("provider"));
        });
      }
    } else {
      provider = validateLiteLLMProviderId(provider);
    }

    if (!baseUrl) {
      if (!inputAvailable) missing.push("--base-url");
      else {
        baseUrl = await collapseSection("Base URL", async () => {
          console.log(stepHeading("Base URL"));
          const defaultBaseUrl = rememberedLiteLLMBaseUrl(provider);
          console.log(hint(defaultBaseUrl
            ? "  OpenAI-compatible LiteLLM endpoint. Press Enter to reuse the remembered URL."
            : "  OpenAI-compatible LiteLLM endpoint, usually ending in /v1."));
          return promptValidated(
            `  ${GLYPH.arrow} Base URL${defaultBaseUrl ? ` [${defaultBaseUrl}]` : ""}: `,
            normalizeLiteLLMBaseUrl,
            liteLLMPromptError("baseUrl"),
            { defaultValue: defaultBaseUrl },
          );
        });
      }
    } else {
      baseUrl = normalizeLiteLLMBaseUrl(baseUrl);
    }

    if (!keyEnv) {
      if (!inputAvailable) missing.push("--key-env");
      else {
        keyEnv = await collapseSection("Project key", async () => {
          console.log(stepHeading("Project key"));
          console.log(hint("  Label for this project's LiteLLM key. Examples: reeds-maint, team.litellm.prod"));
          return promptValidated(`  ${GLYPH.arrow} Project key label: `, validateLiteLLMKeyEnv, liteLLMPromptError("keyLabel"));
        });
      }
    } else {
      keyEnv = validateLiteLLMKeyEnv(keyEnv);
    }
    // Shell-canonical derived form. Used at every shell-touching surface:
    // $env interpolation in summary/error rows, the export instruction we
    // emit on auth-skip mode, and (with literal fallback) process.env
    // lookup for /model/info. When the user typed a clean identifier this
    // equals keyEnv and nothing visible changes.
    const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;
    const targetModelsPath = modelsJsonPath();
    const targetSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
    const targetKeyConfigPath = litellmProjectConfigPath();
    const targetKeyRegistryPath = litellmKeyRegistryPath();
    const targetAuthPath = authJsonPath();

    const currentAuth = readJsonObjectFile(targetAuthPath);
    const keyAuthId = liteLLMKeyAuthId(provider, keyEnv);
    const existingKeyAuthEntry = isPlainObject(currentAuth) && isPlainObject(currentAuth[keyAuthId]) ? currentAuth[keyAuthId] : null;
    const hasExistingKeyAuth = isStoredLiteLLMAuthEntry(existingKeyAuthEntry);
    const existingAuthEntry = isPlainObject(currentAuth) && isPlainObject(currentAuth[provider]) ? currentAuth[provider] : null;
    const hasExistingAuth = Boolean(existingAuthEntry && existingAuthEntry.type === "api_key" && typeof existingAuthEntry.key === "string" && existingAuthEntry.key.length > 0);
    const existingProviderKeyRegistration = Boolean(newKeyProviderDefaults);
    const reusedProviderKeyRegistration = Boolean(reusedKeyDefaults);
    const registeredProviderKeyFlow = existingProviderKeyRegistration || reusedProviderKeyRegistration;
    const preserveProviderAuth = Boolean(newKeyProviderDefaults && hasExistingAuth);
    let writeProjectKeyConfig = !registeredProviderKeyFlow;
    let resolvedKey = lookupKeyValueByName(keyEnv);

    // ── Auth-mode resolution ──────────────────────────────────────────────
    // Interactive setup asks for the key before model selection, so the user
    // has a complete mental model before we fetch metadata or preview writes.
    // Flag-driven runs keep the existing explicit --auth-mode contract.
    let authMode = (options.authMode ?? "").trim().toLowerCase();
    if (authMode && !AUTH_MODES.has(authMode)) {
      throw new Error(`Unknown --auth-mode '${authMode}'. Expected one of: ${[...AUTH_MODES].join(", ")}.`);
    }
    if (!authMode && options.authKey) authMode = "literal";
    if (!authMode && options.authCommand) authMode = "command";
    // The interactive API-key flow (replace-prompt + masked entry) renders
    // inside one collapsible section so it folds to a single "✓ API key" line.
    // `capturedLiteralKey` carries the value the section already read so the
    // literal-mode block below doesn't prompt again.
    let capturedLiteralKey;
    if (!authMode && inputAvailable && !options.yes && !options.dryRun) {
      const result = await collapseSection("API key", async () => {
        console.log(stepHeading("API key"));
        let mode = "literal";
        if (hasExistingKeyAuth) {
          console.log(hint(`  A stored API key already exists for provider ${bold(provider)} with key label ${bold(keyEnv)}.`));
          const replace = await askConfirmation(`  ${GLYPH.arrow} Overwrite the stored key for ${keyEnv}?`, { defaultYes: false });
          mode = replace ? "literal" : "skip";
        } else if (preserveProviderAuth) {
          console.log(hint(`  A provider-level API key already exists for ${bold(provider)}. This new key will be stored under label ${bold(keyEnv)} without replacing it.`));
        } else if (hasExistingAuth) {
          console.log(hint(`  A stored API key already exists for provider ${bold(provider)} in the global auth store.`));
          const replace = await askConfirmation(`  ${GLYPH.arrow} Replace the stored key?`, { defaultYes: false });
          mode = replace ? "literal" : "skip";
        }
        let key;
        if (mode === "literal") {
          console.log(hint("  Paste the key value. Input is masked and the raw key is never printed."));
          while (!key) {
            try {
              key = validateAuthLiteral(await promptSecret(`  ${GLYPH.arrow} API key: `));
            } catch (error) {
              if (isAbortError(error)) throw error;
              console.log(warn(`  ${error.message}`));
            }
          }
        }
        return { mode, key };
      }, { formatValue: (r) => r.mode === "literal" ? dim("••••••••") : dim("kept existing key") });
      authMode = result.mode;
      capturedLiteralKey = result.key;
    }
    if (!authMode) authMode = "skip";

    let authPayload = null;
    if (authMode === "literal") {
      let value = options.authKey ?? capturedLiteralKey;
      while (!value && inputAvailable && !options.yes && !options.dryRun) {
        try {
          console.log(stepHeading("API key"));
          console.log(hint("  Paste the key value. Input is masked and the raw key is never printed."));
          value = validateAuthLiteral(await promptSecret(`  ${GLYPH.arrow} API key: `));
        } catch (error) {
          if (isAbortError(error)) throw error;
          console.log(warn(`  ${error.message}`));
        }
      }
      if (!value) {
        if (!inputAvailable) {
          throw new Error("--auth-mode=literal needs --auth-key=<value> in non-interactive mode.");
        }
        value = await promptSecret(`API key value for ${bold(provider)} ${dim("(input is masked; will be stored in auth.json with 0600 perms)")}\n${dim("›")} `);
      }
      authPayload = { mode: "literal", key: validateAuthLiteral(value) };
      resolvedKey = authPayload.key;
    } else if (authMode === "command") {
      let cmd = options.authCommand;
      if (!cmd) {
        if (!inputAvailable) {
          throw new Error("--auth-mode=command needs --auth-command=<!cmd> in non-interactive mode.");
        }
        cmd = await promptValidated(
          `Shell command for the key ${dim(`(must start with '!', e.g. "!op read 'op://Personal/${provider}/credential'")`)}\n${dim("›")} `,
          validateAuthCommand,
        );
      }
      authPayload = { mode: "command", key: validateAuthCommand(cmd) };
      const fromCmd = resolveKeyForFetch(authPayload.key);
      resolvedKey = fromCmd || undefined;
    } else if (hasExistingKeyAuth) {
      const fromAuth = resolveKeyForFetch(existingKeyAuthEntry.key);
      if (fromAuth) resolvedKey = fromAuth;
    } else if (hasExistingAuth) {
      const fromAuth = resolveKeyForFetch(existingAuthEntry.key);
      if (fromAuth) resolvedKey = fromAuth;
    }

    if (registeredProviderKeyFlow && inputAvailable && !options.yes && !options.dryRun) {
      writeProjectKeyConfig = await collapseSection("Project config", async () => {
        console.log(stepHeading("Project config"));
        console.log(hint(`  Optionally configure this project to use the ${reusedProviderKeyRegistration ? "selected" : "new"} key label now.`));
        console.log(hint(`  Writes: ${targetKeyConfigPath}`));
        return askConfirmation(`  ${GLYPH.arrow} Configure this project to use ${keyEnv}?`, { defaultYes: false });
      }, { formatValue: (value) => dim(value ? targetKeyConfigPath : "skip local project config") });
    }

    if (reusedProviderKeyRegistration && !writeProjectKeyConfig && inputAvailable && !options.yes && !options.dryRun) {
      console.log(`${dim("Skipped.")}  No files were written.`);
      return;
    }

    const rawModels = (typeof options.model === "string" ? options.model : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const shouldFetchCatalogBeforePrompt = !registeredProviderKeyFlow && inputAvailable && !options.yes && !options.dryRun && !rawModels.length;
    const shouldStartCatalogFetch = !registeredProviderKeyFlow && Boolean(resolvedKey);
    const catalogFetchPromise = shouldStartCatalogFetch
      ? (shouldFetchCatalogBeforePrompt
        ? fetchLiteLLMCatalog(baseUrl, resolvedKey)
        : fetchLiteLLMModelInfo(baseUrl, resolvedKey).then((infoMap) => ({
          infoMap,
          modelNames: [],
          metadataError: null,
          modelListError: null,
        })))
        .catch((error) => ({ error }))
      : null;

    let infoMap = new Map();
    let catalogModelNames = [];
    let metadataStatus;
    let metadataIsWarning = false;
    let metadataPrinted = false;
    if (shouldFetchCatalogBeforePrompt) {
      console.log(`\n${dim(GLYPH.dot)} ${dim("Fetching model catalog...")}`);
      if (catalogFetchPromise) {
        const result = await catalogFetchPromise;
        if (result.error) {
          metadataStatus = formatMetadataFailure(result.error, options.verbose);
          metadataIsWarning = true;
          console.log(warn(metadataStatus));
          metadataPrinted = true;
        } else {
          infoMap = result.infoMap;
          catalogModelNames = result.modelNames;
          if (result.modelListError && !result.modelNames.length) {
            metadataStatus = formatCatalogFailure(result.modelListError, options.verbose);
            metadataIsWarning = true;
            console.log(warn(metadataStatus));
            metadataPrinted = true;
          } else if (result.metadataError) {
            metadataStatus = result.modelNames.length
              ? `Fetched model list. Detailed metadata unavailable: ${httpStatusFromMessage(result.metadataError.message) ?? "request failed"}.`
              : formatMetadataFailure(result.metadataError, options.verbose);
            metadataIsWarning = true;
            console.log(warn(metadataStatus));
            metadataPrinted = true;
          }
        }
      } else if (authMode === "command") {
        metadataStatus = "Could not fetch model metadata: auth command produced no output. Models will still work if the ids are correct.";
        metadataIsWarning = true;
        console.log(warn(metadataStatus));
        metadataPrinted = true;
      } else if (authMode === "skip") {
        metadataStatus = `Could not fetch model metadata: no API key was available. Export $${envVar} or store a key to enable metadata. Models will still work if the ids are correct.`;
        metadataIsWarning = true;
        console.log(warn(metadataStatus));
        metadataPrinted = true;
      }
    }

    let modelIds = [];
    if (registeredProviderKeyFlow) {
      modelIds = [...(newKeyProviderDefaults?.models ?? [])];
      if (reusedProviderKeyRegistration) modelIds = [...(reusedKeyDefaults?.modelIds ?? [])];
    } else if (rawModels.length) {
      // --model accepts a single bare name or a comma-separated list.
      modelIds = rawModels.map(normalizeLiteLLMModelPattern);
      validateNonInteractiveLiteLLMModelIds(modelIds);
    } else if (!inputAvailable) {
      missing.push("--model");
    } else {
      modelIds = await promptLiteLLMModelIds(catalogModelNames);
    }

    if (missing.length) {
      throw new Error(`Missing required LiteLLM options: ${missing.join(", ")}. Run in a TTY to answer prompts, or pass all required flags explicitly.`);
    }

    let writeProjectSettings = options.projectSettings === true;
    if (!existingProviderKeyRegistration && writeProjectKeyConfig && options.projectSettings === null && inputAvailable && !options.yes && !options.dryRun) {
      console.log("");
      writeProjectSettings = await askConfirmation(`  ${GLYPH.arrow} Set this project's Pi defaults to these models?`, { defaultYes: false });
    }

    // Attempt to fetch rich model metadata from LiteLLM's /model/info. In
    // the wizard path this may already have happened before model entry so
    // catalog failures appear at the point where they matter.
    if (shouldFetchCatalogBeforePrompt && infoMap.size > 0) {
      const matched = modelIds.filter((id) => infoMap.has(id)).length;
      metadataStatus = `${matched}/${modelIds.length} enriched from /model/info`;
      metadataIsWarning = matched < modelIds.length;
    } else if (!shouldFetchCatalogBeforePrompt && catalogFetchPromise) {
      const result = await catalogFetchPromise;
      if (!result.error) {
        infoMap = result.infoMap;
        const matched = modelIds.filter((id) => infoMap.has(id)).length;
        if (infoMap.size > 0) {
          metadataStatus = `${matched}/${modelIds.length} enriched from /model/info`;
          metadataIsWarning = matched < modelIds.length;
        } else if (result.modelListError && !result.modelNames.length) {
          metadataStatus = formatCatalogFailure(result.modelListError, options.verbose);
          metadataIsWarning = true;
        } else if (result.metadataError) {
          metadataStatus = result.modelNames.length
            ? `Fetched model list. Detailed metadata unavailable: ${httpStatusFromMessage(result.metadataError.message) ?? "request failed"}.`
            : formatMetadataFailure(result.metadataError, options.verbose);
          metadataIsWarning = true;
        }
      } else {
        const { error } = result;
        metadataStatus = formatMetadataFailure(error, options.verbose);
        metadataIsWarning = true;
      }
    } else if (!registeredProviderKeyFlow && !shouldFetchCatalogBeforePrompt && authMode === "command") {
      metadataStatus = "Could not fetch model metadata: auth command produced no output. Models will still work if the ids are correct.";
      metadataIsWarning = true;
    } else if (!registeredProviderKeyFlow && !shouldFetchCatalogBeforePrompt && authMode === "skip") {
      metadataStatus = `Could not fetch model metadata: no API key was available. Export $${envVar} or store a key to enable metadata. Models will still work if the ids are correct.`;
      metadataIsWarning = true;
    }

    const currentModels = registeredProviderKeyFlow ? null : readJsonObjectFile(targetModelsPath);
    const currentSettings = writeProjectSettings ? readJsonObjectFile(targetSettingsPath) : null;
    const currentKeyConfig = writeProjectKeyConfig ? readJsonObjectFile(targetKeyConfigPath) : null;
    const currentKeyRegistry = readLiteLLMKeyRegistry();
    const apiKeyResolverCommand = khalaResolverCommand();
    const mergedModels = registeredProviderKeyFlow ? null : mergeLiteLLMModelsJson(currentModels, { providerId: provider, baseUrl, keyEnv, modelIds, infoMap, apiKeyResolverCommand });
    const mergedSettings = writeProjectSettings ? mergeLiteLLMProjectSettings(currentSettings, { providerId: provider, modelIds }) : null;
    const mergedKeyConfig = writeProjectKeyConfig ? mergeLiteLLMProjectKeyConfig(currentKeyConfig, { providerId: provider, keyEnv }) : null;
    const writeKeyRegistry = !reusedProviderKeyRegistration || Boolean(reusedKeyDefaults?.needsKeyLabel);
    const mergedKeyRegistry = writeKeyRegistry ? mergeLiteLLMKeyRegistry(currentKeyRegistry, { provider, keyEnv, baseUrl, modelIds }) : null;

    if (metadataStatus && !metadataPrinted) console.log(metadataIsWarning ? warn(metadataStatus) : metadataStatus);

    const modelCount = `${modelIds.length} model${modelIds.length === 1 ? "" : "s"}`;
    const providerVerb = mergedModels?.isUpdate ? "update" : "add";
    const providerLocation = describeLocation("global model registry", targetModelsPath, options.verbose);
    const projectKeyLocation = describeLocation("project LiteLLM config", targetKeyConfigPath, options.verbose);
    const keyRegistryLocation = describeLocation("global LiteLLM key registry", targetKeyRegistryPath, options.verbose);
    const authLocation = describeLocation("global auth store", targetAuthPath, options.verbose);
    const settingsLocation = describeLocation("project Pi defaults", targetSettingsPath, options.verbose);
    console.log("");
    console.log(titleLine("Ready to write", { dryRun: options.dryRun }));
    if (reusedKeyDefaults) {
      console.log(rowKeep(`reuse LiteLLM provider ${reusedKeyDefaults.provider} with key label ${reusedKeyDefaults.keyEnv}`));
    } else if (newKeyProviderDefaults) {
      console.log(rowKeep(`add key label ${keyEnv} to existing LiteLLM provider ${newKeyProviderDefaults.name}`));
    }
    if (registeredProviderKeyFlow) {
      console.log(rowKeep(`leave ${providerLocation} provider ${provider} unchanged`));
      if (writeProjectKeyConfig) {
        console.log(rowAdd(`save project key label ${keyEnv} in ${projectKeyLocation}`));
      } else {
        console.log(rowKeep(`leave ${projectKeyLocation} unchanged`));
      }
    } else {
      const rowProvider = mergedModels.isUpdate ? rowSwap : rowAdd;
      console.log(rowProvider(`${providerVerb} ${providerLocation} provider ${provider} with ${modelCount}`));
      console.log(rowAdd(`save project key label ${keyEnv} in ${projectKeyLocation}`));
    }
    if (writeKeyRegistry) {
      console.log(rowAdd(`remember key label ${keyEnv} for provider ${provider} in ${keyRegistryLocation}`));
    } else {
      console.log(rowKeep(`leave ${keyRegistryLocation} unchanged`));
    }
    if (authMode === "literal") {
      if (preserveProviderAuth) {
        console.log(rowAdd(`store API key for label ${keyEnv} in ${authLocation} and keep existing provider key`));
      } else {
        console.log((hasExistingAuth ? rowSwap : rowAdd)(`store API key in ${authLocation}${hasExistingAuth ? " (replace existing key)" : ""}`));
      }
    } else if (authMode === "command") {
      if (preserveProviderAuth) {
        console.log(rowAdd(`store API key command for label ${keyEnv} in ${authLocation} and keep existing provider key`));
      } else {
        console.log((hasExistingAuth ? rowSwap : rowAdd)(`store API key command in ${authLocation}${hasExistingAuth ? " (replace existing key)" : ""}`));
      }
    } else if (hasExistingKeyAuth) {
      console.log(rowKeep(`keep existing API key for label ${keyEnv} in ${authLocation}`));
    } else if (hasExistingAuth) {
      console.log(rowKeep(`keep existing API key in ${authLocation}`));
    } else if (resolvedKey) {
      console.log(rowKeep(`use API key from $${envVar}; do not write ${authLocation}`));
    } else {
      console.log(rowKeep(`leave ${authLocation} unchanged`));
    }
    if (writeProjectSettings) {
      console.log(rowAdd(`set ${settingsLocation} to ${modelSummary(modelIds)}`));
    } else {
      console.log(rowKeep(`leave ${settingsLocation} unchanged`));
    }
    if (options.verbose) {
      console.log(dim(`  provider apiKey command ${buildLiteLLMApiKeyCommand(provider, apiKeyResolverCommand)}`));
      console.log(dim(`  api ${LITELLM_PROVIDER_API}`));
      console.log(dim(`  base URL ${baseUrl}`));
    }
    if (mergedModels?.conflict) {
      console.log(warn("  existing provider config differs and will be updated only if you confirm"));
    }

    if (options.dryRun) {
      console.log(nextStep(`Run without ${bold("--dry-run")} when you are ready to write.`));
      return;
    }

    if (!options.yes) {
      if (!canPrompt()) {
        throw new Error("LiteLLM setup writes require --yes in non-interactive mode.");
      }
      console.log("");
      const confirmed = await askConfirmation(`${GLYPH.arrow} Write changes?`);
      if (!confirmed) {
        console.log(`${dim("Skipped.")}  No files were written.`);
        return;
      }
    }

    if (!registeredProviderKeyFlow) writeJsonFile(targetModelsPath, mergedModels.value, { compactModelEntries: true });
    if (writeProjectSettings) writeJsonFile(targetSettingsPath, mergedSettings);
    if (writeProjectKeyConfig) writeJsonFile(targetKeyConfigPath, mergedKeyConfig);
    if (writeKeyRegistry) writeJsonFile(targetKeyRegistryPath, mergedKeyRegistry);

    // auth.json is written ONLY when the user picked literal/command. The
    // file gets 0600 perms (writeSecureJsonFile chmods explicitly after
    // write to cover both create and update). Unrelated providers in the
    // existing auth.json are preserved by mergeAuthJsonApiKey.
    let authWritten = false;
    if (authPayload && (authPayload.mode === "literal" || authPayload.mode === "command")) {
      const mergedAuth = preserveProviderAuth
        ? { value: isPlainObject(currentAuth) ? { ...currentAuth } : {} }
        : mergeAuthJsonApiKey(currentAuth, provider, authPayload.key);
      if (!preserveProviderAuth && !isStoredLiteLLMAuthEntry(mergedAuth.value[provider])) {
        mergedAuth.value[provider] = { type: "api_key", key: authPayload.key };
      }
      mergedAuth.value[keyAuthId] = { type: "api_key", key: authPayload.key };
      writeSecureJsonFile(targetAuthPath, mergedAuth.value);
      authWritten = true;
    }

    console.log("");
    const doneMessage = existingProviderKeyRegistration
      ? " LiteLLM key is registered."
      : (reusedProviderKeyRegistration ? " LiteLLM project is configured." : " LiteLLM provider is configured.");
    console.log(green(bold("Done.")) + dim(doneMessage));
    if (registeredProviderKeyFlow) {
      console.log(`${dim(GLYPH.dash)} ${dim("Left global model registry unchanged.")}`);
    } else {
      console.log(wroteLine(describeLocation("global model registry", targetModelsPath, options.verbose)));
    }
    if (writeProjectSettings) {
      console.log(wroteLine(describeLocation("project Pi defaults", targetSettingsPath, options.verbose)));
      console.log(`${dim(GLYPH.dash)} ${dim("pi --list-models is global; project model defaults live in .pi/settings.json.")}`);
    } else {
      console.log(`${dim(GLYPH.dash)} ${dim("Left project Pi defaults unchanged.")}`);
    }
    if (!writeProjectKeyConfig) {
      console.log(`${dim(GLYPH.dash)} ${dim("Left project LiteLLM config unchanged.")}`);
    } else {
      console.log(wroteLine(describeLocation("project LiteLLM config", targetKeyConfigPath, options.verbose)));
    }
    if (writeKeyRegistry) {
      console.log(wroteLine(describeLocation("global LiteLLM key registry", targetKeyRegistryPath, options.verbose)));
    } else {
      console.log(`${dim(GLYPH.dash)} ${dim("Left global LiteLLM key registry unchanged.")}`);
    }
    if (authWritten) {
      console.log(wroteLine(`${describeLocation("global auth store", targetAuthPath, options.verbose)} ${dim("(0600)")}`));
    }
    if (options.verbose || authWritten) {
      console.log(authWritten
        ? `Khala stored your API key in ${describeLocation("global auth store", targetAuthPath, options.verbose)} ${dim("(0600, user-only)")}`
        : "Khala stored a key reference, not a secret value.");
    }
  } catch (error) {
    if (isAbortError(error)) {
      console.log("Cancelled.");
      process.exitCode = 130;
      return;
    }
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
}

// ── Scope + model prompts ───────────────────────────────────────────────────
async function askScope(options) {
  if (options.project) return "project";
  if (options.global || options.yes || !canPrompt()) return defaultScope(options);

  console.log(stepHeading("Install scope"));
  console.log(hint("  Choose where Pi should load the khala package and workflow defaults."));
  const result = await askChoice("Scope", [
    "global  — ~/.pi/agent/settings.json",
    "project — .pi/settings.json",
  ], "global  — ~/.pi/agent/settings.json");
  const scope = result.startsWith("project") ? "project" : "global";
  console.log(`${check(GLYPH.tick)} ${bold("Install scope")}  ${dim(scope)}`);
  return scope;
}

const THINKING_CHOICES = ["xhigh", "high", "medium", "low", "minimal", "off"];

async function askProfile(label, defaultThinking, providers, discoveryRows, fallbackPresets) {
  const choices = buildProfileChoices(providers, discoveryRows, fallbackPresets);
  const fallbackId = fallbackPresets[0]?.split(":")[0] ?? choices[0];
  const defaultId = choices.includes(fallbackId) ? fallbackId : choices[0];

  console.log(stepHeading(label));
  console.log(hint("  Pick the model Pi should use for this workflow role."));
  const modelId = await askChoice(`${label} model`, choices, defaultId);
  const [provider, model] = modelId.split("/");
  if (!modelSupportsThinking(discoveryRows, provider, model)) {
    const profile = `${modelId}:off`;
    console.log(`${check(GLYPH.tick)} ${bold(label)}  ${dim(profile)}`);
    return profile;
  }

  const thinking = await askChoice(`${label} thinking`, THINKING_CHOICES, defaultThinking);
  const profile = `${modelId}:${thinking}`;
  console.log(`${check(GLYPH.tick)} ${bold(label)}  ${dim(profile)}`);
  return profile;
}

async function askModels(options) {
  if (options.yes || !canPrompt()) return DEFAULT_MODELS;

  const providers = liteLLMProvidersFromModelsJson();
  const rows      = piDiscoveryRows();

  console.log(stepHeading("Workflow models"));
  console.log(hint("  Defaults are recommended. Use filtering if you already know the provider/model id."));

  const planning    = await askProfile("Planning",    "off",    providers, rows, MODEL_PRESETS.planning);
  const development = await askProfile("Development", "off",    providers, rows, MODEL_PRESETS.development);
  const peerReview  = await askProfile("Peer review", "off",    providers, rows, MODEL_PRESETS.peerReview);
  const triage      = await askProfile("Triage",      "off",    providers, rows, MODEL_PRESETS.triage);
  const knowledge   = await askProfile("Knowledge",   "off",    providers, rows, MODEL_PRESETS.knowledge);
  const lightweight = await askProfile("Lightweight", "off",    providers, rows, MODEL_PRESETS.lightweight);

  return { planning, development, peerReview, triage, knowledge, lightweight };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "litellm") {
    await mainLiteLLM(argv.slice(1));
    return;
  }
  if (argv[0] && !argv[0].startsWith("-")) {
    console.error(`Unknown command: ${argv[0]}`);
    console.error("Run `khala --help` for usage.");
    process.exitCode = 2;
    return;
  }

  // Top-level mode prompt. The full pi setup is the default destination,
  // but a meaningful share of users land here only to point pi at an
  // existing LiteLLM proxy — they don't need to know the `litellm`
  // subcommand exists for that to be a one-arrow-key choice. We only
  // prompt when the user gave us no signal: any flag (including --help,
  // --version, --global, --dry-run) means they've already chosen a path.
  if (argv.length === 0 && canPrompt()) {
    const PI_LABEL = "Set up pi for this project (install + planning/dev/review models)";
    const LITELLM_LABEL = "Only add a LiteLLM provider (skip pi install)";
    try {
      console.log(cyan(bold("Khala")) + dim(" · setup"));
      console.log(hint("Choose the full Pi install or only add a LiteLLM provider. Press Ctrl-C any time to cancel."));
      const mode = await askChoice("Setup path", [PI_LABEL, LITELLM_LABEL], PI_LABEL);
      if (mode === LITELLM_LABEL) {
        await mainLiteLLM([]);
        return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        console.log("Cancelled.");
        process.exitCode = 130;
        return;
      }
      throw error;
    }
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Run `khala --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help)    { console.log(usage());   return; }
  if (options.version) { console.log(version()); return; }

  try {
    const scope  = await askScope(options);
    const models = await askModels(options);

    const args             = installArgs(scope);
    const targetConfigPath = configPath(scope);
    const targetSettingsPath = settingsPath(scope);
    const labelWidth = 12;
    const scopeLabel = scope === "project" ? "project" : "global";

    console.log("");
    console.log(titleLine("Khala configuration", { dryRun: options.dryRun }));
    console.log(rowAdd(`install khala package in ${scopeLabel} Pi settings (${targetSettingsPath})`));
    console.log(rowAdd(`write workflow model config ${targetConfigPath}`));
    console.log(rowKeep(`${"planning".padEnd(labelWidth)}${models.planning}`));
    console.log(rowKeep(`${"development".padEnd(labelWidth)}${models.development}`));
    console.log(rowKeep(`${"peer-review".padEnd(labelWidth)}${models.peerReview}`));
    console.log(rowKeep(`${"triage".padEnd(labelWidth)}${models.triage}`));
    console.log(rowKeep(`${"knowledge".padEnd(labelWidth)}${models.knowledge}`));
    console.log(rowKeep(`${"lightweight".padEnd(labelWidth)}${models.lightweight}`));

    if (options.dryRun) {
      console.log(nextStep(`Run without ${bold("--dry-run")} when you are ready to install.`));
      return;
    }

    // Install
    console.log("");
    const confirmed = await confirmInstall(options);
    if (!confirmed) {
      console.log(`${dim("Skipped.")}  Run ${bold(`pi ${args.join(" ")}`)} when you are ready.`);
      return;
    }

    const invocation = buildPiCommandInvocation(args, { spawnOptions: { stdio: "inherit" } });
    if (!invocation) {
      console.error(PI_CLI_REQUIRED_MESSAGE);
      process.exitCode = 1;
      return;
    }

    const result = spawnSync(invocation.command, invocation.args, invocation.spawnOptions);
    if (result.error) {
      console.error(`Failed to run pi: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.status ?? 1;
    if (process.exitCode === 0) {
      writeWorkflowConfig(targetConfigPath, models);
      console.log("");
      console.log(green(bold("Done.")) + dim(" Khala is installed."));
      console.log(wroteLine(`workflow model config ${targetConfigPath}`));
      console.log(nextStep(`Start Pi and run ${bold("/khala-health")} to verify.`));
    }
  } catch (error) {
    if (isAbortError(error)) {
      console.log("Cancelled.");
      process.exitCode = 130;
      return;
    }
    throw error;
  }
}

await main();
