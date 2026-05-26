import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, isRecord, readTextIfExists } from "../lib/io.ts";
import type { LearningPaths } from "./store.ts";

export type LearnedSkillProvenance =
  | "user-authored"
  | "agent-authored"
  | "background-review-authored"
  | "imported";

export type LearnedSkillState = "active" | "stale" | "archived";

export interface LearnedSkillMetadata {
  name: string;
  provenance: LearnedSkillProvenance;
  createdAt: string;
  lastUsedAt: string | null;
  lastPatchedAt: string | null;
  useCount: number;
  patchCount: number;
  state: LearnedSkillState;
  pinned: boolean;
  sourceRunId: string | null;
}

export interface LearnedSkillRecord {
  dir: string;
  skillFile: string;
  metadataFile: string;
  metadata: LearnedSkillMetadata;
}
const SKILL_PROVENANCE = new Set<LearnedSkillProvenance>([
  "user-authored",
  "agent-authored",
  "background-review-authored",
  "imported",
]);
const SKILL_STATE = new Set<LearnedSkillState>(["active", "stale", "archived"]);

interface SkillPaths {
  dir: string;
  skillFile: string;
  metadataFile: string;
  referencesDir: string;
  templatesDir: string;
  scriptsDir: string;
}

function buildSkillPaths(root: string, skillName: string): SkillPaths {
  const dir = path.join(root, skillName);
  return {
    dir,
    skillFile: path.join(dir, "SKILL.md"),
    metadataFile: path.join(dir, "metadata.json"),
    referencesDir: path.join(dir, "references"),
    templatesDir: path.join(dir, "templates"),
    scriptsDir: path.join(dir, "scripts"),
  };
}
function buildActiveSkillPaths(paths: LearningPaths, skillName: string): SkillPaths {
  return buildSkillPaths(paths.skillsDir, skillName);
}

function buildArchivedSkillPaths(paths: LearningPaths, skillName: string): SkillPaths {
  return buildSkillPaths(paths.archivedSkillsDir, skillName);
}

function parseMetadata(value: unknown): LearnedSkillMetadata | null {
  if (!isRecord(value)) return null;
  const isStringOrNull = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  const {
    name,
    provenance,
    createdAt,
    lastUsedAt,
    lastPatchedAt,
    useCount,
    patchCount,
    state,
    pinned,
    sourceRunId,
  } = value;

  if (
    typeof name !== "string" ||
    typeof provenance !== "string" ||
    !SKILL_PROVENANCE.has(provenance as LearnedSkillProvenance) ||
    typeof createdAt !== "string" ||
    !isStringOrNull(lastUsedAt) ||
    !isStringOrNull(lastPatchedAt) ||
    typeof useCount !== "number" ||
    typeof patchCount !== "number" ||
    typeof state !== "string" ||
    !SKILL_STATE.has(state as LearnedSkillState) ||
    typeof pinned !== "boolean" ||
    !isStringOrNull(sourceRunId)
  ) {
    return null;
  }

  return {
    name,
    provenance,
    createdAt,
    lastUsedAt,
    lastPatchedAt,
    useCount,
    patchCount,
    state,
    pinned,
    sourceRunId,
  } as LearnedSkillMetadata;
}

async function writeLearnedSkillMetadata(
  metadataFile: string,
  metadata: LearnedSkillMetadata,
): Promise<void> {
  await fs.writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readRecordFromPaths(skillPaths: SkillPaths): Promise<LearnedSkillRecord | null> {
  if (!(await exists(skillPaths.metadataFile))) return null;
  const raw = await readTextIfExists(skillPaths.metadataFile);
  if (!raw.trim()) return null;

  try {
    const metadata = parseMetadata(JSON.parse(raw));
    if (!metadata) return null;
    return {
      dir: skillPaths.dir,
      skillFile: skillPaths.skillFile,
      metadataFile: skillPaths.metadataFile,
      metadata,
    };
  } catch {
    return null;
  }
}

async function moveDir(fromDir: string, toDir: string): Promise<void> {
  await fs.mkdir(path.dirname(toDir), { recursive: true });
  await fs.rm(toDir, { recursive: true, force: true });
  await fs.rename(fromDir, toDir);
}
async function updateLearnedSkillMetadata(
  record: LearnedSkillRecord,
  update: (metadata: LearnedSkillMetadata) => LearnedSkillMetadata,
): Promise<LearnedSkillRecord> {
  const metadata = update(record.metadata);
  await writeLearnedSkillMetadata(record.metadataFile, metadata);
  return { ...record, metadata };
}

async function updateSkillByName(params: {
  paths: LearningPaths;
  skillName: string;
  update: (metadata: LearnedSkillMetadata) => LearnedSkillMetadata;
  skipArchived?: boolean;
}): Promise<LearnedSkillRecord | null> {
  const record = await readLearnedSkillMetadata(params.paths, params.skillName);
  if (!record) return null;
  if (params.skipArchived && record.metadata.state === "archived") return record;
  return updateLearnedSkillMetadata(record, params.update);
}
async function transitionSkillDir(params: {
  from: SkillPaths;
  to: SkillPaths;
  nextState: LearnedSkillState;
}): Promise<LearnedSkillRecord | null> {
  const record = await readRecordFromPaths(params.from);
  if (!record) return null;
  await moveDir(params.from.dir, params.to.dir);
  const metadata: LearnedSkillMetadata = { ...record.metadata, state: params.nextState };
  await writeLearnedSkillMetadata(params.to.metadataFile, metadata);
  return {
    dir: params.to.dir,
    skillFile: params.to.skillFile,
    metadataFile: params.to.metadataFile,
    metadata,
  };
}

export async function ensureLearnedSkillLayout(params: {
  paths: LearningPaths;
  skillName: string;
  nowIso: string;
  provenance: LearnedSkillProvenance;
  sourceRunId?: string | null;
}): Promise<LearnedSkillRecord> {
  const skillPaths = buildActiveSkillPaths(params.paths, params.skillName);
  await fs.mkdir(skillPaths.dir, { recursive: true });
  await Promise.all([
    fs.mkdir(skillPaths.referencesDir, { recursive: true }),
    fs.mkdir(skillPaths.templatesDir, { recursive: true }),
    fs.mkdir(skillPaths.scriptsDir, { recursive: true }),
  ]);

  const existing = await readRecordFromPaths(skillPaths);
  const metadata: LearnedSkillMetadata =
    existing?.metadata ?? {
      name: params.skillName,
      provenance: params.provenance,
      createdAt: params.nowIso,
      lastUsedAt: null,
      lastPatchedAt: null,
      useCount: 0,
      patchCount: 0,
      state: "active",
      pinned: false,
      sourceRunId: params.sourceRunId ?? null,
    };

  await writeLearnedSkillMetadata(skillPaths.metadataFile, metadata);
  return {
    dir: skillPaths.dir,
    skillFile: skillPaths.skillFile,
    metadataFile: skillPaths.metadataFile,
    metadata,
  };
}

export async function readLearnedSkillMetadata(
  paths: LearningPaths,
  skillName: string,
): Promise<LearnedSkillRecord | null> {
  return (
    (await readRecordFromPaths(buildActiveSkillPaths(paths, skillName))) ??
    (await readRecordFromPaths(buildArchivedSkillPaths(paths, skillName)))
  );
}

export async function listLearnedSkillRecords(
  paths: LearningPaths,
): Promise<LearnedSkillRecord[]> {
  const roots = [paths.skillsDir, paths.archivedSkillsDir];
  const records: LearnedSkillRecord[] = [];

  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readRecordFromPaths(buildSkillPaths(root, entry.name));
      if (record) records.push(record);
    }
  }

  return records.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

export async function touchLearnedSkillUsage(params: {
  paths: LearningPaths;
  skillName: string;
  nowIso: string;
}): Promise<LearnedSkillRecord | null> {
  return updateSkillByName({
    paths: params.paths,
    skillName: params.skillName,
    update: (metadata) => ({
    ...metadata,
    lastUsedAt: params.nowIso,
    useCount: metadata.useCount + 1,
    state: metadata.state === "archived" ? "archived" : "active",
    }),
  });
}

export async function markLearnedSkillPatched(params: {
  paths: LearningPaths;
  skillName: string;
  nowIso: string;
}): Promise<LearnedSkillRecord | null> {
  return updateSkillByName({
    paths: params.paths,
    skillName: params.skillName,
    update: (metadata) => ({
    ...metadata,
    lastPatchedAt: params.nowIso,
    patchCount: metadata.patchCount + 1,
    state: metadata.state === "archived" ? "archived" : "active",
    }),
  });
}

export async function setLearnedSkillPinned(params: {
  paths: LearningPaths;
  skillName: string;
  pinned: boolean;
}): Promise<LearnedSkillRecord | null> {
  return updateSkillByName({
    paths: params.paths,
    skillName: params.skillName,
    update: (metadata) => ({ ...metadata, pinned: params.pinned }),
  });
}

export async function setLearnedSkillState(params: {
  paths: LearningPaths;
  skillName: string;
  state: Exclude<LearnedSkillState, "archived">;
}): Promise<LearnedSkillRecord | null> {
  return updateSkillByName({
    paths: params.paths,
    skillName: params.skillName,
    skipArchived: true,
    update: (metadata) => ({ ...metadata, state: params.state }),
  });
}

export async function archiveLearnedSkill(params: {
  paths: LearningPaths;
  skillName: string;
}): Promise<LearnedSkillRecord | null> {
  return transitionSkillDir({
    from: buildActiveSkillPaths(params.paths, params.skillName),
    to: buildArchivedSkillPaths(params.paths, params.skillName),
    nextState: "archived",
  });
}

export async function restoreLearnedSkill(params: {
  paths: LearningPaths;
  skillName: string;
}): Promise<LearnedSkillRecord | null> {
  return transitionSkillDir({
    from: buildArchivedSkillPaths(params.paths, params.skillName),
    to: buildActiveSkillPaths(params.paths, params.skillName),
    nextState: "active",
  });
}
