#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import {
  LITELLM_PROVIDER_API,
  mergeLiteLLMModelsJson,
  mergeLiteLLMProjectSettings,
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
  return `khala - setup helper for the Khala Pi package

Usage:
  khala [--global | --project] [--yes] [--dry-run]
  khala litellm --help
  khala --help
  khala --version

Options:
  --global    Install Khala into ~/.pi/agent/settings.json
  --project   Install Khala into .pi/settings.json for the current project
  --yes       Skip prompts and use recommended workflow models
  --dry-run   Print the pi install command and workflow config path without writing
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
    else if (arg === "--yes"    || arg === "-y") options.yes  = true;
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
    const match = trimmed.match(/^(\S+)\s+(\S+)/);
    if (match) rows.push({ provider: match[1], model: match[2] });
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

function discoverPiModels(modelQuery, selectedModelId) {
  const cached = piModelList();
  if (cached.skipped) return { available: false, skipped: true, reason: cached.reason, rows: [] };

  const query = modelQuery.toLowerCase();
  const rows = cached.rows.filter((r) =>
    r.model.toLowerCase().includes(query) || `${r.provider}/${r.model}` === selectedModelId,
  );

  return {
    available: rows.some((r) => r.model === modelQuery || `${r.provider}/${r.model}` === selectedModelId),
    skipped: false,
    rows,
  };
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

function buildProfileChoices(modelQuery, thinkingLevel, providers, discoveryRows, fallbackChoices) {
  const seen = new Set();
  const choices = [];
  const normId = (s) => s.toLowerCase().replace(/[._-]/g, "-");
  const normQuery = normId(modelQuery);
  for (const row of discoveryRows) {
    const c = `${row.provider}/${row.model}:${thinkingLevel}`;
    if (!seen.has(c)) { seen.add(c); choices.push(c); }
  }
  for (const provider of providers) {
    if (provider.models.length && !provider.models.some((m) => normId(m) === normQuery)) continue;
    for (const model of provider.models.length ? provider.models : [modelQuery]) {
      const c = `${provider.name}/${model}:${thinkingLevel}`;
      if (!seen.has(c)) { seen.add(c); choices.push(c); }
    }
  }
  return choices.length ? choices : fallbackChoices;
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
 * Inline arrow-key selector.
 *
 * - Draws the list in-place (cursor-up + clear-to-end, not screen-clear).
 * - Groups choices by provider when the string looks like "provider/…".
 * - On Enter: collapses the whole menu to a single dim summary line.
 * - On Ctrl+C: collapses to nothing and rejects with ABORT_ERR.
 * - Non-TTY / empty choices: returns fallback immediately.
 */
async function askChoice(title, choices, fallback) {
  if (!canPrompt() || !choices.length) return fallback;

  const buildLines = (selIdx) => {
    const lines = [bold(title), dim("  \u2191 \u2193  Enter  Ctrl+C")];
    for (let i = 0; i < choices.length; i++) {
      const sel = i === selIdx;
      lines.push(`  ${sel ? "\u25c9" : muted("\u25ef")} ${sel ? bold(choices[i]) : dim(choices[i])}`);
    }
    return lines;
  };

  let selIdx = 0;
  let drawnLines = 0;

  const paint = (idx) => {
    const lines = buildLines(idx);
    if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
    process.stdout.write(`${lines.join("\n")}\n`);
    drawnLines = lines.length;
  };

  paint(selIdx);

  return new Promise((resolve, reject) => {
    let onKey;

    const settle = (chosen) => {
      process.stdin.off("keypress", onKey);
      rawMode(false);
      process.stdin.pause();
      if (drawnLines > 0) process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
      if (chosen === null) {
        // leave a blank line so the next output starts cleanly
        process.stdout.write("\n");
      } else {
        process.stdout.write(`${title}  ${dim(chosen)}\n`);
      }
    };

    onKey = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") { settle(null); reject(makeAbortError()); return; }
      if (key.name === "up")     { selIdx = (selIdx - 1 + choices.length) % choices.length; paint(selIdx); return; }
      if (key.name === "down")   { selIdx = (selIdx + 1) % choices.length; paint(selIdx); return; }
      if (key.name === "return") { const chosen = choices[selIdx] ?? fallback; settle(chosen); resolve(chosen); }
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
  khala litellm --project --provider <provider> --base-url <url> --key-env <ENV_VAR> --model <model>
  khala litellm --help
  khala litellm --version

Options:
  --project     Configure the current project .pi/settings.json and Pi models.json provider reference
  --provider    LiteLLM provider id (required; examples: team-litellm, nlr)
  --base-url    LiteLLM base URL such as https://lite.example/v1 (required)
  --key-env     Environment variable name used as the Pi apiKey reference (required)
  --model       Model id or bare glob to register and enable (required)
  --yes         Skip the write confirmation prompt
  --dry-run     Print the planned config changes without writing files

raw API keys are never requested or stored. Khala writes non-secret key references only.`;
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
    else if (arg === "--yes" || arg === "-y") options.yes = true;
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
      else model = await promptValidated("LiteLLM model: ", normalizeLiteLLMModelPattern);
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

    console.log("");
    console.log(`${bold("LiteLLM setup")}  ${dim(`v${version()}`)}`);
    console.log(dim("─".repeat(27)));
    console.log(`  ${dim("provider")}   ${provider}`);
    console.log(`  ${dim("base-url")}   ${baseUrl}`);
    console.log(`  ${dim("api")}        ${LITELLM_PROVIDER_API}`);
    console.log(`  ${dim("apiKey")}     $${keyEnv}`);
    console.log(`  ${dim("model")}      ${model}`);
    console.log(`  ${dim("models")}     ${targetModelsPath}`);
    console.log(`  ${dim("settings")}   ${targetSettingsPath}`);
    console.log(`  ${dim("secret")}     raw API keys are never requested or stored`);
    console.log(`  ${dim("hint")}       export ${bold(keyEnv)} or configure your secret manager to provide it`);
    if (mergedModels.conflict) {
      console.log(`  ${warn("!")} existing provider config differs and will be updated only if you confirm`);
    }

    if (options.dryRun) return;

    if (!options.yes) {
      if (!canPrompt()) {
        throw new Error("LiteLLM setup writes require --yes in non-interactive mode.");
      }
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
    console.log(`  ${dim("boundary")} Khala stored a key reference, not a secret value.`);
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

  console.log(dim("  Global installs across all projects. Project installs here only."));
  const result = await askChoice("Install scope", [
    "global  — ~/.pi/agent/settings.json",
    "project — .pi/settings.json",
  ], "global  — ~/.pi/agent/settings.json");
  return result.startsWith("project") ? "project" : "global";
}

async function askModels(options) {
  if (options.yes || !canPrompt()) return DEFAULT_MODELS;

  const providers = liteLLMProvidersFromModelsJson();
  const planRows   = discoverPiModels("gpt-5.5",        DEFAULT_MODELS.planning).rows    ?? [];
  const devRows    = discoverPiModels("gpt-5.4-mini",   DEFAULT_MODELS.development).rows ?? [];
  const reviewRows = discoverPiModels("claude-opus-4.7", DEFAULT_MODELS.peerReview).rows  ?? [];

  const planning = await askChoice(
    "Planning",
    buildProfileChoices("gpt-5.5",        "xhigh",  providers, planRows,   MODEL_PRESETS.planning),
    DEFAULT_MODELS.planning,
  );

  const development = await askChoice(
    "Development",
    buildProfileChoices("gpt-5.4-mini",   "medium", providers, devRows,    MODEL_PRESETS.development),
    DEFAULT_MODELS.development,
  );

  const peerReview = await askChoice(
    "Peer-review",
    buildProfileChoices("claude-opus-4.7", "high",   providers, reviewRows, MODEL_PRESETS.peerReview),
    DEFAULT_MODELS.peerReview,
  );

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
  console.log("");
  console.log(`${bold("Khala configuration")}  ${dim(`v${version()}`)}`);
  console.log(dim("─".repeat(27)));
  console.log("Workflow commands, safety gates, and model routing for Pi.");
  if (options.yes)    console.log(dim("  using defaults  (--yes)"));
  if (options.dryRun) console.log(dim("  no files will be written  (--dry-run)"));

  try {
    const scope  = await askScope(options);
    const models = await askModels(options);

    const args             = installArgs(scope);
    const command          = `pi ${args.join(" ")}`;
    const targetConfigPath = configPath(scope);

    // Summary
    console.log("");
    console.log(dim("─".repeat(50)));
    if (options.yes || !canPrompt()) {
      // --yes and non-TTY skip the inline pickers, so print decisions here
      console.log(`  ${dim("scope")}       ${scope === "project" ? ".pi/settings.json" : "~/.pi/agent/settings.json"}`);
      console.log(`  ${dim("planning")}    ${models.planning}`);
      console.log(`  ${dim("development")} ${models.development}`);
      console.log(`  ${dim("peer-review")} ${models.peerReview}`);
      console.log("");
    }
    console.log(`  ${dim("command")}  ${command}`);
    console.log(`  ${dim("config")}   ${targetConfigPath}`);

    if (options.dryRun) return;

    // Install
    console.log("");
    const confirmed = await confirmInstall(options);
    if (!confirmed) {
      console.log(`${dim("Skipped.")}  Run the command above when ready.`);
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
