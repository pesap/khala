import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LEARNING_STORE_DIRNAME } from "../lib/constants.ts";
import {
  appendLine,
  ensureFile,
  exists,
  formatErrorMessage,
  isMissingPathError,
  isRecord,
  isRecoverableLearningStoreError,
  readTextIfExists,
  readTextTailIfExists,
  statIfExists,
} from "../lib/io.ts";
import { normalizeLearnedWorkflowName } from "./workflows.ts";

export type WorkflowFlagValue = string | number | boolean | null | string[];
export type WorkflowFlags = Record<string, WorkflowFlagValue>;

export type LearningHintKind = "promote" | "improve";
export type PromotionTarget =
  | "docs"
  | "command prompt"
  | "workflow spec"
  | "skill"
  | "test"
  | "lint/harness rule"
  | "hook"
  | "CI gate";

interface LearningHint {
  kind: LearningHintKind;
  sampleSize: number;
  scoreRate: number;
  at: string;
}

export interface LearningPaths {
  root: string;
  memoryDir: string;
  runsDir: string;
  workflowsDir: string;
  promptsDir: string;
  skillsDir: string;
  archivedSkillsDir: string;
  rulesDir: string;
  learningJsonl: string;
  lessonsJsonl: string;
  khalaLearningJsonl: string;
  memoryMd: string;
  promotionQueue: string;
  rulesActiveJsonl: string;
  rulesSessionJsonl: string;
  rulesCandidatesJsonl: string;
  rulesAuditJsonl: string;
  rulesMd: string;
  stateJson: string;
  curatorReport: string;
}

export interface LearningLesson {
  version: number;
  id: string;
  timestamp: string;
  scope: "global" | "repo";
  type: "workflow_correction" | "preference" | "tool_rule" | "project_fact";
  trigger: string;
  lesson: string;
  evidenceSnippet: string;
  confidence: number;
  status: "active" | "superseded";
}

export interface LearningObservation<
  TWorkflowType extends string = string,
  TWorkflowOutcome extends string = string,
> {
  version: number;
  id: string;
  timestamp: string;
  taskType: TWorkflowType;
  input: string;
  flags: WorkflowFlags;
  outcome: TWorkflowOutcome;
  confidence: number;
  evidenceSnippet: string;
  workflowId: string;
}

interface LearningState {
  hints: Record<string, LearningHint>;
}

const MEMORY_TAIL_READ_BYTES = 64_000;
const LESSONS_TAIL_READ_BYTES = 256_000;

export function classifyPromotionTarget(taskType: string, kind: LearningHintKind): PromotionTarget {
  const normalized = taskType.toLowerCase();
  if (kind === "improve") return "workflow spec";
  if (normalized.includes("test")) return "test";
  if (normalized.includes("lint") || normalized.includes("harness") || normalized.includes("rule")) {
    return "lint/harness rule";
  }
  if (normalized.includes("hook")) return "hook";
  if (normalized.includes("ci") || normalized.includes("workflow")) return "CI gate";
  if (normalized.includes("command") || normalized.includes("prompt")) return "command prompt";
  if (normalized.includes("skill")) return "skill";
  if (normalized.includes("doc") || normalized.includes("readme")) return "docs";
  return "workflow spec";
}

export function formatPromotionQueueLine(params: {
  date: string;
  taskType: string;
  kind: LearningHintKind;
  target: PromotionTarget;
  summary: string;
  evidenceSnippet: string;
  confidence: number;
}): string {
  return `- ${params.date} [${params.taskType}/${params.kind}] Target: ${params.target}. ${params.summary} Evidence: ${params.evidenceSnippet} Confidence: ${params.confidence.toFixed(2)}. Safe workflow: review evidence, apply one promotion only, run targeted validation, then seek maintainer review before any durable gate or broad self-edit.`;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isWorkflowFlagValue(value: unknown): value is WorkflowFlagValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isStringArray(value)
  );
}

function isWorkflowFlags(value: unknown): value is WorkflowFlags {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isWorkflowFlagValue(entry));
}

function parseLearningHint(value: unknown): LearningHint | null {
  if (!isRecord(value)) return null;

  const kind = value.kind;
  const sampleSize = value.sampleSize;
  const scoreRate = value.scoreRate;
  const at = value.at;

  if (
    (kind !== "promote" && kind !== "improve") ||
    typeof sampleSize !== "number" ||
    !Number.isFinite(sampleSize) ||
    typeof scoreRate !== "number" ||
    !Number.isFinite(scoreRate) ||
    typeof at !== "string"
  ) {
    return null;
  }

  return { kind, sampleSize, scoreRate, at };
}

function parseLearningHints(value: unknown): Record<string, LearningHint> {
  if (!isRecord(value)) return {};

  const hints: Record<string, LearningHint> = {};
  for (const [key, hintValue] of Object.entries(value)) {
    const parsed = parseLearningHint(hintValue);
    if (parsed) hints[key] = parsed;
  }

  return hints;
}

function parseLearningObservation(value: unknown): LearningObservation | null {
  if (!isRecord(value)) return null;

  const version = value.version;
  const id = value.id;
  const timestamp = value.timestamp;
  const taskType = value.taskType;
  const input = value.input;
  const flags = value.flags;
  const outcome = value.outcome;
  const confidence = value.confidence;
  const evidenceSnippet = value.evidenceSnippet;
  const workflowId = value.workflowId;

  if (
    typeof version !== "number" ||
    !Number.isFinite(version) ||
    typeof id !== "string" ||
    typeof timestamp !== "string" ||
    typeof taskType !== "string" ||
    typeof input !== "string" ||
    !isWorkflowFlags(flags) ||
    typeof outcome !== "string" ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    typeof evidenceSnippet !== "string" ||
    typeof workflowId !== "string"
  ) {
    return null;
  }

  return {
    version,
    id,
    timestamp,
    taskType,
    input,
    flags,
    outcome,
    confidence,
    evidenceSnippet,
    workflowId,
  };
}

function buildLearningPaths(root: string): LearningPaths {
  return {
    root,
    memoryDir: path.join(root, "memory"),
    runsDir: path.join(root, "runs"),
    workflowsDir: path.join(root, "workflows"),
    promptsDir: path.join(root, "prompts"),
    skillsDir: path.join(root, "skills"),
    archivedSkillsDir: path.join(root, "archive", "skills"),
    rulesDir: path.join(root, "rules"),
    learningJsonl: path.join(root, "memory", "learning.jsonl"),
    lessonsJsonl: path.join(root, "memory", "lessons.jsonl"),
    khalaLearningJsonl: path.join(root, "memory", "khala-learning.jsonl"),
    memoryMd: path.join(root, "memory", "MEMORY.md"),
    promotionQueue: path.join(root, "memory", "promotion-queue.md"),
    rulesActiveJsonl: path.join(root, "rules", "active.jsonl"),
    rulesSessionJsonl: path.join(root, "rules", "session.jsonl"),
    rulesCandidatesJsonl: path.join(root, "rules", "candidates.jsonl"),
    rulesAuditJsonl: path.join(root, "rules", "audit.jsonl"),
    rulesMd: path.join(root, "rules", "RULES.md"),
    stateJson: path.join(root, "state.json"),
    curatorReport: path.join(root, "memory", "skill-curator-report.md"),
  };
}

function getGlobalLearningPaths(): LearningPaths {
  return buildLearningPaths(
    path.join(homedir(), ".pi", LEARNING_STORE_DIRNAME),
  );
}

async function resolveLearningPaths(
  cwd: string,
  cache: Map<string, LearningPaths>,
): Promise<LearningPaths> {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const projectPiDir = path.join(cwd, ".pi");
  const useProjectLocal = await exists(projectPiDir);
  const paths = useProjectLocal
    ? buildLearningPaths(path.join(projectPiDir, LEARNING_STORE_DIRNAME))
    : getGlobalLearningPaths();
  cache.set(cwd, paths);
  return paths;
}

async function initializeLearningStore(paths: LearningPaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.memoryDir, { recursive: true }),
    fs.mkdir(paths.runsDir, { recursive: true }),
    fs.mkdir(paths.workflowsDir, { recursive: true }),
    fs.mkdir(paths.promptsDir, { recursive: true }),
    fs.mkdir(paths.skillsDir, { recursive: true }),
    fs.mkdir(paths.archivedSkillsDir, { recursive: true }),
    fs.mkdir(paths.rulesDir, { recursive: true }),
  ]);
  await Promise.all([
    ensureFile(paths.learningJsonl, ""),
    ensureFile(paths.lessonsJsonl, ""),
    ensureFile(paths.khalaLearningJsonl, ""),
    ensureFile(paths.memoryMd, "# MEMORY\n"),
    ensureFile(paths.promotionQueue, "# Promotion Queue\n"),
    ensureFile(paths.rulesActiveJsonl, ""),
    ensureFile(paths.rulesSessionJsonl, ""),
    ensureFile(paths.rulesCandidatesJsonl, ""),
    ensureFile(paths.rulesAuditJsonl, ""),
    ensureFile(paths.rulesMd, "# Khala Active Rules\n\n<!-- khala-rules-version: 1 -->\n"),
    ensureFile(paths.curatorReport, "# Skill Curator Report\n"),
    ensureFile(paths.stateJson, JSON.stringify({ hints: {} }, null, 2)),
  ]);
}

export async function ensureLearningStore(
  cwd: string,
  cache: Map<string, LearningPaths>,
): Promise<LearningPaths> {
  const primary = await resolveLearningPaths(cwd, cache);
  try {
    await initializeLearningStore(primary);
    return primary;
  } catch (error) {
    if (!isRecoverableLearningStoreError(error)) {
      throw new Error(
        `Failed to initialize learning store at ${primary.root}: ${formatErrorMessage(error)}`,
      );
    }
    const fallback = getGlobalLearningPaths();
    await initializeLearningStore(fallback);
    cache.set(cwd, fallback);
    return fallback;
  }
}

export async function getLearningMemoryTail(
  cwd: string,
  cache: Map<string, LearningPaths>,
  tailLines: number,
): Promise<string> {
  const paths = await ensureLearningStore(cwd, cache);
  const memory = await readTextTailIfExists(paths.memoryMd, MEMORY_TAIL_READ_BYTES);
  if (!memory.trim()) return "";

  const lines = memory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return lines.slice(-tailLines).join("\n");
}

export async function getLearnedSkillsList(
  cwd: string,
  cache: Map<string, LearningPaths>,
): Promise<string[]> {
  const paths = await ensureLearningStore(cwd, cache);
  try {
    const entries = await fs.readdir(paths.skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw new Error(
      `Failed to list learned skills in ${paths.skillsDir}: ${formatErrorMessage(error)}`,
    );
  }
}

function parseLearningLesson(value: unknown): LearningLesson | null {
  if (!isRecord(value)) return null;

  if (
    typeof value.version !== "number" ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    (value.scope !== "global" && value.scope !== "repo") ||
    (value.type !== "workflow_correction" &&
      value.type !== "preference" &&
      value.type !== "tool_rule" &&
      value.type !== "project_fact") ||
    typeof value.trigger !== "string" ||
    typeof value.lesson !== "string" ||
    typeof value.evidenceSnippet !== "string" ||
    typeof value.confidence !== "number" ||
    (value.status !== "active" && value.status !== "superseded")
  ) {
    return null;
  }

  return value as unknown as LearningLesson;
}

function parseLearningLessonsJsonl(raw: string): LearningLesson[] {
  const lessons: LearningLesson[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseLearningLesson(JSON.parse(trimmed));
      if (parsed) lessons.push(parsed);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return lessons;
}

export async function appendLearningLesson(
  paths: LearningPaths,
  lesson: LearningLesson,
): Promise<void> {
  const existing = parseLearningLessonsJsonl(
    await readTextIfExists(paths.lessonsJsonl),
  );
  const duplicate = existing
    .slice(-20)
    .some(
      (entry) =>
        entry.status === "active" &&
        entry.trigger === lesson.trigger &&
        entry.lesson === lesson.lesson,
    );
  if (duplicate) return;

  await appendLine(paths.lessonsJsonl, JSON.stringify(lesson));
  await appendLine(
    paths.memoryMd,
    `- ${lesson.timestamp.slice(0, 10)} [lesson/${lesson.type}] ${lesson.lesson} (confidence=${lesson.confidence.toFixed(2)})`,
  );
}

export async function getActiveLearningLessonsTail(
  cwd: string,
  cache: Map<string, LearningPaths>,
  tailLines: number,
): Promise<string> {
  const paths = await ensureLearningStore(cwd, cache);
  const raw = await readTextTailIfExists(paths.lessonsJsonl, LESSONS_TAIL_READ_BYTES);
  if (!raw.trim()) return "";

  return parseLearningLessonsJsonl(raw)
    .filter((lesson) => lesson.status === "active")
    .slice(-tailLines)
    .map((lesson) => `- When ${lesson.trigger}: ${lesson.lesson}`)
    .join("\n");
}

type LearningHintPaths = Pick<
  LearningPaths,
  "learningJsonl" | "promotionQueue" | "stateJson" | "workflowsDir" | "promptsDir"
>;

async function readLearningState(
  paths: LearningHintPaths,
): Promise<LearningState> {
  const raw = await readTextIfExists(paths.stateJson);
  if (!raw.trim()) return { hints: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid learning state JSON in ${paths.stateJson}: ${formatErrorMessage(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Invalid learning state in ${paths.stateJson}: expected a top-level object.`,
    );
  }
  return { hints: parseLearningHints(parsed.hints) };
}

async function writeLearningState(
  paths: LearningHintPaths,
  state: LearningState,
): Promise<void> {
  await fs.writeFile(
    paths.stateJson,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

async function readLearningEntries(
  paths: Pick<LearningPaths, "learningJsonl">,
): Promise<LearningObservation[]> {
  const raw = await readTextIfExists(paths.learningJsonl);
  if (!raw.trim()) return [];
  const entries: LearningObservation[] = [];
  const lines = raw.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let jsonValue: unknown;
    try {
      jsonValue = JSON.parse(trimmed);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw new Error(
        `Failed to parse learning entry at ${paths.learningJsonl}:${index + 1}: ${formatErrorMessage(error)}`,
      );
    }

    const parsed = parseLearningObservation(jsonValue);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export async function maybeEmitPromotionHint<
  TWorkflowType extends string,
  TWorkflowOutcome extends string,
>(params: {
  paths: LearningHintPaths;
  observation: LearningObservation<TWorkflowType, TWorkflowOutcome>;
  ctx: ExtensionContext;
  promotionMinObservations: number;
  promotionSuccessThreshold: number;
  promotionImprovementThreshold: number;
  nowIso: () => string;
  summarizeEvidence: (text: string, max?: number) => string;
  notify: (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" | "success",
  ) => void;
}): Promise<void> {
  const entries = await readLearningEntries(params.paths);
  const relevant = entries
    .filter((entry) => entry.taskType === params.observation.taskType)
    .slice(-20);

  if (relevant.length < params.promotionMinObservations) return;

  const score = relevant.reduce((acc, entry) => {
    if (entry.outcome === "success") return acc + 1;
    if (entry.outcome === "partial") return acc + 0.5;
    return acc;
  }, 0);

  const scoreRate = score / relevant.length;
  const kind: LearningHintKind | null =
    scoreRate >= params.promotionSuccessThreshold
      ? "promote"
      : scoreRate <= params.promotionImprovementThreshold
        ? "improve"
        : null;

  if (!kind) return;

  const state = await readLearningState(params.paths);
  const key = `${params.observation.taskType}:${kind}`;
  const previous = state.hints[key];

  if (
    previous &&
    relevant.length - previous.sampleSize < params.promotionMinObservations
  ) {
    return;
  }

  const now = params.nowIso();
  const summary =
    kind === "promote"
      ? `Observed ${relevant.length} ${params.observation.taskType} runs with a strong score (${scoreRate.toFixed(2)}). Suggest promoting repeated behavior into a durable reviewed gate.`
      : `Observed ${relevant.length} ${params.observation.taskType} runs with low score (${scoreRate.toFixed(2)}). Suggest prompt/workflow refinement before further automation.`;
  const evidenceSnippet = params.summarizeEvidence(
    params.observation.evidenceSnippet,
    240,
  );

  await appendLine(
    params.paths.promotionQueue,
    formatPromotionQueueLine({
      date: now.slice(0, 10),
      taskType: params.observation.taskType,
      kind,
      target: classifyPromotionTarget(params.observation.taskType, kind),
      summary,
      evidenceSnippet,
      confidence: params.observation.confidence,
    }),
  );

  if (kind === "promote" && "workflowsDir" in params.paths) {
    const workflowName = normalizeLearnedWorkflowName(
      `${params.observation.taskType}-autonomous-workflow`,
    );
    const workflowPath = path.join(params.paths.workflowsDir, `${workflowName}.yaml`);
    await appendLine(
      params.paths.promotionQueue,
      `- ${now.slice(0, 10)} [${params.observation.taskType}/workflow-candidate] Target: workflow spec. Candidate learned workflow: ${workflowName}. Review evidence and maintainer approval before creating ${workflowPath}.`,
    );
  }

  state.hints[key] = {
    kind,
    sampleSize: relevant.length,
    scoreRate,
    at: now,
  };

  await writeLearningState(params.paths, state);

  params.notify(
    params.ctx,
    kind === "promote"
      ? `Learning hint: ${params.observation.taskType} is stable enough to promote.`
      : `Learning hint: ${params.observation.taskType} needs workflow tuning.`,
    "info",
  );
}

export async function loadProjectReviewGuidelines(
  cwd: string,
): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await statIfExists(piDir);
    if (piStats?.isDirectory()) {
      const guidelineStats = await statIfExists(guidelinesPath);
      if (!guidelineStats?.isFile()) return null;

      const content = await readTextIfExists(guidelinesPath);
      const trimmed = content.trim();
      return trimmed || null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}
