import type { KhalaLearningAssessment } from "../learning/khala-learn";
import type { LearnedSkillRecord } from "../learning/skills";

export interface SelfImprovementReviewInput {
  hasMeaningfulWorkflow: boolean;
  assessment: KhalaLearningAssessment | null;
  userCorrection: boolean;
  skillPatchSignal: boolean;
}

export function shouldRunSelfImprovementReview(
  input: SelfImprovementReviewInput,
): boolean {
  if (input.assessment?.sensitive) return false;
  if (input.assessment?.shouldLearn) return true;
  if (input.userCorrection) return true;
  if (input.skillPatchSignal) return true;
  return input.hasMeaningfulWorkflow;
}

export function chooseWritableLearnedSkillTarget(
  records: Array<LearnedSkillRecord | null>,
): LearnedSkillRecord | null {
  for (const record of records) {
    if (!record) continue;
    if (record.metadata.state === "archived") continue;
    if (
      record.metadata.provenance === "agent-authored" ||
      record.metadata.provenance === "background-review-authored"
    ) {
      return record;
    }
  }
  return null;
}

export function appendBackgroundReviewLearningSection(
  skillText: string,
  bullet: string,
): string {
  const trimmed = skillText.trimEnd();
  const section = "## Background review learnings";
  if (trimmed.includes(section)) return `${trimmed}\n${bullet}\n`;
  return `${trimmed}\n\n${section}\n${bullet}\n`;
}

export function formatSelfImprovementBullet(params: {
  date: string;
  lesson: string;
  trigger: string;
  evidence: string;
}): string {
  return `- ${params.date}: ${params.lesson} Trigger: ${params.trigger}. Evidence: ${params.evidence}`;
}

export function formatSkillPromotionQueueLine(params: {
  date: string;
  target: string;
  trigger: string;
  lesson: string;
}): string {
  return `- ${params.date} [self-improvement/skill] Target: ${params.target}. Trigger: ${params.trigger}. Lesson: ${params.lesson}`;
}

export function formatSkillReviewQueueLine(params: {
  date: string;
  loadedSkills: string[];
  evidence: string;
}): string {
  return `- ${params.date} [self-improvement/review] Loaded skills: ${params.loadedSkills.join(", ")}. Evidence suggests a skill patch may be needed: ${params.evidence}`;
}

export function buildAutonomousSkillName(params: {
  trigger: string;
  fallback: string;
  slugify: (value: string) => string;
}): string {
  const source = params.trigger.trim() || params.fallback.trim() || "learned-action";
  return params.slugify(source).slice(0, 80) || "learned-action";
}

export function buildAutonomousSkillText(params: {
  skillName: string;
  trigger: string;
  lesson: string;
  evidence: string;
  date: string;
}): string {
  return [
    "---",
    `name: ${params.skillName}`,
    `description: Background-learned procedure for ${params.trigger}`,
    "---",
    "",
    "## Use when",
    `- ${params.trigger}`,
    "",
    "## Steps",
    `1. Apply this learned rule: ${params.lesson}`,
    "2. Inspect current task context before acting; do not rely on stale memory.",
    "3. Validate the result with concrete evidence before finalizing.",
    "",
    "## Evidence",
    `- ${params.date}: ${params.evidence}`,
    "",
    "## Avoid when",
    "- The current task conflicts with newer user instructions.",
    "- The learning contains sensitive or project-private material that should not be reused.",
    "",
  ].join("\n");
}
