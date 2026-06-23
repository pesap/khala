import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveWorkflowRoute } from "../runtime/workflow-model-router.ts";
import {
  IMPROVE_LABEL,
  WORKON_READY_PACKET_NORMALIZED_HEADINGS,
  normalizeWorkonPacketHeading,
} from "./workon-ready-packet.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
// Keep this aligned with scripts/workon-zellij-handoff.sh defaults so the parent
// /workon timeout stays above the script's normal tab-wait + pane-launch window.
const ZELLIJ_TAB_WAIT_ATTEMPTS = 150;
const ZELLIJ_TAB_WAIT_SECONDS = 0.2;
const ZELLIJ_PANE_LAUNCH_ATTEMPTS = 3;
const ZELLIJ_PANE_LAUNCH_WAIT_SECONDS = 0.5;
const ZELLIJ_HANDOFF_TIMEOUT_BUFFER_SECONDS = 10;
const DEFAULT_ZELLIJ_HANDOFF_TIMEOUT_MS = Math.ceil((
  ZELLIJ_TAB_WAIT_ATTEMPTS * ZELLIJ_TAB_WAIT_SECONDS
  + ZELLIJ_PANE_LAUNCH_ATTEMPTS * ZELLIJ_PANE_LAUNCH_WAIT_SECONDS
  + ZELLIJ_HANDOFF_TIMEOUT_BUFFER_SECONDS
) * 1000);
const MAX_HANDOFF_DIAGNOSTIC_PART_LENGTH = 160;
const MAX_HANDOFF_DIAGNOSTIC_SUMMARY_LENGTH = 500;
const MAX_BRANCH_NAME_LENGTH = 64;
const MAX_BRANCH_SCOPE_WORDS = 4;
const MIN_SHARED_BRANCH_SCOPE_WORDS = 2;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");

export type WorkonForge = "auto" | "github" | "gitlab" | "all";
export type WorkonMode = "prepare" | "start";
export type WorkonMultiplexer = "auto" | "none" | "zellij" | "tmux";
export type ResolvedWorkonMultiplexer = "none" | "zellij" | "tmux";
export type WorkonThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface WorkonModelSelection {
  exactModel: string;
  exactThinkingLevel: WorkonThinkingLevel;
  routingMode: "default" | "override";
  routingReason: string;
}

type WorkonBootstrapStatus = "prepared" | "started" | "launched" | "blocked";
type WorkonRoute = "not_ready" | WorkonBootstrapStatus;
type WorkonLedgerWorktreeStatus = "not-started" | WorkonBootstrapStatus;

type WorkonLedgerIssue = Pick<GithubIssueMetadata, "number" | "title" | "url" | "state" | "body">;

interface WorkonLedgerAttempt {
  at: string;
  phase: string;
  status: string;
  detail: string | null;
}

interface WorkonHandoffLedger {
  version: 1;
  repo: string;
  sourceIssues: WorkonLedgerIssue[];
  primaryIssue: WorkonLedgerIssue;
  branchName: string | null;
  capsulePath: string | null;
  ledgerPath: string;
  dryRun: boolean;
  route: WorkonRoute;
  modelSelection: WorkonModelSelection;
  worktree: {
    command: string | null;
    status: WorkonLedgerWorktreeStatus;
    path: string | null;
  };
  launchEligibility: {
    activeZellij: boolean;
    requestedMultiplexer: WorkonMultiplexer;
    resolvedMultiplexer: ResolvedWorkonMultiplexer;
  };
  multiplexer: {
    status: "skipped" | "not-attempted" | "launched" | "blocked";
    requested: WorkonMultiplexer;
    resolved: ResolvedWorkonMultiplexer;
    scopeName: string | null;
    scopeId: string | number | null;
    paneId: string | null;
    worktreeAction: string | null;
  };
  zellij: {
    status: "skipped" | "not-attempted" | "launched" | "blocked";
    tabName: string | null;
    tabId: string | number | null;
    worktreeAction: string | null;
  };
  pi: {
    status: "not-launched" | "pi-process-started" | "capsule-acknowledged";
    paneId: string | null;
    paneAction: string | null;
    handoffCommand: string | null;
    acknowledgementCommand: string | null;
  };
  heartbeat: {
    status: "disabled" | "not-launched" | "started";
    interval: string;
    paneId: string | null;
    action: string | null;
    command: string | null;
  };
  phases: Record<string, string>;
  readinessActionItems: string[];
  failureReason: string | null;
  failure: {
    phase: string | null;
    reason: string | null;
    detail: string | null;
    summary: string | null;
  };
  safeNextAction: string;
  recoveryInstructions: string[];
  attempts: WorkonLedgerAttempt[];
  createdAt: string;
  updatedAt: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  rawStdout?: string;
  rawStderr?: string;
  exitCode?: string | number | null;
  signal?: string | null;
  killed?: boolean;
  timedOut?: boolean;
  timeoutMs?: number;
  command?: string;
}

export type WorkonCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
) => Promise<CommandResult>;

export interface WorkonBootstrapRequest {
  cwd: string;
  target: string;
  targets?: string[];
  repo: string;
  forge: WorkonForge;
  forgeHost?: string;
  mode: WorkonMode;
  dryRun?: boolean;
  capsuleRoot: string;
  nowIso: string;
  requestedMultiplexer: WorkonMultiplexer;
  resolvedMultiplexer: ResolvedWorkonMultiplexer;
  heartbeat: string;
  modelSelection?: WorkonModelSelection;
}

export const WORKON_DEFAULT_THINKING_LEVEL: WorkonThinkingLevel = "medium";

function defaultWorkonModelSelection(): WorkonModelSelection {
  const route = resolveWorkflowRoute("workon");
  const profile = route.profile;
  const routeSource = route.source === "flag"
    ? `workflow flag ${route.description}`
    : route.source === "route"
      ? `workflow route config ${route.description}`
      : `builtin ${route.description}`;
  return {
    exactModel: profile.model ?? "",
    exactThinkingLevel: profile.thinkingLevel,
    routingMode: "default",
    routingReason: profile.model
      ? `Khala/workon ${route.profileName} profile (${profile.source}; ${routeSource})`
      : `Khala/workon ${route.profileName} profile unresolved via ${routeSource}: ${profile.reason ?? "unknown reason"}. Run /khala status for setup guidance or pass --model <id>.`,
  };
}

export const DEFAULT_WORKON_MODEL_SELECTION: WorkonModelSelection = {
  get exactModel() {
    return defaultWorkonModelSelection().exactModel;
  },
  get exactThinkingLevel() {
    return defaultWorkonModelSelection().exactThinkingLevel;
  },
  get routingMode() {
    return defaultWorkonModelSelection().routingMode;
  },
  get routingReason() {
    return defaultWorkonModelSelection().routingReason;
  },
};

function workonModelSelection(request: WorkonBootstrapRequest): WorkonModelSelection {
  return request.modelSelection ?? defaultWorkonModelSelection();
}

interface GithubIssueTarget {
  host: string;
  repo: string;
  number: number;
  fromUrl: boolean;
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

interface WorkonBootstrapEvidence {
  commands: string[];
  gaps: string[];
  route?: WorkonRoute;
  capsulePath?: string;
  issue?: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo?: string;
  branchName?: string;
  worktreeCommand?: string;
  worktreeStatus?: WorkonBootstrapStatus;
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt?: string;
  ledgerPath?: string;
  ledger?: WorkonHandoffLedger;
  requestedMultiplexer?: WorkonMultiplexer;
  resolvedMultiplexer?: ResolvedWorkonMultiplexer;
  handoffRecoveryInstructions?: string[];
  handoffOperatorAction?: string;
  handoffFailureSummary?: string;
  failureSummary?: string;
  modelSelection?: WorkonModelSelection;
  readinessActionItems?: string[];
  readinessActionItemsByIssue?: Array<{
    issue: GithubIssueMetadata;
    actionItems: string[];
  }>;
}

export interface ResolveWorkonMultiplexerParams {
  requested: WorkonMultiplexer;
  env: Pick<NodeJS.ProcessEnv, "ZELLIJ" | "TMUX">;
}

export function isActiveZellijEnv(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function resolveWorkonMultiplexer(params: ResolveWorkonMultiplexerParams): ResolvedWorkonMultiplexer {
  if (params.requested !== "auto") return params.requested;
  if (isActiveZellijEnv(params.env.ZELLIJ)) return "zellij";
  if (isActiveZellijEnv(params.env.TMUX)) return "tmux";
  return "none";
}

interface MultiplexerHandoffResult {
  multiplexer?: ResolvedWorkonMultiplexer;
  status?: string;
  reason?: string;
  detail?: string;
  path?: string;
  scopeName?: string;
  scopeId?: string | number;
  tabName?: string;
  tabId?: string | number;
  sessionName?: string;
  sessionId?: string | number;
  piPaneId?: string;
  piPaneAction?: string;
  heartbeatPaneId?: string;
  heartbeatAction?: string;
  worktreeAction?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+$/g, "");
}

type ConventionalBranchType = "feat" | "fix" | "docs" | "refactor" | "test" | "chore" | "perf";

type BranchIssue = Pick<GithubIssueMetadata, "number" | "title">;

const CONVENTIONAL_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore|perf)(?:\(.+?\))?:\s*/i;
const BRANCH_SCOPE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "with",
]);

function inferConventionalBranchType(title: string): ConventionalBranchType | null {
  const match = title.match(CONVENTIONAL_TITLE_PATTERN);
  return (match?.[1]?.toLowerCase() as ConventionalBranchType | undefined) ?? null;
}

function inferBranchPrefix(issues: BranchIssue[]): ConventionalBranchType | "work" {
  const inferredTypes = issues.map((issue) => inferConventionalBranchType(issue.title));
  if (inferredTypes.some((type) => type === null)) return "work";
  const uniqueTypes = new Set(inferredTypes);
  return uniqueTypes.size === 1 ? inferredTypes[0] ?? "work" : "work";
}

function titleWords(title: string): string[] {
  const titleWithoutConventionalPrefix = title.replace(CONVENTIONAL_TITLE_PATTERN, "");
  return slugify(titleWithoutConventionalPrefix || title || "work")
    .split("-")
    .filter((word) => word.length > 0 && !BRANCH_SCOPE_STOP_WORDS.has(word));
}

function branchIssueRange(issues: BranchIssue[]): string {
  if (issues.length === 1) return String(issues[0]?.number ?? "work");

  const numbers = issues.map((issue) => issue.number).sort((left, right) => left - right);
  const contiguous = numbers.every((number, index) => index === 0 || number === (numbers[index - 1] ?? number) + 1);
  if (contiguous) return `${numbers[0]}-${numbers[numbers.length - 1]}`;
  return `${issues[0]?.number ?? numbers[0]}-multi`;
}

function branchScopeWords(issues: BranchIssue[]): string[] {
  const primaryWords = titleWords(issues[0]?.title ?? "work");
  if (issues.length === 1) return primaryWords.slice(0, MAX_BRANCH_SCOPE_WORDS);

  const wordCounts = new Map<string, number>();
  for (const issue of issues) {
    for (const word of new Set(titleWords(issue.title))) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const sharedWords = primaryWords.filter((word) => (wordCounts.get(word) ?? 0) > 1);
  if (sharedWords.length >= MIN_SHARED_BRANCH_SCOPE_WORDS) {
    return sharedWords.slice(0, MAX_BRANCH_SCOPE_WORDS);
  }
  return primaryWords.slice(0, MAX_BRANCH_SCOPE_WORDS);
}

export function buildWorkonBranchName(issueOrIssues: BranchIssue | BranchIssue[]): string {
  const issues = Array.isArray(issueOrIssues) ? issueOrIssues : [issueOrIssues];
  const prefix = inferBranchPrefix(issues);
  const issueRange = branchIssueRange(issues);
  const branchPrefix = `${prefix}/${issueRange}-`;
  const availableScopeLength = Math.max(1, MAX_BRANCH_NAME_LENGTH - branchPrefix.length);
  const scope = slugify(branchScopeWords(issues).join("-") || "work")
    .slice(0, availableScopeLength)
    .replace(/-+$/g, "") || "work";
  return `${branchPrefix}${scope}`;
}

function githubIssueTargetFromUrl(target: string): GithubIssueTarget | null {
  const match = target.trim().match(
    /^(?:https?:\/\/)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/([1-9]\d*)$/i,
  );
  if (!match) return null;
  return {
    host: normalizeForgeHost(match[1]) ?? "github.com",
    repo: `${match[2]}/${match[3]}`,
    number: Number(match[4]),
    fromUrl: true,
  };
}

function githubRepoSelector(target: GithubIssueTarget): string {
  if (!target.repo) return "";
  return target.fromUrl && target.host !== "github.com" ? `${target.host}/${target.repo}` : target.repo;
}

function githubIssueTargetKey(target: GithubIssueTarget): string {
  return `${target.host}/${target.repo}`.toLowerCase();
}

function repoFromGithubIssueUrl(url: string | undefined): string | null {
  return githubIssueTargetFromUrl(url ?? "")?.repo ?? null;
}

function numericTarget(target: string): number | null {
  return /^[1-9]\d*$/.test(target.trim()) ? Number(target.trim()) : null;
}

function sourceReadSelector(target: GithubIssueTarget): string {
  return `${githubRepoSelector(target)}#${target.number}`;
}

function parseInputHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function sourceReadDiagnosticParts(params: {
  label: string;
  target: GithubIssueTarget;
  result: CommandResult;
  parseInput: string;
  parseError?: string;
}): string[] {
  const parts = [
    "blocked source-read failure",
    `target=${sourceReadSelector(params.target)}`,
    `command=${params.result.command ?? params.label}`,
  ];
  const parseInput = params.parseInput;
  const trimmed = parseInput.trim();
  const parseError = params.parseError?.trim();
  if (parseError) parts.push(`parse-error=${parseError}`);
  if (!params.result.ok) {
    const failure = commandTimeoutDiagnostic(params.result)
      || firstDiagnosticLine(params.result.error)
      || firstDiagnosticLine(params.result.stderr)
      || firstDiagnosticLine(params.result.stdout)
      || "command failed";
    parts.push(`command-failure=${failure}`);
  }
  if (params.result.rawStdout !== undefined) {
    parts.push(`raw-stdout-bytes=${Buffer.byteLength(params.result.rawStdout, "utf8")}`);
  }
  parts.push(`parse-input-bytes=${Buffer.byteLength(parseInput, "utf8")}`);
  parts.push(`redaction-changed-stdout=${params.result.rawStdout !== undefined && params.result.stdout !== params.result.rawStdout}`);
  parts.push(`parse-input-starts-with-brace=${trimmed.startsWith("{")}`);
  parts.push(`parse-input-ends-with-brace=${trimmed.endsWith("}")}`);
  if (parseInput) {
    parts.push(`parse-input-hash=${parseInputHash(parseInput)}`);
  }
  return parts;
}

function sourceReadFailureGap(params: {
  label: string;
  target: GithubIssueTarget;
  result: CommandResult;
  parseInput: string;
  parseError?: string;
}): string {
  return `${params.label}: ${boundedDiagnosticSummary(sourceReadDiagnosticParts(params))}`;
}

function sourceReadFailureSummary(target: GithubIssueTarget, result: CommandResult, parseError?: string): string {
  const selector = sourceReadSelector(target);
  const failure = parseError?.trim()
    ? `parse failure (${compactDiagnosticSnippet(parseError) || parseError.trim()})`
    : commandTimeoutDiagnostic(result)
      || firstDiagnosticLine(result.error)
      || firstDiagnosticLine(result.stderr)
      || firstDiagnosticLine(result.stdout)
      || "command failed";
  return `Source issue read blocked for ${selector}: ${failure}`;
}

function commandTimedOut(result: CommandResult): boolean {
  return result.timedOut || result.exitCode === "ETIMEDOUT";
}

function commandTimeoutDiagnostic(result: CommandResult): string | null {
  if (!commandTimedOut(result)) return null;
  const parts = [`timed out after ${result.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`];
  if (typeof result.killed === "boolean") parts.push(`killed=${result.killed}`);
  if (result.signal) parts.push(`signal=${result.signal}`);
  const command = compactDiagnosticSnippet(result.command);
  if (command) parts.push(`command=${command}`);
  return parts.join("; ");
}

function resultGap(label: string, result: CommandResult): string | null {
  if (result.ok) return null;
  const timeoutDiagnostic = commandTimeoutDiagnostic(result);
  if (timeoutDiagnostic) return `${label}: ${timeoutDiagnostic}`;
  const detail =
    result.stderr
    || result.stdout
    || result.error
    || (result.exitCode !== undefined && result.exitCode !== null ? `exit code ${result.exitCode}` : "command failed");
  const diagnosticLine = detail.trim().split(/\r?\n/).find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("{");
  }) ?? detail.trim().split(/\r?\n/)[0] ?? "command failed";
  return `${label}: ${diagnosticLine}`;
}

function firstDiagnosticLine(value: string | undefined): string {
  return value?.trim().split(/\r?\n/).find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("{");
  })?.trim() ?? "";
}

function compactDiagnosticSnippet(value: string | undefined): string {
  const line = firstDiagnosticLine(value);
  if (!line) return "";
  if (line.length <= MAX_HANDOFF_DIAGNOSTIC_PART_LENGTH) return line;
  return `${line.slice(0, MAX_HANDOFF_DIAGNOSTIC_PART_LENGTH - 1)}…`;
}

function multiplexerHandoffDiagnosticParts(result: CommandResult, parsed: MultiplexerHandoffResult | null): string[] {
  const parts: string[] = [];
  const timeoutDiagnostic = commandTimeoutDiagnostic(result);
  if (timeoutDiagnostic) parts.push(timeoutDiagnostic);
  if (!timeoutDiagnostic && result.exitCode !== undefined && result.exitCode !== null) {
    parts.push(`exit code ${result.exitCode}`);
  }
  const diagnostics: Array<[string, string | undefined]> = [
    ["detail", parsed?.detail],
    ["stderr", result.stderr],
    ["stdout", result.stdout],
    ["error", result.error],
  ];
  for (const [label, value] of diagnostics) {
    const snippet = compactDiagnosticSnippet(value);
    if (snippet) parts.push(`${label}: ${snippet}`);
  }
  return parts;
}

function boundedDiagnosticSummary(parts: string[]): string {
  const summary = parts.join("; ");
  if (summary.length <= MAX_HANDOFF_DIAGNOSTIC_SUMMARY_LENGTH) return summary;
  return `${summary.slice(0, MAX_HANDOFF_DIAGNOSTIC_SUMMARY_LENGTH - 1)}…`;
}

function multiplexerHandoffFailureSummary(
  branchName: string,
  result: CommandResult,
  parsed: MultiplexerHandoffResult | null,
): string {
  const reason = commandTimeoutDiagnostic(result)
    ? "timeout"
    : parsed?.reason
    ? `reason=${parsed.reason}`
    : "command failed";
  const detail = multiplexerHandoffDiagnostic(result, parsed);
  const multiplexer = parsed?.multiplexer ?? "zellij";
  return `Multiplexer Pi handoff (${multiplexer}) ${branchName}: ${reason}: ${detail}`;
}

function multiplexerHandoffDiagnostic(result: CommandResult, parsed: MultiplexerHandoffResult | null): string {
  const parts = multiplexerHandoffDiagnosticParts(result, parsed);
  return parts.length > 0 ? boundedDiagnosticSummary(parts) : "no diagnostic output";
}

function noRetryHandoffAction(
  parsed: MultiplexerHandoffResult | null,
  modelSelection: WorkonModelSelection,
): string | undefined {
  switch (parsed?.reason) {
    case "pi-auth-preflight-failed":
      return `Human action required: authenticate ${modelSelection.exactModel} for Pi, then rerun /workon.`;
    case "pi-model-not-found":
      return `Human action required: select an available Pi model or configure access for ${modelSelection.exactModel}, then rerun /workon.`;
    case "invalid-model":
    case "invalid-thinking":
    case "invalid-heartbeat":
    case "capsule-missing":
      return "Operator action required: fix the invalid /workon handoff input, then rerun /workon.";
    default:
      return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildHandoffRecoveryInstructions(params: {
  request: WorkonBootstrapRequest;
  repo: string;
  branchName: string;
  capsulePath: string;
}): string[] {
  const handoffScript = path.join(PACKAGE_ROOT, "scripts", "workon-multiplexer-handoff.sh");
  const modelSelection = workonModelSelection(params.request);
  const modelArg = modelSelection.exactModel ? ` --model ${shellQuote(modelSelection.exactModel)}` : "";
  const thinkingArg = ` --thinking ${shellQuote(modelSelection.exactThinkingLevel)}`;
  const multiplexer = params.request.resolvedMultiplexer === "none" ? "zellij" : params.request.resolvedMultiplexer;
  return [
    `Retry multiplexer handoff (${multiplexer}) from an active ${multiplexer} pane: cd ${shellQuote(params.request.cwd)} && bash ${shellQuote(handoffScript)} --multiplexer ${shellQuote(multiplexer)} --repo ${shellQuote(params.repo)} --branch ${shellQuote(params.branchName)} --capsule ${shellQuote(params.capsulePath)} --prompt '<handoff prompt from capsule>' --heartbeat ${shellQuote(params.request.heartbeat)}${modelArg}${thinkingArg} --ledger ${shellQuote(handoffLedgerPath(params.request, params.repo))}`,
  ];
}

function normalizeForgeHost(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return normalized || null;
}

function forgeHostFromTarget(target: string): string | null {
  const match = target.match(/^(?:https?:\/\/)?([^/\s]+)\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*/i);
  return normalizeForgeHost(match?.[1]);
}

function defaultForgeHost(forge: WorkonForge): string {
  return forge === "gitlab" ? "gitlab.com" : "github.com";
}

function stateForgeHost(request: Pick<WorkonBootstrapRequest, "forge" | "forgeHost" | "target">): string {
  return normalizeForgeHost(request.forgeHost) ?? forgeHostFromTarget(request.target) ?? defaultForgeHost(request.forge);
}

function repoStateDir(root: string, forgeHost: string, repo: string): string {
  const [owner = "unknown", name = "repo"] = repo.split("/", 2);
  return path.join(root, forgeHost, owner, name);
}

function capsulePath(request: WorkonBootstrapRequest, repo: string): string {
  return path.join(repoStateDir(request.capsuleRoot, stateForgeHost(request), repo), "capsule.md");
}

function handoffLedgerPath(request: WorkonBootstrapRequest, repo: string): string {
  return path.join(repoStateDir(request.capsuleRoot, stateForgeHost(request), repo), "handoff-ledger.json");
}

function ledgerIssue(issue: GithubIssueMetadata): WorkonLedgerIssue {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    body: issue.body,
  };
}

function firstMeaningfulGap(gaps: string[]): string | null {
  return gaps.find((gap) => !gap.startsWith("Retry ") && !gap.startsWith("Manual ")) ?? null;
}

function buildHandoffAcknowledgementCommand(ledgerPath: string): string {
  const ackScript = path.join(PACKAGE_ROOT, "scripts", "workon-handoff-ack.sh");
  return `bash ${shellQuote(ackScript)} --ledger ${shellQuote(ledgerPath)} --status capsule-acknowledged`;
}

function blockedNoRecoveryAction(operatorAction?: string): string {
  return operatorAction
    ?? "No route-owned recovery command is safe for this blocked state. Resolve the bootstrap failure above, then rerun /workon.";
}

function routeInstructionBlock(params: {
  route: WorkonRoute;
  issueUrl?: string;
  recoveryCommand?: string;
  operatorAction?: string;
  failureSummary?: string;
}): string {
  switch (params.route) {
    case "not_ready":
      return [
        "## Deterministic /workon route",
        "Route: not_ready",
        "Allowed action: stop and report the readiness action items.",
        `Only next command: /triage ${params.issueUrl ?? "<issue-url>"}`,
        "Forbidden actions: no Worktrunk start, capsule writing, multiplexer scope or pane creation, Pi launch, heartbeat launch, or GitHub comments.",
      ].join("\n");
    case "prepared":
      return [
        "## Deterministic /workon route",
        "Route: prepared",
        "Allowed action: report the prepared branch, capsule, ledger, and exact next command.",
        "Forbidden actions: do not start Worktrunk, a multiplexer, Pi, or heartbeat from this prompt.",
      ].join("\n");
    case "started":
      return [
        "## Deterministic /workon route",
        "Route: started",
        "Allowed action: report the existing worktree/capsule/ledger and the route-owned recovery command.",
        `Recovery command: ${params.recoveryCommand ?? "(not available)"}`,
        "Forbidden actions: do not create a second worktree/scope or rediscover multiplexer launch commands.",
      ].join("\n");
    case "launched":
      return [
        "## Deterministic /workon route",
        "Route: launched",
        "Allowed action: continue in the launched Pi handoff after reading and acknowledging the capsule.",
        "Forbidden actions: do not relaunch or create alternate tabs.",
      ].join("\n");
    case "blocked": {
      const recoveryCommand = params.recoveryCommand?.trim();
      return [
        "## Deterministic /workon route",
        "Route: blocked",
        recoveryCommand
          ? "Allowed action: run or report the one route-owned recovery command; if it fails, report that exact failure."
          : "Allowed action: report the blocked state and the operator action below; do not retry without a route-owned recovery command.",
        `Failure: ${params.failureSummary ?? "(see evidence gaps)"}`,
        recoveryCommand
          ? `Recovery command: ${recoveryCommand}`
          : "Recovery command: (none safe for this blocked state)",
        ...(recoveryCommand ? [] : [`Next operator action: ${blockedNoRecoveryAction(params.operatorAction)}`]),
        "Forbidden actions: do not improvise alternate launch paths.",
      ].join("\n");
    }
  }
}

function handoffPromptInstructionBlock(params: {
  route: WorkonRoute;
  issueUrl?: string;
  recoveryCommand?: string;
  operatorAction?: string;
  failureSummary?: string;
}): string {
  if (params.route !== "blocked") {
    return routeInstructionBlock(params);
  }

  const recoveryCommand = params.recoveryCommand?.trim();
  return [
    "## Workon child handoff context",
    "Parent /workon route: blocked",
    `Parent failure: ${params.failureSummary ?? "(see parent bootstrap evidence)"}`,
    `Parent recovery command: ${recoveryCommand || blockedNoRecoveryAction(params.operatorAction)}`,
    "This prompt is for a child Pi session after a launcher or operator has placed it in the target worktree.",
    "Do not treat the parent blocked bootstrap route as a prohibition on reading the capsule or implementing the source issue.",
    "If the session is not in the target worktree or no capsule path was provided, stop and report the missing launch context.",
  ].join("\n");
}

function routeFromWorktreeStatus(status: WorkonLedgerWorktreeStatus): WorkonRoute {
  return status === "not-started" ? "not_ready" : status;
}

function buildLedgerSafeNextAction(params: {
  issue: GithubIssueMetadata;
  readinessActionItems: string[];
  worktreeCommand: string | null;
  worktreeStatus: WorkonLedgerWorktreeStatus;
  piStatus: WorkonHandoffLedger["pi"]["status"];
  recoveryInstructions: string[];
  operatorAction?: string;
}): string {
  if (params.readinessActionItems.length > 0) {
    return `/triage ${params.issue.url}`;
  }
  if (params.piStatus === "pi-process-started") {
    return "Wait for capsule acknowledgement, or resume from the ledger and capsule if the child session is gone.";
  }
  if (params.worktreeStatus === "launched") {
    return "Continue in the launched Pi pane; read the session capsule if context is missing.";
  }
  if (params.recoveryInstructions.length > 0) {
    return params.recoveryInstructions[0] ?? "Inspect the session capsule before continuing.";
  }
  if (params.worktreeStatus === "blocked") {
    return blockedNoRecoveryAction(params.operatorAction);
  }
  return params.worktreeCommand ?? "Inspect deterministic workon evidence before retrying.";
}

function buildHandoffLedger(params: {
  request: WorkonBootstrapRequest;
  repo: string;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  branchName?: string;
  capsulePath?: string;
  worktreeCommand?: string;
  worktreeStatus: WorkonLedgerWorktreeStatus;
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  readinessActionItems?: string[];
  handoffRecoveryInstructions?: string[];
  handoffOperatorAction?: string;
  handoffFailureSummary?: string;
  handoffTimedOut?: boolean;
  failureSummary?: string;
  gaps?: string[];
  multiplexerResult?: MultiplexerHandoffResult | null;
}): WorkonHandoffLedger {
  const sourceIssues = params.issues?.length ? params.issues : [params.issue];
  const readinessActionItems = params.readinessActionItems ?? [];
  const recoveryInstructions = params.handoffRecoveryInstructions ?? [];
  const ledgerPath = handoffLedgerPath(params.request, params.repo);
  const heartbeatDisabled = params.request.heartbeat === "0" || params.request.heartbeat === "0.0";
  const piStatus = params.piHandoffCommand ? "pi-process-started" : "not-launched";
  const heartbeatStatus = heartbeatDisabled
    ? "disabled"
    : params.heartbeatCommand
      ? "started"
      : "not-launched";
  const multiplexerStatus = params.request.resolvedMultiplexer === "none"
    ? "skipped"
    : params.worktreeStatus === "launched"
      ? "launched"
      : params.worktreeStatus === "blocked"
        ? "blocked"
        : "not-attempted";
  const zellijStatus = params.request.resolvedMultiplexer === "zellij" ? multiplexerStatus : "skipped";
  const scopeName = params.multiplexerResult?.scopeName
    ?? params.multiplexerResult?.tabName
    ?? params.multiplexerResult?.sessionName
    ?? null;
  const scopeId = params.multiplexerResult?.scopeId
    ?? params.multiplexerResult?.tabId
    ?? params.multiplexerResult?.sessionId
    ?? null;
  const failureReason = readinessActionItems.length > 0
    ? "Autonomous readiness failed."
    : params.handoffFailureSummary ?? params.failureSummary ?? firstMeaningfulGap(params.gaps ?? []);
  const route: WorkonRoute = readinessActionItems.length > 0 ? "not_ready" : routeFromWorktreeStatus(params.worktreeStatus);
  const failurePhase = failureReason
    ? readinessActionItems.length > 0
      ? "readiness"
      : params.handoffFailureSummary || params.handoffTimedOut || params.multiplexerResult
        ? "multiplexer-handoff"
        : params.failureSummary
          ? "bootstrap"
          : params.worktreeStatus === "blocked"
            ? "worktree"
            : "bootstrap"
    : null;

  return {
    version: 1,
    repo: params.repo,
    sourceIssues: sourceIssues.map(ledgerIssue),
    primaryIssue: ledgerIssue(params.issue),
    branchName: params.branchName ?? null,
    capsulePath: params.capsulePath ?? null,
    ledgerPath,
    dryRun: Boolean(params.request.dryRun),
    route,
    modelSelection: workonModelSelection(params.request),
    worktree: {
      command: params.worktreeCommand ?? null,
      status: params.worktreeStatus,
      path: params.worktreePath ?? null,
    },
    launchEligibility: {
      activeZellij: params.request.resolvedMultiplexer === "zellij",
      requestedMultiplexer: params.request.requestedMultiplexer,
      resolvedMultiplexer: params.request.resolvedMultiplexer,
    },
    multiplexer: {
      status: multiplexerStatus,
      requested: params.request.requestedMultiplexer,
      resolved: params.request.resolvedMultiplexer,
      scopeName,
      scopeId,
      paneId: params.multiplexerResult?.piPaneId ?? null,
      worktreeAction: params.multiplexerResult?.worktreeAction ?? null,
    },
    zellij: {
      status: zellijStatus,
      tabName: params.request.resolvedMultiplexer === "zellij" ? params.multiplexerResult?.tabName ?? null : null,
      tabId: params.request.resolvedMultiplexer === "zellij" ? params.multiplexerResult?.tabId ?? null : null,
      worktreeAction: params.request.resolvedMultiplexer === "zellij" ? params.multiplexerResult?.worktreeAction ?? null : null,
    },
    pi: {
      status: piStatus,
      paneId: params.multiplexerResult?.piPaneId ?? null,
      paneAction: params.multiplexerResult?.piPaneAction ?? null,
      handoffCommand: params.piHandoffCommand ?? null,
      acknowledgementCommand: buildHandoffAcknowledgementCommand(ledgerPath),
    },
    heartbeat: {
      status: heartbeatStatus,
      interval: params.request.heartbeat,
      paneId: params.multiplexerResult?.heartbeatPaneId ?? null,
      action: params.multiplexerResult?.heartbeatAction ?? null,
      command: params.heartbeatCommand ?? null,
    },
    phases: {
      sourceIssue: "resolved",
      readiness: readinessActionItems.length > 0 ? "not-ready" : "ready",
      capsule: params.capsulePath ? "written" : "not-written",
      worktree: params.worktreeStatus,
      multiplexer: multiplexerStatus,
      zellij: zellijStatus,
      pi: piStatus,
      heartbeat: heartbeatStatus,
    },
    readinessActionItems,
    failureReason,
    failure: {
      phase: failurePhase,
      reason: params.handoffTimedOut
        ? "timeout"
        : params.multiplexerResult?.reason ?? (readinessActionItems.length > 0 ? "readiness-not-ready" : null),
      detail: params.multiplexerResult?.detail ?? (readinessActionItems.length > 0 ? null : failureReason),
      summary: failureReason,
    },
    safeNextAction: buildLedgerSafeNextAction({
      issue: params.issue,
      readinessActionItems,
      worktreeCommand: params.worktreeCommand ?? null,
      worktreeStatus: params.worktreeStatus,
      piStatus,
      recoveryInstructions,
      operatorAction: params.handoffOperatorAction,
    }),
    recoveryInstructions,
    attempts: [
      {
        at: params.request.nowIso,
        phase: "bootstrap",
        status: readinessActionItems.length > 0 ? "not-ready" : params.worktreeStatus,
        detail: failureReason,
      },
    ],
    createdAt: params.request.nowIso,
    updatedAt: params.request.nowIso,
  };
}

async function writeHandoffLedger(ledger: WorkonHandoffLedger): Promise<string> {
  await fs.mkdir(path.dirname(ledger.ledgerPath), { recursive: true });
  await fs.writeFile(ledger.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  return ledger.ledgerPath;
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

function redactSensitiveCommandArgs(value: string | undefined, args: string[]): string | undefined {
  if (!value) return value;
  let redacted = value;
  for (const flag of ["--prompt"]) {
    const index = args.indexOf(flag);
    const sensitiveValue = index >= 0 ? args[index + 1] : undefined;
    if (sensitiveValue) {
      redacted = redacted.split(sensitiveValue).join("<redacted>");
    }
  }
  redacted = redacted.replace(
    /(--prompt\s+)([\s\S]*?)(?=\s--(?:heartbeat|ledger|model|thinking)\b|$)/g,
    "$1<redacted>",
  );
  return redacted;
}

async function runCommand(
  runner: WorkonCommandRunner,
  cwd: string,
  commands: string[],
  command: string,
  args: string[],
  timeoutMs?: number,
): Promise<CommandResult> {
  const loggedCommand = formatLoggedCommand(command, args);
  commands.push(loggedCommand);
  const result = await runner(command, args, { cwd, timeoutMs });
  return {
    ...result,
    command: loggedCommand,
    timeoutMs: timeoutMs ?? result.timeoutMs,
    rawStdout: result.rawStdout ?? result.stdout,
    rawStderr: result.rawStderr ?? result.stderr,
    stdout: redactSensitiveCommandArgs(result.stdout, args) ?? "",
    stderr: redactSensitiveCommandArgs(result.stderr, args) ?? "",
    error: redactSensitiveCommandArgs(result.error, args),
  };
}

async function runGh(
  runner: WorkonCommandRunner,
  cwd: string,
  commands: string[],
  args: string[],
): Promise<CommandResult> {
  return runCommand(runner, cwd, commands, "gh", args);
}

async function ensureGithubAuth(
  request: WorkonBootstrapRequest,
  runner: WorkonCommandRunner,
  evidence: WorkonBootstrapEvidence,
  host?: string,
): Promise<boolean> {
  const normalizedHost = normalizeForgeHost(host) ?? stateForgeHost(request);
  const hostArgs = normalizedHost ? ["--hostname", normalizedHost] : [];
  const auth = await runGh(runner, request.cwd, evidence.commands, ["auth", "status", ...hostArgs]);
  const label = normalizedHost && normalizedHost !== "github.com"
    ? `GitHub authentication for ${normalizedHost}`
    : "GitHub authentication";
  const authGap = resultGap(label, auth);
  if (authGap) {
    evidence.gaps.push(authGap);
    return false;
  }
  return true;
}

async function resolveIssueTarget(
  request: WorkonBootstrapRequest,
  evidence: WorkonBootstrapEvidence,
): Promise<GithubIssueTarget | null> {
  const issueUrlTarget = githubIssueTargetFromUrl(request.target);
  if (issueUrlTarget) return issueUrlTarget;

  const issueNumber = numericTarget(request.target);
  if (issueNumber) return { host: stateForgeHost(request), repo: request.repo, number: issueNumber, fromUrl: false };

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
  const args = [
    "issue",
    "view",
    String(target.number),
  ];
  const repoSelector = githubRepoSelector(target);
  if (repoSelector) {
    args.push("--repo", repoSelector);
  }
  args.push(
    "--json",
    "number,title,url,body,state,author,labels,assignees",
  );
  const label = `GitHub issue ${target.repo}#${target.number}`;
  const result = await runGh(runner, request.cwd, evidence.commands, args);
  const parseInput = result.rawStdout ?? result.stdout;
  const markSourceReadBlocked = (parseError?: string): null => {
    evidence.route = "blocked";
    evidence.handoffOperatorAction = `Fix the GitHub issue read failure for ${sourceReadSelector(target)}, then rerun /workon.`;
    evidence.failureSummary = sourceReadFailureSummary(target, result, parseError);
    evidence.gaps.push(sourceReadFailureGap({ label, target, result, parseInput, parseError }));
    return null;
  };
  if (!result.ok) {
    return markSourceReadBlocked();
  }

  try {
    const parsed = JSON.parse(parseInput) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as GithubIssueMetadata;
    }
    const parseError = `expected a JSON object but received ${Array.isArray(parsed) ? "an array" : typeof parsed}`;
    return markSourceReadBlocked(parseError);
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return markSourceReadBlocked(parseError);
  }
}

const WORKON_ACCEPTANCE_SECTION_HEADINGS = new Set(["acceptance criteria"]);
const WORKON_VALIDATION_SECTION_HEADINGS = new Set(["validation", "validation plan", "testing", "test plan"]);
const WORKON_NON_GOALS_SECTION_HEADINGS = new Set(["non goals", "non-goals", "out of scope"]);

const MARKDOWN_LIST_ITEM_PATTERN = /^(?:[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+)/;

function workonPacketSectionItems(body: string | undefined, headings: Set<string>): string[] {
  return parseMarkdownSections(body)
    .filter((section) => headings.has(section.normalizedHeading))
    .flatMap((section) =>
      section.lines
        .map((line) => line.trim())
        .filter((line) => MARKDOWN_LIST_ITEM_PATTERN.test(line))
        .map((line) => line.replace(MARKDOWN_LIST_ITEM_PATTERN, "").trim())
        .filter(Boolean),
    );
}

function acceptanceCriteriaFromBody(body: string | undefined): string[] {
  return workonPacketSectionItems(body, WORKON_ACCEPTANCE_SECTION_HEADINGS);
}

function bodyHasHeading(body: string | undefined, headings: string[]): boolean {
  if (!body) return false;
  const normalizedHeadings = headings.map(normalizeHeading);
  return parseMarkdownSections(body).some((section) =>
    normalizedHeadings.some(
      (heading) => section.normalizedHeading === heading || section.normalizedHeading.startsWith(`${heading} `),
    ),
  );
}

function bodyMentions(body: string | undefined, pattern: RegExp): boolean {
  return Boolean(body && pattern.test(body));
}

function issueHasLabel(issue: GithubIssueMetadata, labelName: string): boolean {
  return (issue.labels ?? []).some((label) => label.name?.toLowerCase() === labelName.toLowerCase());
}

function issueLooksLikeBug(issue: GithubIssueMetadata): boolean {
  const labels = issue.labels?.map((label) => label.name ?? "").join(" ") ?? "";
  return /\b(bug|fix|broken|fail|failure|error|regression|incorrect|wrong|invalid)\b/i.test(`${issue.title} ${labels}`);
}

function missingCanonicalWorkonHeadings(body: string | undefined): string[] {
  if (!body) return [...WORKON_READY_PACKET_NORMALIZED_HEADINGS];
  const present = new Set(parseMarkdownSections(body).map((section) => section.normalizedHeading));
  return WORKON_READY_PACKET_NORMALIZED_HEADINGS.filter((heading) => !present.has(heading));
}

function validationItemsFromBody(body: string | undefined): string[] {
  return workonPacketSectionItems(body, WORKON_VALIDATION_SECTION_HEADINGS);
}

type MarkdownSection = {
  heading: string;
  normalizedHeading: string;
  text: string;
  lines: string[];
};

const BREAKING_CHANGE_SECTION_HEADINGS = new Set([
  "breaking change",
  "breaking change risk",
  "public contract",
  "public contract risk",
  "public api",
  "public api risk",
  "schema",
  "schema risk",
  "migration",
  "migration risk",
  "cli contract",
  "cli contract risk",
]);

const REVIEW_SIZE_SECTION_HEADINGS = new Set([
  "review size",
  "review size risk",
  "scope",
  "scope risk",
  "implementation",
  "implementation risk",
]);

const REVIEW_SIZE_EXCLUDED_SECTION_HEADINGS = new Set([
  "reproduction",
  "reproduction status",
  "steps to reproduce",
  "current behavior",
  "evidence",
  "evidence trail",
  "likely root cause",
  "diagnostics",
  "diagnostic notes",
  "debug notes",
  "debugging notes",
  "non goals",
  "non-goals",
  "out of scope",
  "workon readiness notes",
  "/workon readiness notes",
]);

const ABSENT_OR_RESOLVED_RISK_TERMS = new Set([
  "none",
  "no",
  "n/a",
  "not expected",
  "absent",
  "low",
  "resolved",
  "bounded",
]);

const REVIEW_SIZE_RISK_TERMS = [
  "large",
  "broad",
  "sweeping",
  "multi phase",
  "multi-phase",
  "many files",
  "refactor everything",
  "over 500",
];

// Phrases that signal an issue body still defers a concrete scope decision to
// implementation time (exact API/model/file/command names). /workon must not
// start when these are present in the substantive issue body — workon's
// "Do not redefine issue scope" contract would otherwise force the autonomous
// agent to invent the missing decision.
const SCOPE_DEFERRAL_PHRASES: RegExp[] = [
  /\bimplementation should verify\b/i,
  /\bverify\b[\s\S]{0,40}\bduring implementation\b/i,
  /\bto be (?:determined|confirmed|decided)\b/i,
  /(?:^|[^a-zA-Z0-9])TBD(?:[^a-zA-Z0-9]|$)/,
  /\bmay need\b[\s\S]{0,80}\beither\b[\s\S]{0,80}\bor\b/i,
  /\bwe(?:'ll| will)\s+(?:figure\s+out|decide|determine)\b/i,
];

const SCOPE_DEFERRAL_EXCLUDED_SECTION_HEADINGS = new Set([
  "non goals",
  "non-goals",
  "out of scope",
  "open questions",
  "unresolved questions",
  "questions",
  "risks",
  "workon readiness notes",
  "/workon readiness notes",
]);

function substantiveBodyForDeferralScan(body: string | undefined): string {
  if (!body) return "";
  const sections = parseMarkdownSections(body);
  if (sections.length === 0) return body;
  return sections
    .filter((section) => !SCOPE_DEFERRAL_EXCLUDED_SECTION_HEADINGS.has(section.normalizedHeading))
    .map((section) => section.text)
    .join("\n");
}

function hasUnresolvedScopeDeferral(body: string | undefined): boolean {
  const text = substantiveBodyForDeferralScan(body);
  if (!text) return false;
  return SCOPE_DEFERRAL_PHRASES.some((pattern) => pattern.test(text));
}

const normalizeHeading = normalizeWorkonPacketHeading;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedTextIncludesAny(text: string, terms: Iterable<string>): boolean {
  const normalized = normalizeText(text);
  return Array.from(terms).some((term) => normalized.includes(term));
}

function normalizedTextHasTerm(text: string, term: string): boolean {
  const normalized = normalizeText(text);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalized);
}

function markdownSectionHeading(line: string): string | undefined {
  const atxHeading = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/)?.[1]?.trim();
  if (atxHeading) return atxHeading;

  return line.match(/^\s*\*\*(.+?:)\*\*\s*$/)?.[1]?.trim();
}

function parseMarkdownSections(body: string | undefined): MarkdownSection[] {
  if (!body) return [];

  const sections: MarkdownSection[] = [];
  let current: { heading: string; normalizedHeading: string; lines: string[] } | null = null;
  let inFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current?.lines.push(line);
      continue;
    }

    const heading = !inFence ? markdownSectionHeading(line) : undefined;
    if (heading) {
      if (current) {
        sections.push({
          heading: current.heading,
          normalizedHeading: current.normalizedHeading,
          text: [current.heading, ...current.lines].join("\n"),
          lines: current.lines,
        });
      }
      current = { heading, normalizedHeading: normalizeHeading(heading), lines: [] };
      continue;
    }

    current?.lines.push(line);
  }

  if (current) {
    sections.push({
      heading: current.heading,
      normalizedHeading: current.normalizedHeading,
      text: [current.heading, ...current.lines].join("\n"),
      lines: current.lines,
    });
  }

  return sections;
}

function matchingSectionText(body: string | undefined, headings: Set<string>): string {
  return parseMarkdownSections(body)
    .filter((section) => headings.has(section.normalizedHeading))
    .map((section) => section.text)
    .join("\n");
}

function hasAbsentOrResolvedRisk(text: string): boolean {
  return Array.from(ABSENT_OR_RESOLVED_RISK_TERMS).some((term) => normalizedTextHasTerm(text, term));
}

function unresolvedBreakingChange(body: string | undefined): boolean {
  const riskText = matchingSectionText(body, BREAKING_CHANGE_SECTION_HEADINGS);
  const text = riskText || body || "";
  if (!normalizedTextIncludesAny(text, ["breaking change", "public contract", "public api", "schema", "migration", "cli contract"])) return false;
  return !hasAbsentOrResolvedRisk(text);
}

// Review-size risk should come from the proposed scope/risk section, not from
// diagnostics, evidence, non-goals, or text that only quotes trigger words.
function reviewSizeRiskBody(body: string | undefined): string {
  if (!body) return "";

  const scopedRiskText = matchingSectionText(body, REVIEW_SIZE_SECTION_HEADINGS);
  if (scopedRiskText) return scopedRiskText;

  const sections = parseMarkdownSections(body);
  if (sections.length === 0) return body;

  return sections
    .filter((section) => !REVIEW_SIZE_EXCLUDED_SECTION_HEADINGS.has(section.normalizedHeading))
    .map((section) => section.text)
    .join("\n");
}

function reviewSizeRisk(body: string | undefined): boolean {
  const riskText = reviewSizeRiskBody(body);
  if (hasAbsentOrResolvedRisk(riskText)) return false;
  return REVIEW_SIZE_RISK_TERMS.some((term) => normalizedTextHasTerm(riskText, term)) || />\s*500/.test(riskText);
}

function evaluateWorkonReadiness(issue: GithubIssueMetadata): string[] {
  const body = issue.body ?? "";
  const acceptance = acceptanceCriteriaFromBody(body);
  const validation = validationItemsFromBody(body);
  const actionItems: string[] = [];

  if (issueHasLabel(issue, IMPROVE_LABEL)) {
    const missingHeadings = missingCanonicalWorkonHeadings(body);
    if (missingHeadings.length > 0) {
      actionItems.push(`Add canonical /workon-ready headings required for improve issues: ${missingHeadings.join(", ")}.`);
    }
  }

  if (acceptance.length === 0) {
    actionItems.push("Add narrow, testable acceptance criteria to the issue/work packet.");
  }
  if (validation.length === 0 && !bodyHasHeading(body, [...WORKON_VALIDATION_SECTION_HEADINGS])) {
    actionItems.push("Add validation or test expectations, preferably a behavior/regression test for changed behavior.");
  }
  if (
    issueLooksLikeBug(issue) &&
    !bodyHasHeading(body, ["Reproduction", "Steps to reproduce", "Current behavior"]) &&
    !bodyMentions(body, /\b(repro|reproduce|observed behavior|current behavior|failing test|regression test)\b/i)
  ) {
    actionItems.push("Add reproduction steps, observed behavior, or a concrete failing feedback loop for the bug.");
  }
  if (!bodyHasHeading(body, [...WORKON_NON_GOALS_SECTION_HEADINGS])) {
    actionItems.push("Add non-goals or out-of-scope boundaries so autonomous work does not expand scope.");
  }
  if (unresolvedBreakingChange(body)) {
    actionItems.push("Resolve the breaking-change/public-contract risk before autonomous work starts.");
  }
  if (reviewSizeRisk(body)) {
    actionItems.push("Narrow or split the issue so the resulting PR is likely under about 500 LOC changed.");
  }
  if (hasUnresolvedScopeDeferral(body)) {
    actionItems.push(
      "Resolve deferred scope decisions in the issue body (replace 'implementation should verify', 'TBD', 'may need either X or Y', etc. with concrete API/model/file/command names) before /workon.",
    );
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

function issueLine(issue: GithubIssueMetadata): string {
  return `- ${issue.url} (#${issue.number}) ${issue.title}`;
}

function issueNumberList(sourceIssues: GithubIssueMetadata[]): string {
  return sourceIssues.map((issue) => `#${issue.number}`).join(", ");
}

function issueLines(sourceIssues: GithubIssueMetadata[]): string {
  return sourceIssues.map(issueLine).join("\n");
}

function issueOrderLines(sourceIssues: GithubIssueMetadata[]): string {
  return sourceIssues
    .map((issue, index) => `${index + 1}. #${issue.number}: ${issue.title}`)
    .join("\n");
}

function sourceIssueDetails(sourceIssues: GithubIssueMetadata[]): string {
  return sourceIssues
    .map((issue) => `### #${issue.number}: ${issue.title}\n\nURL: ${issue.url}\n\n${issue.body?.trim() || "(no issue body)"}`)
    .join("\n\n");
}

function validationItemsForIssues(sourceIssues: GithubIssueMetadata[]): string[] {
  return sourceIssues.flatMap((issue) => {
    const items = validationItemsFromBody(issue.body);
    if (items.length === 0) {
      return [`#${issue.number}: Run the validation described by the issue before shipping.`];
    }
    return items.map((item) => `#${issue.number}: ${item}`);
  });
}

function multiIssueWorkScope(sourceIssues: GithubIssueMetadata[]): string {
  if (sourceIssues.length <= 1) return "";

  return `## Combined work scope

This is one combined /workon session for these source issues; do not create separate branches, worktrees, capsules, or sessions per issue.
${issueLines(sourceIssues)}

## Implementation order

Use this deterministic starting order, based on the provided target order unless explicit issue-body evidence supports changing it:
${issueOrderLines(sourceIssues)}

Make issue-scoped commits tied to the relevant source issue where practical.`;
}

function capsuleMarkdown(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  worktreeCommand: string;
  worktreeStatus: WorkonBootstrapStatus;
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt: string;
  requestedMultiplexer?: WorkonMultiplexer;
  resolvedMultiplexer?: ResolvedWorkonMultiplexer;
  handoffRecoveryInstructions?: string[];
  handoffOperatorAction?: string;
  handoffFailureSummary?: string;
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
  const sourceIssueDetailsSection = sourceIssueDetails(sourceIssues);
  const acceptance = sourceIssues
    .flatMap((issue) =>
      acceptanceCriteriaFromBody(issue.body).map((item) => `- #${issue.number}: ${item}`),
    )
    .slice(0, 12)
    .join("\n");
  const validation = sourceIssues.length === 1
    ? validationItemsFromBody(params.issue.body)
      .map((item) => `- ${item}`)
      .join("\n") || "- Run the validation described by the issue before shipping."
    : validationItemsForIssues(sourceIssues)
      .map((item) => `- ${item}`)
      .slice(0, 12)
      .join("\n");
  const combinedWorkScope = multiIssueWorkScope(sourceIssues);
  const combinedWorkScopeSection = combinedWorkScope ? `\n${combinedWorkScope}\n` : "";
  const ledgerPath = handoffLedgerPath(params.request, params.repo);
  const modelSelection = workonModelSelection(params.request);

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
Handoff ledger: ${ledgerPath}
Capsule acknowledgement command: ${buildHandoffAcknowledgementCommand(ledgerPath)}
Multiplexer requested: ${params.requestedMultiplexer ?? params.request.requestedMultiplexer}
Multiplexer resolved: ${params.resolvedMultiplexer ?? params.request.resolvedMultiplexer}
Launch eligibility: active multiplexer ${params.request.resolvedMultiplexer !== "none" ? "yes" : "no"}
Heartbeat interval: ${params.request.heartbeat}
Dry run: ${params.request.dryRun ? "yes" : "no"}
Exact model: ${modelSelection.exactModel}
Exact thinking level: ${modelSelection.exactThinkingLevel}
Model routing mode: ${modelSelection.routingMode}
Model routing reason: ${modelSelection.routingReason}
Created: ${params.request.nowIso}

## Problem

${params.issue.title}
${combinedWorkScopeSection}
## Source issue details

${sourceIssueDetailsSection}

## Acceptance criteria

${acceptance}

## Non-goals

- Do not widen scope beyond the source issue(s) without updating the issue or creating a follow-up.
- Do not merge or ship from this capsule; use /ship after implementation and review.
- For multiple source issues, prefer multiple commits, each tied to the relevant issue where practical.

## Validation

${validation}

${params.handoffFailureSummary ? `## Bootstrap failure

${params.handoffFailureSummary}

` : ""}## Handoff recovery

${params.handoffRecoveryInstructions?.length ? params.handoffRecoveryInstructions.map((instruction) => `- ${instruction}`).join("\n") : params.worktreeStatus === "blocked" ? `- ${blockedNoRecoveryAction(params.handoffOperatorAction)}` : "- No restore command needed for the recorded bootstrap state."}

## Open questions

- Confirm whether any acceptance criteria are missing before implementation.

## Next prompt

${params.handoffPrompt}
`;
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

function buildMultiIssueHandoffPrompt(params: {
  issue: GithubIssueMetadata;
  sourceIssues: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  heartbeat: string;
  modelSelection: WorkonModelSelection;
  ledgerPath: string;
  route: WorkonRoute;
  recoveryCommand?: string;
  operatorAction?: string;
  failureSummary?: string;
}): string {
  const sourceIssueLines = issueLines(params.sourceIssues);
  const sourceIssueOrder = issueOrderLines(params.sourceIssues);
  const validation = validationItemsForIssues(params.sourceIssues)
    .map((item) => `- ${item}`)
    .join("\n");
  const sourceIssueReferences = params.sourceIssues
    .map((issue) => `  - ${issue.url} (#${issue.number})`)
    .join("\n");

  return `${handoffPromptInstructionBlock({
    route: params.route,
    issueUrl: params.issue.url,
    recoveryCommand: params.recoveryCommand,
    operatorAction: params.operatorAction,
    failureSummary: params.failureSummary,
  })}

I want to discuss and possibly work on: combined source issue set for ${params.repo}: ${issueNumberList(params.sourceIssues)}

Context:
- Repository: ${params.repo}
- Source issues:
${sourceIssueLines}
- Primary coordination issue: ${params.issue.url} (#${params.issue.number})
- Branch: ${params.branchName}
- Handoff ledger: ${params.ledgerPath}
- Exact model: ${params.modelSelection.exactModel}
- Exact thinking level: ${params.modelSelection.exactThinkingLevel}
- Model routing: ${params.modelSelection.routingMode} (${params.modelSelection.routingReason})
- This handoff comes from \`/workon\`; a session capsule path is provided separately by the launcher.
- Treat this prompt as starting context, not a final technical decision.

Before doing any implementation:
- Read the session capsule path provided by the launcher.
- Acknowledge that the capsule was read by running: \`${buildHandoffAcknowledgementCommand(params.ledgerPath)}\`.
- Read the local agent/repo instructions.
- Inspect the relevant code, docs, tests, recent commits, and linked issue state for every source issue.
- Decide whether this combined task is still real, already solved, stale, over-scoped, or better handled differently.
- Call out stale assumptions, hidden risks, and anything that should stop the work.

Task:
- If your independent review supports it, implement the smallest vertical slice for this combined source-issue set.
- Work through the source issues in this deterministic order unless issue-body evidence supports a different order:
${sourceIssueOrder}
- Create a separate focused commit for each source issue where practical.
- Keep changes scoped to the source issue set and branch.
- Do not widen scope beyond the source issues without creating or recommending a follow-up.

Pre-commit simplify pass:
- After implementation edits, run focused validation for the touched behavior before simplifying.
- Run \`/simplify\` only on the dirty tree before creating the implementation commit; \`/workon\` bootstrap must not invoke \`/simplify\` because no implementation dirty tree exists yet.
- Keep the simplify pass behavior-preserving, source-issue-scoped, and free of drive-by refactors.
- Rerun the focused validation after simplification and before committing.
- Commit only the final implementation plus simplify result; do not require a separate simplify commit.

Draft PR and feedback heartbeat:
- Once there is a coherent implementation commit, create or update a draft PR for this branch on the forge.
- Link the draft PR back to all source issues:
${sourceIssueReferences}
- Make clear the draft PR is not ready to merge until validation and review are complete.
- In the draft PR body, use the repo PR template shape: resolved source-closing marker when applicable, Summary, checklist-style Acceptance criteria copied from every source issue criterion, Deviations from the original plan, command-only Testing Strategy, and References.
- For each source issue criterion, use checkbox state, not textual status prefixes: checked means met; unchecked means unmet.
- Preserve useful concise evidence as nested \`Evidence:\` lines under checklist items.
- For unmet criteria, keep the checkbox unchecked and include a concise reason/follow-up under the item or in Deviations.
- After opening the draft PR, check the PR/issue forge for human feedback every ${heartbeatLabel(params.heartbeat)} while you are still working.
- Prefer in-thread replies for review comments. Do not merge, mark ready, close issues, label, or post broad public comments unless explicitly told.

Validation:
- Run focused tests for the touched code.
- Validate every source issue expectation, not just #${params.issue.number}:
${validation}
- Run the relevant repo quality gate when the change affects public workflow behavior.
- Include exact commands and results in your summary.

Output:
- Start with review findings and recommendation.
- Then provide the plan or patch summary.
- If you edit code, report exact proof run.
- Include draft PR URL/status when created, plus latest heartbeat check result.
- Do not merge, close issues/PRs, label, or post broad public comments unless explicitly told.`;
}

async function buildHandoffPrompt(params: {
  cwd: string;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  heartbeat: string;
  modelSelection: WorkonModelSelection;
  ledgerPath: string;
  route: WorkonRoute;
  recoveryCommand?: string;
  operatorAction?: string;
  failureSummary?: string;
}): Promise<string> {
  const template = await readHandoffTemplate(params.cwd);
  const sourceIssues = params.issues?.length ? params.issues : [params.issue];
  const rendered = renderTemplate(template, {
    branch_name: params.branchName,
    heartbeat_interval: heartbeatLabel(params.heartbeat),
    model_routing_mode: params.modelSelection.routingMode,
    model_routing_reason: params.modelSelection.routingReason,
    handoff_ledger: params.ledgerPath,
    route_instruction_block: handoffPromptInstructionBlock({
      route: params.route,
      issueUrl: params.issue.url,
      recoveryCommand: params.recoveryCommand,
      operatorAction: params.operatorAction,
      failureSummary: params.failureSummary,
    }),
    ack_command: buildHandoffAcknowledgementCommand(params.ledgerPath),
    resolved_model: params.modelSelection.exactModel,
    resolved_thinking_level: params.modelSelection.exactThinkingLevel,
    issue_number: params.issue.number,
    issue_title: params.issue.title,
    issue_url: params.issue.url,
    repo: params.repo,
  });
  if (sourceIssues.length === 1) return rendered;
  return buildMultiIssueHandoffPrompt({
    issue: params.issue,
    sourceIssues,
    repo: params.repo,
    branchName: params.branchName,
    heartbeat: params.heartbeat,
    modelSelection: params.modelSelection,
    ledgerPath: params.ledgerPath,
    route: params.route,
    recoveryCommand: params.recoveryCommand,
    operatorAction: params.operatorAction,
    failureSummary: params.failureSummary,
  });
}

async function writeCapsule(params: {
  request: WorkonBootstrapRequest;
  issue: GithubIssueMetadata;
  issues?: GithubIssueMetadata[];
  repo: string;
  branchName: string;
  worktreeCommand: string;
  worktreeStatus: WorkonBootstrapStatus;
  worktreePath?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffPrompt: string;
  requestedMultiplexer?: WorkonMultiplexer;
  resolvedMultiplexer?: ResolvedWorkonMultiplexer;
  handoffRecoveryInstructions?: string[];
  handoffOperatorAction?: string;
  handoffFailureSummary?: string;
}): Promise<string> {
  const filePath = capsulePath(params.request, params.repo);
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

function parseMultiplexerHandoffResult(output: string): MultiplexerHandoffResult | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as MultiplexerHandoffResult;
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
    ledgerPath: string;
  },
): Promise<{
  status: "prepared" | "started" | "launched" | "blocked";
  path?: string;
  piHandoffCommand?: string;
  heartbeatCommand?: string;
  handoffRecoveryInstructions?: string[];
  handoffOperatorAction?: string;
  handoffFailureSummary?: string;
  handoffTimedOut?: boolean;
  multiplexerResult?: MultiplexerHandoffResult | null;
}> {
  if (request.mode !== "start" || request.dryRun) return { status: "prepared" };

  if (request.resolvedMultiplexer !== "none") {
    const scriptPath = path.join(PACKAGE_ROOT, "scripts", "workon-multiplexer-handoff.sh");
    const handoffArgs = [
      scriptPath,
      "--multiplexer",
      request.resolvedMultiplexer,
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
      "--ledger",
      params.ledgerPath,
    ];
    const modelSelection = workonModelSelection(request);
    if (modelSelection.exactModel) {
      handoffArgs.push("--model", modelSelection.exactModel);
    }
    handoffArgs.push("--thinking", modelSelection.exactThinkingLevel);
    const handoffResult = await runCommand(
      runner,
      request.cwd,
      evidence.commands,
      "bash",
      handoffArgs,
      DEFAULT_ZELLIJ_HANDOFF_TIMEOUT_MS,
    );
    const parsed = parseMultiplexerHandoffResult(`${handoffResult.stdout}\n${handoffResult.stderr}`);
    const multiplexerLabel = `Multiplexer Pi handoff (${request.resolvedMultiplexer}) ${params.branchName}`;
    const handoffGap = resultGap(multiplexerLabel, handoffResult);
    if (handoffGap) {
      const handoffFailureSummary = multiplexerHandoffFailureSummary(params.branchName, handoffResult, parsed);
      const handoffOperatorAction = noRetryHandoffAction(parsed, modelSelection);
      const handoffRecoveryInstructions = handoffOperatorAction
        ? []
        : buildHandoffRecoveryInstructions({
          request,
          repo: params.repo,
          branchName: params.branchName,
          capsulePath: params.capsulePath,
        });
      evidence.gaps.push(handoffFailureSummary);
      if (parsed?.path) {
        evidence.gaps.push(
          `${multiplexerLabel}: Worktree/scope was created but Pi was not launched; continue in ${parsed.scopeName ?? parsed.tabName ?? parsed.sessionName ?? "the Worktrunk multiplexer scope"}, not this session.`,
        );
      } else if (commandTimedOut(handoffResult)) {
        evidence.gaps.push(
          `${multiplexerLabel}: timed out while waiting for the handoff script's normal discovery window; retry is still safe because the handoff script reuses an existing branch/worktree when Worktrunk reports one.`,
        );
      } else if (!handoffOperatorAction) {
        evidence.gaps.push(
          `${multiplexerLabel}: failed before a Worktrunk path was reported; retry is still safe because the handoff script reuses an existing branch/worktree when Worktrunk reports one.`,
        );
      }
      evidence.gaps.push(
        ...(handoffRecoveryInstructions.length
          ? handoffRecoveryInstructions
          : [blockedNoRecoveryAction(handoffOperatorAction)]),
      );
      return {
        status: "blocked",
        path: parsed?.path,
        piHandoffCommand: parsed?.piHandoffCommand,
        heartbeatCommand: parsed?.heartbeatCommand,
        handoffRecoveryInstructions,
        handoffOperatorAction,
        handoffFailureSummary,
        handoffTimedOut: commandTimedOut(handoffResult),
        multiplexerResult: parsed,
      };
    }

    if (parsed?.status !== "launched" || !parsed.path) {
      const handoffFailureSummary = `${multiplexerLabel}: result JSON missing launched path`;
      const handoffRecoveryInstructions = buildHandoffRecoveryInstructions({
        request,
        repo: params.repo,
        branchName: params.branchName,
        capsulePath: params.capsulePath,
      });
      evidence.gaps.push(handoffFailureSummary, ...handoffRecoveryInstructions);
      return {
        status: "blocked",
        handoffRecoveryInstructions,
        handoffFailureSummary,
        multiplexerResult: parsed,
      };
    }

    return {
      status: "launched",
      path: parsed.path,
      piHandoffCommand: parsed.piHandoffCommand ?? "scripts/workon-multiplexer-handoff.sh",
      heartbeatCommand: parsed.heartbeatCommand,
      multiplexerResult: parsed,
    };
  }

  const version = await runCommand(runner, request.cwd, evidence.commands, "wt", [
    "--version",
  ]);
  const versionGap = resultGap("Worktrunk availability", version);
  if (versionGap) {
    evidence.gaps.push(versionGap);
    return { status: "blocked" };
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

  const worktreePath = extractWorktreePath(`${result.stdout}\n${result.stderr}`);
  const handoffRecoveryInstructions = worktreePath
    ? buildHandoffRecoveryInstructions({
        request,
        repo: params.repo,
        branchName: params.branchName,
        capsulePath: params.capsulePath,
      })
    : [];
  evidence.gaps.push(
    "Pi handoff skipped: multiplexer resolved to none, so /workon used direct Worktrunk start; Pi and forge heartbeat cannot be launched from the direct path.",
    ...handoffRecoveryInstructions,
  );

  return {
    status: "started",
    path: worktreePath,
    handoffRecoveryInstructions,
  };
}

export function formatWorkonBootstrapEvidence(evidence: WorkonBootstrapEvidence): string[] {
  const issue = evidence.issue;
  const route = evidence.route ?? evidence.ledger?.route ?? routeFromWorktreeStatus(evidence.worktreeStatus ?? "not-started");
  const lines = [
    routeInstructionBlock({
      route,
      issueUrl: issue?.url,
      recoveryCommand: evidence.handoffRecoveryInstructions?.[0] ?? evidence.ledger?.recoveryInstructions[0],
      operatorAction: evidence.handoffOperatorAction ?? (evidence.ledger?.recoveryInstructions.length ? undefined : evidence.ledger?.safeNextAction),
      failureSummary: evidence.handoffFailureSummary ?? evidence.failureSummary ?? evidence.ledger?.failure.summary ?? undefined,
    }),
    "Deterministic workon bootstrap evidence:",
  ];
  if (issue && evidence.repo && evidence.readinessActionItems?.length) {
    lines.push(
      [
        `Route: ${route}`,
        `Source issue: ${evidence.repo}#${issue.number} ${issue.title}`,
        `Issue URL: ${issue.url}`,
        ...(evidence.issues && evidence.issues.length > 1
          ? [`Source issues: ${evidence.issues.map((sourceIssue) => `#${sourceIssue.number}`).join(", ")}`]
          : []),
        "Autonomous readiness: not-ready",
        "Worktree status: not-started",
        "Session capsule: not written",
        `Handoff ledger: ${evidence.ledgerPath ?? "not written"}`,
      ].join("\n"),
    );
  } else if (issue && evidence.repo && evidence.branchName && evidence.worktreeCommand) {
    lines.push(
      [
        `Route: ${route}`,
        `Source issue: ${evidence.repo}#${issue.number} ${issue.title}`,
        `Issue URL: ${issue.url}`,
        ...(evidence.issues && evidence.issues.length > 1
          ? [`Source issues: ${evidence.issues.map((sourceIssue) => `#${sourceIssue.number}`).join(", ")}`]
          : []),
        "Autonomous readiness: ready",
        `Suggested branch: ${evidence.branchName}`,
        `Suggested Worktrunk command: ${evidence.worktreeCommand}`,
        `Bootstrap phase guidance: resolve issue -> prepare capsule -> ${evidence.worktreeStatus === "prepared" ? "suggest branch only" : "create worktree"} -> ${evidence.worktreeStatus === "launched" ? "launch Pi -> launch heartbeat" : "handoff not launched"}`,
        `Multiplexer requested: ${evidence.requestedMultiplexer ?? evidence.ledger?.multiplexer.requested ?? "auto"}`,
        `Multiplexer resolved: ${evidence.resolvedMultiplexer ?? evidence.ledger?.multiplexer.resolved ?? "none"}`,
        `Launch eligibility: active multiplexer ${(evidence.resolvedMultiplexer ?? evidence.ledger?.multiplexer.resolved) !== "none" ? "yes" : "no"}`,
        `Worktree status: ${evidence.worktreeStatus ?? "prepared"}`,
        `Worktree path: ${evidence.worktreePath ?? "(not available)"}`,
        ...(evidence.handoffFailureSummary ? [`Handoff failure: ${evidence.handoffFailureSummary}`] : []),
        ...(evidence.ledger?.zellij.tabName ? [`Zellij tab name: ${evidence.ledger.zellij.tabName}`] : []),
        ...(evidence.ledger?.zellij.tabId !== null && evidence.ledger?.zellij.tabId !== undefined ? [`Zellij tab ID: ${evidence.ledger.zellij.tabId}`] : []),
        ...(evidence.ledger?.multiplexer.scopeName ? [`Multiplexer scope name: ${evidence.ledger.multiplexer.scopeName}`] : []),
        ...(evidence.ledger?.multiplexer.scopeId !== null && evidence.ledger?.multiplexer.scopeId !== undefined ? [`Multiplexer scope ID: ${evidence.ledger.multiplexer.scopeId}`] : []),
        ...(evidence.ledger?.zellij.worktreeAction ? [`Worktree action: ${evidence.ledger.zellij.worktreeAction}`] : []),
        ...(evidence.ledger?.pi.paneId ? [`Pi pane ID: ${evidence.ledger.pi.paneId}`] : []),
        ...(evidence.ledger?.pi.paneAction ? [`Pi pane action: ${evidence.ledger.pi.paneAction}`] : []),
        ...(evidence.ledger?.heartbeat.paneId ? [`Heartbeat pane ID: ${evidence.ledger.heartbeat.paneId}`] : []),
        ...(evidence.ledger?.heartbeat.action ? [`Heartbeat action: ${evidence.ledger.heartbeat.action}`] : []),
        `Pi handoff command: ${evidence.piHandoffCommand ?? "(not launched)"}`,
        `Forge heartbeat command: ${evidence.heartbeatCommand ?? "(not launched)"}`,
        `Exact model: ${evidence.modelSelection?.exactModel || DEFAULT_WORKON_MODEL_SELECTION.exactModel || "(unresolved)"}`,
        `Exact thinking level: ${evidence.modelSelection?.exactThinkingLevel ?? DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`,
        `Model routing mode: ${evidence.modelSelection?.routingMode ?? "default"}`,
        `Model routing reason: ${evidence.modelSelection?.routingReason ?? DEFAULT_WORKON_MODEL_SELECTION.routingReason}`,
        `Session capsule: ${evidence.capsulePath ?? "not written"}`,
        `Handoff ledger: ${evidence.ledgerPath ?? "not written"}`,
        ...(evidence.handoffRecoveryInstructions?.length
          ? ["Handoff recovery:", ...evidence.handoffRecoveryInstructions.map((instruction) => `- ${instruction}`)]
          : evidence.handoffOperatorAction
            ? ["Handoff recovery:", `- ${evidence.handoffOperatorAction}`]
            : []),
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

  const rawTargets = request.targets?.length ? request.targets : [request.target];
  const urlTargets = rawTargets.map(githubIssueTargetFromUrl);
  const allTargetsAreUrls = urlTargets.every((target): target is GithubIssueTarget => target !== null);
  const issueTargets: GithubIssueTarget[] = [];

  if (allTargetsAreUrls) {
    issueTargets.push(...urlTargets);
  } else {
    if (!await ensureGithubAuth(request, runner, evidence)) {
      return formatWorkonBootstrapEvidence(evidence);
    }
    for (const rawTarget of rawTargets) {
      const target = await resolveIssueTarget({ ...request, target: rawTarget }, evidence);
      if (!target) return formatWorkonBootstrapEvidence(evidence);
      issueTargets.push(target);
    }
  }

  const explicitRepoTargets = issueTargets.filter((target) => target.repo);
  const uniqueExplicitRepoKeys = [...new Set(explicitRepoTargets.map(githubIssueTargetKey))];
  if (uniqueExplicitRepoKeys.length === 1) {
    const explicitTarget = explicitRepoTargets[0];
    for (const target of issueTargets) {
      if (!target.repo && explicitTarget) {
        target.host = explicitTarget.host;
        target.repo = explicitTarget.repo;
      }
    }
  }
  const uniqueRepoKeys = [...new Set(issueTargets.filter((target) => target.repo).map(githubIssueTargetKey))];
  if (uniqueRepoKeys.length > 1) {
    evidence.gaps.push(`Grouped GitHub workon requires one repo and host; found ${issueTargets.map(githubRepoSelector).join(", ")}`);
    return formatWorkonBootstrapEvidence(evidence);
  }

  const resolvedForgeHost = issueTargets[0]?.host ?? stateForgeHost(request);
  const resolvedRequest = { ...request, forgeHost: resolvedForgeHost };
  if (allTargetsAreUrls && !await ensureGithubAuth(resolvedRequest, runner, evidence, resolvedForgeHost)) {
    return formatWorkonBootstrapEvidence(evidence);
  }

  const issues: GithubIssueMetadata[] = [];
  for (const target of issueTargets) {
    const issue = await readGithubIssue(resolvedRequest, runner, evidence, target);
    if (!issue) return formatWorkonBootstrapEvidence(evidence);
    issues.push(issue);
  }
  const issue = issues[0];
  if (!issue) return formatWorkonBootstrapEvidence(evidence);

  const resolvedRepos = [
    ...issueTargets.map((target) => target.repo).filter(Boolean),
    ...issues.map((sourceIssue) => repoFromGithubIssueUrl(sourceIssue.url)).filter((repo): repo is string => Boolean(repo)),
  ];
  const uniqueResolvedRepos = [...new Set(resolvedRepos.map((resolvedRepo) => resolvedRepo.toLowerCase()))];
  if (uniqueResolvedRepos.length > 1) {
    evidence.gaps.push(`Grouped GitHub workon requires one repo and host; found ${resolvedRepos.join(", ")}`);
    return formatWorkonBootstrapEvidence(evidence);
  }
  const repo = resolvedRepos[0] ?? "";
  if (!repo) {
    evidence.gaps.push("GitHub issue repository could not be resolved from --repo, issue URL, or issue metadata.");
    return formatWorkonBootstrapEvidence(evidence);
  }
  const readinessActionItemsByIssue = issues.map((sourceIssue) => ({
    issue: sourceIssue,
    actionItems: evaluateWorkonReadiness(sourceIssue),
  }));
  const readinessActionItems = readinessActionItemsByIssue.flatMap(({ actionItems }) => actionItems);
  if (readinessActionItems.length > 0) {
    evidence.issue = issue;
    evidence.issues = issues;
    evidence.repo = repo;
    evidence.route = "not_ready";
    evidence.readinessActionItems = readinessActionItems;
    evidence.readinessActionItemsByIssue = readinessActionItemsByIssue;
    evidence.gaps.push(formatReadinessActionItems(readinessActionItemsByIssue));
    const ledger = buildHandoffLedger({
      request: resolvedRequest,
      repo,
      issue,
      issues,
      worktreeStatus: "not-started",
      readinessActionItems,
      gaps: evidence.gaps,
    });
    evidence.ledger = ledger;
    evidence.ledgerPath = await writeHandoffLedger(ledger);
    return formatWorkonBootstrapEvidence(evidence);
  }

  const branchName = buildWorkonBranchName(issues);
  const worktreeCommand = `cd ${shellQuote(resolvedRequest.cwd)} && wt switch --create ${branchName} --format json`;
  const modelSelection = workonModelSelection(resolvedRequest);
  if (modelSelection.routingMode === "default" && !modelSelection.exactModel) {
    const operatorAction = "Run /khala status for model profile setup guidance, or rerun /workon with an explicit --model <provider/model> override.";
    const failureSummary = modelSelection.routingReason;
    evidence.issue = issue;
    evidence.issues = issues;
    evidence.repo = repo;
    evidence.branchName = branchName;
    evidence.worktreeCommand = worktreeCommand;
    evidence.worktreeStatus = "blocked";
    evidence.route = "blocked";
    evidence.modelSelection = modelSelection;
    evidence.handoffOperatorAction = operatorAction;
    evidence.failureSummary = failureSummary;
    evidence.gaps.push(failureSummary);
    const ledger = buildHandoffLedger({
      request: resolvedRequest,
      repo,
      issue,
      issues,
      branchName,
      worktreeCommand,
      worktreeStatus: "blocked",
      handoffOperatorAction: operatorAction,
      failureSummary,
      gaps: evidence.gaps,
    });
    evidence.ledger = ledger;
    evidence.ledgerPath = await writeHandoffLedger(ledger);
    return formatWorkonBootstrapEvidence(evidence);
  }
  if (resolvedRequest.dryRun) {
    evidence.gaps.push("Dry run requested: prepared capsule and branch suggestion only; no Worktrunk, multiplexer, Pi, or heartbeat launch was attempted.");
  }
  const initialRoute: WorkonRoute = resolvedRequest.mode === "start" && !resolvedRequest.dryRun && resolvedRequest.resolvedMultiplexer !== "none"
    ? "launched"
    : "prepared";
  const handoffPrompt = await buildHandoffPrompt({
    cwd: resolvedRequest.cwd,
    issue,
    issues,
    repo,
    branchName,
    heartbeat: resolvedRequest.heartbeat,
    modelSelection: workonModelSelection(resolvedRequest),
    ledgerPath: handoffLedgerPath(resolvedRequest, repo),
    route: initialRoute,
  });
  const initialCapsule = await writeCapsule({
    request: resolvedRequest,
    issue,
    issues,
    repo,
    branchName,
    worktreeCommand,
    worktreeStatus: "prepared",
    handoffPrompt,
    requestedMultiplexer: resolvedRequest.requestedMultiplexer,
    resolvedMultiplexer: resolvedRequest.resolvedMultiplexer,
  });
  const worktree = await startWorktreeIfRequested(resolvedRequest, runner, evidence, {
    repo,
    branchName,
    capsulePath: initialCapsule,
    handoffPrompt,
    ledgerPath: handoffLedgerPath(resolvedRequest, repo),
  });
  const finalHandoffPrompt = await buildHandoffPrompt({
    cwd: resolvedRequest.cwd,
    issue,
    issues,
    repo,
    branchName,
    heartbeat: resolvedRequest.heartbeat,
    modelSelection: workonModelSelection(resolvedRequest),
    ledgerPath: handoffLedgerPath(resolvedRequest, repo),
    route: worktree.status,
    recoveryCommand: worktree.handoffRecoveryInstructions?.[0],
    operatorAction: worktree.handoffOperatorAction,
    failureSummary: worktree.handoffFailureSummary,
  });
  const capsule = await writeCapsule({
    request: resolvedRequest,
    issue,
    issues,
    repo,
    branchName,
    worktreeCommand,
    worktreeStatus: worktree.status,
    worktreePath: worktree.path,
    piHandoffCommand: worktree.piHandoffCommand,
    heartbeatCommand: worktree.heartbeatCommand,
    handoffPrompt: finalHandoffPrompt,
    requestedMultiplexer: resolvedRequest.requestedMultiplexer,
    resolvedMultiplexer: resolvedRequest.resolvedMultiplexer,
    handoffRecoveryInstructions: worktree.handoffRecoveryInstructions,
    handoffOperatorAction: worktree.handoffOperatorAction,
    handoffFailureSummary: worktree.handoffFailureSummary,
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
  evidence.modelSelection = workonModelSelection(resolvedRequest);
  evidence.route = worktree.status;
  evidence.handoffPrompt = finalHandoffPrompt;
  evidence.requestedMultiplexer = resolvedRequest.requestedMultiplexer;
  evidence.resolvedMultiplexer = resolvedRequest.resolvedMultiplexer;
  evidence.handoffRecoveryInstructions = worktree.handoffRecoveryInstructions;
  evidence.handoffOperatorAction = worktree.handoffOperatorAction;
  evidence.handoffFailureSummary = worktree.handoffFailureSummary;
  evidence.capsulePath = capsule;
  const ledger = buildHandoffLedger({
    request: resolvedRequest,
    repo,
    issue,
    issues,
    branchName,
    capsulePath: capsule,
    worktreeCommand,
    worktreeStatus: worktree.status,
    worktreePath: worktree.path,
    piHandoffCommand: worktree.piHandoffCommand,
    heartbeatCommand: worktree.heartbeatCommand,
    handoffRecoveryInstructions: worktree.handoffRecoveryInstructions,
    handoffOperatorAction: worktree.handoffOperatorAction,
    handoffFailureSummary: worktree.handoffFailureSummary,
    handoffTimedOut: worktree.handoffTimedOut,
    gaps: evidence.gaps,
    multiplexerResult: worktree.multiplexerResult,
  });
  evidence.ledger = ledger;
  evidence.ledgerPath = await writeHandoffLedger(ledger);
  return formatWorkonBootstrapEvidence(evidence);
}

export function createExecFileRunner(): WorkonCommandRunner {
  return async (command, args, options) => {
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      return { ok: true, stdout, stderr, rawStdout: stdout, rawStderr: stderr, timeoutMs };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        signal?: string | null;
        killed?: boolean;
      };
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return {
        ok: false,
        stdout: redactSensitiveCommandArgs(nodeError.stdout, args) ?? "",
        stderr: redactSensitiveCommandArgs(nodeError.stderr, args) ?? "",
        error: redactSensitiveCommandArgs(nodeError.message, args),
        rawStdout: nodeError.stdout,
        rawStderr: nodeError.stderr,
        exitCode: nodeError.code,
        signal: nodeError.signal ?? null,
        killed: nodeError.killed,
        timedOut:
          nodeError.code === "ETIMEDOUT"
          || /timed out/i.test(nodeError.message)
          || (timeoutMs !== undefined && nodeError.killed === true && nodeError.signal === "SIGTERM" && nodeError.code == null),
        timeoutMs,
      };
    }
  };
}
