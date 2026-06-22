import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatKhalaModelProfilesStatus } from "../runtime/khala-profiles.ts";
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
}

function formatComplianceModes(
  config: RuntimeState["firstPrinciplesConfig"],
): string {
  return `preflight=${config.preflightMode}, postflight=${config.postflightMode}, response=${config.responseComplianceMode}`;
}

export function formatKhalaHealthStatus(state: KhalaHealthState): string {
  return [
    "Khala health (read-only):",
    `- enabled (session): ${state.enabled ? "yes" : "no"}`,
    `- memory_tool_limit: ${state.memoryToolLimit}`,
    `- Compliance modes (session): ${formatComplianceModes(state.firstPrinciplesConfig)}.`,
    formatKhalaModelProfilesStatus(),
  ].join("\n");
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
