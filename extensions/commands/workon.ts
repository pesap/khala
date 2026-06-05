import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const MAX_BRANCH_SLUG_LENGTH = 72;

export type WorkonForge = "auto" | "github" | "gitlab" | "all";
export type WorkonMode = "prepare" | "start";

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
  repo: string;
  forge: WorkonForge;
  mode: WorkonMode;
  capsuleRoot: string;
  nowIso: string;
  launchInZellij: boolean;
  heartbeat: string;
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
  repo?: string;
  branchName?: string;
  worktreeCommand?: string;
  worktreeStatus?: "prepared" | "started" | "launched" | "blocked";
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt?: string;
}

interface ZellijHandoffResult {
  status?: string;
  path?: string;
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
  const match = title.match(/^(feat|fix|docs|refactor|test|chore|perf)(?:\(.+?\))?:/i);
  return match?.[1]?.toLowerCase() ?? "work";
}

export function buildWorkonBranchName(issue: Pick<GithubIssueMetadata, "number" | "title">): string {
  const prefix = inferBranchPrefix(issue.title);
  const titleWithoutConventionalPrefix = issue.title.replace(
    /^(?:feat|fix|docs|refactor|test|chore|perf)(?:\(.+?\))?:\s*/i,
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

function githubPullRequestUrl(target: string): string | null {
  const match = target.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*/i);
  return match?.[0] ?? null;
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

function parseJsonArray<T>(raw: string, gapLabel: string, gaps: string[]): T[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    gaps.push(
      `${gapLabel}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  }
}

function resultGap(label: string, result: CommandResult): string | null {
  if (result.ok) return null;
  const detail = result.error || result.stderr || result.stdout || "command failed";
  return `${label}: ${detail.trim().split("\n")[0]}`;
}

async function runCommand(
  runner: WorkonCommandRunner,
  cwd: string,
  commands: string[],
  command: string,
  args: string[],
): Promise<CommandResult> {
  commands.push(`${command} ${args.join(" ")}`);
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

  const prUrl = githubPullRequestUrl(request.target);
  if (prUrl) {
    evidence.gaps.push(
      `PR target detected (${prUrl}); deterministic PR-to-issue mapping is not implemented yet`,
    );
    return null;
  }

  const issueNumber = numericTarget(request.target);
  const repo = await resolveCurrentGithubRepo(request, runner, evidence);
  if (!repo) return null;
  if (issueNumber) return { repo, number: issueNumber };

  return resolveFreeformIssueTarget(request, runner, evidence, repo);
}

function cleanFreeformTopic(target: string): string {
  const trimmed = target.trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/s);
  return (quoted?.[2] ?? trimmed).trim();
}

function inferIssueTitle(topic: string): string {
  const normalized = cleanFreeformTopic(topic)
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  const prefix = /\b(bug|broken|fail|fix|incorrect|invalid|wrong|error|regression|closes?)\b/i.test(normalized)
    ? "fix"
    : "work";
  const title = normalized.length > 88 ? `${normalized.slice(0, 85).trim()}...` : normalized;
  return `${prefix}: ${title || "follow up on workon topic"}`;
}

function freeformIssueBody(topic: string): string {
  const cleanTopic = cleanFreeformTopic(topic);
  return `## Problem\n\n${cleanTopic}\n\n## Acceptance criteria\n\n- Confirm the intended behavior from this topic before implementation.\n- Add or update focused tests for the changed behavior.\n- Keep the implementation scoped to this issue.\n\n## Non-goals\n\n- Do not broaden scope beyond this topic without updating the issue or creating a follow-up.\n\n## Validation\n\n- Run focused tests for the touched path.\n- Run the relevant repo quality gate if public workflow behavior changes.\n\nCreated from /workon freeform topic.\n`;
}

async function resolveFreeformIssueTarget(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
  repo: string,
): Promise<GithubIssueTarget | null> {
  const topic = cleanFreeformTopic(request.target);
  const search = await runGh(runner, request.cwd, evidence.commands, [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    topic,
    "--limit",
    "5",
    "--json",
    "number,title,url,state",
  ]);
  const searchGap = resultGap(`GitHub issue search ${repo}`, search);
  if (searchGap) {
    evidence.gaps.push(searchGap);
    return null;
  }

  const matches = parseJsonArray<GithubIssueMetadata>(
    search.stdout,
    `GitHub issue search ${repo}`,
    evidence.gaps,
  ).filter((issue) => typeof issue.number === "number");
  const match = matches[0];
  if (match) return { repo, number: match.number };

  const created = await runGh(runner, request.cwd, evidence.commands, [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    inferIssueTitle(topic),
    "--body",
    freeformIssueBody(topic),
  ]);
  const createGap = resultGap(`GitHub issue creation ${repo}`, created);
  if (createGap) {
    evidence.gaps.push(createGap);
    return null;
  }

  const createdTarget = githubIssueTargetFromUrl(created.stdout.trim());
  if (!createdTarget) {
    evidence.gaps.push(`GitHub issue creation ${repo}: output did not include an issue URL`);
    return null;
  }
  return createdTarget;
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
  if (!body) return ["Confirm acceptance criteria from the issue body before implementation."];
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) && /\b(should|must|add|detect|collect|return|render|preserve|support|emit|write|create|resolve)\b/i.test(line));
  return lines.length > 0
    ? lines.slice(0, 8).map((line) => line.replace(/^[-*]\s+/, ""))
    : ["Confirm acceptance criteria from the issue body before implementation."];
}

function capsuleMarkdown(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
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
  const acceptance = acceptanceCriteriaFromBody(params.issue.body)
    .map((item) => `- ${item}`)
    .join("\n");

  return `# Workon session capsule

Repo: ${params.repo}
Issue: ${params.issue.url}
Issue number: #${params.issue.number}
Issue title: ${params.issue.title}
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
Mode: ${params.request.mode}
Created: ${params.request.nowIso}

## Problem

${params.issue.title}

## Acceptance criteria

${acceptance}

## Non-goals

- Do not widen scope beyond issue #${params.issue.number} without updating the issue or creating a follow-up.
- Do not merge or ship from this capsule; use /ship after implementation and review.

## Validation

- npm run test
- npm run lint

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
  return fs.readFile(path.join(cwd, "commands", "workon-handoff-template.md"), "utf8");
}

function heartbeatLabel(value: string): string {
  return `${value} hours`;
}

async function buildHandoffPrompt(params: {
  cwd: string;
  issue: GithubIssueMetadata;
  repo: string;
  branchName: string;
  heartbeat: string;
}): Promise<string> {
  const template = await readHandoffTemplate(params.cwd);
  return renderTemplate(template, {
    branch_name: params.branchName,
    heartbeat_interval: heartbeatLabel(params.heartbeat),
    issue_number: params.issue.number,
    issue_title: params.issue.title,
    issue_url: params.issue.url,
    repo: params.repo,
  });
}

async function writeCapsule(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
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
  if (request.mode !== "start") return { status: "prepared" };

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
    const handoffResult = await runCommand(runner, request.cwd, evidence.commands, "bash", [
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
    ]);
    const handoffGap = resultGap(`Zellij Pi handoff ${params.branchName}`, handoffResult);
    if (handoffGap) {
      evidence.gaps.push(handoffGap);
      return { status: "blocked" };
    }

    const parsed = parseZellijHandoffResult(`${handoffResult.stdout}\n${handoffResult.stderr}`);
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
  if (issue && evidence.repo && evidence.branchName && evidence.worktreeCommand) {
    lines.push(
      [
        `Source issue: ${evidence.repo}#${issue.number} ${issue.title}`,
        `Issue URL: ${issue.url}`,
        `Suggested branch: ${evidence.branchName}`,
        `Suggested Worktrunk command: ${evidence.worktreeCommand}`,
        `Worktree status: ${evidence.worktreeStatus ?? "prepared"}`,
        `Worktree path: ${evidence.worktreePath ?? "(not available)"}`,
        `Pi handoff command: ${evidence.piHandoffCommand ?? "(not launched)"}`,
        `Forge heartbeat command: ${evidence.heartbeatCommand ?? "(not launched)"}`,
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

  const target = await resolveIssueTarget(request, runner, evidence);
  if (!target) return formatWorkonBootstrapEvidence(evidence);

  const issue = await readGithubIssue(request, runner, evidence, target);
  if (!issue) return formatWorkonBootstrapEvidence(evidence);

  const repo = target.repo;
  const branchName = buildWorkonBranchName(issue);
  const worktreeCommand = `wt switch --create ${branchName}`;
  const handoffPrompt = await buildHandoffPrompt({
    cwd: request.cwd,
    issue,
    repo,
    branchName,
    heartbeat: request.heartbeat,
  });
  const initialCapsule = await writeCapsule({
    request,
    issue,
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
  evidence.repo = repo;
  evidence.branchName = branchName;
  evidence.worktreeCommand = worktreeCommand;
  evidence.worktreeStatus = worktree.status;
  evidence.worktreePath = worktree.path;
  evidence.piHandoffCommand = worktree.piHandoffCommand;
  evidence.heartbeatCommand = worktree.heartbeatCommand;
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
