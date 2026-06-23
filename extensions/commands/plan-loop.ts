import type { KhalaThinkingLevel } from "../runtime/khala-profiles.ts";
import type { WorkonThinkingLevel } from "./workon.ts";
import {
  IMPROVE_LABEL,
  WORKON_READY_LABEL,
  workonReadyPacketContractInstruction,
} from "./workon-ready-packet.ts";

export const PLAN_LOOP_STATES = [
  "candidate",
  "audited",
  "draft",
  "needs-revision",
  "blocked",
  "workon-ready",
  "published",
] as const;

export type PlanLoopState = (typeof PLAN_LOOP_STATES)[number];

export const PLAN_LOOP_PHASES = [
  "AUDIT",
  "DRAFT",
  "REVIEW",
  "REVISE",
  "READY ISSUE",
] as const;

export type PlanLoopPhase = (typeof PLAN_LOOP_PHASES)[number];

export const PLAN_REVIEW_SIZE_TARGET_CHANGED_LOC = 500;
export const PLAN_DEFAULT_MAX_ISSUES = 3;
export const PLAN_LOOP_ISSUE_LABELS = [IMPROVE_LABEL, WORKON_READY_LABEL] as const;

export type PlanLoopEvent =
  | { type: "candidate_created"; topic: string }
  | { type: "audit_completed"; findingCount: number; categories: string[] }
  | { type: "draft_created"; title: string }
  | { type: "review_passed"; reviewer: "peer-review" }
  | { type: "review_requested_revision"; blockers: string[] }
  | { type: "draft_blocked"; reason: string }
  | { type: "workon_ready"; title: string }
  | { type: "issue_published"; issueUrl: string };

export interface PlanLoopRoutingSectionsParams {
  planningModel: string | null;
  planningThinkingLevel: KhalaThinkingLevel;
  planningRoutingReason: string;
  reviewerTwo: {
    enabled: boolean;
    context: "fresh";
    loops: number;
    model: string;
    thinkingLevel: WorkonThinkingLevel;
    routingMode: "default" | "override";
    routingReason: string;
  };
}

export function buildPlanLoopRuntimeSections(params: PlanLoopRoutingSectionsParams): string[] {
  return [
    `Plan loop states: ${PLAN_LOOP_STATES.join(" -> ")}`,
    `Plan loop phases: ${PLAN_LOOP_PHASES.join(" -> ")}`,
    `Issue labels on published packets: ${PLAN_LOOP_ISSUE_LABELS.join(", ")} plus category label`,
    `Model routing: default (${params.planningRoutingReason})`,
    `Exact model: ${params.planningModel ?? "(unresolved)"}`,
    `Exact thinking level: ${params.planningThinkingLevel}`,
    `Reviewer Two routing: ${params.reviewerTwo.enabled ? "enabled" : "disabled"}`,
    `Reviewer Two default context: ${params.reviewerTwo.context}`,
    `Reviewer Two loop budget: ${params.reviewerTwo.loops}`,
    `Reviewer Two model: ${params.reviewerTwo.model || "(unresolved)"}`,
    `Reviewer Two thinking level: ${params.reviewerTwo.thinkingLevel}`,
    `Reviewer Two routing reason: ${params.reviewerTwo.routingMode} (${params.reviewerTwo.routingReason})`,
    "Instruction: Ask only blocking questions, one at a time; if enough evidence exists, draft the work packet without waiting.",
    "Instruction: If a question can be answered from code/docs, inspect first and do not ask it.",
    "Instruction: Capture edge cases, trade-offs, in-scope paths, out-of-scope paths, and validation from the live codebase. Do not write local decision docs.",
    `Instruction: Produce an in-memory draft work packet before any issue creation. Use one issue by default and at most ${PLAN_DEFAULT_MAX_ISSUES} slices unless the user explicitly approves more.`,
    `Instruction: Each proposed issue must be independently reviewable, list dependencies and AFK/HITL status, and target less than about ${PLAN_REVIEW_SIZE_TARGET_CHANGED_LOC} lines of code change per PR.`,
    "Instruction: Ask approval on the exact ready issue packet before creating or updating issues.",
    `Instruction: ${workonReadyPacketContractInstruction({ subject: "draft work packet", action: "review" })}`,
    "Instruction: Before any issue creation, run the internal Reviewer Two pass through the same review workflow contract used by /review: review-only, evidence-backed, no mutation, verdict pass/revise/blocked. Synthesize findings as must-fix, optional/deferred, or rejected with rationale, revise within the configured loop budget, and publish only packets that are /workon-ready.",
  ];
}
