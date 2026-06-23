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
};

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

  // 2. Check if --khala-workflow-task flag is set, then look up route
  if (activeWorkflowRoute.taskFlag) {
    const routeProfile = BUILTIN_ROUTES[activeWorkflowRoute.taskFlag];
    if (routeProfile) {
      const profile = resolveKhalaProfile(routeProfile);
      return {
        profileName: routeProfile,
        profile,
        source: "route",
        description: `route ${activeWorkflowRoute.taskFlag} -> ${routeProfile}`,
      };
    }
  }

  // 3. Fallback to builtin route for the requested task
  const fallbackProfile = BUILTIN_ROUTES[task];
  if (fallbackProfile) {
    const profile = resolveKhalaProfile(fallbackProfile);
    return {
      profileName: fallbackProfile,
      profile,
      source: "builtin",
      description: `builtin route ${task} -> ${fallbackProfile}`,
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
 * Get the known builtin routes for display purposes.
 */
export function getBuiltinRouteTable(): Record<string, WorkflowProfileName> {
  return { ...BUILTIN_ROUTES };
}

/**
 * Get the known builtin profiles for display purposes.
 */
export function getBuiltinProfileTable(): Record<WorkflowProfileName, string> {
  return { ...BUILTIN_PROFILES };
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
