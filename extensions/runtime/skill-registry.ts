export type SkillSourceKind =
  | "packaged"
  | "learned"
  | "plugin"
  | "user"
  | "repo-local"
  | "unknown";

export type SkillRegistryEventType =
  | "skill_routed"
  | "skill_loaded"
  | "skill_missing"
  | "skill_used_without_load";

export interface SkillMetadata {
  name: string;
  source: SkillSourceKind;
  path?: string;
}

export interface SkillRegistryEvent {
  type: SkillRegistryEventType;
  skill: SkillMetadata;
  reason: string;
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function classifySkillPath(skillPath: string): SkillSourceKind {
  const normalized = skillPath.replaceAll("\\", "/");
  if (normalized.includes("/plugins/cache/")) return "plugin";
  if (normalized.includes("/.pi/khala/skills/")) return "learned";
  if (normalized.includes("/.agents/skills/")) return "user";
  if (normalized.includes("/.codex/skills/")) return "user";
  if (normalized.includes("/node_modules/")) return "plugin";
  if (normalized.includes("/skills/")) return "packaged";
  if (normalized.startsWith("skills/")) return "repo-local";
  return "unknown";
}

export function buildSkillMetadata(params: {
  name: string;
  path?: string;
  source?: SkillSourceKind;
}): SkillMetadata {
  return {
    name: normalizeSkillName(params.name),
    source: params.source ?? (params.path ? classifySkillPath(params.path) : "unknown"),
    path: params.path,
  };
}

export function buildSkillRegistryEvent(params: {
  type: SkillRegistryEventType;
  name: string;
  reason: string;
  path?: string;
  source?: SkillSourceKind;
}): SkillRegistryEvent {
  return {
    type: params.type,
    skill: buildSkillMetadata({
      name: params.name,
      path: params.path,
      source: params.source,
    }),
    reason: params.reason,
  };
}

export function buildSkillUsedWithoutLoadEvents(params: {
  claimedSkills: readonly string[];
  loadedSkills?: readonly string[];
  reason: string;
}): SkillRegistryEvent[] {
  const loadedSkills = new Set((params.loadedSkills ?? []).map(normalizeSkillName));
  return [...new Set(params.claimedSkills.map(normalizeSkillName))]
    .filter((skill) => skill.length > 0)
    .filter((skill) => !loadedSkills.has(skill))
    .map((skill) =>
      buildSkillRegistryEvent({
        type: "skill_used_without_load",
        name: skill,
        reason: params.reason,
      }),
    );
}
