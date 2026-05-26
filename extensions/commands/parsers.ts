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
  const preset = COMPLIANCE_PRESET_ALIASES[value];
  return preset
    ? { preset }
    : value
      ? {
          preset: "status",
          error: "Usage: /khala [status|strict|enforce|warn|monitor|reset]",
        }
      : { preset: "status" };
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
  return rest
    ? { reason: rest, ttlMinutes }
    : {
        reason: "",
        ttlMinutes,
        error: "Usage: /approve-risk <checker approval reason> [--ttl MINUTES]",
      };
}

export function parsePreflightArgs(
  args: string,
  parsePreflightLine: (line: string) => PreflightRecord | null,
): ParseRecordResult<PreflightRecord> {
  return parseRecordLine(
    args,
    parsePreflightLine,
    'Usage: /preflight Preflight: skill=<name|none> reason="<short>" clarify=<yes|no>',
    'Invalid preflight. Expected: Preflight: skill=<name|none> reason="<short>" clarify=<yes|no>',
  );
}

export function parsePostflightArgs(
  args: string,
  parsePostflightLine: (line: string) => PostflightRecord | null,
): ParseRecordResult<PostflightRecord> {
  return parseRecordLine(
    args,
    parsePostflightLine,
    'Usage: /postflight Postflight: verify="<command_or_check>" result=<pass|fail|not-run>',
    'Invalid postflight. Expected: Postflight: verify="<command_or_check>" result=<pass|fail|not-run>',
  );
}

export const parseDebugArgs = (args: string): { problem: string; fix: boolean } => {
  const { rest, enabled } = parseToggleArg(args, "--fix");
  return { problem: rest, fix: enabled };
};

export const parseFeatureArgs = (args: string): { request: string; ship: boolean } => {
  const { rest, enabled } = parseToggleArg(args, "--ship");
  return { request: rest, ship: enabled };
};

export const parsePlanArgs = (args: string): { plan: string } => ({
  plan: normalizeWhitespace(args),
});
export const parseAuditArgs = (args: string): { claim: string } => ({
  claim: normalizeWhitespace(args),
});
export const parseTriageIssueArgs = (
  args: string,
): { problem: string } => ({ problem: normalizeWhitespace(args) });

export function parseTddArgs(args: string): { goal: string; language: string } {
  let rest = normalizeWhitespace(args);

  const languageResult = removeFlag(rest, /(^|\s)--lang\s+(\S+)(\s|$)/);
  rest = languageResult.value;

  return {
    goal: rest,
    language: normalizeWhitespace(languageResult.match?.[2] ?? "auto").toLowerCase(),
  };
}

export function parseAddressOpenIssuesArgs(args: string): {
  limit: number;
  repo: string;
} {
  let rest = normalizeWhitespace(args);

  const limitResult = removeFlag(rest, /(^|\s)--limit\s+(\d+)(\s|$)/);
  rest = limitResult.value;
  const limit = Number(limitResult.match?.[2] ?? 20);

  const repoResult = removeFlag(rest, /(^|\s)--repo\s+(\S+)(\s|$)/);
  const repo = normalizeWhitespace(repoResult.match?.[2] ?? "");

  return { limit: Number.isFinite(limit) && limit > 0 ? limit : 20, repo };
}

export function parseLearnSkillArgs(args: string): {
  topic: string;
  fromFile?: string;
  fromUrl?: string;
  dryRun: boolean;
} {
  let rest = normalizeWhitespace(args);
  const dryRunResult = removeFlag(rest, /(^|\s)--dry-run(\s|$)/);
  rest = dryRunResult.value;
  const dryRun = Boolean(dryRunResult.match);

  const fromFileResult = removeFlag(rest, /(^|\s)--from-file\s+(\S+)(\s|$)/);
  rest = fromFileResult.value;
  let fromFile = fromFileResult.match?.[2];
  const fromUrlResult = removeFlag(rest, /(^|\s)--from-url\s+(\S+)(\s|$)/);
  rest = fromUrlResult.value;
  let fromUrl = fromUrlResult.match?.[2];

  const fromResult = removeFlag(rest, /(^|\s)--from\s+(\S+)(\s|$)/);
  rest = fromResult.value;
  const from = fromResult.match?.[2];

  if (from && !fromFile && !fromUrl)
    from.match(/^(?:https?:\/\/|ssh:\/\/|file:\/\/|git@)/)
      ? (fromUrl = from)
      : (fromFile = from);
  return {
    topic: rest,
    fromFile,
    fromUrl,
    dryRun,
  };
}

const makeMemoryScopeParser = (usage: string) =>
  (args: string): { scope: "project" | "global"; error?: string } => parseScopeArg(args, usage);

export const parseKhalaMemorySetupArgs = makeMemoryScopeParser(
  "Usage: /khala-memory-setup [project|global]",
);
export const parseKhalaMemoryRestartArgs = makeMemoryScopeParser(
  "Usage: /khala-memory-restart [project|global]",
);
export const parseKhalaMemoryRemoveArgs = makeMemoryScopeParser(
  "Usage: /khala-memory-remove [project|global]",
);

function parseRecordLine<T>(
  args: string,
  parseLine: (line: string) => T | null,
  usageError: string,
  invalidError: string,
): ParseRecordResult<T> {
  const trimmed = args.trim();
  if (!trimmed) return { error: usageError };
  const record = parseLine(trimmed);
  return record ? { record } : { error: invalidError };
}

function parseToggleArg(
  args: string,
  flag: "--fix" | "--ship",
): { rest: string; enabled: boolean } {
  let rest = normalizeWhitespace(args);
  const pattern = `(^|\\s)${flag}(\\s|$)`;
  const replaceRegex = new RegExp(pattern, "g");
  const enabled = replaceRegex.test(rest);
  rest = normalizeWhitespace(rest.replace(replaceRegex, " "));
  rest = removeFlag(rest, /(^|\s)--parallel\s+\d+(\s|$)/).value;
  return { rest, enabled };
}

function parseScopeArg(
  args: string,
  usage: string,
): { scope: "project" | "global"; error?: string } {
  const scope = normalizeWhitespace(args).toLowerCase();
  return !scope || scope === "project"
    ? { scope: "project" }
    : scope === "global"
      ? { scope: "global" }
      : { scope: "project", error: usage };
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
  return trimmed.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/([1-9]\d*)/i)?.[1] ?? null;
}

export function parseReviewArgs(
  args: string,
  cwd: string,
  commandName = "review",
): ParsedReviewArgsResult {
  const usage = `Usage: /${commandName} [uncommitted|branch <name>|commit <sha>|pr <number|url>|folder <paths...>|file <paths...>|<paths...>] [--extra "focus"]`;
  const modeUsage = (value: string): string =>
    `Usage: /${commandName} ${value} [--extra "focus"]`;
  const trimmed = args.trim();
  if (!trimmed) return { mode: "uncommitted" };

  const tokens = tokenizeArgs(trimmed);
  const extraIndex = tokens.indexOf("--extra");
  const positional = extraIndex === -1 ? tokens : tokens.slice(0, extraIndex);
  const extraInstruction =
    extraIndex === -1 ? undefined : tokens.slice(extraIndex + 1).join(" ").trim();
  if (extraIndex !== -1 && !extraInstruction) return { error: usage };

  if (positional.length === 0) return { mode: "uncommitted", extraInstruction };

  const [modeToken, ...rest] = positional;
  const mode = modeToken.toLowerCase();
  const commandUsage = {
    branch: modeUsage("branch <base-branch>"),
    commit: modeUsage("commit <sha>"),
    pr: modeUsage("pr <number|url>"),
  } as const;
  const cleanEntries = (entries: string[]): string[] =>
    entries.map((entry) => entry.trim()).filter(Boolean);
  const singleArg = (
    value: string | undefined,
    parser: (input: string) => string | null = (input) => input,
  ): string | null => {
    const parsed = value?.trim() ? parser(value.trim()) : null;
    return parsed && rest.length === 1 ? parsed : null;
  };

  const directPr = parsePullRequestReference(modeToken);
  if (directPr && rest.length === 0) return { mode: "pr", pr: directPr, extraInstruction };

  switch (mode) {
    case "uncommitted":
      return rest.length > 0
        ? { error: "`uncommitted` does not accept additional arguments." }
        : { mode: "uncommitted", extraInstruction };
    case "branch":
    case "commit":
    case "pr": {
      const value =
        mode === "pr"
          ? singleArg(rest[0], parsePullRequestReference)
          : singleArg(rest[0]);
      if (!value) return { error: commandUsage[mode] };
      return mode === "pr" ? { mode, pr: value, extraInstruction } : mode === "branch" ? { mode, branch: value, extraInstruction } : { mode, commit: value, extraInstruction };
    }
    case "folder":
    case "file": {
      const paths = cleanEntries(rest);
      if (paths.length === 0) return { error: modeUsage(`${mode} <path ...>`) };
      return { mode: "folder", paths, extraInstruction };
    }
  }

  const directPaths = cleanEntries(positional);
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
  const target = (summary: string, instruction: string, flags: WorkflowFlags): ScopedTarget => ({
    summary,
    instruction,
    flags,
  });
  switch (parsed.mode) {
    case "branch":
      return target(`branch ${parsed.branch}`, copy.branch(parsed.branch), { mode: "branch", branch: parsed.branch });
    case "commit":
      return target(`commit ${parsed.commit}`, copy.commit(parsed.commit), { mode: "commit", commit: parsed.commit });
    case "pr":
      return target(`pull request ${parsed.pr}`, copy.pr(parsed.pr), { mode: "pr", pr: parsed.pr });
    case "folder":
      return target(`paths ${parsed.paths.join(", ")}`, copy.folder(parsed.paths), {
        mode: "folder",
        paths: parsed.paths,
      });
    default:
      return target("uncommitted changes", copy.uncommitted, { mode: "uncommitted" });
  }
}

const scopedBranchInstruction = (
  verb: "Review" | "Simplify",
  branch: string,
): string =>
  [
    `${verb} changes against base branch \`${branch}\`${verb === "Simplify" ? " while preserving exact behavior." : "."}`,
    `Find merge base first, e.g. \`git merge-base HEAD ${branch}\`, then ${verb === "Simplify" ? "work from that diff scope." : "inspect diff from that SHA."}`,
  ].join(" ");

const scopedPathInstruction = (
  prefix: "Snapshot review" | "Simplify code",
  paths: string[],
): string =>
  `${prefix} only for files/folders in: ${paths.join(", ")}. Read files directly, do not assume git diff context.`;

export function buildReviewTarget(parsed: ParsedReviewArgs): ScopedTarget {
  return buildScopedTarget(parsed, {
    branch: (branch) => scopedBranchInstruction("Review", branch),
    commit: (commit) =>
      `Review only changes introduced by commit \`${commit}\` (use \`git show ${commit}\` or equivalent).`,
    pr: (pr) =>
      [
        `Review pull request #${pr}.`,
        "Require GitHub CLI (`gh`) for PR metadata/checkout; if it is missing or unauthenticated, stop with setup guidance instead of guessing.",
        "Before checkout, verify there are no staged or unstaged tracked-file changes; untracked files alone must not block PR review.",
        "Resolve PR title, head branch, and base branch with `gh pr view`, checkout with `gh pr checkout`, compute the merge base against the base branch, then review `git diff <merge-base>`.",
      ].join(" "),
    folder: (paths) => scopedPathInstruction("Snapshot review", paths),
    uncommitted:
      "Review staged, unstaged, and untracked changes in the current workspace.",
  });
}

export function buildSimplifyTarget(parsed: ParsedReviewArgs): ScopedTarget {
  return buildScopedTarget(parsed, {
    branch: (branch) => scopedBranchInstruction("Simplify", branch),
    commit: (commit) =>
      `Simplify only code introduced by commit \`${commit}\` while keeping output and API behavior unchanged.`,
    pr: (pr) =>
      [
        `Simplify code in pull request reference \`${pr}\` with no behavior drift.`,
        "If GitHub CLI is available, resolve PR metadata and checkout or diff PR branch against its base branch first.",
      ].join(" "),
    folder: (paths) => scopedPathInstruction("Simplify code", paths),
    uncommitted:
      "Simplify staged, unstaged, and untracked code in the current workspace while preserving exact functionality.",
  });
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
    `name: ${JSON.stringify(skillName)}`,
    `description: ${JSON.stringify(`Reusable workflow for ${summary}`)}`,
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
