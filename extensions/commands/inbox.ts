import { execFile } from "node:child_process";
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

interface GithubEvidence {
  commands: string[];
  gaps: string[];
  repositories: GithubRepository[];
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
  const detail = result.error || result.stderr || result.stdout || "command failed";
  return `${label}: ${detail.trim().split("\n")[0]}`;
}

function repoName(item: GithubSearchItem): string {
  return item.repository?.nameWithOwner || item.repository?.name || "unknown/repo";
}

function itemLine(item: InboxItem): string {
  const updated = item.updatedAt ? ` updated=${item.updatedAt}` : "";
  return `- [${item.bucket}] ${item.repo} ${item.source} #${item.title}${updated} url=${item.url} next=${item.suggestedCommand} evidence=${item.evidence}`;
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

function repoSearchArgs(repo: string): string[] {
  return repo ? ["--repo", repo] : [];
}

function searchJsonFields(): string[] {
  return [
    "--json",
    "number,title,url,repository,updatedAt,isDraft,labels",
  ];
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

export function formatGithubInboxEvidence(evidence: GithubEvidence): string[] {
  const repoLines = evidence.repositories.slice(0, 20).map((repo) => {
    const privacy = repo.isPrivate ? "private" : "public";
    const permission = repo.viewerPermission
      ? ` permission=${repo.viewerPermission}`
      : "";
    const updated = repo.updatedAt ? ` updated=${repo.updatedAt}` : "";
    return `- ${repo.nameWithOwner} (${privacy}${permission}${updated}) ${repo.url ?? ""}`.trim();
  });

  const itemLines = evidence.items.map(itemLine);
  const gapLines = evidence.gaps.map((gap) => `- ${gap}`);
  const commandLines = evidence.commands.map((command) => `- ${command}`);

  return [
    "Deterministic GitHub inbox evidence (read-only):",
    repoLines.length > 0
      ? ["Repository discovery:", ...repoLines].join("\n")
      : "Repository discovery: no repositories reported.",
    itemLines.length > 0
      ? ["Pre-bucketed queue candidates:", ...itemLines].join("\n")
      : "Pre-bucketed queue candidates: none reported by GitHub search.",
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
  const evidence = await collectGithubEvidence(request, runner);
  return formatGithubInboxEvidence(evidence);
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
