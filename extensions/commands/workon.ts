import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const MAX_BRANCH_SLUG_LENGTH = 56;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");

export type WorkonForge = "auto" | "github" | "gitlab" | "all";
export type WorkonMode = "prepare" | "start";
export interface WorkonModelSelection {
  exactModel: string;
  routingMode: "default" | "exact-model";
  routingReason: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type WorkonCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<CommandResult>;

export interface WorkonBootstrapRequest {
  cwd: string;
  target: string;
  targets?: string[];
  repo: string;
  forge: WorkonForge;
  mode: WorkonMode;
  dryRun?: boolean;
  capsuleRoot: string;
  nowIso: string;
  launchInZellij: boolean;
  heartbeat: string;
  modelSelection?: WorkonModelSelection;
}

const DEFAULT_WORKON_MODEL_SELECTION: WorkonModelSelection = {
  exactModel: "",
  routingMode: "default",
  routingReason: "backward-compatible default Pi model selection",
};

function workonModelSelection(request: WorkonBootstrapRequest): WorkonModelSelection {
  return request.modelSelection ?? DEFAULT_WORKON_MODEL_SELECTION;
}

interface GithubIssueTarget {
  repo: string;
  number: number;
}

interface GithubIssueMetadata {
  number: number;
  title: string;
  url: string;
  body?: string;
  state?: string;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
  repository?: { nameWithOwner?: string };
}

interface GithubRepositoryMetadata {
  nameWithOwner: string;
}

interface WorkonBootstrapEvidence {
  commands: string[];
  gaps: string[];
  capsulePath?: string;
  issue?: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo?: string;
  branchName?: string;
  worktreeCommand?: string;
  worktreeStatus?: "prepared" | "started" | "launched" | "blocked";
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt?: string;
  modelSelection?: WorkonModelSelection;
  readinessActionItems?: string[];
  readinessActionItemsByIssue?: Array<{
    issue: GithubIssueMetadata;
    actionItems: string[];
  }>;
}

interface ZellijHandoffResult {
  status?: string;
  path?: string;
  tabName?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

function inferBranchPrefix(title: string): string {
  const match = title.match(/^(feat|fix|docs|refactor|test|chore|perf|work)(?:\(.+?\))?:/i);
  return match?.[1]?.toLowerCase() ?? "work";
}

export function buildWorkonBranchName(issue: Pick<GithubIssueMetadata, "number" | "title">): string {
  const prefix = inferBranchPrefix(issue.title);
  const titleWithoutConventionalPrefix = issue.title.replace(
    /^(?:feat|fix|docs|refactor|test|chore|perf|work)(?:\(.+?\))?:\s*/i,
    "",
  );
  const slug = slugify(titleWithoutConventionalPrefix || issue.title || "work");
  return `${prefix}/${issue.number}-${slug || "work"}`;
}

function githubIssueTargetFromUrl(target: string): GithubIssueTarget | null {
  const match = target.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/([1-9]\d*)/i,
  );
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  };
}

function numericTarget(target: string): number | null {
  return /^[1-9]\d*$/.test(target.trim()) ? Number(target.trim()) : null;
}

function parseJsonObject<T>(raw: string, gapLabel: string, gaps: string[]): T | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch (error) {
    gaps.push(
      `${gapLabel}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function resultGap(label: string, result: CommandResult): string | null {
  if (result.ok) return null;
  const detail = result.error || result.stderr || result.stdout || "command failed";
  return `${label}: ${detail.trim().split("\n")[0]}`;
}

function formatLoggedCommand(command: string, args: string[]): string {
  const redactedArgs = [...args];
  for (const flag of ["--prompt"]) {
    const index = redactedArgs.indexOf(flag);
    if (index >= 0 && index + 1 < redactedArgs.length) {
      redactedArgs[index + 1] = "<redacted>";
    }
  }
  return `${command} ${redactedArgs.join(" ")}`;
}

async function runCommand(
  runner: WorkonCommandRunner,
  cwd: string,
  commands: string[],
  command: string,
  args: string[],
): Promise<CommandResult> {
  commands.push(formatLoggedCommand(command, args));
  return runner(command, args, { cwd });
}

async function runGh(
  runner: WorkonCommandRunner,
  cwd: string,
  commands: string[],
  args: string[],
): Promise<CommandResult> {
  return runCommand(runner, cwd, commands, "gh", args);
}

async function resolveCurrentGithubRepo(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
): Promise<string> {
  if (request.repo) return request.repo;
  const result = await runGh(runner, request.cwd, evidence.commands, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  const gap = resultGap("current GitHub repository", result);
  if (gap) {
    evidence.gaps.push(gap);
    return "";
  }
  const repo = parseJsonObject<GithubRepositoryMetadata>(
    result.stdout,
    "current GitHub repository",
    evidence.gaps,
  );
  return repo?.nameWithOwner ?? "";
}

async function resolveIssueTarget(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
): Promise<GithubIssueTarget | null> {
  const issueUrlTarget = githubIssueTargetFromUrl(request.target);
  if (issueUrlTarget) return issueUrlTarget;

  const issueNumber = numericTarget(request.target);
  const repo = await resolveCurrentGithubRepo(request, runner, evidence);
  if (!repo) return null;
  if (issueNumber) return { repo, number: issueNumber };

  evidence.gaps.push(
    "Workon target is not an issue URL or issue number; use /plan for maintainer ideas or /triage for user-posted issue intake before /workon.",
  );
  return null;
}

async function readGithubIssue(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
  target: GithubIssueTarget,
): Promise<GithubIssueMetadata | null> {
  const result = await runGh(runner, request.cwd, evidence.commands, [
    "issue",
    "view",
    String(target.number),
    "--repo",
    target.repo,
    "--json",
    "number,title,url,body,state,author,labels,assignees",
  ]);
  const gap = resultGap(`GitHub issue ${target.repo}#${target.number}`, result);
  if (gap) {
    evidence.gaps.push(gap);
    return null;
  }
  return parseJsonObject<GithubIssueMetadata>(
    result.stdout,
    `GitHub issue ${target.repo}#${target.number}`,
    evidence.gaps,
  );
}

function acceptanceCriteriaFromBody(body: string | undefined): string[] {
  if (!body) return [];
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+\.|- \[[ xX]\])\s+/.test(line) && /\b(should|must|add|detect|collect|return|render|preserve|support|emit|write|create|resolve|validate|test|pass|fail)\b/i.test(line));
  return lines.slice(0, 8).map((line) => line.replace(/^(?:[-*]|\d+\.|- \[[ xX]\])\s+/, ""));
}

function bodyHasHeading(body: string | undefined, headings: string[]): boolean {
  if (!body) return false;
  return headings.some((heading) => new RegExp(`^#{1,3}\\s+${heading}\\b`, "im").test(body));
}

function bodyMentions(body: string | undefined, pattern: RegExp): boolean {
  return Boolean(body && pattern.test(body));
}

function issueLooksLikeBug(issue: GithubIssueMetadata): boolean {
  const labels = issue.labels?.map((label) => label.name ?? "").join(" ") ?? "";
  return /\b(bug|fix|broken|fail|failure|error|regression|incorrect|wrong|invalid)\b/i.test(`${issue.title} ${labels}`);
}

function validationItemsFromBody(body: string | undefined): string[] {
  if (!body) return [];
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+\.|- \[[ xX]\])\s+/.test(line) && /\b(test|validation|validate|check|lint|typecheck|regression|repro|reproduce)\b/i.test(line));
  return lines.slice(0, 8).map((line) => line.replace(/^(?:[-*]|\d+\.|- \[[ xX]\])\s+/, ""));
}

function unresolvedBreakingChange(body: string | undefined): boolean {
  if (!body || !/breaking change|public api|schema|migration|cli contract/i.test(body)) return false;
  return !/breaking change(?: risk)?:?\s*(?:none|no|n\/a|not expected)|no breaking change/i.test(body);
}

// Review-size risk should come from the proposed scope, not from diagnostic text that
// quotes the trigger words while explaining a readiness false positive.
function reviewSizeRiskBody(body: string | undefined): string {
  if (!body) return "";

  const excludedHeadings = /^(?:reproduction(?: status)?|steps to reproduce|current behavior|evidence(?: trail)?|likely root cause|diagnostics?|debug(?:ging)? notes?)$/i;
  const keptLines: string[] = [];
  let inFence = false;
  let excludeSection = false;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*>/.test(line)) continue;

    const heading = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/)?.[1]?.trim();
    if (heading) {
      excludeSection = excludedHeadings.test(heading);
      if (!excludeSection) keptLines.push(line);
      continue;
    }

    if (!excludeSection) keptLines.push(line);
  }

  return keptLines.join("\n");
}

function reviewSizeRisk(body: string | undefined): boolean {
  return bodyMentions(reviewSizeRiskBody(body), /\b(large|broad|sweeping|multi[- ]?phase|many files|refactor everything|over 500|>\s*500)\b/i);
}

function evaluateWorkonReadiness(issue: GithubIssueMetadata): string[] {
  const body = issue.body ?? "";
  const acceptance = acceptanceCriteriaFromBody(body);
  const validation = validationItemsFromBody(body);
  const actionItems: string[] = [];

  if (acceptance.length === 0) {
    actionItems.push("Add narrow, testable acceptance criteria to the issue/work packet.");
  }
  if (validation.length === 0 && !bodyHasHeading(body, ["Validation", "Testing", "Test plan"])) {
    actionItems.push("Add validation or test expectations, preferably a behavior/regression test for changed behavior.");
  }
  if (
    issueLooksLikeBug(issue) &&
    !bodyHasHeading(body, ["Reproduction", "Steps to reproduce", "Current behavior"]) &&
    !bodyMentions(body, /\b(repro|reproduce|observed behavior|current behavior|failing test|regression test)\b/i)
  ) {
    actionItems.push("Add reproduction steps, observed behavior, or a concrete failing feedback loop for the bug.");
  }
  if (!bodyHasHeading(body, ["Non-goals", "Out of scope"])) {
    actionItems.push("Add non-goals or out-of-scope boundaries so autonomous work does not expand scope.");
  }
  if (unresolvedBreakingChange(body)) {
    actionItems.push("Resolve the breaking-change/public-contract risk before autonomous work starts.");
  }
  if (reviewSizeRisk(body)) {
    actionItems.push("Narrow or split the issue so the resulting PR is likely under about 500 LOC changed.");
  }

  return actionItems;
}

function formatReadinessActionItems(
  readinessActionItemsByIssue: Array<{ issue: GithubIssueMetadata; actionItems: string[] }>,
): string {
  const blockedIssues = readinessActionItemsByIssue.filter(({ actionItems }) => actionItems.length > 0);
  const singleBlockedIssue = blockedIssues.length === 1 ? blockedIssues[0]?.issue : undefined;

  return [
    singleBlockedIssue
      ? `Autonomous readiness: not ready for ${singleBlockedIssue.url}`
      : `Autonomous readiness: not ready for ${blockedIssues.length} source issues`,
    "Action items to make the source issue(s) /workon-ready:",
    ...blockedIssues.flatMap(({ issue, actionItems }) => [
      `- ${issue.url}`,
      ...actionItems.map((item, index) => `  ${index + 1}. ${item}`),
    ]),
    "Suggested next command(s):",
    ...blockedIssues.map(({ issue }) => `- /triage ${issue.url}`),
  ].join("\n");
}

function capsuleMarkdown(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  worktreeCommand: string;
  worktreeStatus: "prepared" | "started" | "launched" | "blocked";
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt: string;
}): string {
  const labels = params.issue.labels
    ?.map((label) => label.name)
    .filter((label): label is string => Boolean(label))
    .join(", ") || "(none)";
  const assignees = params.issue.assignees
    ?.map((assignee) => assignee.login)
    .filter((login): login is string => Boolean(login))
    .join(", ") || "(none)";
  const sourceIssues = params.issues?.length ? params.issues : [params.issue];
  const sourceIssueLines = sourceIssues
    .map((issue) => `- ${issue.url} (#${issue.number}) ${issue.title}`)
    .join("\n");
  const acceptance = sourceIssues
    .flatMap((issue) =>
      acceptanceCriteriaFromBody(issue.body).map((item) => `- #${issue.number}: ${item}`),
    )
    .slice(0, 12)
    .join("\n");
  const validation = validationItemsFromBody(params.issue.body)
    .map((item) => `- ${item}`)
    .join("\n") || "- Run the validation described by the issue before shipping.";

  return `# Workon session capsule

Repo: ${params.repo}
Issue: ${params.issue.url}
Issue number: #${params.issue.number}
Issue title: ${params.issue.title}
Source issues:
${sourceIssueLines}
State: ${params.issue.state ?? "unknown"}
Labels: ${labels}
Assignees: ${assignees}
Branch: ${params.branchName}
Worktree command: ${params.worktreeCommand}
Worktree status: ${params.worktreeStatus}
Worktree path: ${params.worktreePath ?? "(not available)"}
Pi handoff command: ${params.piHandoffCommand ?? "(not launched)"}
Forge heartbeat command: ${params.heartbeatCommand ?? "(not launched)"}
Heartbeat interval: ${params.request.heartbeat}
Dry run: ${params.request.dryRun ? "yes" : "no"}
Exact model: ${workonModelSelection(params.request).exactModel || "(runtime default)"}
Model routing mode: ${workonModelSelection(params.request).routingMode}
Model routing reason: ${workonModelSelection(params.request).routingReason}
Created: ${params.request.nowIso}

## Problem

${params.issue.title}

## Acceptance criteria

${acceptance}

## Non-goals

- Do not widen scope beyond the source issue(s) without updating the issue or creating a follow-up.
- Do not merge or ship from this capsule; use /ship after implementation and review.
- For multiple source issues, prefer multiple commits, each tied to the relevant issue where practical.

## Validation

${validation}

## Open questions

- Confirm whether any acceptance criteria are missing before implementation.

## Next prompt

${params.handoffPrompt}
`;
}

function capsulePath(root: string, repo: string): string {
  const [owner = "unknown", name = "repo"] = repo.split("/", 2);
  return path.join(root, "github.com", owner, name, "capsule.md");
}

function renderTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  }).trim();
}

async function readHandoffTemplate(cwd: string): Promise<string> {
  const cwdTemplatePath = path.join(cwd, "commands", "workon-handoff-template.md");
  try {
    return await fs.readFile(cwdTemplatePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return fs.readFile(path.join(PACKAGE_ROOT, "commands", "workon-handoff-template.md"), "utf8");
}

function heartbeatLabel(value: string): string {
  return `${value} hours`;
}

async function buildHandoffPrompt(params: {
  cwd: string;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  heartbeat: string;
  modelSelection: WorkonModelSelection;
}): Promise<string> {
  const template = await readHandoffTemplate(params.cwd);
  const sourceIssues = params.issues?.length ? params.issues : [params.issue];
  const rendered = renderTemplate(template, {
    branch_name: params.branchName,
    heartbeat_interval: heartbeatLabel(params.heartbeat),
    model_routing_mode: params.modelSelection.routingMode,
    model_routing_reason: params.modelSelection.routingReason,
    resolved_model: params.modelSelection.exactModel || "(runtime default)",
    issue_number: params.issue.number,
    issue_title: params.issue.title,
    issue_url: params.issue.url,
    repo: params.repo,
  });
  if (sourceIssues.length === 1) return rendered;
  return `${rendered}\n\nMultiple source issues for this work session:\n${sourceIssues
    .map((issue) => `- ${issue.url} (#${issue.number}) ${issue.title}`)
    .join("\n")}\n\nInstruction: Make multiple commits, each tied to the relevant source issue where practical.`;
}

async function writeCapsule(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  worktreeCommand: string;
  worktreeStatus: "prepared" | "started" | "launched" | "blocked";
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt: string;
}): Promise<string> {
  const filePath = capsulePath(params.request.capsuleRoot, params.repo);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, capsuleMarkdown(params), "utf8");
  return filePath;
}

function extractWorktreePath(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { path?: unknown };
      if (typeof parsed.path === "string" && parsed.path) return parsed.path;
    } catch {
      // Ignore non-JSON hook output around Worktrunk's JSON line.
    }
  }
  return output.match(/(?:^|\s)(\/[^\s]+)/)?.[1];
}

function parseZellijHandoffResult(output: string): ZellijHandoffResult | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as ZellijHandoffResult;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function startWorktreeIfRequested(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
  params: {
    repo: string;
    branchName: string;
    capsulePath: string;
    handoffPrompt: string;
  },
): Promise<{
  status: "prepared" | "started" | "launched" | "blocked";
  path?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
}> {
  if (request.mode !== "start" || request.dryRun) return { status: "prepared" };

  const version = await runCommand(runner, request.cwd, evidence.commands, "wt", [
    "--version",
  ]);
  const versionGap = resultGap("Worktrunk availability", version);
  if (versionGap) {
    evidence.gaps.push(versionGap);
    return { status: "blocked" };
  }

  if (request.launchInZellij) {
    const scriptPath = path.join(request.cwd, "scripts", "workon-zellij-handoff.sh");
    const handoffArgs = [
      scriptPath,
      "--repo",
      params.repo,
      "--branch",
      params.branchName,
      "--capsule",
      params.capsulePath,
      "--prompt",
      params.handoffPrompt,
      "--heartbeat",
      request.heartbeat,
    ];
    const modelSelection = workonModelSelection(request);
    if (modelSelection.exactModel) {
      handoffArgs.push("--model", modelSelection.exactModel);
    }
    const handoffResult = await runCommand(runner, request.cwd, evidence.commands, "bash", handoffArgs);
    const parsed = parseZellijHandoffResult(`${handoffResult.stdout}\n${handoffResult.stderr}`);
    const handoffGap = resultGap(`Zellij Pi handoff ${params.branchName}`, handoffResult);
    if (handoffGap) {
      evidence.gaps.push(handoffGap);
      if (parsed?.path) {
        evidence.gaps.push(
          `Zellij Pi handoff ${params.branchName}: Worktree/tab was created but Pi was not launched; continue in ${parsed.tabName ?? "the Worktrunk tab"}, not this session.`,
        );
      }
      return { status: "blocked", path: parsed?.path };
    }

    if (parsed?.status !== "launched" || !parsed.path) {
      evidence.gaps.push(`Zellij Pi handoff ${params.branchName}: result JSON missing launched path`);
      return { status: "blocked" };
    }

    return {
      status: "launched",
      path: parsed.path,
      piHandoffCommand: parsed.piHandoffCommand ?? "scripts/workon-zellij-handoff.sh",
      heartbeatCommand: parsed.heartbeatCommand,
    };
  }

  const result = await runCommand(runner, request.cwd, evidence.commands, "wt", [
    "switch",
    "--create",
    params.branchName,
    "--format",
    "json",
  ]);
  const startGap = resultGap(`Worktrunk start ${params.branchName}`, result);
  if (startGap) {
    evidence.gaps.push(startGap);
    return { status: "blocked" };
  }

  return {
    status: "started",
    path: extractWorktreePath(`${result.stdout}\n${result.stderr}`),
  };
}

export function formatWorkonBootstrapEvidence(evidence: WorkonBootstrapEvidence): string[] {
  const issue = evidence.issue;
  const lines = ["Deterministic workon bootstrap evidence:"];
  if (issue && evidence.repo && evidence.readinessActionItems?.length) {
    lines.push(
      [
        `Source issue: ${evidence.repo}#${issue.number} ${issue.title}`,
        `Issue URL: ${issue.url}`,
        ...(evidence.issues && evidence.issues.length > 1
          ? [`Source issues: ${evidence.issues.map((sourceIssue) => `#${sourceIssue.number}`).join(", ")}`]
          : []),
        "Autonomous readiness: not-ready",
        "Worktree status: not-started",
        "Session capsule: not written",
      ].join("\n"),
    );
  } else if (issue && evidence.repo && evidence.branchName && evidence.worktreeCommand) {
    lines.push(
      [
        `Source issue: ${evidence.repo}#${issue.number} ${issue.title}`,
        `Issue URL: ${issue.url}`,
        ...(evidence.issues && evidence.issues.length > 1
          ? [`Source issues: ${evidence.issues.map((sourceIssue) => `#${sourceIssue.number}`).join(", ")}`]
          : []),
        "Autonomous readiness: ready",
        `Suggested branch: ${evidence.branchName}`,
        `Suggested Worktrunk command: ${evidence.worktreeCommand}`,
        `Bootstrap phase guidance: resolve issue -> prepare capsule -> ${evidence.worktreeStatus === "prepared" ? "suggest branch only" : "create worktree"} -> ${evidence.worktreeStatus === "launched" ? "launch Pi -> launch heartbeat" : "handoff not launched"}`,
        `Worktree status: ${evidence.worktreeStatus ?? "prepared"}`,
        `Worktree path: ${evidence.worktreePath ?? "(not available)"}`,
        `Pi handoff command: ${evidence.piHandoffCommand ?? "(not launched)"}`,
        `Forge heartbeat command: ${evidence.heartbeatCommand ?? "(not launched)"}`,
        `Exact model: ${evidence.modelSelection?.exactModel || "(runtime default)"}`,
        `Model routing mode: ${evidence.modelSelection?.routingMode ?? "default"}`,
        `Model routing reason: ${evidence.modelSelection?.routingReason ?? DEFAULT_WORKON_MODEL_SELECTION.routingReason}`,
        `Session capsule: ${evidence.capsulePath ?? "not written"}`,
      ].join("\n"),
    );
  } else {
    lines.push("Source issue: not resolved deterministically.");
  }

  lines.push(
    evidence.gaps.length > 0
      ? ["Evidence gaps and graceful degradation:", ...evidence.gaps.map((gap) => `- ${gap}`)].join("\n")
      : "Evidence gaps and graceful degradation: none.",
  );
  lines.push(
    evidence.commands.length > 0
      ? ["Commands executed:", ...evidence.commands.map((command) => `- ${command}`)].join("\n")
      : "Commands executed: none.",
  );
  return lines;
}

export async function prepareWorkonBootstrap(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner = createExecFileRunner(),
): Promise<string[]> {
  const evidence: WorkonBootstrapEvidence = {
    commands: [],
    gaps: [],
  };

  if (request.forge !== "auto" && request.forge !== "github" && request.forge !== "all") {
    evidence.gaps.push(`GitHub workon bootstrap skipped for forge=${request.forge}`);
    return formatWorkonBootstrapEvidence(evidence);
  }
  if (request.forge === "all") {
    evidence.gaps.push("GitLab workon bootstrap is not implemented in this slice");
  }

  const auth = await runGh(runner, request.cwd, evidence.commands, ["auth", "status"]);
  const authGap = resultGap("GitHub authentication", auth);
  if (authGap) {
    evidence.gaps.push(authGap);
    return formatWorkonBootstrapEvidence(evidence);
  }

  const rawTargets = request.targets?.length ? request.targets : [request.target];
  const issueTargets: GithubIssueTarget[] = [];
  for (const rawTarget of rawTargets) {
    const target = await resolveIssueTarget({ ...request, target: rawTarget }, runner, evidence);
    if (!target) return formatWorkonBootstrapEvidence(evidence);
    issueTargets.push(target);
  }
  const uniqueRepos = [...new Set(issueTargets.map((target) => target.repo.toLowerCase()))];
  if (uniqueRepos.length > 1) {
    evidence.gaps.push(`Grouped GitHub workon requires one repo; found ${issueTargets.map((target) => target.repo).join(", ")}`);
    return formatWorkonBootstrapEvidence(evidence);
  }

  const issues: GithubIssueMetadata[] = [];
  for (const target of issueTargets) {
    const issue = await readGithubIssue(request, runner, evidence, target);
    if (!issue) return formatWorkonBootstrapEvidence(evidence);
    issues.push(issue);
  }
  const issue = issues[0];
  if (!issue) return formatWorkonBootstrapEvidence(evidence);

  const repo = issueTargets[0]?.repo ?? "";
  const readinessActionItemsByIssue = issues.map((sourceIssue) => ({
    issue: sourceIssue,
    actionItems: evaluateWorkonReadiness(sourceIssue),
  }));
  const readinessActionItems = readinessActionItemsByIssue.flatMap(({ actionItems }) => actionItems);
  if (readinessActionItems.length > 0) {
    evidence.issue = issue;
    evidence.issues = issues;
    evidence.repo = repo;
    evidence.readinessActionItems = readinessActionItems;
    evidence.readinessActionItemsByIssue = readinessActionItemsByIssue;
    evidence.gaps.push(formatReadinessActionItems(readinessActionItemsByIssue));
    return formatWorkonBootstrapEvidence(evidence);
  }

  const branchName = buildWorkonBranchName(issue);
  const worktreeCommand = `wt switch --create ${branchName} --format json`;
  if (request.dryRun) {
    evidence.gaps.push("Dry run requested: prepared capsule and branch suggestion only; no Worktrunk, Zellij, Pi, or heartbeat launch was attempted.");
  }
  const handoffPrompt = await buildHandoffPrompt({
    cwd: request.cwd,
    issue,
    issues,
    repo,
    branchName,
    heartbeat: request.heartbeat,
    modelSelection: workonModelSelection(request),
  });
  const initialCapsule = await writeCapsule({
    request,
    issue,
    issues,
    repo,
    branchName,
    worktreeCommand,
    worktreeStatus: "prepared",
    handoffPrompt,
  });
  const worktree = await startWorktreeIfRequested(request, runner, evidence, {
    repo,
    branchName,
    capsulePath: initialCapsule,
    handoffPrompt,
  });
  const capsule = await writeCapsule({
    request,
    issue,
    issues,
    repo,
    branchName,
    worktreeCommand,
    worktreeStatus: worktree.status,
    worktreePath: worktree.path,
    piHandoffCommand: worktree.piHandoffCommand,
    heartbeatCommand: worktree.heartbeatCommand,
    handoffPrompt,
  });

  evidence.issue = issue;
  evidence.issues = issues;
  evidence.repo = repo;
  evidence.branchName = branchName;
  evidence.worktreeCommand = worktreeCommand;
  evidence.worktreeStatus = worktree.status;
  evidence.worktreePath = worktree.path;
  evidence.piHandoffCommand = worktree.piHandoffCommand;
  evidence.heartbeatCommand = worktree.heartbeatCommand;
  evidence.modelSelection = workonModelSelection(request);
  evidence.handoffPrompt = handoffPrompt;
  evidence.capsulePath = capsule;
  return formatWorkonBootstrapEvidence(evidence);
}

export function createExecFileRunner(): WorkonCommandRunner {
  return async (command, args, options) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      return {
        ok: false,
        stdout: nodeError.stdout ?? "",
        stderr: nodeError.stderr ?? "",
        error: nodeError.message,
      };
    }
  };
}
