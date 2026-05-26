import { promises as fs } from "node:fs";
import path from "node:path";
import { isMissingPathError, readTextIfExists } from "../lib/io.ts";
import type { LearningPaths } from "./store.ts";

export type KhalaCorpusKind =
  | "memory"
  | "lesson"
  | "learning"
  | "curator"
  | "rule"
  | "rule_candidate"
  | "rule_audit"
  | "skill"
  | "workflow"
  | "prompt";

export interface KhalaCorpusSearchResult {
  path: string;
  kind: KhalaCorpusKind;
  score: number;
  title: string;
  snippet: string;
}

export type KhalaMemorySearchResult = KhalaCorpusSearchResult;

const SEARCH_FILE_LIMIT = 500;
const MAX_FILE_BYTES = 250_000;
const KIND_SCORE_BONUS: Partial<Record<KhalaCorpusKind, number>> = {
  skill: 1.5,
  workflow: 1.25,
  prompt: 1.25,
  lesson: 1,
  learning: 1,
  rule: 2,
  rule_candidate: 2,
};

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.-]{1,}/g)
        ?.filter((term) => term.length >= 2) ?? [],
    ),
  );
}

function classifyCorpusPath(filePath: string, paths: LearningPaths): KhalaCorpusKind {
  if (filePath === paths.memoryMd) return "memory";
  if (filePath === paths.lessonsJsonl) return "lesson";
  if (filePath === paths.khalaLearningJsonl) return "learning";
  if (filePath === paths.curatorReport) return "curator";
  if (filePath === paths.rulesActiveJsonl || filePath === paths.rulesSessionJsonl || filePath === paths.rulesMd) return "rule";
  if (filePath === paths.rulesCandidatesJsonl) return "rule_candidate";
  if (filePath === paths.rulesAuditJsonl) return "rule_audit";
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.includes("/skills/")) return "skill";
  if (normalized.includes("/workflows/")) return "workflow";
  if (normalized.includes("/prompts/")) return "prompt";
  return "memory";
}
const fixedCorpusFiles = (paths: LearningPaths): string[] => [
  paths.memoryMd,
  paths.lessonsJsonl,
  paths.khalaLearningJsonl,
  paths.curatorReport,
  paths.promotionQueue,
  paths.rulesActiveJsonl,
  paths.rulesSessionJsonl,
  paths.rulesCandidatesJsonl,
  paths.rulesAuditJsonl,
  paths.rulesMd,
];

async function walkCandidateFiles(
  root: string,
  budget: { remaining: number },
): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    if (budget.remaining <= 0) return;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      if (budget.remaining <= 0) return;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|jsonl|ya?ml)$/i.test(entry.name)) continue;
      files.push(next);
      budget.remaining -= 1;
    }
  }

  await walk(root);
  return files;
}

async function collectCandidateFiles(
  fixedFiles: string[],
  roots: string[],
): Promise<string[]> {
  const budget = { remaining: Math.max(0, SEARCH_FILE_LIMIT - fixedFiles.length) };
  const discovered: string[] = [];
  for (const root of roots) {
    if (budget.remaining <= 0) break;
    discovered.push(...(await walkCandidateFiles(root, budget)));
  }
  return Array.from(new Set([...fixedFiles, ...discovered]));
}

async function readSearchableFile(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stats?.isFile() || stats.size > MAX_FILE_BYTES) return "";
  return readTextIfExists(filePath);
}

function bestSnippet(text: string, terms: string[], maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const center = firstHit ?? 0;
  const start = Math.max(0, center - Math.floor(maxLength / 3));
  const snippet = normalized.slice(start, start + maxLength).trim();
  return `${start > 0 ? "..." : ""}${snippet}${start + maxLength < normalized.length ? "..." : ""}`;
}

function scoreMemoryText(params: {
  query: string;
  terms: string[];
  filePath: string;
  text: string;
  kind: KhalaCorpusKind;
}): number {
  const lowerText = params.text.toLowerCase();
  const lowerPath = params.filePath.toLowerCase();
  const query = params.query.toLowerCase().trim();
  let score = 0;

  if (query.length > 0 && lowerText.includes(query)) score += 12;
  if (query.length > 0 && lowerPath.includes(query)) score += 4;

  for (const term of params.terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const textMatches = lowerText.match(new RegExp(`\\b${escaped}\\b`, "g"));
    const fuzzyMatches = lowerText.match(new RegExp(escaped, "g"));
    score += (textMatches?.length ?? 0) * 3;
    score += Math.min((fuzzyMatches?.length ?? 0), 8);
    score += lowerPath.includes(term) ? 2 : 0;
  }

  return score + (KIND_SCORE_BONUS[params.kind] ?? 0);
}

export async function searchKhalaCorpus(params: {
  paths: LearningPaths;
  query: string;
  limit: number;
  snippetLength: number;
  includeKinds?: KhalaCorpusKind[];
}): Promise<KhalaCorpusSearchResult[]> {
  const query = params.query.trim();
  if (!query) return [];
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const includeKinds = params.includeKinds
    ? new Set<KhalaCorpusKind>(params.includeKinds)
    : null;

  const files = await collectCandidateFiles(fixedCorpusFiles(params.paths), [
    params.paths.skillsDir,
    params.paths.workflowsDir,
    params.paths.promptsDir,
    params.paths.rulesDir,
  ]);

  const results: KhalaCorpusSearchResult[] = [];
  for (const file of files) {
    const text = await readSearchableFile(file);
    if (!text.trim()) continue;
    const kind = classifyCorpusPath(file, params.paths);
    if (includeKinds && !includeKinds.has(kind)) continue;
    const score = scoreMemoryText({
      query,
      terms,
      filePath: file,
      text,
      kind,
    });
    if (score <= 0) continue;
    results.push({
      path: path.relative(params.paths.root, file),
      kind,
      score: Number(score.toFixed(2)),
      title: path.basename(file),
      snippet: bestSnippet(text, terms, params.snippetLength),
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, params.limit);
}

export const searchKhalaMemory = searchKhalaCorpus;
