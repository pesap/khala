import { load as loadYaml } from "js-yaml";
import path from "node:path";
import { isRecord, readTextIfExists } from "../lib/io.ts";

export type HookLifecycle = "on_session_start" | "pre_risky_action" | "on_session_end";
export type HookType = "markdown" | "policy";

export interface HookEntry {
  type: HookType;
  path?: string;
  policy?: string;
  description?: string;
}

export interface HookConfig {
  on_session_start: HookEntry[];
  pre_risky_action: HookEntry[];
  on_session_end: HookEntry[];
}

export interface HookConfigLoadResult {
  config: HookConfig;
  warnings: string[];
}

export const DEFAULT_HOOK_CONFIG: HookConfig = {
  on_session_start: [{ type: "markdown", path: "bootstrap.md", description: "Load compliance baseline and escalation triggers." }],
  pre_risky_action: [{ type: "policy", policy: "require_human_checker_for_high_risk", description: "Block high-risk execution without explicit approval." }],
  on_session_end: [{ type: "markdown", path: "teardown.md", description: "Persist compliance-relevant summary and next checks." }],
};

export function cloneHookConfig(config: HookConfig): HookConfig {
  return {
    on_session_start: config.on_session_start.map((entry) => ({ ...entry })),
    pre_risky_action: config.pre_risky_action.map((entry) => ({ ...entry })),
    on_session_end: config.on_session_end.map((entry) => ({ ...entry })),
  };
}

function isHookLifecycle(value: string): value is HookLifecycle {
  return value === "on_session_start" || value === "pre_risky_action" || value === "on_session_end";
}

function parseHookEntry(value: unknown, lifecycle: HookLifecycle, warnings: string[]): HookEntry | null {
  if (!isRecord(value)) {
    warnings.push(`Invalid hook entry under ${lifecycle}; expected mapping.`);
    return null;
  }

  const type = value.type;
  if (type !== "markdown" && type !== "policy") {
    warnings.push(`Unsupported hook entry type '${String(type)}' under ${lifecycle}; entry ignored.`);
    return null;
  }

  const entry: HookEntry = { type };
  if (typeof value.path === "string") entry.path = value.path;
  if (typeof value.policy === "string") entry.policy = value.policy;
  if (typeof value.description === "string") entry.description = value.description;
  return entry;
}

function parseLifecycleEntries(root: Record<string, unknown>, lifecycle: HookLifecycle, warnings: string[]): HookEntry[] {
  const rawEntries = root[lifecycle];
  if (!Array.isArray(rawEntries)) {
    warnings.push(`Hook lifecycle '${lifecycle}' missing or not a list in hooks.yaml; default policy used.`);
    return [];
  }

  const entries = rawEntries
    .map((entry) => parseHookEntry(entry, lifecycle, warnings))
    .filter((entry): entry is HookEntry => entry !== null);

  if (entries.length === 0) {
    warnings.push(`Hook lifecycle '${lifecycle}' has no valid entries in hooks.yaml; default policy used.`);
  }

  return entries;
}

export function parseHooksConfig(raw: string, defaults: HookConfig = DEFAULT_HOOK_CONFIG): HookConfigLoadResult {
  const warnings: string[] = [];

  let parsedYaml: unknown;
  try {
    parsedYaml = loadYaml(raw);
  } catch (error) {
    return {
      config: cloneHookConfig(defaults),
      warnings: [`hooks.yaml parse error (${error instanceof Error ? error.message : String(error)}); default hook policy used.`],
    };
  }

  if (!isRecord(parsedYaml)) {
    return {
      config: cloneHookConfig(defaults),
      warnings: ["hooks.yaml must contain an object root; default hook policy used."],
    };
  }

  const hookRoot = isRecord(parsedYaml.hooks) ? parsedYaml.hooks : parsedYaml;
  const merged = cloneHookConfig(defaults);

  for (const lifecycle of ["on_session_start", "pre_risky_action", "on_session_end"] as const) {
    const entries = parseLifecycleEntries(hookRoot, lifecycle, warnings);
    if (entries.length > 0) {
      merged[lifecycle] = entries;
    }
  }

  for (const key of Object.keys(hookRoot)) {
    if (!isHookLifecycle(key)) {
      warnings.push(`Unknown hook lifecycle '${key}' ignored.`);
    }
  }

  return {
    config: merged,
    warnings,
  };
}

export async function loadHooksConfig(hooksConfigPath: string, defaults: HookConfig = DEFAULT_HOOK_CONFIG): Promise<HookConfigLoadResult> {
  const raw = await readTextIfExists(hooksConfigPath);
  if (!raw.trim()) {
    return {
      config: cloneHookConfig(defaults),
      warnings: ["hooks.yaml missing or empty; default hook policy used."],
    };
  }
  return parseHooksConfig(raw, defaults);
}

function resolveHookMarkdownPath(hooksDir: string, hookPath: string): string | null {
  const candidate = hookPath.trim();
  if (!candidate || path.isAbsolute(candidate)) return null;

  const hooksRoot = path.resolve(hooksDir);
  const resolved = path.resolve(hooksRoot, candidate);
  const relative = path.relative(hooksRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export async function buildLifecycleHookMarkdown(params: {
  lifecycle: HookLifecycle;
  activeHookConfig: HookConfig;
  hooksDir: string;
  readTextIfExists?: (filePath: string) => Promise<string>;
}): Promise<string> {
  const readTextFn = params.readTextIfExists ?? readTextIfExists;
  const entries = params.activeHookConfig[params.lifecycle].filter((entry) => entry.type === "markdown" && typeof entry.path === "string");
  if (entries.length === 0) return "";

  const sections: string[] = [];
  for (const entry of entries) {
    if (typeof entry.path !== "string") continue;

    const hookPath = resolveHookMarkdownPath(params.hooksDir, entry.path);
    if (!hookPath) {
      sections.push(`[${params.lifecycle}:${entry.path}]\n(Invalid hook markdown path; must stay within hooks directory)`);
      continue;
    }

    const content = await readTextFn(hookPath);
    sections.push(
      content.trim()
        ? `[${params.lifecycle}:${entry.path}]\n${content.trim()}`
        : `[${params.lifecycle}:${entry.path}]\n(Missing hook markdown file or empty content)`,
    );
  }

  return sections.join("\n\n");
}
