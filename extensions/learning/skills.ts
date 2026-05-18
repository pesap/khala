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

interface SkillPaths {
  dir: string;
  skillFile: string;
  metadataFile: string;
  referencesDir: string;
  templatesDir: string;
  scriptsDir: string;
}

function buildActiveSkillPaths(paths: LearningPaths, skillName: string): SkillPaths {
  const dir = path.join(paths.skillsDir, skillName);
  return {
    dir,
    skillFile: path.join(dir, "SKILL.md"),
    metadataFile: path.join(dir, "metadata.json"),
    referencesDir: path.join(dir, "references"),
    templatesDir: path.join(dir, "templates"),
    scriptsDir: path.join(dir, "scripts"),
  };
}

function buildArchivedSkillPaths(
  paths: LearningPaths,
  skillName: string,
): SkillPaths {
  const dir = path.join(paths.archivedSkillsDir, skillName);
  return {
    dir,
    skillFile: path.join(dir, "SKILL.md"),
    metadataFile: path.join(dir, "metadata.json"),
    referencesDir: path.join(dir, "references"),
    templatesDir: path.join(dir, "templates"),
    scriptsDir: path.join(dir, "scripts"),
  };
}

function parseMetadata(value: unknown): LearnedSkillMetadata | null {
  if (!isRecord(value)) return null;
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
    (provenance !== "user-authored" &&
      provenance !== "agent-authored" &&
      provenance !== "background-review-authored" &&
      provenance !== "imported") ||
    typeof createdAt !== "string" ||
    (lastUsedAt !== null && typeof lastUsedAt !== "string") ||
    (lastPatchedAt !== null && typeof lastPatchedAt !== "string") ||
    typeof useCount !== "number" ||
    typeof patchCount !== "number" ||
    (state !== "active" && state !== "stale" && state !== "archived") ||
    typeof pinned !== "boolean" ||
    (sourceRunId !== null && typeof sourceRunId !== "string")
  ) {
    return null;
  }

  return {
    name: name as string,
    provenance: provenance as LearnedSkillProvenance,
    createdAt: createdAt as string,
    lastUsedAt: lastUsedAt as string | null,
    lastPatchedAt: lastPatchedAt as string | null,
    useCount: useCount as number,
    patchCount: patchCount as number,
    state: state as LearnedSkillState,
    pinned: pinned as boolean,
    sourceRunId: sourceRunId as string | null,
  };
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
      const metadataFile = path.join(root, entry.name, "metadata.json");
      const skillFile = path.join(root, entry.name, "SKILL.md");
      const record = await readRecordFromPaths({
        dir: path.join(root, entry.name),
        skillFile,
        metadataFile,
        referencesDir: path.join(root, entry.name, "references"),
        templatesDir: path.join(root, entry.name, "templates"),
        scriptsDir: path.join(root, entry.name, "scripts"),
      });
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
  const record = await readLearnedSkillMetadata(params.paths, params.skillName);
  if (!record) return null;
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    lastUsedAt: params.nowIso,
    useCount: record.metadata.useCount + 1,
    state: record.metadata.state === "archived" ? "archived" : "active",
  };
  await writeLearnedSkillMetadata(record.metadataFile, metadata);
  return { ...record, metadata };
}

export async function markLearnedSkillPatched(params: {
  paths: LearningPaths;
  skillName: string;
  nowIso: string;
}): Promise<LearnedSkillRecord | null> {
  const record = await readLearnedSkillMetadata(params.paths, params.skillName);
  if (!record) return null;
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    lastPatchedAt: params.nowIso,
    patchCount: record.metadata.patchCount + 1,
    state: record.metadata.state === "archived" ? "archived" : "active",
  };
  await writeLearnedSkillMetadata(record.metadataFile, metadata);
  return { ...record, metadata };
}

export async function setLearnedSkillPinned(params: {
  paths: LearningPaths;
  skillName: string;
  pinned: boolean;
}): Promise<LearnedSkillRecord | null> {
  const record = await readLearnedSkillMetadata(params.paths, params.skillName);
  if (!record) return null;
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    pinned: params.pinned,
  };
  await writeLearnedSkillMetadata(record.metadataFile, metadata);
  return { ...record, metadata };
}

export async function setLearnedSkillState(params: {
  paths: LearningPaths;
  skillName: string;
  state: Exclude<LearnedSkillState, "archived">;
}): Promise<LearnedSkillRecord | null> {
  const record = await readLearnedSkillMetadata(params.paths, params.skillName);
  if (!record || record.metadata.state === "archived") return record;
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    state: params.state,
  };
  await writeLearnedSkillMetadata(record.metadataFile, metadata);
  return { ...record, metadata };
}

export async function archiveLearnedSkill(params: {
  paths: LearningPaths;
  skillName: string;
}): Promise<LearnedSkillRecord | null> {
  const activePaths = buildActiveSkillPaths(params.paths, params.skillName);
  const record = await readRecordFromPaths(activePaths);
  if (!record) return null;

  const archivedPaths = buildArchivedSkillPaths(params.paths, params.skillName);
  await moveDir(activePaths.dir, archivedPaths.dir);
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    state: "archived",
  };
  await writeLearnedSkillMetadata(archivedPaths.metadataFile, metadata);
  return {
    dir: archivedPaths.dir,
    skillFile: archivedPaths.skillFile,
    metadataFile: archivedPaths.metadataFile,
    metadata,
  };
}

export async function restoreLearnedSkill(params: {
  paths: LearningPaths;
  skillName: string;
}): Promise<LearnedSkillRecord | null> {
  const archivedPaths = buildArchivedSkillPaths(params.paths, params.skillName);
  const record = await readRecordFromPaths(archivedPaths);
  if (!record) return null;

  const activePaths = buildActiveSkillPaths(params.paths, params.skillName);
  await moveDir(archivedPaths.dir, activePaths.dir);
  const metadata: LearnedSkillMetadata = {
    ...record.metadata,
    state: "active",
  };
  await writeLearnedSkillMetadata(activePaths.metadataFile, metadata);
  return {
    dir: activePaths.dir,
    skillFile: activePaths.skillFile,
    metadataFile: activePaths.metadataFile,
    metadata,
  };
}
