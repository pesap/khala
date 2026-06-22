import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PolicyMode, PostflightRecord, PreflightRecord } from "../policy/first-principles.ts";
import { formatKhalaHealthStatus } from "./khala.ts";
import type { RuntimeState } from "../state/runtime.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;

export function createComplianceCommandHandlers(params: {
  runtimeState: RuntimeState;
  notify: (ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, message: string, type: NotifyType) => void;
  parseComplianceArgs: (args: string) => { preset: "status" | "reset" | PolicyMode; error?: string };
  parseApproveRiskArgs: (args: string) => { reason: string; ttlMinutes: number; error?: string };
  parsePreflightArgs: (args: string) => { record?: PreflightRecord; error?: string };
  parsePostflightArgs: (args: string) => { record?: PostflightRecord; error?: string };
  nowIso: () => string;
  getDefaultFirstPrinciplesConfig: () => RuntimeState["firstPrinciplesConfig"];
  appendComplianceModeEntry: (record: RuntimeState["firstPrinciplesConfig"] & { at: string; source: "command" }) => void;
  appendRiskApprovalEntry: (approval: { reason: string; approvedAt: string; expiresAt: string }) => void;
  appendPreflightEntry: (record: PreflightRecord) => void;
  appendPostflightEntry: (record: PostflightRecord) => void;
  getActiveWorkflowId?: () => string | null;
}): {
  compliance: CommandHandler;
  approveRisk: CommandHandler;
  preflight: CommandHandler;
  postflight: CommandHandler;
} {
  const formatCompliance = (config: RuntimeState["firstPrinciplesConfig"]): string => (
    `preflight=${config.preflightMode}, postflight=${config.postflightMode}, response=${config.responseComplianceMode}`
  );

  const applyMode = (mode: PolicyMode): RuntimeState["firstPrinciplesConfig"] => ({
    preflightMode: mode,
    postflightMode: mode,
    responseComplianceMode: mode,
  });

  return {
    compliance: async (args, ctx) => {
      const parsed = params.parseComplianceArgs(args ?? "");
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

      const isReset = parsed.preset === "reset";
      const nextConfig = isReset
        ? { ...params.getDefaultFirstPrinciplesConfig() }
        : applyMode(parsed.preset as PolicyMode);

      params.runtimeState.firstPrinciplesConfig = nextConfig;
      params.appendComplianceModeEntry({
        at: params.nowIso(),
        source: "command",
        ...nextConfig,
      });

      params.notify(
        ctx,
        isReset
          ? `Compliance modes reset to defaults: ${formatCompliance(nextConfig)}.`
          : `Compliance strictness updated: ${formatCompliance(nextConfig)}.`,
        "success",
      );
    },

    approveRisk: async (args, ctx) => {
      const parsed = params.parseApproveRiskArgs(args ?? "");
      if (parsed.error) {
        params.notify(ctx, parsed.error, "error");
        return;
      }

      const approvedAt = params.nowIso();
      const expiresAt = new Date(Date.now() + parsed.ttlMinutes * 60_000).toISOString();
      params.runtimeState.riskApproval = {
        reason: parsed.reason,
        approvedAt,
        expiresAt,
      };

      params.appendRiskApprovalEntry(params.runtimeState.riskApproval);
      params.notify(ctx, `Risk approval recorded until ${expiresAt}.`, "success");
    },

    preflight: async (args, ctx) => {
      const parsed = params.parsePreflightArgs(args ?? "");
      if (parsed.error || !parsed.record) {
        params.notify(ctx, parsed.error ?? "Invalid preflight.", "error");
        return;
      }

      const activeWorkflowId = params.getActiveWorkflowId?.() ?? null;
      const record = activeWorkflowId
        ? { ...parsed.record, workflowId: activeWorkflowId }
        : parsed.record;

      params.runtimeState.activePreflight = record;
      params.appendPreflightEntry(record);
      params.notify(ctx, `Preflight recorded (${record.skill}).`, "success");
    },

    postflight: async (args, ctx) => {
      const parsed = params.parsePostflightArgs(args ?? "");
      if (parsed.error || !parsed.record) {
        params.notify(ctx, parsed.error ?? "Invalid postflight.", "error");
        return;
      }
      params.runtimeState.latestPostflight = parsed.record;
      params.appendPostflightEntry(parsed.record);
      params.notify(ctx, `Postflight recorded (${parsed.record.result}).`, "success");
    },
  };
}
