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
  attemptedSources?: SkillSourceKind[];
}

const ASSISTANT_SKILL_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:used|applied|followed|loaded|read|invoked)\s+(?:the\s+|your\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+skill(?:\s+guidance)?\b|\b(?:using|following|applying|followed|applied)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+skill(?:\s+guidance)?\b/gi;
const ASSISTANT_SKILLS_LIST_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:used|applied|followed|loaded|read|invoked)\s+(?:the\s+|your\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}(?:\s*(?:,|and)\s*[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})+)\s+skills(?:\s+guidance)?\b|\b(?:using|following|applying|followed|applied)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}(?:\s*(?:,|and)\s*[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})+)\s+skills(?:\s+guidance)?\b/gi;
const ASSISTANT_SKILL_GUIDANCE_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:used|applied|followed)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+(?:guidance|best practices?)\b|\b(?:using|following|applying|followed|applied)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+(?:guidance|best practices?)\b/gi;
const ASSISTANT_SKILL_GUIDANCE_LIST_CLAIM_REGEX =
  /\b(?:i|we)\s+(?:used|applied|followed)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}(?:\s*(?:,|and)\s*(?!(?:used|applied|followed|loaded|read|invoked)\b)[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})+)\s+(?:guidance|best practices?)\b|\b(?:using|following|applying|followed|applied)\s+(?:the\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}(?:\s*(?:,|and)\s*(?!(?:used|applied|followed|loaded|read|invoked)\b)[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})+)\s+(?:guidance|best practices?)\b/gi;
const ASSISTANT_CHAINED_NAMED_SKILL_REGEX =
  /(?:,|\band\b)\s+(?:the\s+|your\s+)?(?!(?:used|applied|followed|loaded|read|invoked)\b)([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+skill\b/gi;
const EXPLICIT_SKILL_REQUEST_REGEX =
  /(?:\b(?:load|use|read|apply|follow|invoke)\s+(?:(?:the|your)\s+)?(?:[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}\s+)?skills?\b|\/skill:[a-z0-9_.:-]+|\$[A-Z][A-Za-z0-9_.:-]+|skills\/[a-z0-9_.:-]+\/SKILL\.md)/i;
const EXPLICIT_NAMED_SKILL_REGEX =
  /\b(?:load|use|read|apply|follow|invoke)\s+(?:the\s+|your\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+skill\b/gi;
const EXPLICIT_NAMED_SKILLS_LIST_REGEX =
  /\b(?:load|use|read|apply|follow|invoke)\s+(?:the\s+|your\s+)?([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,8}(?:\s*(?:,|and)\s*[a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})+)\s+skills\b/gi;
const CHAINED_NAMED_SKILL_REGEX =
  /(?:,|\band\b)\s+(?:the\s+|your\s+)?(?!(?:used|applied|followed|loaded|read|invoked)\b)([a-z0-9_.:-]+(?:\s+[a-z0-9_.:-]+){0,2})\s+skill\b/gi;
const SLASH_SKILL_REGEX = /\/skill:([a-z0-9_.:-]+)/gi;
const DOLLAR_SKILL_REGEX = /\$([A-Z][A-Za-z0-9_.:-]+)/g;
const SKILL_READ_PATH_REGEX =
  /(?:^|[\s"'/])(?:skills(?:\/\.system)?|\.agents\/skills|\.codex\/skills|\.pi\/khala\/skills)\/[^/"']+\/SKILL\.md(?=$|[\s"',}\]]|\.(?:$|[\s"',}\]]))/i;
const SKILL_NAME_PATH_REGEX =
  /(?:^|[\s"'/])(?:skills(?:\/\.system)?|\.agents\/skills|\.codex\/skills|\.pi\/khala\/skills)\/([^/"']+)\/SKILL\.md(?=$|[\s"',}\]]|\.(?:$|[\s"',}\]]))/i;
const SKILL_NAME_PATH_GLOBAL_REGEX =
  /(?:^|[\s"'/])(?:skills(?:\/\.system)?|\.agents\/skills|\.codex\/skills|\.pi\/khala\/skills)\/([^/"']+)\/SKILL\.md(?=$|[\s"',}\]]|\.(?:$|[\s"',}\]]))/gi;
const GENERIC_SKILL_NAME_TERMS = new Set([
  "a",
  "an",
  "appropriate",
  "best",
  "few",
  "needed",
  "relevant",
  "right",
  "several",
  "some",
]);
const SKILL_FRONTMATTER_NAME_REGEX =
  /^name\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\n]+))/m;
const PROACTIVE_SKILL_ROUTES: Array<{
  skills: string[];
  pattern: RegExp;
}> = [
  {
    skills: ["design-quality-review"],
    pattern:
      /\b(?:review|code review|pr review|pull request review|inspect changes|review changes)\b/i,
  },
  {
    skills: ["debug-investigation"],
    pattern:
      /\b(?:debug|diagnose|root cause|failing test|test failure|failing(?:\s+[a-z0-9_-]+){0,5}\s+(?:checks?|ci|workflow)|check failure|ci failure|failing ci|failing workflow|workflow failure|not working|investigate failure)\b/i,
  },
  {
    skills: ["tdd-core"],
    pattern: /\b(?:tdd|test[- ]driven|red[- ]green[- ]refactor)\b/i,
  },
  {
    skills: ["skill-creator"],
    pattern:
      /\b(?:create|write|build|update|improve|refine)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:agent\s+)?skill\b(?!\s+routing)/i,
  },
  {
    skills: ["security-audit"],
    pattern:
      /\b(?:security audit|audit security|vulnerabilit(?:y|ies)|threat model|secrets? exposure)\b/i,
  },
  {
    skills: ["docs-authoring"],
    pattern:
      /\b(?:write|draft|update|improve|author)\s+(?:the\s+)?(?:docs?|documentation|readme|adr)\b/i,
  },
  {
    skills: ["academic-review"],
    pattern:
      /\b(?:first principles|feynman|explain simply|simple explanation|challenge this approach|be more skeptical|reviewer2|reviewer 2|decomplexify (?:this )?(?:paper|concept|approach)|academic paper)\b/i,
  },
  {
    skills: ["design-quality-review"],
    pattern:
      /\b(?:dependency|dependencies|import graph|module boundaries|coupling|circular imports?|circular dependencies|dependency cycles?|layering)\b/i,
  },
  {
    skills: ["data-model"],
    pattern:
      /\b(?:data model|data contract|typed config|schema evolution|serialization shape|loose dict|pydantic|dataclass|field constraints?|validators?|payload filtering|validated contracts?)\b/i,
  },
  {
    skills: ["openai-docs"],
    pattern:
      /\b(?:openai|chatgpt|responses api|assistants api|openai api|gpt[- ]?[45]|structured outputs?|function calling|tool calling|prompt caching)\b/i,
  },
  {
    skills: ["good-api"],
    pattern:
      /\b(?:api design|developer-facing api|sdk design|api ergonomics|ergonomic api|beginner-friendly api|enterprise-ready api|learning ladder|composable api|awkward api|api review)\b/i,
  },
  {
    skills: ["design-quality-review"],
    pattern:
      /\b(?:dead code|unused code|unused exports?|unused files?|unused dependencies|remove unused|delete unused|prune exports?|knip|vulture|ruff-unused|legacy paths?)\b/i,
  },
  {
    skills: ["design-quality-review"],
    pattern:
      /\b(?:type safety|type hardening|tighten (?:the )?(?:[a-z0-9_-]+\s+){0,3}types?|remove any|unsafe casts?|implicit any|static analysis|type drift|contract ambiguity)\b/i,
  },
  {
    skills: ["public-api-guard"],
    pattern:
      /\b(?:public api|api compatibility|breaking change|non[- ]breaking|exported interfaces?|cli contracts?|schema contracts?|compatibility diff)\b/i,
  },
  {
    skills: ["feature-delivery"],
    pattern:
      /\b(?:new feature|add (?:a )?feature|feature delivery|scoped enhancement|end[- ]to[- ]end delivery|acceptance criteria)\b/i,
  },
  {
    skills: ["github"],
    pattern:
      /\b(?:github|github actions?|actions? workflow|pull request|\bpr\b|pr comments?|review comments?|issues?|copilot comments?)\b/i,
  },
  {
    skills: ["commit"],
    pattern:
      /\b(?:(?:create|make|write|prepare|draft)\s+(?:a\s+|an\s+)?(?:local\s+|signed\s+)?commit|commit\s+(?:(?:these|those|the|my)\s+)?(?:(?:current|selected|staged)\s+)?(?:changes|files|fix|work))\b/i,
  },
  {
    skills: ["rust-developer"],
    pattern:
      /\b(?:rust|cargo|clippy|rustfmt|crate::|\.rs\b|unsafe block|panic-prone|unwrap\(|expect\()\b/i,
  },
  {
    skills: ["python-developer"],
    pattern:
      /\b(?:python|pytest|pyproject\.toml|requirements\.txt|uv\b|\.py\b)\b/i,
  },
  {
    skills: ["testing-pytest"],
    pattern:
      /\b(?:pytest|pytests|conftest\.py|pytest fixture|pytest fixtures|parametrize|hypothesis|flaky pytest|pytest coverage)\b/i,
  },
  {
    skills: ["uv"],
    pattern:
      /\b(?:uv run|uv add|uv lock|uv init|pip install|venv|virtualenv|python script\.py|script dependencies|standalone python script)\b/i,
  },
  {
    skills: ["infrasys"],
    pattern:
      /\b(?:infrasys|system component|system components|component graph|supplemental attributes?|cost curves?|fuel curves?|time series (?:on|for) components?|system serialization|system deserialization|schema migration hooks?|power system model|grid model)\b/i,
  },
  {
    skills: ["typescript"],
    pattern:
      /\b(?:typescript|tsconfig|\.tsx?\b|node --test|npm test|npm run)\b/i,
  },
  {
    skills: ["bash-script"],
    pattern:
      /\b(?:bash script|shell script|\.sh\b|shellcheck|set -euo pipefail|bash pitfalls?|strict mode|cleanup traps?|idempotent setup script)\b/i,
  },
  {
    skills: ["cli-ux"],
    pattern:
      /\b(?:cli ux|command[- ]line interface|command tree|subcommands?|help text|exit codes?|stdout|stderr|structured output|--json|no_color|no-color|shell completions?)\b/i,
  },
  {
    skills: ["design-quality-review"],
    pattern:
      /\b(?:simplify|refactor|decomplexify|clean up|cleanup|reduce complexity|design-quality-review)\b/i,
  },
];

export interface SkillPathClassificationContext {
  repoRoot?: string;
  packageRoot?: string;
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function normalizedClaimedSkillName(skill: string | undefined): string {
  const normalized = normalizeSkillName(skill ?? "");
  return GENERIC_SKILL_NAME_TERMS.has(normalized) ? "" : normalized;
}

function normalizedClaimedSkillList(skills: string | undefined): string[] {
  return (
    skills
      ?.split(/\s*(?:,|\band\b)\s*/i)
      .map((skill) => normalizedClaimedSkillName(skill))
      .filter(Boolean) ?? []
  );
}

export function assistantClaimedSkillNames(assistantText: string): string[] {
  const skills = new Set<string>();
  for (const match of assistantText.matchAll(ASSISTANT_SKILLS_LIST_CLAIM_REGEX)) {
    for (const skill of normalizedClaimedSkillList(match[1] ?? match[2])) {
      skills.add(skill);
    }
  }
  for (const match of assistantText.matchAll(
    ASSISTANT_SKILL_GUIDANCE_LIST_CLAIM_REGEX,
  )) {
    for (const skill of normalizedClaimedSkillList(match[1] ?? match[2])) {
      skills.add(skill);
    }
  }
  for (const match of assistantText.matchAll(ASSISTANT_SKILL_CLAIM_REGEX)) {
    const skill = normalizedClaimedSkillName(match[1] ?? match[2]);
    if (skill) skills.add(skill);
  }
  for (const match of assistantText.matchAll(
    ASSISTANT_SKILL_GUIDANCE_CLAIM_REGEX,
  )) {
    const skill = normalizedClaimedSkillName(
      (match[1] ?? match[2])?.replace(/\s+skills?$/i, ""),
    );
    if (skill) skills.add(skill);
  }
  if (skills.size > 0) {
    for (const match of assistantText.matchAll(ASSISTANT_CHAINED_NAMED_SKILL_REGEX)) {
      const skill = normalizedClaimedSkillName(match[1]);
      if (skill) skills.add(skill);
    }
  }
  return [...skills];
}

export function skillNeedReason(userText: string): string | null {
  return EXPLICIT_SKILL_REQUEST_REGEX.test(userText)
    ? "user explicitly requested a skill"
    : null;
}

export function explicitSkillNamesForUserText(userText: string): string[] {
  const skills = new Set<string>();
  for (const match of userText.matchAll(EXPLICIT_NAMED_SKILLS_LIST_REGEX)) {
    for (const skill of normalizedExplicitSkillList(match[1])) {
      skills.add(skill.toLowerCase());
    }
  }
  for (const match of userText.matchAll(EXPLICIT_NAMED_SKILL_REGEX)) {
    const skill = normalizedExplicitSkillName(match[1]);
    if (skill) skills.add(skill.toLowerCase());
  }
  if (skills.size > 0 || skillNeedReason(userText)) {
    for (const match of userText.matchAll(CHAINED_NAMED_SKILL_REGEX)) {
      const skill = normalizedExplicitSkillName(match[1]);
      if (skill) skills.add(skill.toLowerCase());
    }
  }
  for (const match of userText.matchAll(SLASH_SKILL_REGEX)) {
    const skill = match[1]?.trim();
    if (skill) skills.add(skill.toLowerCase());
  }
  for (const match of userText.matchAll(DOLLAR_SKILL_REGEX)) {
    const skill = match[1]?.trim();
    if (skill) skills.add(skill.toLowerCase());
  }
  for (const match of userText.matchAll(SKILL_NAME_PATH_GLOBAL_REGEX)) {
    const skill = match[1]?.trim();
    if (skill) skills.add(skill.toLowerCase());
  }
  return [...skills];
}

export function recommendedSkillsForUserText(userText: string): string[] {
  const text = userText.trim();
  if (!text) return [];

  const skills = new Set<string>();
  for (const route of PROACTIVE_SKILL_ROUTES) {
    if (!route.pattern.test(text)) continue;
    for (const skill of route.skills) skills.add(skill);
  }
  return [...skills];
}

export function isSkillReadPath(skillPath: string): boolean {
  return skillMetadataFromSkillReadPath(skillPath) !== null;
}

export function skillNameFromSkillReadPath(skillPath: string): string | null {
  return skillMetadataFromSkillReadPath(skillPath)?.name ?? null;
}

export function skillMetadataFromSkillReadPath(
  skillPath: string,
  context: SkillPathClassificationContext = {},
): SkillMetadata | null {
  const normalizedPath = skillPath.replaceAll("\\", "/");
  if (!SKILL_READ_PATH_REGEX.test(normalizedPath)) return null;
  const match = normalizedPath.match(SKILL_NAME_PATH_REGEX);
  const skillName = match?.[1];
  return skillName
    ? buildSkillMetadata({
        name: skillName,
        path: normalizedPath,
        repoRoot: context.repoRoot,
        packageRoot: context.packageRoot,
      })
    : null;
}

function normalizedExplicitSkillList(skills: string | undefined): string[] {
  return (
    skills
      ?.split(/\s*(?:,|\band\b)\s*/i)
      .map((skill) => normalizedExplicitSkillName(skill))
      .filter(Boolean) ?? []
  );
}

function normalizedExplicitSkillName(skill: string | undefined): string {
  const normalized = normalizeSkillName(skill ?? "");
  return GENERIC_SKILL_NAME_TERMS.has(normalized) ? "" : normalized;
}

function normalizePathPrefix(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function pathIsWithin(normalizedPath: string, normalizedPrefix: string): boolean {
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function classifySkillPath(
  skillPath: string,
  context: SkillPathClassificationContext = {},
): SkillSourceKind {
  const normalized = skillPath.replaceAll("\\", "/");
  if (context.packageRoot) {
    const packageRoot = normalizePathPrefix(context.packageRoot);
    if (pathIsWithin(normalized, packageRoot)) return "packaged";
  }
  if (context.repoRoot) {
    const repoSkillsRoot = `${normalizePathPrefix(context.repoRoot)}/skills`;
    if (pathIsWithin(normalized, repoSkillsRoot)) return "repo-local";
  }
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
  repoRoot?: string;
  packageRoot?: string;
}): SkillMetadata {
  return {
    name: normalizeSkillName(params.name),
    source:
      params.source ??
      (params.path
        ? classifySkillPath(params.path, {
            repoRoot: params.repoRoot,
            packageRoot: params.packageRoot,
          })
        : "unknown"),
    path: params.path,
  };
}

export function buildSkillMetadataFromMarkdown(params: {
  name: string;
  markdown: string;
  path?: string;
  source?: SkillSourceKind;
  repoRoot?: string;
  packageRoot?: string;
}): SkillMetadata {
  const frontmatterMatch = params.markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return buildSkillMetadata(params);
  }

  const nameMatch = frontmatterMatch[1].match(SKILL_FRONTMATTER_NAME_REGEX);
  const frontmatterName = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3])
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return buildSkillMetadata({
    ...params,
    name: frontmatterName || params.name,
  });
}

export function normalizeSkillMetadata(skill: SkillMetadata): SkillMetadata {
  const path = typeof skill.path === "string" ? skill.path : undefined;
  const source = isSkillSourceKind(skill.source)
    ? skill.source
    : path
      ? classifySkillPath(path)
      : "unknown";
  return {
    name: normalizeSkillName(skill.name),
    source,
    path,
  };
}

export function isSkillSourceKind(value: unknown): value is SkillSourceKind {
  return (
    value === "packaged" ||
    value === "learned" ||
    value === "plugin" ||
    value === "user" ||
    value === "repo-local" ||
    value === "unknown"
  );
}

export function normalizeAttemptedSkillSources(value: unknown): SkillSourceKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isSkillSourceKind))].filter(
    (source) => source !== "unknown",
  );
}

export function indexSkillMetadata(
  skills: readonly SkillMetadata[],
): Map<string, SkillMetadata> {
  const index = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    const normalized = normalizeSkillMetadata(skill);
    const name = normalized.name;
    if (!name || index.has(name)) continue;
    index.set(name, normalized);
  }
  return index;
}

export function buildSkillRegistryEvent(params: {
  type: SkillRegistryEventType;
  name: string;
  reason: string;
  path?: string;
  source?: SkillSourceKind;
  repoRoot?: string;
  packageRoot?: string;
  attemptedSources?: readonly SkillSourceKind[];
}): SkillRegistryEvent {
  const attemptedSources = normalizeAttemptedSkillSources(params.attemptedSources);
  return {
    type: params.type,
    skill: buildSkillMetadata({
      name: params.name,
      path: params.path,
      source: params.source,
      repoRoot: params.repoRoot,
      packageRoot: params.packageRoot,
    }),
    reason: params.reason,
    ...(attemptedSources.length > 0 ? { attemptedSources } : {}),
  };
}

export function buildSkillUsedWithoutLoadEvents(params: {
  claimedSkills: readonly string[];
  loadedSkills?: readonly (string | SkillMetadata)[];
  knownSkills?: readonly SkillMetadata[];
  reason: string;
}): SkillRegistryEvent[] {
  const loadedSkills = new Set(
    (params.loadedSkills ?? []).map((skill) =>
      typeof skill === "string"
        ? normalizeSkillName(skill)
        : normalizeSkillMetadata(skill).name,
    ),
  );
  const knownSkills = indexSkillMetadata(params.knownSkills ?? []);
  return [...new Set(params.claimedSkills.map(normalizeSkillName))]
    .filter((skill) => skill.length > 0)
    .filter((skill) => !loadedSkills.has(skill))
    .map((skill) => {
      const metadata = knownSkills.get(skill);
      return metadata
        ? {
            type: "skill_used_without_load" as const,
            skill: metadata,
            reason: params.reason,
          }
        : buildSkillRegistryEvent({
            type: "skill_used_without_load",
            name: skill,
            reason: params.reason,
          });
    });
}
