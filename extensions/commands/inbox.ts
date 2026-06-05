import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type InboxForge = "auto" | "github" | "gitlab" | "all";
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

export interface InboxEvidenceRequest {
  cwd: string;
  limit: number;
  repo: string;
  user: string;
  forge: InboxForge;
  focus: InboxFocus;
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

interface InboxItem {
  bucket: string;
  repo: string;
  source: string;
  title: string;
  url: string;
  updatedAt?: string;
  suggestedCommand: string;
  evidence: string;
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

function compareOptionalIso(a?: string, b?: string): number {
  if (a && b && a !== b) return a.localeCompare(b);
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

function compareInboxItems(a: InboxItem, b: InboxItem): number {
  return (
    bucketPriority(a.bucket) - bucketPriority(b.bucket) ||
    (SOURCE_PRIORITY.get(a.source) ?? Number.MAX_SAFE_INTEGER) -
      (SOURCE_PRIORITY.get(b.source) ?? Number.MAX_SAFE_INTEGER) ||
    compareOptionalIso(a.updatedAt, b.updatedAt) ||
    compareText(a.repo, b.repo) ||
    compareText(a.title, b.title) ||
    compareText(a.url, b.url)
  );
}

function sortedInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort(compareInboxItems);
}

function topNextCommands(items: InboxItem[]): string[] {
  const commands: string[] = [];
  for (const item of sortedInboxItems(items)) {
    if (!commands.includes(item.suggestedCommand)) {
      commands.push(item.suggestedCommand);
    }
    if (commands.length === 3) break;
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

function searchJsonFields(): string[] {
  return ["--json", "number,title,url,repository,updatedAt,isDraft,labels"];
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

async function capsuleCreatedIso(capsulePath: string): Promise<string | null> {
  try {
    const content = await readFile(capsulePath, "utf8");
    const created = content.match(/^Created:\s*(?<created>\S+)/m)?.groups
      ?.created;
    if (!created) return null;
    const parsed = new Date(created);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

async function collectLocalEvidence(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner,
): Promise<LocalEvidence> {
  const evidence: LocalEvidence = { commands: [], gaps: [], items: [] };
  const collectWorktrees = shouldCollectWorktrees(request.focus);
  const collectSessions = shouldCollectSessions(request.focus);
  if (!collectWorktrees && !collectSessions) {
    evidence.gaps.push(`Local collector skipped for focus=${request.focus}`);
    return evidence;
  }

  const remote = await runGit(runner, request.cwd, evidence.commands, [
    "remote",
    "get-url",
    "origin",
  ]);
  const repo =
    request.repo || (remote.ok ? currentRepoFromRemote(remote.stdout) : null);

  if (collectWorktrees) {
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
      const worktrees = parseWorktreeList(worktreeResult.stdout).slice(
        0,
        request.limit,
      );
      for (const worktree of worktrees) {
        const status = await runGit(runner, worktree.path, evidence.commands, [
          "status",
          "--porcelain=v1",
          "-b",
        ]);
        const statusGap = resultGap(
          `local git status ${worktree.path}`,
          status,
        );
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
          evidence:
            "git worktree list --porcelain; git status --porcelain=v1 -b",
        });
      }
    }
  }

  if (!collectSessions) return evidence;

  if (!repo) {
    evidence.gaps.push(
      "session capsule lookup skipped: GitHub repo could not be inferred",
    );
    return evidence;
  }

  const [owner, name] = repo.split("/");
  const capsulePath = path.join(
    request.capsuleRoot ?? path.join(homedir(), ".pi", "khala"),
    "github.com",
    owner,
    name,
    "capsule.md",
  );
  const created = await capsuleCreatedIso(capsulePath);
  if (!created) {
    evidence.gaps.push(
      `session capsule Created metadata not found for ${repo}`,
    );
    return evidence;
  }

  const now = new Date(request.nowIso ?? new Date().toISOString());
  const ageHours = Math.floor(
    (now.getTime() - new Date(created).getTime()) / 3_600_000,
  );
  if (ageHours >= 24) {
    evidence.items.push({
      bucket: "Agent/session needs attention",
      repo,
      source: "stale-session-capsule",
      title: `session capsule is ${ageHours}h old at ${capsulePath}`,
      url: capsulePath,
      updatedAt: created,
      suggestedCommand: `/workon --mode start --repo ${repo}`,
      evidence: "session capsule Created metadata",
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
        ...searchJsonFields(),
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
        ...searchJsonFields(),
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
        ...searchJsonFields(),
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
        ...searchJsonFields(),
      ],
      {
        bucket: "New work needs shaping",
        source: "assigned-issue",
        suggestedCommand: (_repo, item) => `/triage-issue ${item.url}`,
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
        ...searchJsonFields(),
      ],
      {
        bucket: "New work needs shaping",
        source: "authored-issue",
        suggestedCommand: (_repo, item) => `/triage-issue ${item.url}`,
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

export async function collectInboxEvidence(
  request: InboxEvidenceRequest,
  runner: InboxCommandRunner = createExecFileRunner(),
): Promise<string[]> {
  const [githubEvidence, localEvidence] = await Promise.all([
    collectGithubEvidence(request, runner),
    collectLocalEvidence(request, runner),
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
