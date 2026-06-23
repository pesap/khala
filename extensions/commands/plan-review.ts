import { normalizeWhitespace } from "../lib/text.ts";
import type { WorkonThinkingLevel } from "./workon.ts";

export const REVIEWER_TWO_REVIEW_CONTRACT = [
  "Reviewer Two reuses the /review posture: scoped, skeptical, evidence-backed, read-only review.",
  "Reviewer Two is advisory only. The parent /plan workflow remains the decision-maker before any issue creation.",
  "Reviewer prompt contract: do not implement edits, do not launch Worktrunk/Zellij/Pi, do not create issues, do not create PRs, and do not mutate forge state.",
  "Reviewer output contract: decision, blockers, importantRevisions, optionalSuggestions, missingAcceptanceCriteria, validationGaps, scopeConcerns, recommendation.",
  "Reviewer must explicitly decide whether the packet is /workon-ready: observable outcome, narrow acceptance criteria, concrete validation commands, AFK/HITL status, review-size risk, drift check, and STOP conditions.",
  "Reviewer decision vocabulary: pass, revise, blocked.",
] as const;

export type ReviewerTwoDecision = "pass" | "revise" | "blocked";

export interface NormalizedPlanWorkPacket {
  goal: string;
  why: string;
  inScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  validationPlan: string[];
  risks: string[];
  openQuestions: string[];
  canonicalRefs: string[];
}

export interface ReviewerTwoReviewSettings {
  enabled: boolean;
  model: string;
  thinkingLevel: WorkonThinkingLevel;
  loops: number;
  context: "fresh";
  routingMode: "default" | "override";
  routingReason: string;
}

export interface ReviewerTwoReviewResult {
  decision: ReviewerTwoDecision;
  blockers: string[];
  importantRevisions: string[];
  optionalSuggestions: string[];
  missingAcceptanceCriteria: string[];
  validationGaps: string[];
  scopeConcerns: string[];
  recommendation: string;
}

export function normalizePlanWorkPacket(
  input: string | Partial<NormalizedPlanWorkPacket>,
): NormalizedPlanWorkPacket {
  if (typeof input === "string") {
    const goal = normalizeWhitespace(input);
    return {
      goal,
      why: "",
      inScope: [],
      outOfScope: [],
      acceptanceCriteria: [],
      validationPlan: [],
      risks: [],
      openQuestions: [],
      canonicalRefs: [],
    };
  }

  return {
    goal: normalizeWhitespace(input.goal ?? ""),
    why: normalizeWhitespace(input.why ?? ""),
    inScope: normalizeStringList(input.inScope),
    outOfScope: normalizeStringList(input.outOfScope),
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    validationPlan: normalizeStringList(input.validationPlan),
    risks: normalizeStringList(input.risks),
    openQuestions: normalizeStringList(input.openQuestions),
    canonicalRefs: normalizeStringList(input.canonicalRefs),
  };
}

export function buildPlanReviewerTwoSections(
  input: string | Partial<NormalizedPlanWorkPacket>,
  settings: ReviewerTwoReviewSettings,
): string[] {
  const packet = normalizePlanWorkPacket(input);
  const sections = [
    ...REVIEWER_TWO_REVIEW_CONTRACT,
    `Reviewer Two settings: enabled=${settings.enabled ? "yes" : "no"}, model=${settings.model || "(unresolved)"}, thinking=${settings.thinkingLevel}, loops=${settings.loops}, context=${settings.context}, routing=${settings.routingMode} (${settings.routingReason})`,
    `Normalized draft work packet: goal=${packet.goal || "(unspecified)"}; why/user impact=${packet.why || "(unspecified)"}`,
    `In scope: ${renderList(packet.inScope)}`,
    `Out of scope: ${renderList(packet.outOfScope)}`,
    `Acceptance criteria: ${renderList(packet.acceptanceCriteria)}`,
    `Validation plan: ${renderList(packet.validationPlan)}`,
    `Risks/open questions: ${renderList([...packet.risks, ...packet.openQuestions])}`,
    `Evidence refs: ${renderList(packet.canonicalRefs)}`,
    "Parent synthesis contract: classify Reviewer Two findings as must-fix before issue creation, optional/deferred, or rejected with rationale before any issue creation.",
    "Stop rules: use one fresh-context Reviewer Two pass by default, keep the maximum review loop budget bounded at 2, and ask one concrete human decision question if Reviewer Two is blocked or the parent disagrees on a blocker.",
  ];

  if (!settings.enabled) {
    sections.splice(
      1,
      0,
      "Reviewer Two is disabled for this /plan invocation; skip the review pass and continue with the parent workflow.",
    );
  }

  return sections;
}

export function normalizeReviewerTwoReviewResult(
  input: unknown,
): ReviewerTwoReviewResult | { error: string } {
  const parsed = typeof input === "string" ? tryParseJson(input) : input;
  if (!isRecord(parsed)) {
    return { error: "Invalid Reviewer Two result: expected an object or JSON string." };
  }

  const decision = normalizeDecision(parsed.decision);
  if (!decision) {
    return { error: "Invalid Reviewer Two result: decision must be pass, revise, or blocked." };
  }

  const recommendation = normalizeWhitespace(
    typeof parsed.recommendation === "string" ? parsed.recommendation : "",
  );
  if (!recommendation) {
    return { error: "Invalid Reviewer Two result: recommendation is required." };
  }

  return {
    decision,
    blockers: normalizeStringList(parsed.blockers),
    importantRevisions: normalizeStringList(parsed.importantRevisions),
    optionalSuggestions: normalizeStringList(parsed.optionalSuggestions),
    missingAcceptanceCriteria: normalizeStringList(parsed.missingAcceptanceCriteria),
    validationGaps: normalizeStringList(parsed.validationGaps),
    scopeConcerns: normalizeStringList(parsed.scopeConcerns),
    recommendation,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      const normalized = normalizeWhitespace(value);
      return normalized ? [normalized] : [];
    }
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? normalizeWhitespace(entry) : ""))
    .filter((entry) => entry.length > 0);
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join(" | ") : "(none)";
}

function normalizeDecision(value: unknown): ReviewerTwoDecision | null {
  if (value === "pass" || value === "revise" || value === "blocked") {
    return value;
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
