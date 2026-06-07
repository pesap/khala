import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type InboxForge = "auto" | "github" | "gitlab" | "all";
export type InboxScope = "auto" | "current" | "global";
export type InboxFocus =
  | "all"
  | "reviews"
  | "issues"
  | "prs"
  | "ci"
  | "local"
  | "sessions";

export const INBOX_FORGES: readonly InboxForge[] = [
  "auto",
  "github",
  "gitlab",
  "all",
];
export const INBOX_FOCUS_VALUES: readonly InboxFocus[] = [
  "all",
  "reviews",
  "issues",
  "prs",
  "ci",
  "local",
  "sessions",
];
export const INBOX_SCOPE_VALUES: readonly InboxScope[] = [
  "auto",
  "current",
  "global",
];

export interface InboxEvidenceRequest {
  cwd: string;
  limit: number;
  repo: string;
  user: string;
  forge: InboxForge;
  focus: InboxFocus;
  scope?: InboxScope;
  capsuleRoot?: string;
  nowIso?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type InboxCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<CommandResult>;

interface GithubRepository {
  nameWithOwner: string;
  url?: string;
  updatedAt?: string;
  isArchived?: boolean;
  isPrivate?: boolean;
  viewerPermission?: string;
}

interface GithubSearchItem {
  number: number;
  title: string;
  url: string;
  updatedAt?: string;
  isDraft?: boolean;
  repository?: {
    nameWithOwner?: string;
    name?: string;
  };
  labels?: Array<{ name?: string }>;
}

export type InboxFreshness = "fresh" | "stale" | "ancient" | "unknown";

export interface InboxItem {
  bucket: string;
  repo: string;
  source: string;
  title: string;
  url: string;
  updatedAt?: string;
  freshness?: InboxFreshness;
  suggestedCommand: string;
  evidence: string;
}

export type InboxCollectorName = "github" | "gitlab" | "local" | "sessions";
export type InboxCollectorStatus = "ok" | "partial" | "skipped" | "failed";
export type InboxSnapshotStatus = "success" | "partial" | "failed";

export interface InboxCollectorSnapshot {
  name: InboxCollectorName;
  status: InboxCollectorStatus;
  gaps: string[];
  commands: string[];
}

export interface InboxSnapshot {
  generatedAt: string;
  scope: {
    cwd: string;
    repo?: string;
    user?: string;
    forge: InboxForge;
    focus: InboxFocus;
  };
  status: InboxSnapshotStatus;
  collectors: InboxCollectorSnapshot[];
  items: InboxItem[];
}

const INBOX_BUCKETS = [
  "Needs you now",
  "My work is broken",
  "Agent/session needs attention",
  "New work needs shaping",
  "Ready for agents",
  "Low-risk background",
] as const;

const SOURCE_PRIORITY = new Map<string, number>([
  ["review-requested-pr", 0],
  ["authored-pr-ci-failure", 0],
  ["authored-pr-ci-pending", 1],
  ["local-worktree", 2],
  ["stale-session-capsule", 3],
  ["assigned-issue", 0],
  ["authored-issue", 1],
]);

interface GithubEvidence {
  commands: string[];
  gaps: string[];
  repositories: GithubRepository[];
  items: InboxItem[];
}

interface GitWorktree {
  path: string;
  branch?: string;
  detached?: boolean;
}

interface SessionCapsule {
  path: string;
  repo: string;
  issue?: string;
  issueNumber?: string;
  branch?: string;
  worktreePath?: string;
  worktreeStatus?: string;
  state?: string;
  createdIso?: string;
}

interface LocalEvidence {
  commands: string[];
  gaps: string[];
  items: InboxItem[];
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

function parseJsonObject<T>(
  raw: string,
  gapLabel: string,
  gaps: string[],
): T | null {
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
  const detail =
    result.error || result.stderr || result.stdout || "command failed";
  return `${label}: ${detail.trim().split("\n")[0]}`;
}

function repoName(item: GithubSearchItem): string {
  return (
    item.repository?.nameWithOwner || item.repository?.name || "unknown/repo"
  );
}

function itemLine(item: InboxItem): string {
  const updated = item.updatedAt ?? "unknown";
  return `- source=${item.source} repo=${item.repo} title="#${item.title}" updated=${updated} url=${item.url} next=${item.suggestedCommand} evidence=${item.evidence}`;
}

function bucketPriority(bucket: string): number {
  const index = INBOX_BUCKETS.indexOf(bucket as (typeof INBOX_BUCKETS)[number]);
  return index === -1 ? INBOX_BUCKETS.length : index;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

function freshnessPriority(item: InboxItem): number {
  if (isBlockingInboxItem(item)) return 0;
  switch (item.freshness) {
    case "fresh":
      return 0;
    case "stale":
      return 1;
    case "ancient":
      return 3;
    case "unknown":
    case undefined:
      return 2;
  }
}

function compareOptionalIsoNewestFirst(a?: string, b?: string): number {
  if (a && b && a !== b) return b.localeCompare(a);
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function isBlockingInboxItem(item: InboxItem): boolean {
  return (
    item.source === "authored-pr-ci-failure" ||
    item.bucket === "My work is broken" ||
    item.source === "stale-session-capsule" ||
    item.source === "local-worktree"
  );
}

function isActiveInboxItem(item: InboxItem): boolean {
  return item.freshness !== "ancient" || isBlockingInboxItem(item);
}

function compareInboxItems(a: InboxItem, b: InboxItem): number {
  return (
    freshnessPriority(a) - freshnessPriority(b) ||
    bucketPriority(a.bucket) - bucketPriority(b.bucket) ||
    (SOURCE_PRIORITY.get(a.source) ?? Number.MAX_SAFE_INTEGER) -
      (SOURCE_PRIORITY.get(b.source) ?? Number.MAX_SAFE_INTEGER) ||
    compareOptionalIsoNewestFirst(a.updatedAt, b.updatedAt) ||
    compareText(a.repo, b.repo) ||
    compareText(a.title, b.title) ||
    compareText(a.url, b.url)
  );
}

function classifyInboxFreshness(
  updatedAt: string | undefined,
  nowIso: string,
): InboxFreshness {
  if (!updatedAt) return "unknown";
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(updatedMs) || Number.isNaN(nowMs)) return "unknown";
  const ageDays = Math.max(0, (nowMs - updatedMs) / 86_400_000);
  if (ageDays <= 7) return "fresh";
  if (ageDays <= 90) return "stale";
  return "ancient";
}

function classifyInboxItems(items: InboxItem[], nowIso: string): InboxItem[] {
  return items.map((item) => ({
    ...item,
    freshness: item.freshness ?? classifyInboxFreshness(item.updatedAt, nowIso),
  }));
}

function sortedInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort(compareInboxItems);
}

function topNextCommands(items: InboxItem[], limit = 3): string[] {
  const commands: string[] = [];
  for (const item of sortedInboxItems(items)) {
    if (!commands.includes(item.suggestedCommand)) {
      commands.push(item.suggestedCommand);
    }
    if (commands.length === limit) break;
  }
  return commands;
}

function renderMaintainerQueue(items: InboxItem[]): string {
  const sortedItems = sortedInboxItems(items);
  const lines = ["Deterministic maintainer queue:"];
  for (const bucket of INBOX_BUCKETS) {
    const bucketItems = sortedItems.filter((item) => item.bucket === bucket);
    lines.push(`${bucket} (${bucketItems.length}):`);
    lines.push(
      ...(bucketItems.length > 0
        ? bucketItems.map(itemLine)
        : ["- no collected items"]),
    );
  }
  const commands = topNextCommands(items);
  lines.push("Top 3 next commands:");
  lines.push(
    ...(commands.length > 0
      ? commands.map((command, index) => `${index + 1}. ${command}`)
      : ["- none from collected evidence"]),
  );
  return lines.join("\n");
}

function searchItemToInboxItem(
  item: GithubSearchItem,
  params: {
    bucket: string;
    source: string;
    suggestedCommand: (repo: string, item: GithubSearchItem) => string;
    evidence: string;
  },
): InboxItem | null {
  if (!item.url || !item.title || typeof item.number !== "number") return null;
  const repo = repoName(item);
  return {
    bucket: params.bucket,
    repo,
    source: params.source,
    title: `${item.number}: ${item.title}`,
    url: item.url,
    updatedAt: item.updatedAt,
    suggestedCommand: params.suggestedCommand(repo, item),
    evidence: params.evidence,
  };
}

function shouldCollectReviewRequests(focus: InboxFocus): boolean {
  return focus === "all" || focus === "reviews" || focus === "prs";
}

function shouldCollectPrCiSignals(focus: InboxFocus): boolean {
  return focus === "all" || focus === "prs" || focus === "ci";
}

function shouldCollectIssueSignals(focus: InboxFocus): boolean {
  return focus === "all" || focus === "issues";
}

function shouldCollectGithub(forge: InboxForge): boolean {
  return forge === "auto" || forge === "github" || forge === "all";
}

function shouldCollectWorktrees(focus: InboxFocus): boolean {
  return focus === "all" || focus === "local";
}

function shouldCollectSessions(focus: InboxFocus): boolean {
  return focus === "all" || focus === "local" || focus === "sessions";
}

function repoSearchArgs(repo: string): string[] {
  return repo ? ["--repo", repo] : [];
}

const SEARCH_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "repository",
  "updatedAt",
] as const;

function searchJsonFields(extraFields: readonly string[] = []): string[] {
  return ["--json", [...SEARCH_JSON_FIELDS, ...extraFields, "labels"].join(",")];
}

function prSearchJsonFields(): string[] {
  return searchJsonFields(["isDraft"]);
}

function issueSearchJsonFields(): string[] {
  return searchJsonFields();
}

function repositoryJsonFields(): string[] {
  return [
    "--json",
    "nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission",
  ];
}

async function runGh(
  runner: InboxCommandRunner,
  cwd: string,
  commands: string[],
  args: string[],
): Promise<CommandResult> {
  commands.push(`gh ${args.join(" ")}`);
  return runner("gh", args, { cwd });
}

async function runGit(
  runner: InboxCommandRunner,
  cwd: string,
  commands: string[],
  args: string[],
): Promise<CommandResult> {
  commands.push(`(cd ${cwd} && git ${args.join(" ")})`);
  return runner("git", args, { cwd });
}

function normalizeBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function parseWorktreeList(raw: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...valueParts] = line.split(" ");
    const value = valueParts.join(" ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value };
    } else if (key === "branch" && current) {
      current.branch = normalizeBranch(value);
    } else if (key === "detached" && current) {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function statusHasUncommitted(raw: string): boolean {
  return raw.split("\n").some((line) => line.trim() && !line.startsWith("##"));
}

function statusHeader(raw: string): string {
  return raw.split("\n").find((line) => line.startsWith("##")) ?? "";
}

function statusHasUnpushed(raw: string): boolean {
  return /\[([^\]]*, )?ahead \d+/.test(statusHeader(raw));
}

function statusHasUpstream(raw: string): boolean {
  return statusHeader(raw).includes("...");
}

function statusHasGoneUpstream(raw: string): boolean {
  return /\bgone\b/.test(statusHeader(raw));
}

function currentRepoFromRemote(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /github\.com[:/](?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/,
  );
  if (!match?.groups) return null;
  return `${match.groups.owner}/${match.groups.repo}`;
}

function parseCapsuleFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(?<key>[A-Za-z][A-Za-z ]+):\s*(?<value>.*)$/);
    if (match?.groups) fields[match.groups.key] = match.groups.value.trim();
  }
  return fields;
}

function normalizedCapsuleValue(value?: string): string | undefined {
  if (
    !value ||
    /^\((?:not available|not launched|none|unknown)\)$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

function parseCapsuleCreated(value?: string): string | undefined {
  const created = normalizedCapsuleValue(value);
  if (!created) return undefined;
  const parsed = new Date(created);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function capsuleRepoFromPath(root: string, capsulePath: string): string {
  const relative = path.relative(path.join(root, "github.com"), capsulePath);
  const [owner, name] = relative.split(path.sep);
  return owner && name ? `${owner}/${name}` : "unknown/repo";
}

async function readSessionCapsule(
  root: string,
  capsulePath: string,
): Promise<SessionCapsule | null> {
  try {
    const content = await readFile(capsulePath, "utf8");
    const fields = parseCapsuleFields(content);
    return {
      path: capsulePath,
      repo:
        normalizedCapsuleValue(fields.Repo) ??
        capsuleRepoFromPath(root, capsulePath),
      issue: normalizedCapsuleValue(fields.Issue),
      issueNumber: normalizedCapsuleValue(fields["Issue number"]),
      branch: normalizedCapsuleValue(fields.Branch),
      worktreePath: normalizedCapsuleValue(fields["Worktree path"]),
      worktreeStatus: normalizedCapsuleValue(fields["Worktree status"]),
      state: normalizedCapsuleValue(fields.State),
      createdIso: parseCapsuleCreated(fields.Created),
    };
  } catch {
    return null;
  }
}

async function discoverSessionCapsules(
  root: string,
  gaps: string[],
): Promise<SessionCapsule[]> {
  const githubRoot = path.join(root, "github.com");
  let owners: string[];
  try {
    owners = await readdir(githubRoot);
  } catch {
    gaps.push(
      `session capsule discovery: no capsules found under ${githubRoot}`,
    );
    return [];
  }

  const capsulePaths: string[] = [];
  for (const owner of owners.sort()) {
    const ownerRoot = path.join(githubRoot, owner);
    let repos: string[];
    try {
      repos = await readdir(ownerRoot);
    } catch {
      continue;
    }
    for (const repo of repos.sort()) {
      capsulePaths.push(path.join(ownerRoot, repo, "capsule.md"));
    }
  }

  const capsules: SessionCapsule[] = [];
  for (const capsulePath of capsulePaths) {
    const capsule = await readSessionCapsule(root, capsulePath);
    if (capsule) capsules.push(capsule);
  }
  return capsules;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function capsuleWorktreeEvidence(
  capsule: SessionCapsule,
  worktrees: GitWorktree[],
): { path?: string; missing: boolean; matchedBy: string } {
  if (capsule.worktreePath) {
    return {
      path: capsule.worktreePath,
      missing: false,
      matchedBy: "capsule worktree path",
    };
  }
  if (capsule.branch) {
    const match = worktrees.find(
      (worktree) => worktree.branch === capsule.branch,
    );
    if (match)
      return {
        path: match.path,
        missing: false,
        matchedBy: "git worktree branch",
      };
  }
  return { missing: false, matchedBy: "no local worktree match" };
}

async function collectLocalEvidence(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
  effectiveScope: Exclude<InboxScope, "auto">,
): Promise<LocalEvidence> {
  const evidence: LocalEvidence = { commands: [], gaps: [], items: [] };
  const collectWorktrees =
    effectiveScope === "current" && shouldCollectWorktrees(request.focus);
  const collectSessions = shouldCollectSessions(request.focus);
  const discoverWorktrees =
    effectiveScope === "current" && (collectWorktrees || collectSessions);
  if (!collectWorktrees && !collectSessions) {
    evidence.gaps.push(`Local collector skipped for focus=${request.focus}`);
    return evidence;
  }

  let repo: string | null = request.repo || null;
  if (effectiveScope === "current") {
    const gitRoot = await runGit(runner, request.cwd, evidence.commands, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (!gitRoot.ok || gitRoot.stdout.trim() !== "true") {
      evidence.gaps.push(
        `Local git collector skipped: ${request.cwd} is not inside a git repository`,
      );
      return evidence;
    }

    const remote = await runGit(runner, request.cwd, evidence.commands, [
      "remote",
      "get-url",
      "origin",
    ]);
    repo = repo || (remote.ok ? currentRepoFromRemote(remote.stdout) : null);
  }

  let worktrees: GitWorktree[] = [];
  if (discoverWorktrees) {
    const worktreeResult = await runGit(
      runner,
      request.cwd,
      evidence.commands,
      ["worktree", "list", "--porcelain"],
    );
    const worktreeGap = resultGap("local git worktrees", worktreeResult);
    if (worktreeGap) {
      evidence.gaps.push(worktreeGap);
    } else {
      worktrees = parseWorktreeList(worktreeResult.stdout).slice(
        0,
        request.limit,
      );
    }
  }

  if (collectWorktrees) {
    for (const worktree of worktrees) {
      const status = await runGit(runner, worktree.path, evidence.commands, [
        "status",
        "--porcelain=v1",
        "-b",
      ]);
      const statusGap = resultGap(`local git status ${worktree.path}`, status);
      if (statusGap) {
        evidence.gaps.push(statusGap);
        continue;
      }

      const dirty = statusHasUncommitted(status.stdout);
      const unpushed = statusHasUnpushed(status.stdout);
      const unpublished =
        Boolean(worktree.branch) && !statusHasUpstream(status.stdout);
      const gone = statusHasGoneUpstream(status.stdout);
      if (!dirty && !unpushed && !unpublished && !gone) continue;

      const signals = [
        dirty ? "uncommitted" : "",
        unpushed ? "unpushed" : "",
        unpublished ? "unpublished" : "",
        gone ? "missing-upstream" : "",
      ].filter(Boolean);
      const branch =
        worktree.branch ?? (worktree.detached ? "detached" : "unknown");
      evidence.items.push({
        bucket: gone ? "My work is broken" : "Agent/session needs attention",
        repo: repo ?? "current-repo",
        source: "local-worktree",
        title: `${branch}: ${signals.join("+")} work at ${worktree.path}`,
        url: worktree.path,
        suggestedCommand: `/inbox --focus local`,
        evidence: "git worktree list --porcelain; git status --porcelain=v1 -b",
      });
    }
  }

  if (!collectSessions) return evidence;

  const capsuleRoot =
    request.capsuleRoot ?? path.join(homedir(), ".pi", "khala");
  const capsules = (await discoverSessionCapsules(capsuleRoot, evidence.gaps))
    .filter((capsule) => !request.repo || capsule.repo === request.repo)
    .slice(0, request.limit);
  if (capsules.length === 0) return evidence;

  const now = new Date(request.nowIso ?? new Date().toISOString());
  for (const capsule of capsules) {
    const created = capsule.createdIso;
    const ageHours = created
      ? Math.floor((now.getTime() - new Date(created).getTime()) / 3_600_000)
      : null;
    const worktree = capsuleWorktreeEvidence(capsule, worktrees);
    const missingWorktree = capsule.worktreePath
      ? !(await pathExists(capsule.worktreePath))
      : false;
    const blocked = capsule.worktreeStatus === "blocked";
    const stale = ageHours !== null && ageHours >= 24;
    if (!blocked && !stale && !missingWorktree) continue;

    const signals = [
      blocked ? "blocked" : "",
      stale && ageHours !== null ? `stale-${ageHours}h` : "",
      missingWorktree ? "missing-worktree" : "",
    ].filter(Boolean);
    const branch = capsule.branch ?? "unknown-branch";
    const issue = capsule.issueNumber ? ` ${capsule.issueNumber}` : "";
    const worktreePath = worktree.path ? ` worktree=${worktree.path}` : "";
    evidence.items.push({
      bucket:
        blocked || missingWorktree
          ? "My work is broken"
          : "Agent/session needs attention",
      repo: capsule.repo,
      source: "stale-session-capsule",
      title: `${branch}${issue}: ${signals.join("+")} capsule at ${capsule.path}${worktreePath}`,
      url: capsule.issue ?? capsule.path,
      updatedAt: created,
      suggestedCommand: `/workon ${capsule.issue ?? "<issue-number>"} --repo ${capsule.repo}`,
      evidence: `session capsule metadata; ${worktree.matchedBy}`,
    });
  }
  return evidence;
}

async function resolveGithubUser(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
  evidence: GithubEvidence,
): Promise<string> {
  if (!request.user || request.user !== "@me") return request.user;
  const result = await runGh(runner, request.cwd, evidence.commands, [
    "api",
    "user",
    "--jq",
    ".login",
  ]);
  const gap = resultGap("resolve authenticated GitHub user", result);
  if (gap) evidence.gaps.push(gap);
  return result.ok ? result.stdout.trim() || "@me" : "@me";
}

async function collectViewerRepositories(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
  evidence: GithubEvidence,
): Promise<void> {
  const result = await runGh(runner, request.cwd, evidence.commands, [
    "api",
    "graphql",
    "-F",
    `first=${request.limit}`,
    "-f",
    "query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } }",
    "--jq",
    ".data.viewer.repositories.nodes",
  ]);
  const gap = resultGap("repositories for authenticated GitHub user", result);
  if (gap) {
    evidence.gaps.push(gap);
    return;
  }
  evidence.repositories.push(
    ...parseJsonArray<GithubRepository>(
      result.stdout,
      "repositories for authenticated GitHub user",
      evidence.gaps,
    ),
  );
}

async function collectRepositories(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
  evidence: GithubEvidence,
  resolvedUser: string,
): Promise<void> {
  if (request.repo) {
    const result = await runGh(runner, request.cwd, evidence.commands, [
      "repo",
      "view",
      request.repo,
      ...repositoryJsonFields(),
    ]);
    const gap = resultGap(`repo override ${request.repo}`, result);
    if (gap) {
      evidence.gaps.push(gap);
      return;
    }
    const repo = parseJsonObject<GithubRepository>(
      result.stdout,
      `repo override ${request.repo}`,
      evidence.gaps,
    );
    if (repo) evidence.repositories.push(repo);
    if (request.user) {
      evidence.gaps.push(
        "repo override provided; user repository discovery intentionally skipped",
      );
    }
    return;
  }

  if (!resolvedUser) {
    const result = await runGh(runner, request.cwd, evidence.commands, [
      "repo",
      "view",
      ...repositoryJsonFields(),
    ]);
    const gap = resultGap("current repository", result);
    if (gap) {
      evidence.gaps.push(gap);
      return;
    }
    const repo = parseJsonObject<GithubRepository>(
      result.stdout,
      "current repository",
      evidence.gaps,
    );
    if (repo) evidence.repositories.push(repo);
    return;
  }

  if (request.user === "@me") {
    await collectViewerRepositories(request, runner, evidence);
    return;
  }

  const result = await runGh(runner, request.cwd, evidence.commands, [
    "repo",
    "list",
    resolvedUser,
    "--limit",
    String(request.limit),
    "--no-archived",
    ...repositoryJsonFields(),
  ]);
  const gap = resultGap(`repositories for ${resolvedUser}`, result);
  if (gap) {
    evidence.gaps.push(gap);
    return;
  }
  evidence.repositories.push(
    ...parseJsonArray<GithubRepository>(
      result.stdout,
      `repositories for ${resolvedUser}`,
      evidence.gaps,
    ),
  );
}

async function collectSearchItems(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
  evidence: GithubEvidence,
  args: string[],
  itemParams: Parameters<typeof searchItemToInboxItem>[1],
): Promise<void> {
  const result = await runGh(runner, request.cwd, evidence.commands, args);
  const gap = resultGap(args.slice(0, 3).join(" "), result);
  if (gap) {
    evidence.gaps.push(gap);
    return;
  }
  const items = parseJsonArray<GithubSearchItem>(
    result.stdout,
    args.slice(0, 3).join(" "),
    evidence.gaps,
  );
  for (const item of items) {
    const inboxItem = searchItemToInboxItem(item, itemParams);
    if (inboxItem) evidence.items.push(inboxItem);
  }
}

async function collectGithubEvidence(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
): Promise<GithubEvidence> {
  const evidence: GithubEvidence = {
    commands: [],
    gaps: [],
    repositories: [],
    items: [],
  };

  if (!shouldCollectGithub(request.forge)) {
    evidence.gaps.push(`GitHub collector skipped for forge=${request.forge}`);
    return evidence;
  }
  if (request.forge === "all") {
    evidence.gaps.push("GitLab collector is not implemented in this slice");
  }

  const auth = await runGh(runner, request.cwd, evidence.commands, [
    "auth",
    "status",
  ]);
  const authGap = resultGap("GitHub authentication", auth);
  if (authGap) {
    evidence.gaps.push(authGap);
    return evidence;
  }

  const resolvedUser = await resolveGithubUser(request, runner, evidence);
  await collectRepositories(request, runner, evidence, resolvedUser);

  const scopedRepoArgs = repoSearchArgs(request.repo);
  if (shouldCollectReviewRequests(request.focus)) {
    await collectSearchItems(
      request,
      runner,
      evidence,
      [
        "search",
        "prs",
        "--review-requested=@me",
        "--state=open",
        "--limit",
        String(request.limit),
        ...scopedRepoArgs,
        ...prSearchJsonFields(),
      ],
      {
        bucket: "Needs you now",
        source: "review-requested-pr",
        suggestedCommand: (_repo, item) => `/review pr ${item.url}`,
        evidence: "gh search prs --review-requested=@me --state=open",
      },
    );
  }

  if (shouldCollectPrCiSignals(request.focus)) {
    await collectSearchItems(
      request,
      runner,
      evidence,
      [
        "search",
        "prs",
        "--author=@me",
        "--state=open",
        "--checks=failure",
        "--limit",
        String(request.limit),
        ...scopedRepoArgs,
        ...prSearchJsonFields(),
      ],
      {
        bucket: "My work is broken",
        source: "authored-pr-ci-failure",
        suggestedCommand: (repo) => `/inbox --repo ${repo} --focus ci`,
        evidence: "gh search prs --author=@me --state=open --checks=failure",
      },
    );

    await collectSearchItems(
      request,
      runner,
      evidence,
      [
        "search",
        "prs",
        "--author=@me",
        "--state=open",
        "--checks=pending",
        "--limit",
        String(request.limit),
        ...scopedRepoArgs,
        ...prSearchJsonFields(),
      ],
      {
        bucket: "My work is broken",
        source: "authored-pr-ci-pending",
        suggestedCommand: (repo) => `/inbox --repo ${repo} --focus ci`,
        evidence: "gh search prs --author=@me --state=open --checks=pending",
      },
    );
  }

  if (shouldCollectIssueSignals(request.focus)) {
    await collectSearchItems(
      request,
      runner,
      evidence,
      [
        "search",
        "issues",
        "--assignee=@me",
        "--state=open",
        "--limit",
        String(request.limit),
        ...scopedRepoArgs,
        ...issueSearchJsonFields(),
      ],
      {
        bucket: "New work needs shaping",
        source: "assigned-issue",
        suggestedCommand: (_repo, item) => `/triage ${item.url}`,
        evidence: "gh search issues --assignee=@me --state=open",
      },
    );

    await collectSearchItems(
      request,
      runner,
      evidence,
      [
        "search",
        "issues",
        "--author=@me",
        "--state=open",
        "--limit",
        String(request.limit),
        ...scopedRepoArgs,
        ...issueSearchJsonFields(),
      ],
      {
        bucket: "New work needs shaping",
        source: "authored-issue",
        suggestedCommand: (_repo, item) => `/triage ${item.url}`,
        evidence: "gh search issues --author=@me --state=open",
      },
    );
  }

  return evidence;
}

export function formatLocalInboxEvidence(evidence: LocalEvidence): string[] {
  const itemLines = evidence.items.map(itemLine);
  const gapLines = evidence.gaps.map((gap) => `- ${gap}`);
  const commandLines = evidence.commands.map((command) => `- ${command}`);

  return [
    "Deterministic local inbox evidence (read-only):",
    itemLines.length > 0
      ? ["Local queue candidates:", ...itemLines].join("\n")
      : "Local queue candidates: none reported by git/session metadata.",
    gapLines.length > 0
      ? ["Local evidence gaps and graceful degradation:", ...gapLines].join(
          "\n",
        )
      : "Local evidence gaps and graceful degradation: none.",
    ["Read-only local commands executed:", ...commandLines].join("\n"),
  ];
}

export function formatGithubInboxEvidence(
  evidence: GithubEvidence,
  queueItems: InboxItem[] = evidence.items,
): string[] {
  const repoLines = evidence.repositories.slice(0, 20).map((repo) => {
    const privacy = repo.isPrivate ? "private" : "public";
    const permission = repo.viewerPermission
      ? ` permission=${repo.viewerPermission}`
      : "";
    const updated = repo.updatedAt ? ` updated=${repo.updatedAt}` : "";
    return `- ${repo.nameWithOwner} (${privacy}${permission}${updated}) ${repo.url ?? ""}`.trim();
  });

  const gapLines = evidence.gaps.map((gap) => `- ${gap}`);
  const commandLines = evidence.commands.map((command) => `- ${command}`);

  return [
    "Deterministic GitHub inbox evidence (read-only):",
    repoLines.length > 0
      ? ["Repository discovery:", ...repoLines].join("\n")
      : "Repository discovery: no repositories reported.",
    renderMaintainerQueue(queueItems),
    gapLines.length > 0
      ? ["Evidence gaps and graceful degradation:", ...gapLines].join("\n")
      : "Evidence gaps and graceful degradation: none.",
    ["Read-only commands executed:", ...commandLines].join("\n"),
  ];
}

async function isInsideGitRepository(
  cwd: string,
  runner: InboxCommandRunner,
): Promise<boolean> {
  const result = await runner("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
  });
  return result.ok && result.stdout.trim() === "true";
}

async function resolveInboxScope(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
): Promise<Exclude<InboxScope, "auto">> {
  if (request.scope === "global") return "global";
  if (request.scope === "current") return "current";
  return (await isInsideGitRepository(request.cwd, runner))
    ? "current"
    : "global";
}

function requestForScope(
  request: InboxEvidenceRequest,
  effectiveScope: Exclude<InboxScope, "auto">,
): InboxEvidenceRequest {
  if (effectiveScope === "global" && !request.repo && !request.user) {
    return { ...request, user: "@me" };
  }
  return request;
}

function collectorStatus(
  gaps: string[],
  commands: string[],
): InboxCollectorStatus {
  if (gaps.some((gap) => gap.includes(" skipped "))) return "skipped";
  if (commands.length === 0 && gaps.length > 0) return "failed";
  if (gaps.length > 0) return "partial";
  return "ok";
}

function snapshotStatus(
  collectors: InboxCollectorSnapshot[],
): InboxSnapshotStatus {
  if (collectors.every((collector) => collector.status === "failed")) {
    return "failed";
  }
  if (collectors.some((collector) => collector.status !== "ok")) {
    return "partial";
  }
  return "success";
}

export async function collectInboxSnapshot(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner = createExecFileRunner(),
): Promise<InboxSnapshot> {
  const effectiveScope = await resolveInboxScope(request, runner);
  const scopedRequest = requestForScope(request, effectiveScope);
  const [githubEvidence, localEvidence] = await Promise.all([
    collectGithubEvidence(scopedRequest, runner),
    collectLocalEvidence(scopedRequest, runner, effectiveScope),
  ]);
  const collectors: InboxCollectorSnapshot[] = [
    {
      name: "github",
      status: collectorStatus(githubEvidence.gaps, githubEvidence.commands),
      gaps: [...githubEvidence.gaps].sort(compareText),
      commands: [...githubEvidence.commands],
    },
    {
      name: "local",
      status: collectorStatus(localEvidence.gaps, localEvidence.commands),
      gaps: [...localEvidence.gaps].sort(compareText),
      commands: [...localEvidence.commands],
    },
  ];
  const generatedAt = request.nowIso ?? new Date().toISOString();
  const items = classifyInboxItems(
    [...githubEvidence.items, ...localEvidence.items],
    generatedAt,
  ).sort(compareInboxItems);

  return {
    generatedAt,
    scope: {
      cwd: request.cwd,
      repo: scopedRequest.repo || undefined,
      user: scopedRequest.user || undefined,
      forge: scopedRequest.forge,
      focus: scopedRequest.focus,
    },
    status: snapshotStatus(collectors),
    collectors,
    items,
  };
}

function formatInboxTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return iso.replace("T", " ").slice(0, 16);
}

function formatCollectorHealth(snapshot: InboxSnapshot): string {
  return snapshot.collectors
    .map((collector) => `${collector.name} ${collector.status}`)
    .join(" · ");
}

function conciseItemReason(item: InboxItem): string {
  const source = item.source.replaceAll("-", " ");
  const freshness = item.freshness ? `${item.freshness} ` : "";
  const updated = item.updatedAt ? `, updated ${item.updatedAt}` : "";
  return `${freshness}${source}${updated}`;
}

function renderDoNextItem(item: InboxItem, index: number): string {
  return [
    `${index + 1}. ${item.repo} #${item.title} — ${conciseItemReason(item)}`,
    `   ${item.suggestedCommand}`,
  ].join("\n");
}

function countBySource(items: InboxItem[], source: string): number {
  return items.filter((item) => item.source === source).length;
}

function renderCompactCounts(items: InboxItem[]): string {
  const reviewCount = countBySource(items, "review-requested-pr");
  const brokenCiCount =
    countBySource(items, "authored-pr-ci-failure") +
    countBySource(items, "authored-pr-ci-pending");
  const blockedSessionCount = items.filter(
    (item) =>
      item.source === "stale-session-capsule" && item.bucket === "My work is broken",
  ).length;
  const issueCount =
    countBySource(items, "assigned-issue") + countBySource(items, "authored-issue");
  const localCount = countBySource(items, "local-worktree");
  return `Counts: reviews ${reviewCount}, broken CI ${brokenCiCount}, blocked sessions ${blockedSessionCount}, issues ${issueCount}, local ${localCount}`;
}

function renderCompactGaps(snapshot: InboxSnapshot): string {
  const gaps = snapshot.collectors.flatMap((collector) => collector.gaps);
  if (gaps.length === 0) return "Gaps: none";
  return `Gaps: ${gaps.slice(0, 3).join("; ")}${gaps.length > 3 ? `; +${gaps.length - 3} more` : ""}`;
}

export function renderInboxSnapshotCompact(snapshot: InboxSnapshot): string {
  const sortedItems = sortedInboxItems(
    classifyInboxItems(snapshot.items, snapshot.generatedAt),
  );
  const activeItems = sortedItems.filter(isActiveInboxItem);
  const topItems = (activeItems.length > 0 ? activeItems : sortedItems).slice(
    0,
    5,
  );
  const staleItems = sortedItems.filter((item) => item.freshness === "ancient");
  const lines = [
    `Inbox · ${formatInboxTimestamp(snapshot.generatedAt)} · ${snapshot.status}`,
    formatCollectorHealth(snapshot),
    "",
    "Do next",
  ];
  lines.push(
    ...(topItems.length > 0
      ? topItems.map(renderDoNextItem)
      : ["- No ranked actions from collected evidence."]),
  );
  if (staleItems.length > 0) {
    lines.push(
      "",
      "Stale/noisy",
      ...staleItems.slice(0, 5).map(renderDoNextItem),
    );
  }
  lines.push("", renderCompactCounts(snapshot.items), renderCompactGaps(snapshot));
  return `${lines.join("\n")}\n`;
}

export function renderInboxSnapshotJson(snapshot: InboxSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export async function collectInboxDashboard(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner = createExecFileRunner(),
): Promise<string[]> {
  const snapshot = await collectInboxSnapshot(request, runner);
  return [renderInboxSnapshotCompact(snapshot).trimEnd()];
}

export async function collectInboxEvidence(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner = createExecFileRunner(),
): Promise<string[]> {
  const effectiveScope = await resolveInboxScope(request, runner);
  const scopedRequest = requestForScope(request, effectiveScope);
  const [githubEvidence, localEvidence] = await Promise.all([
    collectGithubEvidence(scopedRequest, runner),
    collectLocalEvidence(scopedRequest, runner, effectiveScope),
  ]);
  return [
    ...formatGithubInboxEvidence(githubEvidence, [
      ...githubEvidence.items,
      ...localEvidence.items,
    ]),
    ...formatLocalInboxEvidence(localEvidence),
  ];
}

export function createExecFileRunner(): InboxCommandRunner {
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
