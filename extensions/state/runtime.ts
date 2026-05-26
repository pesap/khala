import type { FirstPrinciplesConfig, PolicyMode, PolicyOutcome, PostflightRecord, PreflightRecord } from "../policy/first-principles.ts";
import type { RiskCategory } from "../policy/risk.ts";

export interface RiskApproval {
  reason: string;
  approvedAt: string;
  expiresAt: string;
}

export interface RiskEvent {
  at: string;
  command: string;
  category: RiskCategory;
  detail: string;
  approved: boolean;
}

export interface PolicyEvent {
  at: string;
  phase: "preflight" | "postflight";
  mode: PolicyMode;
  outcome: PolicyOutcome;
  detail: string;
  toolName?: string;
}

export interface RuntimeState {
  agentEnabled: boolean;
  riskApproval: RiskApproval | null;
  riskEvents: RiskEvent[];
  firstPrinciplesConfig: FirstPrinciplesConfig;
  activePreflight: PreflightRecord | null;
  latestPostflight: PostflightRecord | null;
  policyEvents: PolicyEvent[];
  memoryToolCallLimit: number;
  lastObligationBlockKey: string | null;
  lastObligationBlockCount: number;
  lastMemoryGateBlockKey: string | null;
  lastMemoryGateBlockCount: number;
}

export function createRuntimeState(): RuntimeState {
  return {
    agentEnabled: false,
    riskApproval: null,
    riskEvents: [],
    firstPrinciplesConfig: { preflightMode: "warn", postflightMode: "warn", responseComplianceMode: "warn" },
    activePreflight: null,
    latestPostflight: null,
    policyEvents: [],
    memoryToolCallLimit: 15,
    lastObligationBlockKey: null,
    lastObligationBlockCount: 0,
    lastMemoryGateBlockKey: null,
    lastMemoryGateBlockCount: 0,
  };
}

export function setAgentEnabled(state: RuntimeState, enabled: boolean): void {
  state.agentEnabled = enabled;
}

export function hasValidRiskApproval(state: RuntimeState): boolean {
  if (!state.riskApproval) return false;
  return Date.parse(state.riskApproval.expiresAt) > Date.now();
}

export function resetSessionComplianceState(state: RuntimeState): void {
  state.riskEvents = [];
  state.policyEvents = [];
  state.riskApproval = null;
  state.activePreflight = null;
  state.latestPostflight = null;
  state.lastObligationBlockKey = null;
  state.lastObligationBlockCount = 0;
  state.lastMemoryGateBlockKey = null;
  state.lastMemoryGateBlockCount = 0;
}
