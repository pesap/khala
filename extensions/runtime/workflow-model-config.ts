/**
 * Durable config for workflow model profiles and routes.
 *
 * Config path: <pi-agent-config>/khala/workflow-model.yaml
 *
 * Example config:
 * ```yaml
 * profiles:
 *   planning: "github-copilot/gpt-5.5:xhigh"
 *   development: "github-copilot/gpt-5.4-mini:medium"
 *   peer-review: "github-copilot/opus4.7:high"
 *
 * routes:
 *   plan: "planning"
 *   debug: "planning"
 *   triage: "planning"
 *   workon: "development"
 *   review: "development"
 *   reviewer-two: "peer-review"
 * ```
 *
 * Precedence: explicit workflow override > khala workflow flag >
 *   route config > profile config > builtin default
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { exists } from "../lib/io.ts";
import type { KhalaThinkingLevel } from "./khala-profiles.ts";

// ── Types ────────────────────────────────────────────────────────

export interface WorkflowModelConfig {
  /** Profile definitions: profileName -> "provider/model:thinking" */
  profiles: Record<string, string>;
  /** Route definitions: taskName -> profileName */
  routes: Record<string, string>;
}

/** Default config file name relative to the khala store root. */
const CONFIG_FILE_NAME = "workflow-model.yaml";

/** Built-in defaults. */
export const BUILTIN_WORKFLOW_PROFILES: Record<string, string> = {
  planning: "github-copilot/gpt-5.5:xhigh",
  development: "github-copilot/gpt-5.4-mini:medium",
  "peer-review": "github-copilot/opus4.7:high",
};

export const BUILTIN_WORKFLOW_ROUTES: Record<string, string> = {
  workon: "development",
  plan: "planning",
  triage: "planning",
  debug: "planning",
  review: "development",
  "reviewer-two": "peer-review",
};

// ── Profile string parsing ───────────────────────────────────────

export interface ParsedProfileEntry {
  modelId: string;
  thinkingLevel: KhalaThinkingLevel;
}

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/**
 * Parse a profile entry string like "provider/model:thinking".
 * Returns null if the format is invalid.
 */
export function parseProfileEntry(entry: string): ParsedProfileEntry | null {
  if (!entry || typeof entry !== "string") return null;

  const trimmed = entry.trim();
  if (!trimmed) return null;

  // Format: provider/model:thinking OR provider/model
  const colonIdx = trimmed.lastIndexOf(":");
  const thinkingLevel = trimmed.slice(colonIdx + 1).trim();
  const modelId = colonIdx > 0 ? trimmed.slice(0, colonIdx).trim() : trimmed.trim();

  if (!modelId) return null;
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(modelId)) return null;

  const validThinking = THINKING_LEVELS.includes(
    thinkingLevel as (typeof THINKING_LEVELS)[number],
  );
  const level = validThinking ? (thinkingLevel as KhalaThinkingLevel) : "medium";

  return { modelId, thinkingLevel: level };
}

/**
 * Format a profile entry string from model ID and thinking level.
 */
export function formatProfileEntry(
  modelId: string,
  thinkingLevel: KhalaThinkingLevel = "medium",
): string {
  return `${modelId}:${thinkingLevel}`;
}

// ── Config loading ───────────────────────────────────────────────

function parseYamlLine(
  raw: string,
): { key: string; value: string; indent: number } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const indent = raw.length - raw.trimStart().length;

  // Match "key: value" pairs, handling quoted values
  const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+)$/);
  if (!match) return null;

  const key = match[1];
  const rawValue = match[2];
  if (!key || !rawValue) return null;

  const value = rawValue.trim().replace(/^["']|["']$/g, "");
  return { key, value, indent };
}

function parseYamlConfig(raw: string): {
  profiles: Record<string, string>;
  routes: Record<string, string>;
  warnings: string[];
} {
  const profiles: Record<string, string> = {};
  const routes: Record<string, string> = {};
  const warnings: string[] = [];

  // Track which top-level section we're in
  let currentSection: "profiles" | "routes" | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseYamlLine(line);
    if (!parsed) {
      // Check for top-level section headers like "profiles:" or "routes:"
      const sectionMatch = line.trim().match(
        /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*$/,
      );
      if (sectionMatch) {
        const section = sectionMatch[1];
        if (!section) continue;
        if (section === "profiles" || section === "routes") {
          currentSection = section;
        } else if (parsed === null) {
          // Skip unknown top-level sections
          currentSection = null;
        }
      }
      continue;
    }

    if (currentSection === "profiles" && parsed.indent > 0) {
      if (parsed.value) {
        profiles[parsed.key] = parsed.value;
      }
    } else if (currentSection === "routes" && parsed.indent > 0) {
      if (parsed.value) {
        routes[parsed.key] = parsed.value;
      }
    }
  }

  return { profiles, routes, warnings };
}

export interface WorkflowModelConfigLoadResult {
  config: WorkflowModelConfig;
  warnings: string[];
  path?: string;
  found: boolean;
  explicitProfiles: string[];
  explicitRoutes: string[];
}

/**
 * Load workflow model config from a YAML file.
 * Falls back to builtin defaults when the file is missing or invalid.
 */
export async function loadWorkflowModelConfig(
  configPath?: string,
): Promise<WorkflowModelConfigLoadResult> {
  if (!configPath) {
    return {
      config: {
        profiles: { ...BUILTIN_WORKFLOW_PROFILES },
        routes: { ...BUILTIN_WORKFLOW_ROUTES },
      },
      warnings: ["No workflow model config path provided; using builtin defaults."],
      found: false,
      explicitProfiles: [],
      explicitRoutes: [],
    };
  }

  if (!(await exists(configPath))) {
    return {
      config: {
        profiles: { ...BUILTIN_WORKFLOW_PROFILES },
        routes: { ...BUILTIN_WORKFLOW_ROUTES },
      },
      warnings: [
        `Workflow model config not found at ${configPath}; using builtin defaults.`,
      ],
      path: configPath,
      found: false,
      explicitProfiles: [],
      explicitRoutes: [],
    };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    return {
      config: {
        profiles: { ...BUILTIN_WORKFLOW_PROFILES },
        routes: { ...BUILTIN_WORKFLOW_ROUTES },
      },
      warnings: [
        `Failed to read workflow model config: ${error instanceof Error ? error.message : String(error)}; using builtin defaults.`,
      ],
      path: configPath,
      found: true,
      explicitProfiles: [],
      explicitRoutes: [],
    };
  }

  const parsed = parseYamlConfig(raw);
  const warnings: string[] = [];

  // Merge: config overrides specific builtins, but builtins remain as fallback
  const mergedProfiles = { ...BUILTIN_WORKFLOW_PROFILES, ...parsed.profiles };
  const mergedRoutes = { ...BUILTIN_WORKFLOW_ROUTES, ...parsed.routes };

  // Validate profile entries
  for (const [name, entry] of Object.entries(parsed.profiles)) {
    const parsedEntry = parseProfileEntry(entry);
    if (!parsedEntry) {
      warnings.push(
        `Ignoring invalid profile entry for '${name}': "${entry}". Expected format: "provider/model:thinking".`,
      );
      delete mergedProfiles[name];
      // Restore builtin if present
      if (name in BUILTIN_WORKFLOW_PROFILES) {
        mergedProfiles[name] = BUILTIN_WORKFLOW_PROFILES[name];
      }
    }
  }

  // Validate route references
  for (const [task, profileName] of Object.entries(parsed.routes)) {
    if (!(profileName in mergedProfiles)) {
      warnings.push(
        `Route '${task}' references unknown profile '${profileName}'. Using builtin route if available.`,
      );
      // Restore builtin route if present
      if (task in BUILTIN_WORKFLOW_ROUTES) {
        mergedRoutes[task] = BUILTIN_WORKFLOW_ROUTES[task];
      }
    }
  }

  if (parsed.warnings.length > 0) {
    warnings.push(...parsed.warnings);
  }

  const explicitProfiles = Object.keys(parsed.profiles)
    .filter((name) => mergedProfiles[name] === parsed.profiles[name])
    .sort();
  const explicitRoutes = Object.keys(parsed.routes)
    .filter((task) => mergedRoutes[task] === parsed.routes[task])
    .sort();

  return {
    config: {
      profiles: mergedProfiles,
      routes: mergedRoutes,
    },
    warnings,
    path: configPath,
    found: true,
    explicitProfiles,
    explicitRoutes,
  };
}

/**
 * Get the default config file path under a Khala config root.
 */
export function getWorkflowModelConfigPath(khalaStoreRoot: string): string {
  return path.join(khalaStoreRoot, CONFIG_FILE_NAME);
}

/**
 * Write a workflow model config file.
 */
export async function writeWorkflowModelConfig(
  config: WorkflowModelConfig,
  configPath: string,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });

  const lines: string[] = [
    "# Khala workflow model config",
    "# Profile format: provider/model:thinking",
    "# thinking: off|minimal|low|medium|high|xhigh",
    "",
    "profiles:",
  ];

  // Sort for deterministic output
  const sortedProfiles = Object.entries(config.profiles).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, entry] of sortedProfiles) {
    lines.push(`  ${name}: "${entry}"`);
  }

  lines.push("", "routes:");
  const sortedRoutes = Object.entries(config.routes).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [task, profileName] of sortedRoutes) {
    lines.push(`  ${task}: "${profileName}"`);
  }

  lines.push(""); // trailing newline
  await writeFile(configPath, lines.join("\n"), "utf8");
}
