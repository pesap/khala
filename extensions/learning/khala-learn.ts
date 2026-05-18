import { Type } from "typebox";
import type { LearningLesson, LearningPaths } from "./store.ts";
import { appendLine, readTextIfExists } from "../lib/io.ts";
import { normalizeWhitespace, summarizeEvidence } from "../lib/text.ts";

export const KhalaAssessLearningParams = Type.Object({
  taskSummary: Type.String({ description: "Short summary of the user task or prompt" }),
  assistantSummary: Type.Optional(Type.String({ description: "Summary of the assistant outcome or findings" })),
  workflowType: Type.Optional(Type.String({ description: "Workflow name if applicable" })),
  workflowId: Type.Optional(Type.String({ description: "Workflow id if applicable" })),
  mutationCount: Type.Optional(Type.Number({ description: "Number of mutation tool calls or changed files" })),
  loadedSkills: Type.Optional(Type.Array(Type.String(), { description: "Skills loaded during execution" })),
  policyWarnings: Type.Optional(Type.Array(Type.String(), { description: "Policy warnings or near-miss signals" })),
  userCorrection: Type.Optional(Type.Boolean({ description: "Whether the user corrected the agent" })),
  reusable: Type.Optional(Type.Boolean({ description: "Whether the lesson appears reusable" })),
  confidenceHint: Type.Optional(Type.Number({ description: "Optional confidence hint 0..1" })),
  trigger: Type.Optional(Type.String({ description: "Candidate trigger text" })),
  lessonCandidate: Type.Optional(Type.String({ description: "Candidate lesson text" })),
  evidence: Type.Optional(Type.Array(Type.String(), { description: "Concrete evidence items" })),
});

export const KhalaLearnParams = Type.Object({
  kind: Type.String({ description: "workflow_correction|preference|tool_rule|project_fact" }),
  scope: Type.String({ description: "repo|global" }),
  trigger: Type.String({ description: "When this lesson should apply" }),
  lesson: Type.String({ description: "The durable learning to remember" }),
  evidenceSnippet: Type.String({ description: "Short evidence snippet justifying the lesson" }),
  confidence: Type.Number({ description: "Confidence 0..1" }),
  score: Type.Number({ description: "Assessment score 0..1" }),
  promotable: Type.Optional(Type.Boolean({ description: "Whether this lesson is promotable" })),
  workflowType: Type.Optional(Type.String({ description: "Workflow type if applicable" })),
  workflowId: Type.Optional(Type.String({ description: "Workflow id if applicable" })),
  source: Type.Optional(Type.String({ description: "auto|manual" })),
  actionTaken: Type.Optional(Type.Array(Type.String(), { description: "Optional actions taken because of this lesson" })),
});

export type LearningKind = LearningLesson["type"];
export type LearningScope = LearningLesson["scope"];

export interface KhalaLearningAssessment {
  shouldLearn: boolean;
  score: number;
  confidence: number;
  kind: LearningKind;
  scope: LearningScope;
  trigger: string;
  lesson: string;
  reason: string;
  evidence: string[];
  evidenceSnippet: string;
  promotable: boolean;
  sensitive: boolean;
  components: {
    reusability: number;
    evidenceStrength: number;
    impact: number;
    novelty: number;
    clarity: number;
  };
}

export interface KhalaLearningRecord extends KhalaLearningAssessment {
  version: number;
  id: string;
  timestamp: string;
  workflowType?: string;
  workflowId?: string;
  source: "auto" | "manual";
  actionTaken?: string[];
}

interface AssessInput {
  taskSummary: string;
  assistantSummary?: string;
  workflowType?: string;
  workflowId?: string;
  mutationCount?: number;
  loadedSkills?: string[];
  policyWarnings?: string[];
  userCorrection?: boolean;
  reusable?: boolean;
  confidenceHint?: number;
  trigger?: string;
  lessonCandidate?: string;
  evidence?: string[];
}

interface RecentLearningLike {
  trigger: string;
  lesson: string;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function inferCorrectionLesson(taskSummary: string): { trigger: string; lesson: string } | null {
  const lower = taskSummary.toLowerCase();
  if (!/wrong|instead|actually|do not|don't|stalling|stalled|stop planning|implement/.test(lower)) {
    return null;
  }
  if (/stalling|stalled|stop planning|implement/.test(lower)) {
    return {
      trigger: "user reports stalling or asks for implementation",
      lesson:
        "Move to concrete tool action or ask one blocking question; do not keep responding with plans only.",
    };
  }
  if (/instead|actually/.test(lower)) {
    return {
      trigger: "user redirects scope or edits intent",
      lesson:
        "Prefer the user's latest correction over prior assumptions and restate only the changed operating rule briefly.",
    };
  }
  return {
    trigger: "user gives corrective feedback",
    lesson:
      "Treat this as corrective feedback; adjust behavior immediately instead of repeating the previous approach.",
  };
}

function inferWorkflowLesson(input: AssessInput): { kind: LearningKind; trigger: string; lesson: string } | null {
  const combined = `${input.taskSummary} ${input.assistantSummary ?? ""} ${(input.policyWarnings ?? []).join(" ")}`.toLowerCase();
  if (/unsigned commit|signing/.test(combined)) {
    return {
      kind: "tool_rule",
      trigger: "commit or ship work with GitButler",
      lesson:
        "Verify commit signing before push; if signing is unavailable or unclear, stop and request assistance instead of creating an unsigned commit.",
    };
  }
  if (/duplicate pr|stale branch|already merged|squash merge|fresh branch|mainline/.test(combined)) {
    return {
      kind: "workflow_correction",
      trigger: "shipping follow-up work after a merged PR",
      lesson:
        "After a merged PR, especially after squash merge, rebuild follow-up work on a fresh branch from the latest default branch instead of reusing the old branch.",
    };
  }
  if ((input.policyWarnings ?? []).some((line) => /preflight/i.test(line))) {
    return {
      kind: "tool_rule",
      trigger: "mutation work under first-principles gate",
      lesson:
        "Provide explicit preflight intent before mutation tools so policy checks have the intended scope and reason.",
    };
  }
  if ((input.policyWarnings ?? []).some((line) => /postflight/i.test(line))) {
    return {
      kind: "tool_rule",
      trigger: "mutation work after code or file changes",
      lesson:
        "Always include concrete postflight verification after mutation work so outcomes are auditable and policy-compliant.",
    };
  }
  return null;
}

function chooseKind(input: AssessInput, hasCorrection: boolean): LearningKind {
  if (hasCorrection) return "workflow_correction";
  if ((input.workflowType ?? "") === "learn-skill") return "tool_rule";
  if ((input.policyWarnings?.length ?? 0) > 0) return "tool_rule";
  return "project_fact";
}

function computeNovelty(trigger: string, lesson: string, recents: RecentLearningLike[]): number {
  const triggerNorm = normalizeWhitespace(trigger).toLowerCase();
  const lessonNorm = normalizeWhitespace(lesson).toLowerCase();
  if (
    recents.some(
      (entry) =>
        normalizeWhitespace(entry.trigger).toLowerCase() === triggerNorm &&
        normalizeWhitespace(entry.lesson).toLowerCase() === lessonNorm,
    )
  ) {
    return 0.2;
  }
  return 0.85;
}

export function assessLearning(input: AssessInput, recent: RecentLearningLike[] = []): KhalaLearningAssessment {
  const correction = input.userCorrection ? inferCorrectionLesson(input.taskSummary) : null;
  const workflowLesson = inferWorkflowLesson(input);
  const lesson = input.lessonCandidate ?? correction?.lesson ?? workflowLesson?.lesson ?? "";
  const trigger = input.trigger ?? correction?.trigger ?? workflowLesson?.trigger ?? (input.workflowType ? `${input.workflowType} workflow outcome` : "task outcome");
  const evidence = (input.evidence ?? []).filter(Boolean);
  if (input.userCorrection) evidence.unshift("user correction detected");
  if ((input.mutationCount ?? 0) > 0) evidence.push(`${input.mutationCount} mutation(s)`);
  if ((input.loadedSkills?.length ?? 0) > 0) evidence.push(`loaded skills: ${input.loadedSkills?.join(", ")}`);
  for (const warning of input.policyWarnings ?? []) {
    evidence.push(`policy warning: ${warning}`);
  }
  const evidenceSnippet = summarizeEvidence([
    input.taskSummary,
    input.assistantSummary,
    ...evidence,
  ]
    .filter(Boolean)
    .join(" | "));

  const reusability = clamp(
    input.reusable === true
      ? 1
      : correction || workflowLesson
        ? 0.9
        : input.workflowType || (input.loadedSkills?.length ?? 0) > 0 || (input.mutationCount ?? 0) > 0
          ? 0.7
          : 0.35,
  );
  const evidenceStrength = clamp(
    0.25 + (input.userCorrection ? 0.25 : 0) + Math.min((evidence.length / 4) * 0.3, 0.3) + ((input.mutationCount ?? 0) > 0 ? 0.2 : 0),
  );
  const impact = clamp(
    input.workflowType === "ship" || input.workflowType === "learn-skill"
      ? 0.95
      : input.workflowType === "debug" || input.workflowType === "review"
        ? 0.85
        : (input.mutationCount ?? 0) > 0
          ? 0.7
          : 0.45,
  );
  const novelty = computeNovelty(trigger, lesson, recent);
  const clarity = clamp(lesson.length >= 24 ? 0.9 : lesson.length > 0 ? 0.5 : 0);
  const score = clamp(
    reusability * 0.3 + evidenceStrength * 0.25 + impact * 0.2 + novelty * 0.15 + clarity * 0.1,
  );
  const confidence = clamp(
    input.confidenceHint ?? (score * 0.7 + evidenceStrength * 0.2 + clarity * 0.1),
  );
  const sensitive = /token|secret|password|private key|credential/i.test(evidenceSnippet);
  const shouldLearn = !sensitive && lesson.length > 0 && score >= 0.75 && confidence >= 0.75;
  const promotable = shouldLearn && score >= 0.9 && confidence >= 0.9;
  const kind = workflowLesson?.kind ?? chooseKind(input, correction !== null);
  const reason = shouldLearn
    ? "Reusable, evidence-backed learning worth storing."
    : sensitive
      ? "Potentially sensitive content; do not store."
      : lesson.length === 0
        ? "No durable lesson candidate inferred."
        : `Score/confidence below threshold (score=${score.toFixed(2)}, confidence=${confidence.toFixed(2)}).`;

  return {
    shouldLearn,
    score,
    confidence,
    kind,
    scope: "repo",
    trigger,
    lesson,
    reason,
    evidence,
    evidenceSnippet,
    promotable,
    sensitive,
    components: {
      reusability,
      evidenceStrength,
      impact,
      novelty,
      clarity,
    },
  };
}

function parseKhalaLearningRecord(value: unknown): KhalaLearningRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.trigger !== "string" ||
    typeof record.lesson !== "string" ||
    typeof record.score !== "number" ||
    typeof record.confidence !== "number"
  ) {
    return null;
  }
  return value as KhalaLearningRecord;
}

export async function readRecentKhalaLearningRecords(paths: LearningPaths, limit = 20): Promise<KhalaLearningRecord[]> {
  const raw = await readTextIfExists(paths.khalaLearningJsonl);
  if (!raw.trim()) return [];
  const records: KhalaLearningRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseKhalaLearningRecord(JSON.parse(trimmed));
      if (parsed) records.push(parsed);
    } catch {
    }
  }
  return records.slice(-limit);
}

function isDuplicateKhalaLearningRecord(
  entry: Pick<KhalaLearningRecord, "trigger" | "lesson">,
  record: Pick<KhalaLearningRecord, "trigger" | "lesson">,
): boolean {
  return (
    normalizeWhitespace(entry.trigger).toLowerCase() ===
      normalizeWhitespace(record.trigger).toLowerCase() &&
    normalizeWhitespace(entry.lesson).toLowerCase() ===
      normalizeWhitespace(record.lesson).toLowerCase()
  );
}

export async function appendKhalaLearningRecord(paths: LearningPaths, record: KhalaLearningRecord): Promise<boolean> {
  const recents = await readRecentKhalaLearningRecords(paths, 20);
  const duplicate = recents.some((entry) =>
    isDuplicateKhalaLearningRecord(entry, record),
  );
  if (duplicate) return false;
  await appendLine(paths.khalaLearningJsonl, JSON.stringify(record));
  await appendLine(
    paths.memoryMd,
    `- ${record.timestamp.slice(0, 10)} [khala-learn/${record.kind}] ${record.lesson} (score=${record.score.toFixed(2)}, confidence=${record.confidence.toFixed(2)})`,
  );
  return true;
}

export async function persistKhalaLearningRecord(paths: LearningPaths, record: KhalaLearningRecord): Promise<boolean> {
  const stored = await appendKhalaLearningRecord(paths, record);
  if (!stored || !record.promotable) return stored;
  await appendLine(
    paths.promotionQueue,
    `- ${record.timestamp.slice(0, 10)} [khala-learn/promote] ${record.lesson} (score=${record.score.toFixed(2)}, confidence=${record.confidence.toFixed(2)})`,
  );
  return stored;
}
