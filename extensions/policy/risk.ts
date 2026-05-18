import { DESTRUCTIVE_COMMAND_PATTERNS, SENSITIVE_COMMAND_PATTERNS } from "../lib/constants.ts";
import { summarizeEvidence } from "../lib/text.ts";

export type RiskCategory = "destructive_operation" | "secret_or_pii_exposure_risk";

export interface ClassifiedRisk {
  category: RiskCategory;
  detail: string;
}

export interface RiskPolicyEvent {
  at: string;
  command: string;
  category: RiskCategory;
  detail: string;
  approved: boolean;
}

export interface RiskPolicyHookConfig {
  pre_risky_action: Array<{ type?: string; policy?: string }>;
}

export interface EvaluateRiskPolicyResult {
  blockedMessage: string | null;
  event: RiskPolicyEvent | null;
  consumeApproval: boolean;
}

export function requiresCheckerForHighRisk(config: RiskPolicyHookConfig): boolean {
  return config.pre_risky_action.some((entry) => entry.type === "policy" && entry.policy === "require_human_checker_for_high_risk");
}

export function classifyRiskyCommand(command: string): ClassifiedRisk | null {
  for (const entry of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (entry.pattern.test(command)) {
      return {
        category: "destructive_operation",
        detail: entry.detail,
      };
    }
  }

  for (const entry of SENSITIVE_COMMAND_PATTERNS) {
    if (entry.pattern.test(command)) {
      return {
        category: "secret_or_pii_exposure_risk",
        detail: entry.detail,
      };
    }
  }

  return null;
}

export function buildRiskApprovalRequiredMessage(risk: ClassifiedRisk): string {
  return [
    `Error: High-risk command blocked (${risk.category}; ${risk.detail}).`,
    "Checker approval is required before executing high-risk actions.",
    "",
    "Run:",
    "  /approve-risk \"checker approved: <ticket/reason>\"",
    "",
    "Approval is one-time and expires automatically.",
  ].join("\n");
}

export function evaluateRiskPolicy(command: string, options: {
  hookConfig: RiskPolicyHookConfig;
  hasValidRiskApproval: boolean;
  nowIso: () => string;
}): EvaluateRiskPolicyResult {
  if (!requiresCheckerForHighRisk(options.hookConfig)) {
    return { blockedMessage: null, event: null, consumeApproval: false };
  }

  const risk = classifyRiskyCommand(command);
  if (!risk) {
    return { blockedMessage: null, event: null, consumeApproval: false };
  }

  const at = options.nowIso();
  if (!options.hasValidRiskApproval) {
    return {
      blockedMessage: buildRiskApprovalRequiredMessage(risk),
      event: {
        at,
        command: summarizeEvidence(command, 200),
        category: risk.category,
        detail: risk.detail,
        approved: false,
      },
      consumeApproval: false,
    };
  }

  return {
    blockedMessage: null,
    event: {
      at,
      command: summarizeEvidence(command, 200),
      category: risk.category,
      detail: risk.detail,
      approved: true,
    },
    consumeApproval: true,
  };
}
