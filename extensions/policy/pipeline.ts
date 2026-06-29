import { getBlockedCommandMessage } from "./blocked-commands.ts";
import { buildPreflightRawLine, modeOutcome, type PolicyMode, type PolicyOutcome, type PreflightRecord } from "./first-principles.ts";
import { evaluateRiskPolicy, type RiskPolicyEvent, type RiskPolicyHookConfig } from "./risk.ts";

interface SpawnPolicyResult {
  blockedMessage: string | null;
  riskEvent: RiskPolicyEvent | null;
  consumeRiskApproval: boolean;
}

export function evaluateSpawnPolicy(command: string, options: {
  hookConfig: RiskPolicyHookConfig;
  hasValidRiskApproval: boolean;
  nowIso: () => string;
}): SpawnPolicyResult {
  const slashCommandBlock = getSlashCommandShellBlockMessage(command);
  if (slashCommandBlock) {
    return {
      blockedMessage: slashCommandBlock,
      riskEvent: null,
      consumeRiskApproval: false,
    };
  }

  const blockedMessage = getBlockedCommandMessage(command);
  if (blockedMessage) {
    return {
      blockedMessage,
      riskEvent: null,
      consumeRiskApproval: false,
    };
  }

  const riskResult = evaluateRiskPolicy(command, options);
  return {
    blockedMessage: riskResult.blockedMessage,
    riskEvent: riskResult.event,
    consumeRiskApproval: riskResult.consumeApproval,
  };
}

function getSlashCommandShellBlockMessage(command: string): string | null {
  const normalized = command.trim();
  const match = normalized.match(/^\/(preflight|postflight)\b/);
  if (!match) return null;

  const slashCommand = `/${match[1]}`;
  return [
    `Blocked shell execution of ${slashCommand}.`,
    `${slashCommand} is a Pi chat command, not a shell command.`,
    "Send the record as assistant text in the chat so Khala can parse it, then retry the blocked operation.",
  ].join("\n");
}

interface MutationPreflightDecision {
  outcome: PolicyOutcome;
  detail: string;
  warningMessage?: string;
  blockReason?: string;
}

function buildAcceptedPreflightDetail(preflight: PreflightRecord): string {
  return `Using ${preflight.source} preflight: ${buildPreflightRawLine(preflight)}`;
}

function evaluatePreflightValidity(preflight: PreflightRecord | null, activeWorkflowId: string | null): {
  violation: boolean;
  detail: string;
} {
  if (!preflight) {
    return {
      violation: true,
      detail: "Missing valid preflight before mutation.",
    };
  }

  if (preflight.source === "auto") {
    if (!activeWorkflowId) {
      return {
        violation: true,
        detail: "Stale auto preflight outside active workflow.",
      };
    }

    if (preflight.workflowId !== activeWorkflowId) {
      return {
        violation: true,
        detail: `Auto preflight workflow mismatch (expected ${activeWorkflowId}, got ${preflight.workflowId ?? "none"}).`,
      };
    }

    return {
      violation: false,
      detail: buildAcceptedPreflightDetail(preflight),
    };
  }

  if (activeWorkflowId && preflight.workflowId && preflight.workflowId !== activeWorkflowId) {
    return {
      violation: true,
      detail: `Manual preflight workflow mismatch (expected ${activeWorkflowId}, got ${preflight.workflowId}).`,
    };
  }

  return {
    violation: false,
    detail: buildAcceptedPreflightDetail(preflight),
  };
}

export function evaluateMutationPreflightPolicy(options: {
  preflightMode: PolicyMode;
  preflight: PreflightRecord | null;
  toolName: string;
  activeWorkflowId: string | null;
}): MutationPreflightDecision {
  const { violation, detail } = evaluatePreflightValidity(options.preflight, options.activeWorkflowId);
  const outcome = modeOutcome(options.preflightMode, violation);

  if (outcome === "warn") {
    return {
      outcome,
      detail,
      warningMessage: `Policy warning (${options.toolName}): ${detail}`,
    };
  }

  if (outcome === "block") {
    return {
      outcome,
      detail,
      blockReason: [
        `Policy blocked ${options.toolName}.`,
        "Missing or invalid preflight before first mutation.",
        "Send this as assistant/chat text, not through the shell, either alone or immediately before the retrying tool call:",
        "  Preflight: skill=<name|none> reason=\"<short>\" clarify=<yes|no>",
        "Remediate and retry.",
      ].join("\n"),
    };
  }

  return {
    outcome,
    detail,
  };
}
