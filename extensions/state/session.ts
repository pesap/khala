import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../lib/io.ts";
import { AGENT_STATE_TYPE, COMPLIANCE_MODE_TYPE, POLICY_EVENT_TYPE, POSTFLIGHT_EVENT_TYPE, PREFLIGHT_STATE_TYPE, RISK_APPROVAL_TYPE } from "../lib/constants.ts";
import { parsePolicyMode, type PostflightRecord, type PreflightRecord } from "../policy/first-principles.ts";
import type { PolicyEvent, RiskApproval, RuntimeState } from "./runtime.ts";

interface RiskApprovalEntryData {
  approved?: boolean;
  reason?: string;
  approvedAt?: string;
  expiresAt?: string;
}

interface PreflightStateEntryData {
  at?: string;
  skill?: string;
  reason?: string;
  clarify?: string;
  raw?: string;
  source?: string;
  workflowId?: string | null;
}

interface AgentStateEntryData {
  enabled?: boolean;
}

interface ComplianceModeEntryData {
  preflightMode?: string;
  postflightMode?: string;
  responseComplianceMode?: string;
}

export function getAgentEnabledFromSession(ctx: ExtensionContext): boolean {
  let enabled: boolean | null = null;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== AGENT_STATE_TYPE) continue;

    if (!isRecord(entry.data)) continue;
    const data: AgentStateEntryData = entry.data;

    if (typeof data.enabled === "boolean") {
      enabled = data.enabled;
    }
  }

  return enabled ?? true;
}

export function getComplianceModeFromSession(ctx: ExtensionContext): RuntimeState["firstPrinciplesConfig"] | null {
  let config: RuntimeState["firstPrinciplesConfig"] | null = null;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== COMPLIANCE_MODE_TYPE) continue;

    if (!isRecord(entry.data)) continue;
    const data: ComplianceModeEntryData = entry.data;

    const preflightMode = parsePolicyMode(data.preflightMode);
    const postflightMode = parsePolicyMode(data.postflightMode);
    const responseComplianceMode = parsePolicyMode(data.responseComplianceMode);

    if (!preflightMode || !postflightMode || !responseComplianceMode) {
      continue;
    }

    config = {
      preflightMode,
      postflightMode,
      responseComplianceMode,
    };
  }

  return config;
}

export function getRiskApprovalFromSession(ctx: ExtensionContext): RiskApproval | null {
  let approval: RiskApproval | null = null;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== RISK_APPROVAL_TYPE) continue;

    if (!isRecord(entry.data)) {
      approval = null;
      continue;
    }

    const data: RiskApprovalEntryData = entry.data;
    if (data.approved !== true) {
      approval = null;
      continue;
    }

    if (
      typeof data.reason === "string"
      && typeof data.approvedAt === "string"
      && typeof data.expiresAt === "string"
    ) {
      approval = {
        reason: data.reason,
        approvedAt: data.approvedAt,
        expiresAt: data.expiresAt,
      };
    }
  }

  if (!approval) return null;
  return Date.parse(approval.expiresAt) > Date.now() ? approval : null;
}

export function getPreflightFromSession(
  ctx: ExtensionContext,
  guards: {
    isPreflightClarify: (value: unknown) => value is PreflightRecord["clarify"];
    isPreflightSource: (value: unknown) => value is PreflightRecord["source"];
  },
): PreflightRecord | null {
  let record: PreflightRecord | null = null;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== PREFLIGHT_STATE_TYPE) continue;

    if (!isRecord(entry.data)) continue;
    const data: PreflightStateEntryData = entry.data;

    if (
      typeof data.at === "string"
      && typeof data.skill === "string"
      && typeof data.reason === "string"
      && guards.isPreflightClarify(data.clarify)
      && typeof data.raw === "string"
      && guards.isPreflightSource(data.source)
      && (data.workflowId === undefined || data.workflowId === null || typeof data.workflowId === "string")
    ) {
      record = {
        at: data.at,
        skill: data.skill,
        reason: data.reason,
        clarify: data.clarify,
        raw: data.raw,
        source: data.source,
        workflowId: data.workflowId ?? null,
      };
    }
  }

  return record;
}

export function appendAgentStateEntry(pi: ExtensionAPI, enabled: boolean, at: string, source?: string): void {
  const payload = source
    ? { enabled, source, at }
    : { enabled, at };
  pi.appendEntry(AGENT_STATE_TYPE, payload);
}

export function appendComplianceModeEntry(
  pi: ExtensionAPI,
  config: RuntimeState["firstPrinciplesConfig"] & { at: string; source: "command" },
): void {
  pi.appendEntry(COMPLIANCE_MODE_TYPE, config);
}

export function appendRiskApprovalEntry(pi: ExtensionAPI, approval: RiskApproval): void {
  pi.appendEntry(RISK_APPROVAL_TYPE, {
    approved: true,
    reason: approval.reason,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
  });
}

export function appendPreflightEntry(pi: ExtensionAPI, record: PreflightRecord): void {
  pi.appendEntry(PREFLIGHT_STATE_TYPE, record);
}

export function appendPostflightEntry(pi: ExtensionAPI, record: PostflightRecord): void {
  pi.appendEntry(POSTFLIGHT_EVENT_TYPE, record);
}

export function appendPolicyEvent(pi: ExtensionAPI, state: RuntimeState, event: PolicyEvent): void {
  state.policyEvents.push(event);
  pi.appendEntry(POLICY_EVENT_TYPE, event);
}
