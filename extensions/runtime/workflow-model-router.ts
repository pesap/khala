/**
 * Workflow model router: ties together Khala workflow profile flags,
 * task-to-profile routing, and profile resolution.
 *
 * Precedence (highest to lowest):
 *   1. explicit workflow override (e.g. /workon --model, future)
 *   2. khala workflow flag (--khala-workflow-profile, --khala-workflow-task)
 *   3. route config (workon -> development)
 *   4. profile config (development -> model/thinking)
 *   5. builtin default
 */

import {
  resolveKhalaProfile,
  setKhalaWorkflowProfilesForRuntime,
  type KhalaModelProfile,
  type KhalaProfileName,
} from "./khala-profiles.ts";

// ── Task-to-profile routing ──────────────────────────────────────

export type WorkflowTask = string;
export type WorkflowProfileName = KhalaProfileName;

/** Built-in default route table: workflow task -> profile name. */
const BUILTIN_ROUTES: Record<string, WorkflowProfileName> = {
  workon: "development",
  plan: "planning",
  triage: "planning",
  debug: "planning",
  review: "development",
  "peer-review": "peer-review",
};

/** Built-in default profile map: profile name -> model id:thinking suffix. */
const BUILTIN_PROFILES: Record<WorkflowProfileName, string> = {
  planning: "github-copilot/gpt-5.5:xhigh",
  development: "github-copilot/gpt-5.4-mini:medium",
  "peer-review": "github-copilot/claude-opus-4.7:high",
  agents: "github-copilot/gpt-5.4-mini:medium",
};

// ── Durable config overrides ────────────────────────────────────

/** Merged routes (builtin + config). */
let mergedRoutes: Record<string, string> = { ...BUILTIN_ROUTES };

/** Merged profiles (builtin + config). */
let mergedProfiles: Record<string, string> = { ...BUILTIN_PROFILES };

export interface WorkflowModelConfigStatus {
  path?: string;
  found: boolean;
  explicitProfiles: string[];
  explicitRoutes: string[];
}

let workflowModelConfigStatus: WorkflowModelConfigStatus = {
  found: false,
  explicitProfiles: [],
  explicitRoutes: [],
};

export interface WorkflowModelConfigSetOptions {
  path?: string;
  found?: boolean;
  explicitProfiles?: Iterable<string>;
  explicitRoutes?: Iterable<string>;
}

/**
 * Set the merged routes and profiles from durable config.
 * Builtin defaults remain as fallback for any keys not in config.
 */
export function setWorkflowModelConfig(
  config: {
    routes: Record<string, string>;
    profiles: Record<string, string>;
  },
  options: WorkflowModelConfigSetOptions = {},
): void {
  mergedRoutes = { ...BUILTIN_ROUTES, ...config.routes };
  mergedProfiles = { ...BUILTIN_PROFILES, ...config.profiles };

  const explicitProfiles = Array.from(
    new Set(options.explicitProfiles ?? Object.keys(config.profiles)),
  ).sort();
  const explicitRoutes = Array.from(
    new Set(options.explicitRoutes ?? Object.keys(config.routes)),
  ).sort();

  workflowModelConfigStatus = {
    path: options.path,
    found: options.found ?? false,
    explicitProfiles,
    explicitRoutes,
  };
  setKhalaWorkflowProfilesForRuntime(mergedProfiles, explicitProfiles);
}

/**
 * Get the current merged routes.
 */
export function getMergedRoutes(): Record<string, string> {
  return { ...mergedRoutes };
}

/**
 * Get the current merged profiles.
 */
export function getMergedProfiles(): Record<string, string> {
  return { ...mergedProfiles };
}

export function getWorkflowModelConfigStatus(): WorkflowModelConfigStatus {
  return {
    ...workflowModelConfigStatus,
    explicitProfiles: [...workflowModelConfigStatus.explicitProfiles],
    explicitRoutes: [...workflowModelConfigStatus.explicitRoutes],
  };
}

/**
 * Reset config to builtin defaults (for tests).
 */
export function resetWorkflowModelConfigForTests(): void {
  mergedRoutes = { ...BUILTIN_ROUTES };
  mergedProfiles = { ...BUILTIN_PROFILES };
  workflowModelConfigStatus = {
    found: false,
    explicitProfiles: [],
    explicitRoutes: [],
  };
  setKhalaWorkflowProfilesForRuntime(mergedProfiles, []);
}

// ── Active state (set from flags / config) ───────────────────────

export interface ActiveWorkflowRoute {
  /** The --khala-workflow-profile flag value, if provided. */
  profileFlag: string;
  /** The --khala-workflow-task flag value, if provided. */
  taskFlag: string;
}

let activeWorkflowRoute: ActiveWorkflowRoute = {
  profileFlag: "",
  taskFlag: "",
};

/**
 * Set the active workflow route from CLI flags or config.
 * Called during session_start after parsing flags.
 */
export function setActiveWorkflowRoute(route: ActiveWorkflowRoute): void {
  activeWorkflowRoute = { ...route };
}

/**
 * Reset for tests.
 */
export function resetActiveWorkflowRouteForTests(): void {
  activeWorkflowRoute = { profileFlag: "", taskFlag: "" };
  resetWorkflowModelConfigForTests();
}

/**
 * Get the current active workflow route state.
 */
export function getActiveWorkflowRoute(): Readonly<ActiveWorkflowRoute> {
  return activeWorkflowRoute;
}

// ── Route resolution ─────────────────────────────────────────────

export interface WorkflowRouteResolution {
  /** The resolved profile name. */
  profileName: WorkflowProfileName;
  /** The resolved model profile. */
  profile: KhalaModelProfile;
  /** Where the profile came from. */
  source: "flag" | "route" | "builtin";
  /** Human-readable routing description. */
  description: string;
}

export interface ResolveWorkflowRouteOptions {
  /**
   * Ignore the active implementation workflow flags and resolve only durable
   * route/config state. Use for nested peer-review defaults that must not
   * inherit the caller's implementation profile.
   */
  ignoreActiveWorkflowFlags?: boolean;
}

/**
 * Resolve the workflow route for a given workflow name.
 *
 * @param task - The workflow task name (e.g. "workon", "plan", "triage").
 * @returns A route resolution with the resolved profile and model.
 */
export function resolveWorkflowRoute(
  task: WorkflowTask,
  options: ResolveWorkflowRouteOptions = {},
): WorkflowRouteResolution {
  if (!options.ignoreActiveWorkflowFlags) {
    // 1. Check if --khala-workflow-profile flag is set (highest precedence)
    if (activeWorkflowRoute.profileFlag) {
      const profileName = activeWorkflowRoute.profileFlag as WorkflowProfileName;
      const profile = resolveKhalaProfile(profileName);
      return {
        profileName,
        profile,
        source: "flag",
        description: `--khala-workflow-profile=${profileName}`,
      };
    }

    // 2. Check if --khala-workflow-task flag is set, then look up merged route
    if (activeWorkflowRoute.taskFlag) {
      const routeProfile = mergedRoutes[activeWorkflowRoute.taskFlag];
      if (routeProfile) {
        const profile = resolveKhalaProfile(routeProfile as WorkflowProfileName);
        return {
          profileName: routeProfile as WorkflowProfileName,
          profile,
          source: "route",
          description: `route ${activeWorkflowRoute.taskFlag} -> ${routeProfile}`,
        };
      }
    }
  }

  // 3. Look up merged route for the requested task
  const routeProfile = mergedRoutes[task];
  if (routeProfile) {
    const profile = resolveKhalaProfile(routeProfile as WorkflowProfileName);
    const source = workflowModelConfigStatus.explicitRoutes.includes(task)
      ? "route"
      : "builtin";
    return {
      profileName: routeProfile as WorkflowProfileName,
      profile,
      source,
      description: `route ${task} -> ${routeProfile}`,
    };
  }

  // 4. Last resort: resolve the task name as a profile name
  const profile = resolveKhalaProfile(task as WorkflowProfileName);
  return {
    profileName: task as WorkflowProfileName,
    profile,
    source: "builtin",
    description: `fallback direct profile ${task}`,
  };
}

/**
 * Format a human-readable description of the active workflow route state.
 */
function formatEntries(entries: Record<string, string>, separator: string): string {
  return Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${separator}${value}`)
    .join(", ");
}

/**
 * Format a human-readable description of the active workflow route state.
 */
export function formatWorkflowRouteStatus(): string {
  const lines: string[] = [];
  const configPath = workflowModelConfigStatus.path;
  const configState = workflowModelConfigStatus.found
    ? `found at ${configPath ?? "(path unavailable)"}`
    : configPath
      ? `not found at ${configPath}; using builtin defaults`
      : "not found; using builtin defaults";

  lines.push(`- workflow config: ${configState}`);
  if (workflowModelConfigStatus.explicitProfiles.length > 0) {
    lines.push(
      `- workflow config profiles: ${workflowModelConfigStatus.explicitProfiles.join(", ")}`,
    );
  }
  if (workflowModelConfigStatus.explicitRoutes.length > 0) {
    lines.push(
      `- workflow config routes: ${workflowModelConfigStatus.explicitRoutes.join(", ")}`,
    );
  }
  if (activeWorkflowRoute.profileFlag) {
    lines.push(`- workflow profile flag: ${activeWorkflowRoute.profileFlag}`);
  } else {
    lines.push("- workflow profile flag: none (CLI override not set; workflow config still applies)");
  }
  if (activeWorkflowRoute.taskFlag) {
    lines.push(`- workflow task flag: ${activeWorkflowRoute.taskFlag}`);
  } else {
    lines.push("- workflow task flag: none (CLI override not set; command routes still apply)");
  }
  lines.push(`- active profiles: ${formatEntries(mergedProfiles, "=")}`);
  lines.push(`- active routes: ${formatEntries(mergedRoutes, "->")}`);
  lines.push(
    "- note: Pi --model affects this session; --khala-* affects Khala workflow launches only.",
  );
  return lines.join("\n");
}
