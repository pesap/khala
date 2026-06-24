#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import {
  LITELLM_PROVIDER_API,
  buildProfileChoices,
  filterValidLiteLLMModelNames,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectSettings,
  modelSupportsThinking,
  normalizeLiteLLMBaseUrl,
  normalizeLiteLLMModelPattern,
  readJsonObjectFile,
  validateLiteLLMKeyEnv,
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

/**
 * Inline arrow-key selector with viewport scrolling and type-to-filter.
 *
 * - Shows a window of up to PICKER_WINDOW rows so 50+ choices stay usable.
 * - Type to filter (case-insensitive substring); Backspace removes, Esc clears.
 * - Up/Down moves within the filtered list; selection is preserved across
 *   filter changes whenever the previously-hovered choice still matches.
 * - On Enter or Ctrl+C: clears the entire picker so no residual line is left;
 *   the caller surfaces the choice in its own summary.
 * - Non-TTY / empty choices: returns fallback immediately.
 *
 * Options:
 *   allowCustom: when true and the user types a query that doesn't match an
 *     existing choice exactly, a synthetic `use "<query>"` entry appears at
 *     the top. Selecting it returns the typed query verbatim so the caller
 *     can accept new values that weren't in the discovery list.
 */
const PICKER_WINDOW = 10;

// Safety net: always restore the terminal cursor on process exit so a crashed
// or signaled picker can't leave the cursor hidden. No-op on non-TTY stdout.
if (process.stdout.isTTY) {
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
}

async function askChoice(title, choices, fallback, options = {}) {
  if (!canPrompt() || !choices.length) return fallback;

  const allowCustom = options.allowCustom === true;
  let query = "";
  let filtered = choices;

  const buildItems = () => {
    const items = filtered.map((c) => ({ value: c, display: c, custom: false }));
    if (allowCustom && query && !filtered.includes(query)) {
      items.unshift({ value: query, display: query, custom: true });
    }
    return items;
  };

  let items = buildItems();
  const fallbackIdx = items.findIndex((it) => it.value === fallback);
  let selIdx = fallbackIdx >= 0 ? fallbackIdx : 0;
  let hovered = items[selIdx]?.value ?? null;

  const applyFilter = () => {
    if (!query) {
      filtered = choices;
    } else {
      const q = query.toLowerCase();
      filtered = choices.filter((c) => c.toLowerCase().includes(q));
    }
    items = buildItems();
    const next = hovered ? items.findIndex((it) => it.value === hovered) : -1;
    selIdx = next >= 0 ? next : 0;
    hovered = items[selIdx]?.value ?? null;
  };

  const viewport = () => {
    const total = items.length;
    if (total <= PICKER_WINDOW) return { start: 0, end: total };
    let start = Math.max(0, selIdx - Math.floor(PICKER_WINDOW / 2));
    const end   = Math.min(total, start + PICKER_WINDOW);
    start = Math.max(0, end - PICKER_WINDOW);
    return { start, end };
  };

  const buildLines = () => {
    const lines = [];
    const count = filtered.length === choices.length
      ? `${choices.length}`
      : `${filtered.length}/${choices.length}`;
    lines.push(`${bold(title)}  ${dim(`(${count})`)}`);
    lines.push(`${dim("›")} ${query || dim("type to filter…")}`);
    lines.push(dim("  ↑ ↓ select  Enter accept  Esc clear  Ctrl+C cancel"));
    if (!items.length) {
      lines.push(dim("  no matches"));
      return lines;
    }
    const { start, end } = viewport();
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
        lines.push(`  ${sel ? "◉" : muted("◯")} ${text}`);
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
    drawnLines = lines.length;
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
        if (!items.length) return;
        const chosen = items[selIdx]?.value ?? fallback;
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
      // Printable ASCII appends to the filter query.
      if (typeof str === "string" && str.length === 1 && !key.ctrl && !key.meta) {
        const code = str.charCodeAt(0);
        if (code >= 32 && code < 127) {
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
  khala litellm --provider <id> --base-url <url> --key-env <env-var> --model <pattern> [flags]
  khala litellm --help

Flags:
      --provider <id>        LiteLLM provider id  (e.g. team-litellm)
      --base-url <url>       LiteLLM base URL     (e.g. https://lite.example/v1)
      --key-env <env-var>    Env var name used as the Pi apiKey reference
      --model <pattern>      Model id or bare glob to register and enable
  -l, --project              Write to .pi/settings.json in the current project (default)
  -y, --yes                  Skip the write confirmation
      --no-input             Alias for --yes (use in scripts and CI)
      --dry-run              Print the planned config changes without writing files
  -h, --help                 Show help
  -v, --version              Show version

Examples:
  khala litellm --project --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env LITELLM_API_KEY --model gpt-5.4-mini --dry-run
  khala litellm --project --provider team-litellm --base-url https://lite.example/v1 \\
    --key-env LITELLM_API_KEY --model gpt-5.4-mini --yes

Secret boundary:
  Khala writes only the key reference, e.g. "$LITELLM_API_KEY".
  raw API keys are never requested or stored.

Environment:
  PI_CODING_AGENT_DIR  Override the Pi agent directory (default: ~/.pi/agent)
  NO_COLOR             Disable ANSI color in output
`;
}

function parseLitellmArgs(args) {
  const options = { baseUrl: "", dryRun: false, global: false, help: false, keyEnv: "", model: "", project: false, provider: "", version: false, yes: false };

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
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.global) throw new Error("khala litellm only supports project setup; use --project.");
  if (!options.project) options.project = true;
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
 * Build the bare model-name choices for the LiteLLM model picker.
 *
 * Seeds choices from pi --list-models and any explicit models already on a
 * LiteLLM provider in models.json, dedup'd by bare model name (LiteLLM's
 * model field is the bare name without a provider prefix). Names that
 * couldn't be registered as a LiteLLM model (whitespace, slash, or colon)
 * are skipped so the user can't pick a value that would fail validation.
 * The picker is opened in allowCustom mode so users can still type a brand
 * new model id that isn't in the discovery list.
 */
function liteLLMModelChoices() {
  const raw = [];
  for (const row of piDiscoveryRows()) raw.push(row.model);
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

async function pickLiteLLMModel() {
  const choices = liteLLMModelChoices();
  if (!choices.length) {
    return promptValidated("LiteLLM model: ", normalizeLiteLLMModelPattern);
  }
  drainStdin();
  while (true) {
    const picked = await askChoice("LiteLLM model", choices, choices[0], { allowCustom: true });
    try {
      return normalizeLiteLLMModelPattern(picked);
    } catch (error) {
      console.log(warn(`  ${error.message}`));
    }
  }
}

function writeJsonFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
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

async function mainLiteLLM(argv) {
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
    let model = options.model;

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
      else keyEnv = await promptValidated("LiteLLM key env var: ", validateLiteLLMKeyEnv);
    } else {
      keyEnv = validateLiteLLMKeyEnv(keyEnv);
    }

    if (!model) {
      if (!promptAvailable) missing.push("--model");
      else model = await pickLiteLLMModel();
    } else {
      model = normalizeLiteLLMModelPattern(model);
    }

    if (missing.length) {
      throw new Error(`Missing required LiteLLM options: ${missing.join(", ")}. Run in a TTY to answer prompts, or pass all required flags explicitly.`);
    }

    const targetModelsPath = modelsJsonPath();
    const targetSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
    const currentModels = readJsonObjectFile(targetModelsPath);
    const currentSettings = readJsonObjectFile(targetSettingsPath);
    const mergedModels = mergeLiteLLMModelsJson(currentModels, { providerId: provider, baseUrl, keyEnv, modelId: model });
    const mergedSettings = mergeLiteLLMProjectSettings(currentSettings, { providerId: provider, modelId: model });

    // Summary
    const modeTag = options.dryRun ? dim(" [dry-run]") : "";
    const labelWidth = 12;
    console.log("");
    console.log(`${bold("Khala LiteLLM")}${modeTag}${dim(":")}`);
    console.log(`${dim("models".padEnd(labelWidth))}${targetModelsPath}`);
    console.log(`${dim("settings".padEnd(labelWidth))}${targetSettingsPath}`);
    console.log(`${dim("provider".padEnd(labelWidth))}${provider}`);
    console.log(`${dim("base-url".padEnd(labelWidth))}${baseUrl}`);
    console.log(`${dim("api".padEnd(labelWidth))}${LITELLM_PROVIDER_API}`);
    console.log(`${dim("apiKey".padEnd(labelWidth))}$${keyEnv}`);
    console.log(`${dim("model".padEnd(labelWidth))}${model}`);
    if (mergedModels.conflict) {
      console.log(`${warn("!")} existing provider config differs and will be updated only if you confirm`);
    }

    if (options.dryRun) return;

    if (!options.yes) {
      if (!canPrompt()) {
        throw new Error("LiteLLM setup writes require --yes in non-interactive mode.");
      }
      console.log("");
      const confirmed = await askConfirmation(mergedModels.conflict ? "Overwrite the existing LiteLLM provider config now?" : "Write LiteLLM provider config now?");
      if (!confirmed) {
        console.log(`${dim("Skipped.")}  No files were written.`);
        return;
      }
    }

    writeJsonFile(targetModelsPath, mergedModels.value);
    writeJsonFile(targetSettingsPath, mergedSettings);

    console.log("");
    console.log(`${check("✓")} Wrote ${targetModelsPath}`);
    console.log(`${check("✓")} Wrote ${targetSettingsPath}`);
    console.log(`${dim("boundary".padEnd(12))}Khala stored a key reference, not a secret value.`);
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
