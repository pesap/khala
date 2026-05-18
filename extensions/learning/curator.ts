import { promises as fs } from "node:fs";
import { formatErrorMessage } from "../lib/io.ts";
import {
  listLearnedSkillRecords,
  setLearnedSkillState,
  type LearnedSkillRecord,
} from "./skills.ts";
import type { LearningPaths } from "./store.ts";

const STALE_DAYS = 30;
const RECENT_DAYS = 14;

function daysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return null;
  return Math.floor((nowMs - value) / 86_400_000);
}

function isRecent(iso: string | null, nowMs: number): boolean {
  const days = daysSince(iso, nowMs);
  return days !== null && days <= RECENT_DAYS;
}

function isStaleCandidate(record: LearnedSkillRecord, nowMs: number): boolean {
  if (record.metadata.state === "archived" || record.metadata.pinned) return false;
  if (
    record.metadata.provenance !== "agent-authored" &&
    record.metadata.provenance !== "background-review-authored"
  ) {
    return false;
  }
  const lastTouched =
    record.metadata.lastUsedAt ??
    record.metadata.lastPatchedAt ??
    record.metadata.createdAt;
  const days = daysSince(lastTouched, nowMs);
  return days !== null && days >= STALE_DAYS;
}

function renderSkill(record: LearnedSkillRecord): string {
  return `- ${record.metadata.name} (${record.metadata.provenance}, state=${record.metadata.state}, uses=${record.metadata.useCount}, patches=${record.metadata.patchCount}, pinned=${record.metadata.pinned ? "yes" : "no"})`;
}

export async function generateCuratorReport(params: {
  paths: LearningPaths;
  nowIso: string;
}): Promise<string> {
  const records = await listLearnedSkillRecords(params.paths);
  const nowMs = Date.parse(params.nowIso);
  const newlyCreated = records.filter((record) =>
    isRecent(record.metadata.createdAt, nowMs),
  );
  const recentlyPatched = records.filter((record) =>
    isRecent(record.metadata.lastPatchedAt, nowMs),
  );
  const staleCandidates = records.filter((record) =>
    isStaleCandidate(record, nowMs),
  );
  const archiveActions = records.filter(
    (record) => record.metadata.state === "archived",
  );
  const pinnedSkills = records.filter((record) => record.metadata.pinned);
  const consolidationSuggestions = staleCandidates
    .filter((record) => record.metadata.useCount <= 1)
    .map(
      (record) =>
        `- ${record.metadata.name} may be too narrow; prefer consolidating into an umbrella skill before more automation.`,
    );

  return [
    "# Skill Curator Report",
    "",
    `Generated: ${params.nowIso}`,
    "",
    "## Newly Created Skills",
    ...(newlyCreated.length > 0
      ? newlyCreated.map(renderSkill)
      : ["- none"]),
    "",
    "## Recently Patched Skills",
    ...(recentlyPatched.length > 0
      ? recentlyPatched.map(renderSkill)
      : ["- none"]),
    "",
    "## Stale Candidates",
    ...(staleCandidates.length > 0
      ? staleCandidates.map(renderSkill)
      : ["- none"]),
    "",
    "## Archive Actions",
    ...(archiveActions.length > 0
      ? archiveActions.map(renderSkill)
      : ["- none"]),
    "",
    "## Consolidation Suggestions",
    ...(consolidationSuggestions.length > 0
      ? consolidationSuggestions
      : ["- none"]),
    "",
    "## Pinned Skills",
    ...(pinnedSkills.length > 0 ? pinnedSkills.map(renderSkill) : ["- none"]),
    "",
  ].join("\n");
}

export async function refreshCuratorReport(params: {
  paths: LearningPaths;
  nowIso: string;
}): Promise<void> {
  const records = await listLearnedSkillRecords(params.paths);
  const nowMs = Date.parse(params.nowIso);
  for (const record of records) {
    if (record.metadata.state === "archived") continue;
    const nextState = isStaleCandidate(record, nowMs) ? "stale" : "active";
    if (record.metadata.state !== nextState) {
      await setLearnedSkillState({
        paths: params.paths,
        skillName: record.metadata.name,
        state: nextState,
      });
    }
  }

  const report = await generateCuratorReport(params);
  try {
    await fs.writeFile(params.paths.curatorReport, `${report}\n`, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to write curator report: ${formatErrorMessage(error)}`,
    );
  }
}
