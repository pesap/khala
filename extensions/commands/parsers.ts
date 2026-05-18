import { existsSync } from "node:fs";
import path from "node:path";
import { RISK_APPROVAL_TTL_MINUTES } from "../lib/constants.ts";
import { removeFlag } from "../lib/flags.ts";
import { normalizeWhitespace } from "../lib/text.ts";
import type {
  PolicyMode,
  PostflightRecord,
  PreflightRecord,
} from "../policy/first-principles.ts";

export type WorkflowFlagValue = string | number | boolean | null | string[];
export type WorkflowFlags = Record<string, WorkflowFlagValue>;

export type ParsedReviewArgs =
  | { mode: "uncommitted"; extraInstruction?: string }
  | { mode: "branch"; branch: string; extraInstruction?: string }
  | { mode: "commit"; commit: string; extraInstruction?: string }
  | { mode: "pr"; pr: string; extraInstruction?: string }
  | { mode: "folder"; paths: string[]; extraInstruction?: string };

export type ParsedReviewArgsResult = ParsedReviewArgs | { error: string };

export interface ScopedTarget {
  summary: string;
  instruction: string;
  flags: WorkflowFlags;
}

export interface ParseRecordResult<T> {
  record?: T;
  error?: string;
}

export type CompliancePreset = "status" | "reset" | PolicyMode;

const COMPLIANCE_PRESET_ALIASES: Record<string, CompliancePreset> = {
  status: "status",
  strict: "enforce",
  enforce: "enforce",
  warn: "warn",
  warning: "warn",
  monitor: "monitor",
  reset: "reset",
  default: "reset",
  defaults: "reset",
};

export function parseComplianceArgs(args: string): {
  preset: CompliancePreset;
  error?: string;
} {
  const value = normalizeWhitespace(args).toLowerCase();
  if (!value) {
    return { preset: "status" };
  }

  const preset = COMPLIANCE_PRESET_ALIASES[value];
  if (preset) {
    return { preset };
  }

  return {
    preset: "status",
    error: "Usage: /khala [status|strict|enforce|warn|monitor|reset]",
  };
}

export function parseApproveRiskArgs(args: string): {
  reason: string;
  ttlMinutes: number;
  error?: string;
} {
  let rest = normalizeWhitespace(args);
  const ttlResult = removeFlag(rest, /(^|\s)--ttl\s+(\d+)(\s|$)/);
  rest = ttlResult.value;

  const ttlCandidate = Number(
    ttlResult.match?.[2] ?? RISK_APPROVAL_TTL_MINUTES,
  );
  const ttlMinutes = Number.isFinite(ttlCandidate)
    ? Math.max(1, Math.min(120, Math.floor(ttlCandidate)))
    : RISK_APPROVAL_TTL_MINUTES;
  if (!rest) {
    return {
      reason: "",
      ttlMinutes,
      error: "Usage: /approve-risk <checker approval reason> [--ttl MINUTES]",
    };
  }

  return {
    reason: rest,
    ttlMinutes,
  };
}

export function parsePreflightArgs(
  args: string,
  parsePreflightLine: (line: string) => PreflightRecord | null,
): ParseRecordResult<PreflightRecord> {
  const candidate = args.trim();
  if (!candidate) {
    return {
      error:
        'Usage: /preflight Preflight: skill=<name|none> reason="<short>" clarify=<yes|no>',
    };
  }

  const parsed = parsePreflightLine(candidate);
  if (!parsed) {
    return {
      error:
        'Invalid preflight. Expected: Preflight: skill=<name|none> reason="<short>" clarify=<yes|no>',
    };
  }

  return { record: parsed };
}

export function parsePostflightArgs(
  args: string,
  parsePostflightLine: (line: string) => PostflightRecord | null,
): ParseRecordResult<PostflightRecord> {
  const candidate = args.trim();
  if (!candidate) {
    return {
      error:
        'Usage: /postflight Postflight: verify="<command_or_check>" result=<pass|fail|not-run>',
    };
  }

  const parsed = parsePostflightLine(candidate);
  if (!parsed) {
    return {
      error:
        'Invalid postflight. Expected: Postflight: verify="<command_or_check>" result=<pass|fail|not-run>',
    };
  }

  return { record: parsed };
}

export function parseDebugArgs(args: string): {
  problem: string;
  fix: boolean;
} {
  let rest = normalizeWhitespace(args);
  const fix = /(^|\s)--fix(\s|$)/.test(rest);
  rest = normalizeWhitespace(rest.replace(/(^|\s)--fix(\s|$)/g, " "));
  rest = removeFlag(rest, /(^|\s)--parallel\s+\d+(\s|$)/).value;

  return {
    problem: rest,
    fix,
  };
}

export function parseFeatureArgs(args: string): {
  request: string;
  ship: boolean;
} {
  let rest = normalizeWhitespace(args);
  const ship = /(^|\s)--ship(\s|$)/.test(rest);
  rest = normalizeWhitespace(rest.replace(/(^|\s)--ship(\s|$)/g, " "));
  rest = removeFlag(rest, /(^|\s)--parallel\s+\d+(\s|$)/).value;

  return {
    request: rest,
    ship,
  };
}

export function parsePlanArgs(args: string): { plan: string } {
  return { plan: normalizeWhitespace(args) };
}

export function parseTriageIssueArgs(args: string): { problem: string } {
  return { problem: normalizeWhitespace(args) };
}

export function parseTddArgs(args: string): { goal: string; language: string } {
  let rest = normalizeWhitespace(args);

  const languageResult = removeFlag(rest, /(^|\s)--lang\s+(\S+)(\s|$)/);
  rest = languageResult.value;
  const language = normalizeWhitespace(
    languageResult.match?.[2] ?? "auto",
  ).toLowerCase();

  return {
    goal: rest,
    language: language || "auto",
  };
}

export function parseAddressOpenIssuesArgs(args: string): {
  limit: number;
  repo: string;
} {
  let rest = normalizeWhitespace(args);

  const limitResult = removeFlag(rest, /(^|\s)--limit\s+(\d+)(\s|$)/);
  rest = limitResult.value;
  const limitRaw = Number(limitResult.match?.[2] ?? 20);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;

  const repoResult = removeFlag(rest, /(^|\s)--repo\s+(\S+)(\s|$)/);
  const repo = normalizeWhitespace(repoResult.match?.[2] ?? "");

  return { limit, repo };
}

export function parseLearnSkillArgs(args: string): {
  topic: string;
  fromFile?: string;
  fromUrl?: string;
  dryRun: boolean;
} {
  let rest = normalizeWhitespace(args);
  const dryRun = /(^|\s)--dry-run(\s|$)/.test(rest);
  rest = normalizeWhitespace(rest.replace(/(^|\s)--dry-run(\s|$)/g, " "));

  const fromFileResult = removeFlag(rest, /(^|\s)--from-file\s+(\S+)(\s|$)/);
  rest = fromFileResult.value;
  let fromFile = fromFileResult.match?.[2];
  const fromUrlResult = removeFlag(rest, /(^|\s)--from-url\s+(\S+)(\s|$)/);
  rest = fromUrlResult.value;
  let fromUrl = fromUrlResult.match?.[2];

  const fromResult = removeFlag(rest, /(^|\s)--from\s+(\S+)(\s|$)/);
  rest = fromResult.value;
  const from = fromResult.match?.[2];

  if (from && !fromFile && !fromUrl) {
    if (/^(?:https?:\/\/|ssh:\/\/|file:\/\/|git@)/.test(from)) {
      fromUrl = from;
    } else {
      fromFile = from;
    }
  }
  return {
    topic: rest,
    fromFile,
    fromUrl,
    dryRun,
  };
}

export function parseKhalaMemorySetupArgs(args: string): {
  scope: "project" | "global";
  error?: string;
} {
  const scope = normalizeWhitespace(args).toLowerCase();
  if (!scope) {
    return { scope: "project" };
  }

  if (scope === "project" || scope === "global") {
    return { scope };
  }

  return {
    scope: "project",
    error: "Usage: /khala-memory-setup [project|global]",
  };
}

export function parseKhalaMemoryRestartArgs(args: string): {
  scope: "project" | "global";
  error?: string;
} {
  const scope = normalizeWhitespace(args).toLowerCase();
  if (!scope) {
    return { scope: "project" };
  }

  if (scope === "project" || scope === "global") {
    return { scope };
  }

  return {
    scope: "project",
    error: "Usage: /khala-memory-restart [project|global]",
  };
}

export function parseKhalaMemoryRemoveArgs(args: string): {
  scope: "project" | "global";
  error?: string;
} {
  const scope = normalizeWhitespace(args).toLowerCase();
  if (!scope) {
    return { scope: "project" };
  }

  if (scope === "project" || scope === "global") {
    return { scope };
  }

  return {
    scope: "project",
    error: "Usage: /khala-memory-remove [project|global]",
  };
}

function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (quote) {
      if (char === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
        continue;
      }

      if (char === quote) {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isResolvableReviewPath(entry: string, cwd: string): boolean {
  const value = entry.trim();
  if (!value) return false;
  if (existsSync(path.resolve(cwd, value))) return true;

  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(".")
  );
}

function parsePullRequestReference(value: string): string | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/([1-9]\d*)/i);
  return match?.[1] ?? null;
}

export function parseReviewArgs(
  args: string,
  cwd: string,
  commandName = "review",
): ParsedReviewArgsResult {
  const usage = `Usage: /${commandName} [uncommitted|branch <name>|commit <sha>|pr <number|url>|folder <paths...>|file <paths...>|<paths...>] [--extra "focus"]`;
  const trimmed = args.trim();
  if (!trimmed) {
    return { mode: "uncommitted" };
  }

  const tokens = tokenizeArgs(trimmed);
  const positional: string[] = [];
  let extraInstruction: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--extra") {
      const extra = tokens
        .slice(i + 1)
        .join(" ")
        .trim();
      if (!extra) {
        return { error: usage };
      }

      extraInstruction = extra;
      break;
    }

    positional.push(token);
  }

  if (positional.length === 0) {
    return { mode: "uncommitted", extraInstruction };
  }

  const [modeToken, ...rest] = positional;
  const mode = modeToken.toLowerCase();

  const directPr = parsePullRequestReference(modeToken);
  if (directPr && rest.length === 0) {
    return { mode: "pr", pr: directPr, extraInstruction };
  }

  if (mode === "uncommitted") {
    if (rest.length > 0) {
      return { error: "`uncommitted` does not accept additional arguments." };
    }

    return { mode: "uncommitted", extraInstruction };
  }

  if (mode === "branch") {
    const branch = rest[0]?.trim();
    if (!branch || rest.length !== 1) {
      return {
        error: `Usage: /${commandName} branch <base-branch> [--extra "focus"]`,
      };
    }

    return { mode: "branch", branch, extraInstruction };
  }

  if (mode === "commit") {
    const commit = rest[0]?.trim();
    if (!commit || rest.length !== 1) {
      return { error: `Usage: /${commandName} commit <sha> [--extra "focus"]` };
    }

    return { mode: "commit", commit, extraInstruction };
  }

  if (mode === "pr") {
    const pr = rest[0]?.trim();
    const parsedPr = pr ? parsePullRequestReference(pr) : null;
    if (!parsedPr || rest.length !== 1) {
      return {
        error: `Usage: /${commandName} pr <number|url> [--extra "focus"]`,
      };
    }

    return { mode: "pr", pr: parsedPr, extraInstruction };
  }

  if (mode === "folder" || mode === "file") {
    const paths = rest
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (paths.length === 0) {
      return {
        error: `Usage: /${commandName} ${mode} <path ...> [--extra "focus"]`,
      };
    }

    return { mode: "folder", paths, extraInstruction };
  }

  const directPaths = positional
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (
    directPaths.length > 0 &&
    directPaths.every((entry) => isResolvableReviewPath(entry, cwd))
  ) {
    return { mode: "folder", paths: directPaths, extraInstruction };
  }

  return { error: usage };
}

function buildScopedTarget(
  parsed: ParsedReviewArgs,
  copy: {
    branch: (branch: string) => string;
    commit: (commit: string) => string;
    pr: (pr: string) => string;
    folder: (paths: string[]) => string;
    uncommitted: string;
  },
): ScopedTarget {
  if (parsed.mode === "branch") {
    return {
      summary: `branch ${parsed.branch}`,
      instruction: copy.branch(parsed.branch),
      flags: { mode: "branch", branch: parsed.branch },
    };
  }
  if (parsed.mode === "commit") {
    return {
      summary: `commit ${parsed.commit}`,
      instruction: copy.commit(parsed.commit),
      flags: { mode: "commit", commit: parsed.commit },
    };
  }
  if (parsed.mode === "pr") {
    return {
      summary: `pull request ${parsed.pr}`,
      instruction: copy.pr(parsed.pr),
      flags: { mode: "pr", pr: parsed.pr },
    };
  }
  if (parsed.mode === "folder") {
    return {
      summary: `paths ${parsed.paths.join(", ")}`,
      instruction: copy.folder(parsed.paths),
      flags: { mode: "folder", paths: parsed.paths },
    };
  }

  return {
    summary: "uncommitted changes",
    instruction: copy.uncommitted,
    flags: { mode: "uncommitted" },
  };
}

export function buildReviewTarget(parsed: ParsedReviewArgs): ScopedTarget {
  return buildScopedTarget(parsed, {
    branch: (branch) =>
      [
        `Review changes against base branch \`${branch}\`.`,
        `Find merge base first, e.g. \`git merge-base HEAD ${branch}\`, then inspect diff from that SHA.`,
      ].join(" "),
    commit: (commit) =>
      `Review only changes introduced by commit \`${commit}\` (use \`git show ${commit}\` or equivalent).`,
    pr: (pr) =>
      [
        `Review pull request #${pr}.`,
        "Require GitHub CLI (`gh`) for PR metadata/checkout; if it is missing or unauthenticated, stop with setup guidance instead of guessing.",
        "Before checkout, verify there are no staged or unstaged tracked-file changes; untracked files alone must not block PR review.",
        "Resolve PR title, head branch, and base branch with `gh pr view`, checkout with `gh pr checkout`, compute the merge base against the base branch, then review `git diff <merge-base>`.",
      ].join(" "),
    folder: (paths) =>
      `Snapshot review only for files/folders in: ${paths.join(", ")}. Read files directly, do not assume git diff context.`,
    uncommitted:
      "Review staged, unstaged, and untracked changes in the current workspace.",
  });
}

export function buildSimplifyTarget(parsed: ParsedReviewArgs): ScopedTarget {
  return buildScopedTarget(parsed, {
    branch: (branch) =>
      [
        `Simplify code changed against base branch \`${branch}\` while preserving exact behavior.`,
        `Find merge base first, e.g. \`git merge-base HEAD ${branch}\`, then work from that diff scope.`,
      ].join(" "),
    commit: (commit) =>
      `Simplify only code introduced by commit \`${commit}\` while keeping output and API behavior unchanged.`,
    pr: (pr) =>
      [
        `Simplify code in pull request reference \`${pr}\` with no behavior drift.`,
        "If GitHub CLI is available, resolve PR metadata and checkout or diff PR branch against its base branch first.",
      ].join(" "),
    folder: (paths) =>
      `Simplify code only in these files/folders: ${paths.join(", ")}. Read files directly, do not assume git diff context.`,
    uncommitted:
      "Simplify staged, unstaged, and untracked code in the current workspace while preserving exact functionality.",
  });
}

function toYamlQuotedScalar(value: string): string {
  return JSON.stringify(value);
}

export function chooseAvailableSkillName(params: {
  topic: string;
  fromFile?: string;
  fromUrl?: string;
  reservedNames: ReadonlySet<string>;
  slugify: (value: string) => string;
}): string {
  const sourceHint = params.fromUrl || params.fromFile || "";
  const baseHint = params.topic || (sourceHint ? "learned-skill" : "new-skill");
  const slug = params.slugify(baseHint) || "new-skill";
  const preferredName = slug.startsWith("khala-") ? slug : `khala-${slug}`;

  if (!params.reservedNames.has(preferredName)) return preferredName;

  let suffix = 2;
  while (params.reservedNames.has(`${preferredName}-${suffix}`)) suffix += 1;
  return `${preferredName}-${suffix}`;
}

export function buildSkillTemplate(skillName: string, topic: string): string {
  const summary = topic || skillName;
  return [
    "---",
    `name: ${toYamlQuotedScalar(skillName)}`,
    `description: ${toYamlQuotedScalar(`Reusable workflow for ${summary}`)}`,
    "---",
    "",
    "## Use when",
    `- ${summary}`,
    "",
    "## Steps",
    "1. Clarify input and intent.",
    "2. Execute the workflow with concise output.",
    "3. Validate outcomes before finalizing.",
    "",
    "## Output",
    "- Summary of actions",
    "- Validation evidence",
    "- Risks and follow-ups",
    "",
    "## Avoid when",
    "- The task needs one-off ad hoc handling",
    "- Requirements are unclear and need discovery first",
    "",
  ].join("\n");
}
