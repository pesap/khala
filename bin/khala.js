#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import {
  LITELLM_PROVIDER_API,
  buildLiteLLMApiKeyCommand,
  buildProfileChoices,
  filterValidLiteLLMModelNames,
  mergeAuthJsonApiKey,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectKeyConfig,
  mergeLiteLLMProjectSettings,
  modelSupportsThinking,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  parseLiteLLMModelInfoResponse,
  readJsonObjectFile,
  stringifyModelsJson,
  validateAuthCommand,
  validateAuthLiteral,
  validateLiteLLMKeyEnv,
  deriveEnvVarFromKeyName,
  validateLiteLLMProviderId,
} from "./khala-setup-lib.js";

const PACKAGE_SPEC = "npm:khala";
const WORKFLOW_CONFIG_FILE = "workflow-model.yaml";
const LITELLM_APIS = new Set(["openai-completions", "openai-responses"]);
const MODEL_PRESETS = {
  planning:    ["github-copilot/gpt-5.5:xhigh", "openai-codex/gpt-5.5:xhigh", "openrouter/openai/gpt-5.5:xhigh"],
  development: ["openai-codex/gpt-5.4-mini:medium", "github-copilot/gpt-5.4-mini:medium", "openrouter/openai/gpt-5.4-mini:medium"],
  peerReview:  ["github-copilot/claude-opus-4.7:high"],
};
const DEFAULT_MODELS = {
  planning:   MODEL_PRESETS.planning[0],
  development: MODEL_PRESETS.development[0],
  peerReview:  MODEL_PRESETS.peerReview[0],
};

// ── ANSI (TTY + NO_COLOR aware) ────────────────────────────────────────────
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim    = (s) => COLOR ? `\x1b[2m${s}\x1b[0m`  : s;
const bold   = (s) => COLOR ? `\x1b[1m${s}\x1b[0m`  : s;
const muted  = (s) => COLOR ? `\x1b[90m${s}\x1b[0m` : s;
const check  = (s) => COLOR ? `\x1b[32m${s}\x1b[0m` : s;
const warn   = (s) => COLOR ? `\x1b[33m${s}\x1b[0m` : s;

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
  return scope === "project" ? ["install", "-l", PACKAGE_SPEC] : ["install", PACKAGE_SPEC];
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
    "",
    "routes:",
    '  plan: "planning"',
    '  debug: "planning"',
    '  triage: "planning"',
    '  workon: "development"',
    '  review: "development"',
    '  peer-review: "peer-review"',
    "",
  ].join("\n");
}

function writeWorkflowConfig(targetPath, models) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, workflowConfig(models), "utf8");
}

function defaultScope(options) {
  if (options.project) return "project";
  if (options.global)  return "global";
  return "global";
}

function canPrompt() { return process.stdin.isTTY && process.stdout.isTTY; }

// ── Discovery helpers ───────────────────────────────────────────────────────
function parseModelListOutput(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^provider\s+model\b/i.test(trimmed) || /^no models/i.test(trimmed)) continue;
    // columns: provider model context max-out thinking images
    const match = trimmed.match(/^(\S+)\s+(\S+)(?:\s+\S+\s+\S+\s+(\S+))?/);
    if (!match) continue;
    const [, provider, model, thinkingField] = match;
    const thinking =
      thinkingField === undefined ? undefined : thinkingField.toLowerCase() === "yes";
    rows.push({ provider, model, thinking });
  }
  return rows;
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
  process.stdout.write(question);
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
          const err = new Error("aborted");
          err.code = "ABORT_ERR";
          reject(err);
          return;
        }
        if (code === 0x0d || code === 0x0a) { // Enter
          cleanup();
          resolve(buf);
          return;
        }
        if (code === 0x7f || code === 0x08) { // Backspace / Delete
          buf = buf.slice(0, -1);
          continue;
        }
        if (code >= 0x20) buf += ch;          // ignore non-printable controls
      }
    };
    stdin.on("data", onData);
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

  const result = spawnSync("pi", ["--list-models"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    _piModelListCache = { skipped: true, reason: result.error?.message ?? `exit ${result.status ?? 1}`, rows: [] };
  } else {
    _piModelListCache = { skipped: false, rows: parseModelListOutput(result.stdout ?? "") };
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
    if (!baseUrl || !LITELLM_APIS.has(api)) continue;
    const models = Array.isArray(config.models)
      ? config.models.map((m) => (m && typeof m.id === "string" ? m.id.trim() : "")).filter(Boolean)
      : [];
    providers.push({ name, baseUrl, api, models });
  }
  _providersCache = providers;
  return providers;
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
  const selected = multi ? new Set(choices) : null;
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
    filtered = q ? choices.filter((c) => c.toLowerCase().includes(q)) : [...choices];
    items = buildItems();
    const next = hovered ? items.findIndex((it) => it.value === hovered) : -1;
    selIdx = next >= 0 ? next : 0;
    hovered = items[selIdx]?.value ?? null;
  };

  const buildLines = () => {
    const lines = [];
    const count = multi
      ? `${selected.size}/${choices.length} selected${filtered.length === choices.length ? "" : `, ${filtered.length} match`}`
      : (filtered.length === choices.length ? `${choices.length}` : `${filtered.length}/${choices.length}`);
    lines.push(`${bold(title)}  ${dim(`(${count})`)}`);
    lines.push(`${dim("›")} ${query.trim() ? query : dim("type to filter…")}`);
    lines.push(dim(multi
      ? "  ↑ ↓ move  Space toggle  Ctrl+A all/none  Enter accept  Esc clear  Ctrl+C cancel"
      : "  ↑ ↓ select  Enter accept  Esc clear  Ctrl+C cancel"));
    if (!items.length) {
      lines.push(dim("  no matches"));
      return lines;
    }
    const { start, end } = pickerViewport(items.length, selIdx);
    if (start > 0) lines.push(dim(`  ↑ ${start} more`));
    for (let i = start; i < end; i++) {
      const sel = i === selIdx;
      const item = items[i];
      if (item.custom) {
        const label = `add "${item.value}"`;
        const text = sel ? bold(label) : dim(label);
        lines.push(`  ${sel ? check("+") : "+"} ${text}`);
      } else {
        const text = sel ? bold(item.display) : dim(item.display);
        if (multi) {
          const checked = selected.has(item.value);
          const box = checked ? "[x]" : "[ ]";
          const glyph = sel ? bold(box) : (checked ? box : muted(box));
          lines.push(`  ${glyph} ${text}`);
        } else {
          lines.push(`  ${sel ? "◉" : muted("◯")} ${text}`);
        }
      }
    }
    if (end < items.length) lines.push(dim(`  ↓ ${items.length - end} more`));
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
        if (query) { query = ""; applyFilter(); paint(); }
        return;
      }
      if (key.name === "backspace") {
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

/** Single-keypress Y/n confirm. No readline needed. */
async function askConfirmation(promptText) {
  if (!canPrompt()) return false;

  return new Promise((resolve, reject) => {
    process.stdout.write(`${bold(promptText)} ${dim("[Y/n]")} `);
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
      if (key.name === "return")        { settle(true,  "y"); return; }
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
  return askConfirmation("Install now?");
}

function litellmUsage() {
  return `khala litellm - configure a LiteLLM-compatible Pi provider

Usage:
  khala litellm --provider <id> --base-url <url> --key-env <name> --model <patterns> [flags]
  khala litellm print-key --provider <id>
  khala litellm --help

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
  -h, --help                 Show help
  -v, --version              Show version

Examples:
  # Interactive: picker asks how to store the key, fetches /model/info, writes everything.
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

Key name vs. shell env var:
  --key-env stores a friendly label (often the name you assigned the key in the
  LiteLLM portal). When pi falls back to env-var resolution, it reads the
  *derived* shell name: portal label 'reeds-maint' → 'export REEDS_MAINT=...'.
  If you typed a valid shell identifier directly (e.g. 'LITELLM_API_KEY'),
  derivation is a no-op and the export name is identical.

Key resolution at runtime:
  Pi resolves provider keys in this order: --api-key flag > auth.json[<id>] > env var.
  Storing in auth.json (literal or command) means the key works without an exported
  env var, and pi can fetch /model/info on a fresh shell. The file is created with
  0600 perms; unrelated providers are preserved on merge.

Environment:
  PI_CODING_AGENT_DIR  Override the Pi agent directory (default: ~/.pi/agent)
  NO_COLOR             Disable ANSI color in output
`;
}

function parseLitellmArgs(args) {
  const options = { baseUrl: "", dryRun: false, global: false, help: false, keyEnv: "", model: "", project: false, projectSettings: null, provider: "", version: false, yes: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--global") options.global = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--project" || arg === "-l") options.project = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--yes" || arg === "-y" || arg === "--no-input") options.yes = true;
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

function promptLine(question) {
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
      resolve(answer);
    });
  });
}

async function promptValidated(question, normalizer) {
  while (true) {
    const answer = String(await promptLine(question)).trim();
    try {
      return normalizer(answer);
    } catch (error) {
      console.log(warn(`  ${error.message}`));
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

/**
 * Build the bare model-name choices for the LiteLLM model picker.
 *
 * Sourced only from LiteLLM providers already in models.json — those are
 * the names we have actual evidence are valid on a user's LiteLLM proxy.
 * We deliberately do NOT seed from `pi --list-models`: pi's known-model
 * registry covers vendor catalogs (openai, anthropic, …) that almost
 * always extend well beyond what any given LiteLLM hub actually proxies,
 * so surfacing those choices is misleading. On a fresh setup with no
 * existing LiteLLM providers, pickLiteLLMModels falls back to a free-text
 * line prompt so the user can simply type the model id their hub serves.
 */
function liteLLMModelChoices() {
  const raw = [];
  for (const provider of liteLLMProvidersFromModelsJson()) {
    for (const m of provider.models) raw.push(m);
  }
  return filterValidLiteLLMModelNames(raw);
}

// Throw away any buffered stdin bytes so a stray \n from a previous
// readline prompt can't immediately resolve the next picker with its default.
function drainStdin() {
  if (!process.stdin.isTTY) return;
  while (process.stdin.read() !== null) {
    // discard
  }
}

const AUTH_MODES = new Set(["skip", "literal", "command"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Three-choice picker for how the API key should be stored. The labels are
 * deliberately verbose because this is a one-time decision per provider and
 * users need to understand the tradeoff (paste vs. command vs. env-var).
 * `fallbackMode` picks the default-highlighted entry based on whether a
 * working key source already exists.
 */
async function askAuthMode({ providerId, keyEnv, hasExistingAuth, fallbackMode }) {
  // The skip label needs the *shell-canonical* form because that's what
  // the user would type into `export`. keyEnv may be a portal label like
  // `reeds-maint` that the shell can't parse on the LHS of `=`.
  const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;
  const LITERAL = `Paste the key value once  ${dim("— stored in ~/.pi/agent/auth.json (0600)")}`;
  const COMMAND = `Use a shell command       ${dim("— !op read / !security …, stored in auth.json (0600)")}`;
  const SKIP    = `Skip                      ${dim(`— keep using $${envVar} from the shell${hasExistingAuth ? " (auth.json entry already exists)" : ""}`)}`;
  const labelByMode = { literal: LITERAL, command: COMMAND, skip: SKIP };
  const choices = [LITERAL, COMMAND, SKIP];
  const fallbackLabel = labelByMode[fallbackMode] ?? SKIP;
  const picked = await askChoice(
    `How should pi resolve the API key for ${bold(providerId)}?`,
    choices,
    fallbackLabel,
  );
  if (picked === LITERAL) return "literal";
  if (picked === COMMAND) return "command";
  return "skip";
}

async function pickLiteLLMModels() {
  const choices = liteLLMModelChoices();
  if (!choices.length) {
    // First-time setup: no prior LiteLLM models to multi-select from. Use a
    // single line prompt; users who want to register many models at once
    // can pass `--model "a,b,c"` on the command line.
    return [await promptValidated("LiteLLM model: ", normalizeLiteLLMModelPattern)];
  }
  drainStdin();
  while (true) {
    const picked = await askMultiChoice("LiteLLM models", choices, { allowCustom: true });
    if (!picked.length) {
      console.log(warn("  Select at least one model (press Space to toggle)."));
      continue;
    }
    try {
      return picked.map(normalizeLiteLLMModelPattern);
    } catch (error) {
      console.log(warn(`  ${error.message}`));
    }
  }
}

// LiteLLM mounts /model/info at the proxy root; the /v1 segment of the
// base URL is only for the OpenAI-compatible chat/completions/embeddings
// surface. Strip a trailing /v1 (case-insensitive) before appending.
function liteLLMModelInfoUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/model/info`;
}

/**
 * Best-effort fetch of LiteLLM `/model/info` for the given proxy. The API
 * key is taken from the caller (read from `process.env[keyEnv]` upstream)
 * and is never logged or persisted. Throws a short, key-free Error on
 * timeout / non-2xx / parse failure so the CLI can degrade gracefully.
 */
async function fetchLiteLLMModelInfo(baseUrl, apiKey, { timeoutMs = 10_000 } = {}) {
  const url = liteLLMModelInfoUrl(baseUrl);
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
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${url}: invalid JSON body (${error.message})`);
  }
  return parseLiteLLMModelInfoResponse(body);
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
    console.log("Usage: khala litellm print-key --provider <id>");
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
      // Tell the user which env var to actually export. With portal-style
      // labels (e.g. `reeds-maint`) the literal isn't a valid shell ident,
      // so we name the derived form they'd type into `export`.
      const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;
      throw new Error(`Project LiteLLM key '${keyEnv}' has no exported value (expected $${envVar}).`);
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
    const missing = [];
    let provider = options.provider;
    let baseUrl = options.baseUrl;
    let keyEnv = options.keyEnv;

    if (!provider) {
      if (!promptAvailable) missing.push("--provider");
      else provider = await promptValidated("LiteLLM provider id: ", validateLiteLLMProviderId);
    } else {
      provider = validateLiteLLMProviderId(provider);
    }

    if (!baseUrl) {
      if (!promptAvailable) missing.push("--base-url");
      else baseUrl = await promptValidated("LiteLLM base URL: ", normalizeLiteLLMBaseUrl);
    } else {
      baseUrl = normalizeLiteLLMBaseUrl(baseUrl);
    }

    if (!keyEnv) {
      if (!promptAvailable) missing.push("--key-env");
      else keyEnv = await promptValidated(
        "LiteLLM key name (matches your LiteLLM portal label, e.g. reeds-maint): ",
        validateLiteLLMKeyEnv,
      );
    } else {
      keyEnv = validateLiteLLMKeyEnv(keyEnv);
    }
    // Shell-canonical derived form. Used at every shell-touching surface:
    // $env interpolation in summary/error rows, the export instruction we
    // emit on auth-skip mode, and (with literal fallback) process.env
    // lookup for /model/info. When the user typed a clean identifier this
    // equals keyEnv and nothing visible changes.
    const envVar = deriveEnvVarFromKeyName(keyEnv) ?? keyEnv;

    // Pre-flight env-var check. Run this BEFORE the (potentially long)
    // picker step so a user who forgot to `export` gets an immediate,
    // The actual API key value, if we have it. Filled below by the
    // auth-mode flow; the env-var fallback is consulted last so users with
    // an existing exported $KEY keep getting auto-enrichment for free.
    let resolvedKey = lookupKeyValueByName(keyEnv);


    let modelIds = [];
    const rawModels = (typeof options.model === "string" ? options.model : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawModels.length) {
      // --model accepts a single bare name or a comma-separated list.
      modelIds = rawModels.map(normalizeLiteLLMModelPattern);
    } else if (!promptAvailable) {
      missing.push("--model");
    } else {
      modelIds = await pickLiteLLMModels();
    }

    if (missing.length) {
      throw new Error(`Missing required LiteLLM options: ${missing.join(", ")}. Run in a TTY to answer prompts, or pass all required flags explicitly.`);
    }

    const targetModelsPath = modelsJsonPath();
    const targetSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
    const targetKeyConfigPath = litellmProjectConfigPath();
    const targetAuthPath = authJsonPath();

    let writeProjectSettings = options.projectSettings === true;
    if (options.projectSettings === null && promptAvailable && !options.yes && !options.dryRun) {
      console.log("");
      writeProjectSettings = await askConfirmation("Use these LiteLLM models as this project's Pi defaults now?");
    }

    // ── Auth-mode resolution ──────────────────────────────────────────────
    // Three storage modes, all pi-canonical (~/.pi/agent/auth.json schema):
    //   skip    — write nothing to auth.json; rely on the env var the user
    //             exports in their shell. Current default behavior.
    //   literal — paste-once secret value, stored at auth.json[<id>].key as
    //             a literal string. 0600 file perms.
    //   command — shell command (e.g. !op read ...) stored verbatim; pi
    //             exec's it on demand and uses stdout as the key.
    // The mode comes from --auth-mode if given, else a three-choice picker
    // in TTY, else "skip" in non-interactive runs.
    const currentAuth = readJsonObjectFile(targetAuthPath);
    const existingAuthEntry = isPlainObject(currentAuth) && isPlainObject(currentAuth[provider]) ? currentAuth[provider] : null;
    const hasExistingAuth = Boolean(existingAuthEntry && existingAuthEntry.type === "api_key" && typeof existingAuthEntry.key === "string" && existingAuthEntry.key.length > 0);

    let authMode = (options.authMode ?? "").trim().toLowerCase();
    if (authMode && !AUTH_MODES.has(authMode)) {
      throw new Error(`Unknown --auth-mode '${authMode}'. Expected one of: ${[...AUTH_MODES].join(", ")}.`);
    }
    if (!authMode && options.authKey) authMode = "literal";
    if (!authMode && options.authCommand) authMode = "command";
    if (!authMode && promptAvailable && !options.yes && !options.dryRun) {
      // Default cursor: if the user already has a working key source (env var
      // exported OR auth.json already has an entry for this provider), assume
      // "skip" so a no-op re-run is one Enter away. Otherwise default to
      // "literal" since that's the path that actually enables /model/info
      // enrichment for first-time setup.
      const fallbackMode = (resolvedKey || hasExistingAuth) ? "skip" : "literal";
      authMode = await askAuthMode({ providerId: provider, keyEnv, hasExistingAuth, fallbackMode });
    }
    if (!authMode) authMode = "skip";

    // Capture the literal/command payload for non-skip modes. Never stored
    // in a variable that gets logged or echoed; resolvedKey replaces the
    // env-var fallback once we have it.
    let authPayload = null;
    if (authMode === "literal") {
      let value = options.authKey;
      if (!value) {
        if (!canPrompt()) {
          throw new Error("--auth-mode=literal needs --auth-key=<value> in non-interactive mode.");
        }
        value = await promptSecret(`API key value for ${bold(provider)} ${dim("(input is masked; will be stored in auth.json with 0600 perms)")}\n${dim("›")} `);
      }
      authPayload = { mode: "literal", key: validateAuthLiteral(value) };
      resolvedKey = authPayload.key;
    } else if (authMode === "command") {
      let cmd = options.authCommand;
      if (!cmd) {
        if (!canPrompt()) {
          throw new Error("--auth-mode=command needs --auth-command=<!cmd> in non-interactive mode.");
        }
        cmd = await promptValidated(
          `Shell command for the key ${dim(`(must start with '!', e.g. "!op read 'op://Personal/${provider}/credential'")`)}\n${dim("›")} `,
          validateAuthCommand,
        );
      }
      authPayload = { mode: "command", key: validateAuthCommand(cmd) };
      // Resolve the command immediately so we can fetch /model/info now.
      // If exec fails, leave resolvedKey unset; the metadata row will warn
      // and we'll fall back to bare entries, but the auth.json write still
      // proceeds (the user can fix their keychain entry separately).
      const fromCmd = resolveKeyForFetch(authPayload.key);
      if (fromCmd) resolvedKey = fromCmd;
      else resolvedKey = undefined;
    } else if (hasExistingAuth) {
      // Skip mode, but auth.json already has an api_key — use its value
      // for the enrichment fetch (pi will do the same at runtime).
      const fromAuth = resolveKeyForFetch(existingAuthEntry.key);
      if (fromAuth) resolvedKey = fromAuth;
    }

    // Attempt to fetch rich model metadata from LiteLLM's /model/info. The
    // key source is whichever of {auth.json, --auth-key, --auth-command,
    // env var} resolved above. We never persist the value beyond this call
    // unless the user explicitly chose literal/command mode.
    let infoMap = new Map();
    let metadataStatus;
    let metadataIsWarning = false;
    if (resolvedKey) {
      try {
        infoMap = await fetchLiteLLMModelInfo(baseUrl, resolvedKey);
        const matched = modelIds.filter((id) => infoMap.has(id)).length;
        metadataStatus = `${matched}/${modelIds.length} enriched from /model/info`;
        metadataIsWarning = matched < modelIds.length;
      } catch (error) {
        metadataStatus = `fetch failed (${error.message}); writing bare entries`;
        metadataIsWarning = true;
      }
    } else if (authMode === "command") {
      metadataStatus = `NOT FETCHED — auth command produced no output; writing bare entries`;
      metadataIsWarning = true;
    } else if (authMode === "skip") {
      metadataStatus = `NOT FETCHED — $${envVar} is not exported and auth.json has no entry; writing bare entries`;
      metadataIsWarning = true;
    }

    const currentModels = readJsonObjectFile(targetModelsPath);
    const currentSettings = writeProjectSettings ? readJsonObjectFile(targetSettingsPath) : null;
    const currentKeyConfig = readJsonObjectFile(targetKeyConfigPath);
    const mergedModels = mergeLiteLLMModelsJson(currentModels, { providerId: provider, baseUrl, keyEnv, modelIds, infoMap });
    const mergedSettings = writeProjectSettings ? mergeLiteLLMProjectSettings(currentSettings, { providerId: provider, modelIds }) : null;
    const mergedKeyConfig = mergeLiteLLMProjectKeyConfig(currentKeyConfig, { providerId: provider, keyEnv });

    // Summary
    const modeTag = options.dryRun ? dim(" [dry-run]") : "";
    const labelWidth = 12;
    console.log("");
    console.log(`${bold("Khala LiteLLM")}${modeTag}${dim(":")}`);
    console.log(`${dim("models".padEnd(labelWidth))}${targetModelsPath}`);
    console.log(`${dim("settings".padEnd(labelWidth))}${writeProjectSettings ? targetSettingsPath : `${dim("skipped")} ${dim(`(pass --project-settings to update ${targetSettingsPath})`)}`}`);
    console.log(`${dim("keys".padEnd(labelWidth))}${targetKeyConfigPath}`);
    // Provider row gets a short qualifier so the user can see at a glance
    // whether this is a fresh registration or an in-place update.
    const providerTag = mergedModels.isUpdate
      ? dim(`  (updating${mergedModels.previousModelCount ? `, was ${mergedModels.previousModelCount} model${mergedModels.previousModelCount === 1 ? "" : "s"}` : ""})`)
      : dim("  (new)");
    console.log(`${dim("provider".padEnd(labelWidth))}${provider}${providerTag}`);
    console.log(`${dim("base-url".padEnd(labelWidth))}${baseUrl}`);
    console.log(`${dim("api".padEnd(labelWidth))}${LITELLM_PROVIDER_API}`);
    console.log(`${dim("apiKey".padEnd(labelWidth))}${buildLiteLLMApiKeyCommand(provider)}`);
    // Key row: show the portal label as the primary, and the derived shell
    // env var name as a parenthetical when they differ. Users typed the
    // portal label, so it should anchor the row; the derived form tells
    // them what to put after `export`. When the user typed an identifier
    // directly (legacy path), the two match and we drop the parenthetical.
    const keyRow = (envVar && envVar !== keyEnv)
      ? `${keyEnv}  ${dim(`(exports as $${envVar})`)}`
      : `$${keyEnv}`;
    console.log(`${dim("key".padEnd(labelWidth))}${keyRow}`);
    // Auth row: explain exactly where pi will read the key from at runtime.
    // Three shapes match the three resolved modes; the warn() colorization
    // is reserved for the "no working source" case the metadata row catches.
    let authRow;
    if (authMode === "literal") {
      authRow = `store value in ${targetAuthPath} ${dim("(0600)")}${hasExistingAuth ? dim("  (updating)") : dim("  (new)")}`;
    } else if (authMode === "command") {
      authRow = `store command in ${targetAuthPath} ${dim("(0600)")}${hasExistingAuth ? dim("  (updating)") : dim("  (new)")}`;
    } else if (hasExistingAuth) {
      authRow = `${dim(`(existing entry in ${targetAuthPath})`)}`;
    } else if (resolvedKey) {
      authRow = `$${envVar} from shell ${dim("(no auth.json entry)")}`;
    } else {
      authRow = warn(`none — $${envVar} unset and no auth.json entry`);
    }
    console.log(`${dim("auth".padEnd(labelWidth))}${authRow}`);
    // Collapse the selected-model list to a single row to match the one-row-
    // per-concept aesthetic of the main Khala configuration block. The full
    // list is verifiable in models.json after writing.
    const extra = modelIds.length - 1;
    const moreSuffix = extra > 0 ? `  ${dim(`+${extra} more`)}` : "";
    console.log(`${dim("model".padEnd(labelWidth))}${modelIds[0]}${moreSuffix}`);
    if (metadataStatus) console.log(`${dim("metadata".padEnd(labelWidth))}${metadataIsWarning ? warn(metadataStatus) : metadataStatus}`);
    if (mergedModels.conflict) {
      console.log(`${warn("!")} existing provider config differs and will be updated only if you confirm`);
    }

    if (options.dryRun) return;

    if (!options.yes) {
      if (!canPrompt()) {
        throw new Error("LiteLLM setup writes require --yes in non-interactive mode.");
      }
      console.log("");
      const confirmed = await askConfirmation(mergedModels.conflict ? "Overwrite the existing LiteLLM provider/key config now?" : "Write LiteLLM provider/key config now?");
      if (!confirmed) {
        console.log(`${dim("Skipped.")}  No files were written.`);
        return;
      }
    }

    writeJsonFile(targetModelsPath, mergedModels.value, { compactModelEntries: true });
    if (writeProjectSettings) writeJsonFile(targetSettingsPath, mergedSettings);
    writeJsonFile(targetKeyConfigPath, mergedKeyConfig);

    // auth.json is written ONLY when the user picked literal/command. The
    // file gets 0600 perms (writeSecureJsonFile chmods explicitly after
    // write to cover both create and update). Unrelated providers in the
    // existing auth.json are preserved by mergeAuthJsonApiKey.
    let authWritten = false;
    if (authPayload && (authPayload.mode === "literal" || authPayload.mode === "command")) {
      const mergedAuth = mergeAuthJsonApiKey(currentAuth, provider, authPayload.key);
      writeSecureJsonFile(targetAuthPath, mergedAuth.value);
      authWritten = true;
    }

    console.log("");
    console.log(`${check("✓")} Wrote ${targetModelsPath}`);
    if (writeProjectSettings) {
      console.log(`${check("✓")} Wrote ${targetSettingsPath}`);
    } else {
      console.log(`${dim("settings".padEnd(12))}Skipped project defaults.`);
    }
    console.log(`${check("✓")} Wrote ${targetKeyConfigPath}`);
    if (authWritten) {
      console.log(`${check("✓")} Wrote ${targetAuthPath} ${dim("(0600)")}`);
    }
    console.log(`${dim("boundary".padEnd(12))}${authWritten
      ? `Khala stored your API key in ${targetAuthPath} ${dim("(0600, user-only)")}`
      : `Khala stored a key reference, not a secret value.`}`);
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

  const result = await askChoice("Install scope", [
    "global  — ~/.pi/agent/settings.json",
    "project — .pi/settings.json",
  ], "global  — ~/.pi/agent/settings.json");
  return result.startsWith("project") ? "project" : "global";
}

const THINKING_CHOICES = ["xhigh", "high", "medium", "low", "minimal", "off"];

async function askProfile(label, defaultThinking, providers, discoveryRows, fallbackPresets) {
  const choices = buildProfileChoices(providers, discoveryRows, fallbackPresets);
  const fallbackId = fallbackPresets[0]?.split(":")[0] ?? choices[0];
  const defaultId = choices.includes(fallbackId) ? fallbackId : choices[0];

  const modelId = await askChoice(label, choices, defaultId);
  const [provider, model] = modelId.split("/");
  if (!modelSupportsThinking(discoveryRows, provider, model)) {
    return `${modelId}:off`;
  }

  const thinking = await askChoice(`${label} thinking`, THINKING_CHOICES, defaultThinking);
  return `${modelId}:${thinking}`;
}

async function askModels(options) {
  if (options.yes || !canPrompt()) return DEFAULT_MODELS;

  const providers = liteLLMProvidersFromModelsJson();
  const rows      = piDiscoveryRows();

  const planning    = await askProfile("Planning",    "xhigh",  providers, rows, MODEL_PRESETS.planning);
  const development = await askProfile("Development", "medium", providers, rows, MODEL_PRESETS.development);
  const peerReview  = await askProfile("Peer-review", "high",   providers, rows, MODEL_PRESETS.peerReview);

  return { planning, development, peerReview };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "litellm") {
    await mainLiteLLM(argv.slice(1));
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
      const mode = await askChoice("What would you like to do?", [PI_LABEL, LITELLM_LABEL], PI_LABEL);
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

  // Welcome
  const modeTag = options.dryRun ? dim(" [dry-run]") : "";
  console.log("");
  console.log(`${bold("Khala configuration")}${modeTag}${dim(":")}`);

  try {
    const scope  = await askScope(options);
    const models = await askModels(options);

    const args             = installArgs(scope);
    const targetConfigPath = configPath(scope);
    const targetSettingsPath = settingsPath(scope);
    const labelWidth = 12;

    console.log(`${dim("scope".padEnd(labelWidth))}${targetSettingsPath}`);
    console.log(`${dim("config".padEnd(labelWidth))}${targetConfigPath}`);
    console.log(`${dim("planning".padEnd(labelWidth))}${models.planning}`);
    console.log(`${dim("development".padEnd(labelWidth))}${models.development}`);
    console.log(`${dim("peer-review".padEnd(labelWidth))}${models.peerReview}`);

    if (options.dryRun) return;

    // Install
    console.log("");
    const confirmed = await confirmInstall(options);
    if (!confirmed) {
      console.log(`${dim("Skipped.")}  Run ${bold(`pi ${args.join(" ")}`)} when you're ready.`);
      return;
    }

    const result = spawnSync("pi", args, { stdio: "inherit" });
    if (result.error) {
      console.error(`Failed to run pi: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.status ?? 1;
    if (process.exitCode === 0) {
      writeWorkflowConfig(targetConfigPath, models);
      console.log("");
      console.log(`${check("✓")} Installed.  Config written to ${targetConfigPath}`);
      console.log(`  Start Pi and run ${bold("/khala")} then ${bold("/khala-health")} to verify.`);
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
