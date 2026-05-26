import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, isMissingPathError, readTextIfExists } from "../lib/io.ts";
import type { LearningPaths } from "./store.ts";

export type LearnedWorkflowPaths = Pick<
  LearningPaths,
  "workflowsDir" | "promptsDir"
>;

export interface LearnedWorkflowRecord {
  name: string;
  workflowFile: string;
  promptFile: string;
}
const WORKFLOW_EXT = ".yaml";

export function normalizeLearnedWorkflowName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "learned-workflow"
  );
}

export function buildLearnedWorkflowArtifact(params: {
  workflowName: string;
  taskType: string;
  date: string;
  sampleSize: number;
  scoreRate: number;
  summary: string;
}): string {
  return [
    `name: ${params.workflowName}`,
    "version: 1",
    "source: khala-autonomous-memory",
    `created: ${params.date}`,
    `taskType: ${JSON.stringify(params.taskType)}`,
    `sampleSize: ${params.sampleSize}`,
    `scoreRate: ${params.scoreRate.toFixed(2)}`,
    "steps:",
    "  - read_memory: call khala_read_memory before mutation or memory writes",
    "  - search_memory: call khala_search_memory with a task-specific query for non-trivial work",
    "  - inspect: gather current repo/task evidence",
    "  - act: perform the smallest concrete action that satisfies the request",
    "  - verify: run targeted validation or record why validation was not possible",
    "  - learn: store or patch durable non-sensitive lessons",
    "promotionEvidence:",
    `  summary: ${JSON.stringify(params.summary)}`,
    "",
  ].join("\n");
}

export function buildLearnedWorkflowPromptTemplate(params: {
  workflowName: string;
  taskType: string;
  summary: string;
}): string {
  return [
    "---",
    `description: Run khala learned workflow ${params.workflowName}`,
    'argument-hint: "[input]"',
    "---",
    "",
    `Run khala learned workflow \`${params.workflowName}\`.`,
    "",
    `Task type: ${params.taskType}`,
    `Promotion evidence: ${params.summary}`,
    "",
    "Workflow instructions:",
    "- Call khala_read_memory before mutation or memory writes.",
    "- Call khala_search_memory with a task-specific query before non-trivial work.",
    "- Inspect current repo/task evidence before acting.",
    "- Perform the smallest concrete action that satisfies the request.",
    "- Validate the result or explain why validation was not possible.",
    "- Store or patch durable non-sensitive lessons when appropriate.",
    "",
    "User input:",
    "$ARGUMENTS",
    "",
  ].join("\n");
}

export function getLearnedWorkflowPaths(
  paths: LearnedWorkflowPaths,
  workflowName: string,
): LearnedWorkflowRecord {
  const name = normalizeLearnedWorkflowName(workflowName);
  return {
    name,
    workflowFile: path.join(paths.workflowsDir, `${name}${WORKFLOW_EXT}`),
    promptFile: path.join(paths.promptsDir, `${name}.md`),
  };
}

export async function writeLearnedWorkflowPromptTemplate(params: {
  paths: LearnedWorkflowPaths;
  workflowName: string;
  taskType: string;
  summary: string;
}): Promise<LearnedWorkflowRecord> {
  const record = getLearnedWorkflowPaths(params.paths, params.workflowName);
  await fs.mkdir(path.dirname(record.promptFile), { recursive: true });
  await fs.writeFile(
    record.promptFile,
    buildLearnedWorkflowPromptTemplate({
      workflowName: record.name,
      taskType: params.taskType,
      summary: params.summary,
    }),
    "utf8",
  );
  return record;
}

export async function listLearnedWorkflows(
  paths: LearnedWorkflowPaths,
): Promise<LearnedWorkflowRecord[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(paths.workflowsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(WORKFLOW_EXT))
    .map((entry) => getLearnedWorkflowPaths(paths, entry.name.slice(0, -WORKFLOW_EXT.length)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readLearnedWorkflow(
  paths: LearnedWorkflowPaths,
  workflowName: string,
): Promise<{ record: LearnedWorkflowRecord; workflowText: string; promptText: string } | null> {
  const record = getLearnedWorkflowPaths(paths, workflowName);
  if (!(await exists(record.workflowFile))) return null;
  const [workflowText, promptText] = await Promise.all([
    readTextIfExists(record.workflowFile),
    readTextIfExists(record.promptFile),
  ]);
  return { record, workflowText, promptText };
}
