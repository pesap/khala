import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  resolveKhalaProfile,
} from "../runtime/khala-profiles.ts";
import {
  formatWorkflowRouteStatus,
  getMergedRoutes,
} from "../runtime/workflow-model-router.ts";
import type { RuntimeState } from "../state/runtime.ts";
import { normalizeWhitespace } from "../lib/text.ts";
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

export function formatKhalaHealthStatus(state: KhalaHealthState): string {
  const sessionModelLine = state.piSessionModel
    ? `- model: ${state.piSessionModel}`
    : "- model: (not available)";
  const sessionThinkingLine = state.piSessionThinking
    ? `- thinking: ${state.piSessionThinking}`
    : "- thinking: (not set)";

  // Build checkhealth-style model profiles section
  const planningProfile = resolveKhalaProfile("planning");
  const developmentProfile = resolveKhalaProfile("development");

  const planningStatus = planningProfile.status === "ok" ? "OK" : "ERROR";
  const devStatus = developmentProfile.status === "ok" ? "OK" : "WARNING";

  const planningRoutes = routesForProfile("planning");
  const devRoutes = routesForProfile("development");

  const healthSummary: string[] = [];
  let warningCount = 0;
  let errorCount = 0;

  if (planningProfile.status !== "ok") errorCount += 1;
  if (developmentProfile.status !== "ok") warningCount += 1;

  const issues: string[] = [];
  if (warningCount > 0) issues.push(`${warningCount} warning`);
  if (errorCount > 0) issues.push(`${errorCount} error`);
  const healthLabel = issues.length > 0
    ? `Khala health: ${issues.join(", ")}`
    : "Khala health: OK";
  healthSummary.push(healthLabel, "");

  // Session section
  healthSummary.push(
    "Session ~",
    `- enabled: ${state.enabled ? "yes" : "no"}`,
    `- memory_tool_limit: ${state.memoryToolLimit}`,
    `- compliance: preflight=${state.firstPrinciplesConfig.preflightMode}, postflight=${state.firstPrinciplesConfig.postflightMode}, response=${state.firstPrinciplesConfig.responseComplianceMode}`,
    "",
  );

  // Pi session model section
  healthSummary.push(
    "Pi session model ~",
    sessionModelLine,
    sessionThinkingLine,
    "",
  );

  // Khala workflow model routing section
  healthSummary.push("Khala workflow model routing ~");
  healthSummary.push(formatWorkflowRouteStatus());
  healthSummary.push("");

  // Model profiles section (checkhealth-style)
  const profileLines: string[] = ["Model profiles ~", ""];

  profileLines.push(`- ${planningStatus} planning`);
  profileLines.push(`  - model: ${planningProfile.model ?? "(unresolved)"}`);
  profileLines.push(`  - thinking: ${planningProfile.thinkingLevel}`);
  if (planningRoutes.length > 0) {
    profileLines.push(`  - used by: ${planningRoutes.join(", ")}`);
  }
  if (planningProfile.status !== "ok" && planningProfile.reason) {
    profileLines.push(`  - problem: ${planningProfile.reason}`);
  }
  if (planningProfile.setupHint) {
    profileLines.push(
      "  - fix:",
      ...planningProfile.setupHint
        .split(/\d\.\s+/)
        .filter((s) => s.trim())
        .map((s, i) => `    ${i + 1}. ${s.trim()}`),
    );
  }
  profileLines.push("");

  profileLines.push(`- ${devStatus} development`);
  profileLines.push(`  - model: ${developmentProfile.model ?? "(unresolved)"}`);
  profileLines.push(`  - thinking: ${developmentProfile.thinkingLevel}`);
  if (devRoutes.length > 0) {
    profileLines.push(`  - used by: ${devRoutes.join(", ")}`);
  }
  if (developmentProfile.status !== "ok") {
    profileLines.push(`  - problem: ${developmentProfile.reason ?? "model was not found in Pi model discovery"}`);
    profileLines.push(
      "  - fix:",
      "    1. pi --list-models gpt-5.4-mini",
      "    2. edit Khala workflow model config",
    );
  }

  return [...healthSummary, ...profileLines].join("\n");
}

export function parseKhalaArgs(args: string | undefined): {
  remainingArgs: string;
  memoryToolLimit?: number;
} {
  const rawArgs = normalizeWhitespace(args ?? "");
  const limitMatch = rawArgs.match(
    /(?:^|\s)--(?:learn-tool-limit|memory-tool-limit)\s+(\d+)(?=\s|$)/,
  );
  const remainingArgs = normalizeWhitespace(
    rawArgs.replace(
      /(?:^|\s)--(?:learn-tool-limit|memory-tool-limit)\s+\d+(?=\s|$)/,
      " ",
    ),
  );

  return {
    remainingArgs,
    memoryToolLimit: limitMatch
      ? Math.max(1, Math.min(100, Number.parseInt(limitMatch[1] ?? "15", 10)))
      : undefined,
  };
}

export function createKhalaCommandHandlers(params: {
  runtimeState: RuntimeState;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
  setAgentEnabledState: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    enabled: boolean,
  ) => void;
  appendAgentStateEntry: (enabled: boolean, at: string, source?: string) => void;
  nowIso: () => string;
  runCompliancePreset: (preset: string, ctx: ExtensionCommandContext) => Promise<void>;
}): {
  khala: CommandHandler;
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

    khala: async (args, ctx) => {
      const parsed = parseKhalaArgs(args);
      const normalizedArgs = normalizeWhitespace(parsed.remainingArgs).toLowerCase();

      if (normalizedArgs === "status") {
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

      if (normalizedArgs) {
        const modeArgs = parseKhalaModeArgs(normalizedArgs);
        params.notify(
          ctx,
          modeArgs.error ?? "Usage: /khala [--learn-tool-limit N|--memory-tool-limit N] or /khala-health for status",
          "error",
        );
        return;
      }

      if (parsed.memoryToolLimit !== undefined) {
        params.runtimeState.memoryToolCallLimit = parsed.memoryToolLimit;
        if (params.runtimeState.agentEnabled) {
          params.notify(
            ctx,
            `khala memory/tool learning threshold updated: memory_tool_limit=${params.runtimeState.memoryToolCallLimit}`,
            "success",
          );
        }
      }

      if (!params.runtimeState.agentEnabled) {
        params.setAgentEnabledState(ctx, true);
        params.appendAgentStateEntry(true, params.nowIso(), "khala");
        params.notify(
          ctx,
          `khala initialized. End-of-turn learning assessment is now active. memory_tool_limit=${params.runtimeState.memoryToolCallLimit}`,
          "success",
        );
      }

      await params.runCompliancePreset("warn", ctx);
    },
  };
}
