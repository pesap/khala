#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const PACKAGE_SPEC = "npm:khala";
const WORKFLOW_CONFIG_FILE = "workflow-model.yaml";
const MODEL_PRESETS = {
  planning: [
    "github-copilot/gpt-5.5:xhigh",
    "openai-codex/gpt-5.5:xhigh",
    "openrouter/openai/gpt-5.5:xhigh",
  ],
  development: [
    "openai-codex/gpt-5.4-mini:medium",
    "github-copilot/gpt-5.4-mini:medium",
    "openrouter/openai/gpt-5.4-mini:medium",
  ],
  peerReview: [
    "github-copilot/claude-opus-4.7:high",
  ],
};
const DEFAULT_MODELS = {
  planning: MODEL_PRESETS.planning[0],
  development: MODEL_PRESETS.development[0],
  peerReview: MODEL_PRESETS.peerReview[0],
};

function usage() {
  return `khala - setup helper for the Khala Pi package

Usage:
  khala [--global | --project] [--yes] [--dry-run]
  khala --help
  khala --version

Options:
  --global    Install Khala into ~/.pi/agent/settings.json
  --project   Install Khala into .pi/settings.json for the current project
  --yes       Skip prompts and use recommended workflow models
  --dry-run   Print the pi install command and workflow config path without writing
`;
}

function version() {
  return "0.1.0";
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    help: false,
    project: false,
    global: false,
    version: false,
    yes: false,
  };

  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--global") options.global = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--project" || arg === "-l") options.project = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.global && options.project) {
    throw new Error("Choose either --global or --project, not both.");
  }

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
    "  plan: \"planning\"",
    "  debug: \"planning\"",
    "  triage: \"planning\"",
    "  workon: \"development\"",
    "  review: \"development\"",
    "  peer-review: \"peer-review\"",
    "",
  ].join("\n");
}

function writeWorkflowConfig(targetPath, models) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, workflowConfig(models), "utf8");
}

function defaultScope(options) {
  if (options.project) return "project";
  if (options.global) return "global";
  return "global";
}

function canPrompt() {
  return process.stdin.isTTY && process.stdout.isTTY;
}

async function askScope(rl, options) {
  if (options.project) return "project";
  if (options.global || options.yes || !canPrompt()) return "global";

  console.log("Where should Khala be installed?");
  console.log("  1) Global:  ~/.pi/agent/settings.json");
  console.log("  2) Project: .pi/settings.json");
  const answer = await rl.question("Choose [1]: ");
  return answer.trim() === "2" ? "project" : "global";
}

async function askChoice(rl, title, choices, fallback) {
  if (!canPrompt()) return fallback;

  console.log(title);
  for (const [index, choice] of choices.entries()) {
    console.log(`  ${index + 1}) ${choice}`);
  }
  console.log(`  ${choices.length + 1}) Custom`);
  const answer = await rl.question("Choose [1]: ");
  const index = answer.trim() ? Number.parseInt(answer.trim(), 10) - 1 : 0;

  if (index >= 0 && index < choices.length) return choices[index];
  if (index === choices.length) {
    const custom = await rl.question("Enter provider/model:thinking: ");
    return custom.trim() || fallback;
  }

  return fallback;
}

async function askModels(rl, options) {
  if (options.yes || !canPrompt()) return DEFAULT_MODELS;

  return {
    planning: await askChoice(
      rl,
      "Which model should planning workflows use (/plan, /triage, /debug)?",
      MODEL_PRESETS.planning,
      DEFAULT_MODELS.planning,
    ),
    development: await askChoice(
      rl,
      "Which model should development workflows use (/workon, /review)?",
      MODEL_PRESETS.development,
      DEFAULT_MODELS.development,
    ),
    peerReview: await askChoice(
      rl,
      "Which model should the peer-review profile use inside /plan?",
      MODEL_PRESETS.peerReview,
      DEFAULT_MODELS.peerReview,
    ),
  };
}

async function confirmInstall(rl, options) {
  if (options.yes) return true;
  if (!canPrompt()) return false;

  const answer = await rl.question("Install and write workflow config now? [Y/n] ");
  return !/^n(o)?$/i.test(answer.trim());
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error("Run `khala --help` for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(version());
    return;
  }

  const rl = canPrompt() ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const scope = rl ? await askScope(rl, options) : defaultScope(options);
    const models = rl ? await askModels(rl, options) : DEFAULT_MODELS;
    const args = installArgs(scope);
    const command = `pi ${args.join(" ")}`;
    const targetConfigPath = configPath(scope);

    console.log("Khala setup");
    console.log("This configures Pi through its recommended settings file:");
    console.log(scope === "project" ? "- .pi/settings.json" : "- ~/.pi/agent/settings.json");
    console.log(`Command: ${command}`);
    console.log(`Workflow config: ${targetConfigPath}`);
    console.log(`Planning workflows: ${models.planning}`);
    console.log(`Development workflows: ${models.development}`);
    console.log(`Peer-review workflows: ${models.peerReview}`);

    if (options.dryRun) return;

    const confirmed = options.yes || (rl ? await confirmInstall(rl, options) : false);
    if (!confirmed) {
      console.log("Not installed. Run the command above when ready.");
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
      console.log(`Wrote ${targetConfigPath}`);
      console.log("Next: start pi and run `/khala-health`.");
    }
  } finally {
    rl?.close();
  }
}

await main();
