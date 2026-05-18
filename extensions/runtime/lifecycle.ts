import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildLifecycleHookMarkdown,
  type HookConfig,
} from "../hooks/config.ts";
import { appendLine, formatErrorMessage } from "../lib/io.ts";
import {
  resetSessionComplianceState,
  type RuntimeState,
} from "../state/runtime.ts";

export interface LowConfidenceEvent {
  at: string;
  workflowId: string;
  workflowType: string;
  confidence: number;
  outcome: string;
}

type NotifyFn = (
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
  type: "info" | "error" | "warning" | "success",
) => void;

async function appendRuntimeDailyLog(
  runtimeDailyLogPath: string,
  line: string,
): Promise<void> {
  try {
    await appendLine(runtimeDailyLogPath, line);
  } catch (error) {
    console.warn(
      `Failed to append runtime log line to ${runtimeDailyLogPath}: ${formatErrorMessage(error)}`,
    );
  }
}

export async function runSessionEndHooks(params: {
  pi: ExtensionAPI;
  ctx: Pick<ExtensionContext, "hasUI" | "ui">;
  activeHookConfig: HookConfig;
  hooksDir: string;
  runtimeDailyLogPath: string;
  runtimeState: RuntimeState;
  lowConfidenceEvents: LowConfidenceEvent[];
  notify: NotifyFn;
  nowIso: () => string;
}): Promise<void> {
  const teardownHooks = await buildLifecycleHookMarkdown({
    lifecycle: "on_session_end",
    activeHookConfig: params.activeHookConfig,
    hooksDir: params.hooksDir,
  });
  const summary = {
    at: params.nowIso(),
    riskEvents: params.runtimeState.riskEvents,
    lowConfidenceEvents: params.lowConfidenceEvents,
    policyEvents: params.runtimeState.policyEvents,
    teardownHooksLoaded: Boolean(teardownHooks.trim()),
  };
  params.pi.appendEntry("khala-hook-summary", summary);

  const executedHighRisk = params.runtimeState.riskEvents.filter(
    (event) => event.approved,
  ).length;
  const blockedHighRisk = params.runtimeState.riskEvents.filter(
    (event) => !event.approved,
  ).length;
  const blockedPolicy = params.runtimeState.policyEvents.filter(
    (event) => event.outcome === "block",
  ).length;
  const warnedPolicy = params.runtimeState.policyEvents.filter(
    (event) => event.outcome === "warn",
  ).length;
  params.notify(
    params.ctx,
    `Hook teardown summary: high-risk approved=${executedHighRisk}, blocked=${blockedHighRisk}, policy(block=${blockedPolicy},warn=${warnedPolicy}), low-confidence=${params.lowConfidenceEvents.length}.`,
    "info",
  );

  await appendRuntimeDailyLog(
    params.runtimeDailyLogPath,
    `- ${summary.at.slice(0, 10)}: hook-summary approved_high_risk=${executedHighRisk} blocked_high_risk=${blockedHighRisk} policy_blocked=${blockedPolicy} policy_warned=${warnedPolicy} low_confidence=${params.lowConfidenceEvents.length}`,
  );

  resetSessionComplianceState(params.runtimeState);
}
