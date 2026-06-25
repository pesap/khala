import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  resolveKhalaProfile,
} from "../runtime/khala-profiles.ts";
import {
  getMergedRoutes,
  getWorkflowModelConfigStatus,
} from "../runtime/workflow-model-router.ts";
import type { RuntimeState } from "../state/runtime.ts";
import { parseKhalaModeArgs } from "./parsers.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export interface KhalaHealthState {
  enabled: boolean;
  memoryToolLimit: number;
  firstPrinciplesConfig: RuntimeState["firstPrinciplesConfig"];
  piSessionModel?: string;
  piSessionThinking?: string;
}

/** Routes that use each profile, for health display. */
function routesForProfile(profileName: string): string[] {
  const routes = getMergedRoutes();
  return Object.entries(routes)
    .filter(([, p]) => p === profileName)
    .map(([task]) => `/${task}`);
}

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
} as const;

function colorStatusLine(status: "OK" | "ERROR", line: string): string {
  const color = status === "OK" ? ANSI.green : ANSI.red;
  return `${color}${line}${ANSI.reset}`;
}

function profileStatusLabel(profileStatus: "ok" | "unresolved"): "OK" | "ERROR" {
  return profileStatus === "ok" ? "OK" : "ERROR";
}

function routedProfileNames(): string[] {
  const routeProfiles = Object.values(getMergedRoutes());
  return Array.from(new Set(["planning", "development", ...routeProfiles]));
}

export function formatKhalaHealthStatus(state: KhalaHealthState): string {
  const profiles = routedProfileNames().map((name) => resolveKhalaProfile(name));
  const configStatus = getWorkflowModelConfigStatus();
  let errorCount = 0;

  for (const profile of profiles) {
    if (profile.status !== "ok") errorCount += 1;
  }
  if (!configStatus.found) errorCount += 1;
  if (configStatus.found && configStatus.warnings.length > 0) errorCount += configStatus.warnings.length;

  const healthLine = errorCount > 0
    ? colorStatusLine("ERROR", `Khala health: ${errorCount} error${errorCount === 1 ? "" : "s"}`)
    : colorStatusLine("OK", "Khala health: OK");

  const lines: string[] = [
    healthLine,
    "",
    "Session Configuration",
    "=====================",
    `- enabled: ${state.enabled ? "yes" : "no"}`,
    `- memory_tool_limit: ${state.memoryToolLimit}`,
    `- compliance: preflight=${state.firstPrinciplesConfig.preflightMode}, postflight=${state.firstPrinciplesConfig.postflightMode}, response=${state.firstPrinciplesConfig.responseComplianceMode}`,
    "",
    "Model profiles",
    "==============",
    "",
  ];

  const configLine = configStatus.found
    ? `- OK found at ${configStatus.path ?? "(path unavailable)"}`
    : `- ERROR workflow-model.yaml not found${configStatus.path ? ` at ${configStatus.path}` : ""}`;
  lines.push(colorStatusLine(configStatus.found ? "OK" : "ERROR", configLine));
  for (const warning of configStatus.warnings) {
    lines.push(`- workflow config warning: ${warning}`);
  }

  for (const profile of profiles) {
    const status = profileStatusLabel(profile.status);
    const routes = routesForProfile(profile.name);
    lines.push("");
    lines.push(colorStatusLine(status, `- ${status} ${profile.name}`));
    lines.push(`  - model: ${profile.model ?? "(unresolved)"}`);
    lines.push(`  - thinking: ${profile.thinkingLevel}`);
    if (routes.length > 0) {
      lines.push(`  - used by: ${routes.join(", ")}`);
    }
    if (profile.status !== "ok") {
      lines.push(`  - problem: ${profile.reason ?? "model was not found in Pi model discovery"}`);
      if (profile.setupHint) lines.push(`  - fix: ${profile.setupHint}`);
    }
  }

  return lines.join("\n");
}

export function createKhalaCommandHandlers(params: {
  runtimeState: RuntimeState;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
  runCompliancePreset: (preset: string, ctx: ExtensionCommandContext) => Promise<void>;
}): {
  khalaHealth: CommandHandler;
  khalaMode: CommandHandler;
} {
  return {
    khalaHealth: async (_args, ctx) => {
      params.notify(
        ctx,
        formatKhalaHealthStatus({
          enabled: params.runtimeState.agentEnabled,
          memoryToolLimit: params.runtimeState.memoryToolCallLimit,
          firstPrinciplesConfig: params.runtimeState.firstPrinciplesConfig,
        }),
        "info",
      );
    },

    khalaMode: async (args, ctx) => {
      const parsed = parseKhalaModeArgs(args ?? "");
      if (parsed.error) {
        params.notify(ctx, parsed.error, "error");
        return;
      }

      if (parsed.preset === "status") {
        params.notify(
          ctx,
          formatKhalaHealthStatus({
            enabled: params.runtimeState.agentEnabled,
            memoryToolLimit: params.runtimeState.memoryToolCallLimit,
            firstPrinciplesConfig: params.runtimeState.firstPrinciplesConfig,
          }),
          "info",
        );
        return;
      }

      await params.runCompliancePreset(parsed.preset, ctx);
    },

  };
}
