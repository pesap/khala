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

import { resolveKhalaProfile, type KhalaModelProfile, type KhalaProfileName } from "./khala-profiles.ts";

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
};

/** Built-in default profile map: profile name -> model id:thinking suffix. */
const BUILTIN_PROFILES: Record<WorkflowProfileName, string> = {
  planning: "github-copilot/gpt-5.5:xhigh",
  development: "github-copilot/gpt-5.4-mini:medium",
  agents: "github-copilot/gpt-5.4-mini:medium",
};

// ── Durable config overrides ────────────────────────────────────

/** Merged routes (builtin + config). */
let mergedRoutes: Record<string, string> = { ...BUILTIN_ROUTES };

/** Merged profiles (builtin + config). */
let mergedProfiles: Record<string, string> = { ...BUILTIN_PROFILES };

/**
 * Set the merged routes and profiles from durable config.
 * Builtin defaults remain as fallback for any keys not in config.
 */
export function setWorkflowModelConfig(config: {
  routes: Record<string, string>;
  profiles: Record<string, string>;
}): void {
  mergedRoutes = { ...BUILTIN_ROUTES, ...config.routes };
  mergedProfiles = { ...BUILTIN_PROFILES, ...config.profiles };
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

/**
 * Reset config to builtin defaults (for tests).
 */
export function resetWorkflowModelConfigForTests(): void {
  mergedRoutes = { ...BUILTIN_ROUTES };
  mergedProfiles = { ...BUILTIN_PROFILES };
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

/**
 * Resolve the workflow route for a given workflow name.
 *
 * @param task - The workflow task name (e.g. "workon", "plan", "triage").
 * @returns A route resolution with the resolved profile and model.
 */
export function resolveWorkflowRoute(task: WorkflowTask): WorkflowRouteResolution {
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

  // 3. Look up merged route for the requested task
  const routeProfile = mergedRoutes[task];
  if (routeProfile) {
    const profile = resolveKhalaProfile(routeProfile as WorkflowProfileName);
    return {
      profileName: routeProfile as WorkflowProfileName,
      profile,
      source: "builtin",
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
export function formatWorkflowRouteStatus(): string {
  const lines: string[] = [];
  if (activeWorkflowRoute.profileFlag) {
    lines.push(`- workflow profile flag: ${activeWorkflowRoute.profileFlag}`);
  } else {
    lines.push("- workflow profile flag: (not set)");
  }
  if (activeWorkflowRoute.taskFlag) {
    lines.push(`- workflow task flag: ${activeWorkflowRoute.taskFlag}`);
  } else {
    lines.push("- workflow task flag: (not set)");
  }
  lines.push(
    "- note: Pi --model affects this session; --khala-* affects Khala workflow launches only.",
  );
  return lines.join("\n");
}
