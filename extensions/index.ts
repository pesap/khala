import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import registerFffExtension from "@ff-labs/pi-fff/src/index.ts";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import registerSubagentExtension from "pi-subagents/src/extension/index.ts";
import { createComplianceCommandHandlers } from "./commands/compliance.ts";
import { createKhalaCommandHandlers } from "./commands/khala.ts";
import { createKhalaHubCommandHandlers } from "./commands/khala-hub.ts";
import { createCuratorCommandHandlers } from "./commands/curator.ts";
import { createLearnedWorkflowCommandHandlers } from "./commands/learned-workflows.ts";
import { createRunLedgerCommandHandlers } from "./commands/run-ledger.ts";
import { createRuleCommandHandlers } from "./commands/rules.ts";
import {
  buildReviewTarget,
  buildSimplifyTarget,
  buildSkillTemplate,
  chooseAvailableSkillName,
  parseAddressOpenIssuesArgs,
  parseApproveRiskArgs,
  parseAuditArgs,
  parseComplianceArgs,
  parseDebugArgs,
  parsePlanArgs,
  parseInboxArgs,
  parseWorkonArgs,
  parseLearnSkillArgs,
  parsePostflightArgs,
  parsePreflightArgs,
  parseReviewArgs,
  parseTriageArgs,
  type WorkflowFlags,
} from "./commands/parsers.ts";
import { registerCommands } from "./commands/register.ts";
import { createWorkflowCommandHandlers } from "./commands/workflow-handlers.ts";
import {
  ADDRESS_OPEN_ISSUES_COMMAND_SOURCE,
  AUDIT_COMMAND_SOURCE,
  PLAN_COMMAND_SOURCE,
  GIT_REVIEW_COMMAND_SOURCE,
  HARNESS_ISSUE_TYPE,
  INBOX_COMMAND_SOURCE,
  WORKON_COMMAND_SOURCE,
  LEARNING_VERSION,
  MEMORY_TAIL_LINES,
  PROMOTION_IMPROVEMENT_THRESHOLD,
  PROMOTION_MIN_OBSERVATIONS,
  PROMOTION_SUCCESS_THRESHOLD,
  POSTFLIGHT_INSTRUCTION,
  REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
  REVIEW_COMMAND_SOURCE,
  SHIP_COMMAND_SOURCE,
  SIMPLIFY_COMMAND_SOURCE,
  TRIAGE_COMMAND_SOURCE,
} from "./lib/constants.ts";
import { appendLine, exists, readText } from "./lib/io.ts";
import { normalizeWhitespace, slugify, summarizeEvidence } from "./lib/text.ts";
import { makeId, nowIso } from "./lib/time.ts";
import {
  DEFAULT_HOOK_CONFIG,
  loadHooksConfig,
  type HookConfig,
} from "./hooks/config.ts";
import { refreshCuratorReport } from "./learning/curator.ts";
import {
  KhalaAssessLearningParams,
  KhalaLearnParams,
  assessLearning,
  persistKhalaLearningRecord,
  readRecentKhalaLearningRecords,
  searchKhalaLearningRecords,
  validateLearningCandidateQuality,
  type KhalaLearningAssessment,
  type KhalaLearningRecord,
  type KhalaLearningSearchHit,
} from "./learning/khala-learn.ts";
import {
  searchKhalaMemory,
  type KhalaMemorySearchResult,
} from "./learning/search.ts";
import {
  clearSessionRules,
  readEffectiveRuntimeRules,
} from "./learning/rules.ts";
import {
  ensureLearningStore,
  getActiveLearningLessonsTail,
  getLearningMemoryTail,
  loadProjectReviewGuidelines,
  maybeEmitPromotionHint,
  type LearningLesson,
  type LearningPaths,
} from "./learning/store.ts";
import {
  ensureLearnedSkillLayout,
  listLearnedSkillRecords,
  markLearnedSkillPatched,
  readLearnedSkillMetadata,
  touchLearnedSkillUsage,
} from "./learning/skills.ts";
import { listLearnedWorkflows } from "./learning/workflows.ts";
import { validateGeneratedSkillDir } from "./learning/skill-guard.ts";
import {
  extractPostflightFromAssistantText,
  modeOutcome,
  parsePostflightLine,
  parsePreflightLine,
  type PreflightRecord,
} from "./policy/first-principles.ts";
import {
  evaluateMutationPreflightPolicy,
  evaluateSpawnPolicy,
} from "./policy/pipeline.ts";
import {
  createRuntimeState,
  hasValidRiskApproval,
  setAgentEnabled,
  type PolicyEvent,
} from "./state/runtime.ts";
import {
  appendAgentStateEntry,
  appendComplianceModeEntry,
  appendPolicyEvent,
  appendPostflightEntry,
  appendPreflightEntry,
  appendRiskApprovalEntry,
  getAgentEnabledFromSession,
  getComplianceModeFromSession,
  getPreflightFromSession,
  getRiskApprovalFromSession,
} from "./state/session.ts";
import {
  advanceWorkflowTrackingForTurnBoundary as advanceTrackedWorkflowForTurnBoundary,
  beginWorkflowTracking as beginTrackedWorkflow,
  completeWorkflowTracking as completeTrackedWorkflow,
  enqueueWorkflow as enqueueWorkflowMessage,
  ensureWorkflowSlotAvailable as ensureWorkflowSlotAvailableForCommand,
  interruptWorkflowTracking as interruptTrackedWorkflow,
  markWorkflowWaitingForFooter,
  recordWorkflowToolCall,
} from "./workflows/engine.ts";
import { workflowLocalContextFromFlags } from "./workflows/local.ts";
import { workflowSourceFromFlags } from "./workflows/source.ts";
import { notifyWorkflowStarted } from "./workflows/notifications.ts";
import {
  extractLastAssistantText,
  assistantMessageHasToolCall,
  assistantTurnHasToolCallSinceLatestUser,
  extractLastUserText,
  findPendingMemoryGateRecovery,
  getLastAssistantMessage,
  hasRequiredWorkflowFooter,
  inferOutcomeFromText,
  inferTurnObligation,
  isActionOrApprovalObligation,
  isAssistantClarification,
  isAssistantClarificationAllowedForObligation,
  isEmptyTerminalAssistantResponse,
  normalizeLoopGuardText,
  evaluateObligationLoopGuard,
  shouldBlockUnsatisfiedTurnObligation,
} from "./runtime/assistant.ts";
import {
  appendBackgroundReviewLearningSection,
  buildAutonomousSkillName,
  buildAutonomousSkillText,
  chooseAvailableGeneratedSkillName,
  chooseWritableLearnedSkillTarget,
  formatSelfImprovementBullet,
  formatSkillPromotionQueueLine,
  formatSkillReviewQueueLine,
  shouldRunSelfImprovementReview,
} from "./runtime/self-improvement.ts";
import {
  createWorkflowReaders,
  getBootstrapPayload,
  loadFirstPrinciplesConfig,
  readWorkflowSkill,
} from "./runtime/bootstrap.ts";
import {
  getToolInterceptionCounters,
  requiresFreshMemoryToolCall,
} from "./runtime/tool-interception.ts";
import {
  appendRunLedgerEvent,
  buildRunLedgerSkillEvent,
} from "./runtime/run-ledger.ts";
import {
  buildSkillUsedWithoutLoadEvents,
  type SkillRegistryEvent,
} from "./runtime/skill-registry.ts";
import { isMutationToolCall, toolCallContextParts } from "./runtime/tool-registry.ts";
import {
  runSessionEndHooks,
  type LowConfidenceEvent,
} from "./runtime/lifecycle.ts";
import {
  evaluateHarnessTurn,
  assistantClaimedSkillNames,
  memorySearchQueryQuality,
  type HarnessTurnIssue,
} from "./runtime/escalation.ts";
import { RUNTIME_PATHS, resolveWorkflowModelConfigPath } from "./runtime/paths.ts";
import {
  setActiveWorkflowRoute,
  setWorkflowModelConfig,
} from "./runtime/workflow-model-router.ts";
import { loadWorkflowModelConfig } from "./runtime/workflow-model-config.ts";
import {
  cloneRuntimeProfile,
  DEFAULT_RUNTIME_PROFILE,
  getWorkflowConfig,
  loadRuntimeProfile,
  validateRuntimeProfile,
  type RuntimeProfile,
  type WorkflowType,
} from "./runtime/profile.ts";
import { formatKhalaStatusLabel, notify, setKhalaStatus } from "./runtime/ui.ts";
type PreflightClarify = PreflightRecord["clarify"];
type PreflightSource = PreflightRecord["source"];

type PendingWorkflow = import("./workflows/engine").PendingWorkflow<
  string,
  WorkflowFlags
>;

let pendingWorkflow: PendingWorkflow | null = null;
const learningPathCache = new Map<string, LearningPaths>();
let activeHookConfig: HookConfig = DEFAULT_HOOK_CONFIG;
let activeRuntimeProfile: RuntimeProfile = DEFAULT_RUNTIME_PROFILE;
let lowConfidenceEvents: LowConfidenceEvent[] = [];
let bundledExtensionsInitialized = false;
const runtimeState = createRuntimeState();
const REPEATED_BLOCK_GUARD_THRESHOLD = 3;
let taskToolCallCount = 0;
let latestUserInput = "";
let latestTaskInput = "";
let latestMemoryRefreshQuery = "";
let learnedSkillCompletionCache: string[] = [];
let learnedWorkflowCompletionCache: string[] = [];
let memoryGate = {
  hasRead: false,
  toolCallsSinceRead: 0,
  invalidReason: "task start",
};

async function recordPendingWorkflowToolCall(params: {
  workflow: PendingWorkflow | null;
  toolName: string;
  input?: unknown;
  at: string;
}): Promise<void> {
  await recordWorkflowToolCall(params);
}

async function recordPendingWorkflowSkillEvent(params: {
  workflow: PendingWorkflow | null;
  event: SkillRegistryEvent;
  at: string;
}): Promise<void> {
  if (!params.workflow) return;
  await appendRunLedgerEvent({
    runFile: params.workflow.runFile,
    event: buildRunLedgerSkillEvent({
      workflowId: params.workflow.id,
      event: params.event,
      at: params.at,
    }),
  });
}

async function recordSkillUsedWithoutLoadEvents(params: {
  workflow: PendingWorkflow | null;
  assistantText: string;
  reason: string;
  at: string;
}): Promise<void> {
  const events = buildSkillUsedWithoutLoadEvents({
    claimedSkills: assistantClaimedSkillNames(params.assistantText),
    loadedSkills: params.workflow?.loadedSkills ?? [],
    knownSkills: params.workflow?.skillMetadata ?? [],
    reason: params.reason,
  });
  for (const event of events) {
    await recordPendingWorkflowSkillEvent({
      workflow: params.workflow,
      event,
      at: params.at,
    });
  }
}

async function interruptPendingWorkflow(params: {
  reason: string;
  notifyContext?: Pick<ExtensionContext, "hasUI" | "ui">;
}): Promise<void> {
  const workflow = pendingWorkflow;
  if (!workflow) return;
  try {
    await interruptTrackedWorkflow({
      workflow,
      at: nowIso(),
      reason: params.reason,
    });
  } catch (error) {
    if (params.notifyContext) {
      notify(
        params.notifyContext,
        `Failed to mark workflow ${workflow.id} interrupted: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }
}

function clampPositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  return Math.max(1, Math.min(max, int));
}

function clampUnit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeRepoRemote(value: string): string {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function runGitValue(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 1_500,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function resolveRepoMemoryKey(cwd: string): string {
  const remote = runGitValue(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote) return normalizeRepoRemote(remote);
  const root = runGitValue(cwd, ["rev-parse", "--show-toplevel"]);
  return normalizeRepoRemote(root || cwd);
}

function resolveRepoLocalSkillsPath(cwd: string): string {
  const root = runGitValue(cwd, ["rev-parse", "--show-toplevel"]);
  return path.join(root || cwd, "skills");
}

function resolveUserSkillPaths(): string[] {
  const home = homedir();
  return [
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

async function resolvePluginSkillPaths(): Promise<string[]> {
  const pluginCache = path.join(homedir(), ".codex", "plugins", "cache");
  let pluginNames: string[];
  try {
    pluginNames = await fs.readdir(pluginCache);
  } catch {
    return [];
  }

  const skillRoots: string[] = [];
  for (const pluginName of pluginNames) {
    const pluginRoot = path.join(pluginCache, pluginName);
    let versions: string[];
    try {
      versions = await fs.readdir(pluginRoot);
    } catch {
      continue;
    }
    for (const version of versions) {
      skillRoots.push(path.join(pluginRoot, version, "skills"));
    }
  }
  return skillRoots;
}

let sessionFirstPrinciplesDefaults = { ...runtimeState.firstPrinciplesConfig };

const workflowReaders = createWorkflowReaders({
  skillflowsDir: RUNTIME_PATHS.skillflowsDir,
  commandsDir: RUNTIME_PATHS.commandsDir,
  packageSkillsPath: RUNTIME_PATHS.packageSkillsPath,
  learnedSkillsPath: path.join(homedir(), ".pi", "khala", "skills"),
});
const USER_CORRECTION_PATTERN =
  /\b(wrong|not working|stalling|stalled|do not|don't|instead|actually|stop planning|implement it)\b/i;

const INTERCEPTED_COMMAND_PATHS = [
  RUNTIME_PATHS.interceptedCommandsDir,
  path.join(RUNTIME_PATHS.packageRoot, "node_modules", ".bin"),
] as const;

function prependInterceptedCommandsPath(command: string): string {
  const escapedPathPrefix = INTERCEPTED_COMMAND_PATHS.map((entry) =>
    entry.replace(/"/g, '\\"'),
  ).join(":");
  return `export PATH="${escapedPathPrefix}:$PATH"\n${command}`;
}

function withInterceptedPathEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const currentPath = baseEnv.PATH ?? baseEnv.Path ?? "";
  const pathPrefix = INTERCEPTED_COMMAND_PATHS.join(path.delimiter);
  const mergedPath = currentPath
    ? `${pathPrefix}${path.delimiter}${currentPath}`
    : pathPrefix;

  return {
    ...baseEnv,
    PATH: mergedPath,
    Path: mergedPath,
  };
}

function createInterceptedUserBashOperations() {
  const local = createLocalBashOperations();
  return {
    exec: (
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ) =>
      local.exec(command, cwd, {
        ...options,
        env: withInterceptedPathEnv(options.env ?? process.env),
      }),
  };
}

function parseBooleanEnv(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
  if (/^(?:0|false|no|off)$/i.test(raw)) return false;
  return null;
}

function detectPowerShellParentOnWindows(): boolean {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${process.ppid}"; if ($null -ne $proc) { $proc.Name }`,
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 1000,
    },
  );

  if (result.error || result.status !== 0) return false;
  const parentName = (result.stdout ?? "").trim().toLowerCase();
  return parentName.includes("pwsh") || parentName.includes("powershell");
}

function shouldUsePowerShellBashOverride(): boolean {
  if (process.platform !== "win32") return false;

  const forcedPowerShell = parseBooleanEnv("KHALA_FORCE_POWERSHELL_BASH");
  if (forcedPowerShell !== null) return forcedPowerShell;

  return detectPowerShellParentOnWindows();
}

function getWindowsPowerShellCandidates(): string[] {
  const configured = process.env.KHALA_POWERSHELL_PATH?.trim();
  if (configured) return [configured];

  return ["pwsh.exe", "powershell.exe"];
}

type PowerShellBashResult = {
  shell: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function runPowerShellCommand(params: {
  shell: string;
  command: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<PowerShellBashResult> {
  const timeoutSeconds =
    typeof params.timeoutSeconds === "number" &&
    Number.isFinite(params.timeoutSeconds)
      ? Math.max(1, Math.floor(params.timeoutSeconds))
      : null;
  const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : null;

  return await new Promise<PowerShellBashResult>((resolve, reject) => {
    const child = spawn(
      params.shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        params.command,
      ],
      {
        cwd: process.cwd(),
        env: withInterceptedPathEnv(process.env),
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeoutHandle =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      params.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      child.kill();
      settle(() => {
        cleanup();
        reject(new Error("PowerShell command aborted by signal"));
      });
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      settle(() => {
        cleanup();
        reject(error);
      });
    });

    child.on("close", (code) => {
      settle(() => {
        cleanup();
        resolve({
          shell: params.shell,
          command: params.command,
          exitCode: code ?? (timedOut ? 124 : 1),
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  });
}

async function runPowerShellCommandWithFallback(params: {
  command: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<PowerShellBashResult> {
  const candidates = getWindowsPowerShellCandidates();
  let lastError: unknown = null;

  for (const shell of candidates) {
    try {
      return await runPowerShellCommand({
        shell,
        command: params.command,
        timeoutSeconds: params.timeoutSeconds,
        signal: params.signal,
      });
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errno === "ENOENT") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw (
    lastError ?? new Error("No PowerShell executable found for bash override.")
  );
}

function createPowerShellBashTool(): Record<string, unknown> {
  return {
    name: "bash",
    description:
      "Execute a PowerShell command as a Windows bash override. Returns stdout/stderr and exit details.",
    parameters: Type.Object({
      command: Type.String({
        description: "PowerShell command to execute",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (optional)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { command?: string; timeout?: number },
      signal: AbortSignal,
    ) => {
      const command =
        typeof params.command === "string" ? params.command.trim() : "";
      if (!command) {
        throw new Error("bash tool requires a non-empty command string.");
      }

      if (runtimeState.agentEnabled) {
        const policy = evaluateSpawnPolicy(command, {
          hookConfig: activeHookConfig,
          hasValidRiskApproval: hasValidRiskApproval(runtimeState),
          nowIso,
        });

        if (policy.riskEvent) {
          runtimeState.riskEvents.push(policy.riskEvent);
        }

        if (policy.consumeRiskApproval) {
          runtimeState.riskApproval = null;
        }

        if (policy.blockedMessage) {
          throw new Error(policy.blockedMessage);
        }
      }

      const result = await runPowerShellCommandWithFallback({
        command,
        timeoutSeconds: params.timeout,
        signal,
      });

      const text =
        [result.stdout.trimEnd(), result.stderr.trimEnd()]
          .filter((entry) => entry.length > 0)
          .join(result.stdout && result.stderr ? "\n" : "") ||
        `(no output; exit=${result.exitCode})`;

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        details: result,
      };
    },
  };
}

function warnBundledExtensionLoadFailure(
  ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
  extensionName: string,
  error: unknown,
): void {
  const message = `Failed to load bundled ${extensionName}: ${error instanceof Error ? error.message : String(error)}`;
  if (ctx) {
    notify(ctx, message, "warning");
    return;
  }
  console.warn(message);
}

function registerBundledExtension(
  ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
  extensionName: string,
  register: () => void,
): void {
  try {
    register();
  } catch (error) {
    warnBundledExtensionLoadFailure(ctx, extensionName, error);
  }
}

function shouldConsiderKhalaLearning(params: {
  userText: string;
  assistantText: string;
  workflow: PendingWorkflow | null;
  harnessIssueSummaries?: string[];
}): boolean {
  if ((params.harnessIssueSummaries?.length ?? 0) > 0) return true;
  const combined = normalizeWhitespace(
    `${params.userText} ${params.assistantText}`,
  );
  if (taskToolCallCount > runtimeState.memoryToolCallLimit) return true;
  if (params.workflow !== null) return true;
  if (combined.length >= 40) return true;
  return /\b(wrong|not working|stalling|stalled|do not|don't|instead|actually|stop planning|implement it|unsigned commit|duplicate pr|stale branch|preflight|postflight)\b/i.test(
    combined,
  );
}

async function maybeAssessAndLearn(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  workflow: PendingWorkflow | null;
  userText: string;
  assistantText: string;
  harnessIssueSummaries?: string[];
}): Promise<KhalaLearningAssessment | null> {
  if (!runtimeState.agentEnabled) return null;
  if (
    !shouldConsiderKhalaLearning({
      userText: params.userText,
      assistantText: params.assistantText,
      workflow: params.workflow,
      harnessIssueSummaries: params.harnessIssueSummaries,
    })
  ) {
    return null;
  }

  const paths = await ensureLearningStore(params.ctx.cwd, learningPathCache);
  const repoKey = resolveRepoMemoryKey(params.ctx.cwd);
  const recents = await readRecentKhalaLearningRecords(paths, 20, { repoKey });
  const assessment = assessLearning(
    {
      taskSummary: params.userText,
      assistantSummary: params.assistantText,
      workflowType: params.workflow?.type,
      workflowId: params.workflow?.id,
      mutationCount: params.workflow?.mutationCount ?? 0,
      loadedSkills: params.workflow?.loadedSkills ?? [],
      policyWarnings: [
        ...(params.workflow?.policyWarnings ?? []),
        ...(params.harnessIssueSummaries ?? []),
      ],
      userCorrection: USER_CORRECTION_PATTERN.test(params.userText),
      ...(taskToolCallCount > runtimeState.memoryToolCallLimit
        ? {
            reusable: true,
            confidenceHint: 0.78,
            trigger: "task exceeds memory refresh threshold",
            lessonCandidate:
              "For long tasks, refresh memory after the configured tool-call limit and force an end-of-task learning review so stale context and reusable workflow corrections are not missed.",
            evidence: [
              `${taskToolCallCount} tool call(s) in task; limit=${runtimeState.memoryToolCallLimit}`,
            ],
          }
        : {}),
    },
    recents,
  );

  params.pi.appendEntry("khala-learning-assessment", {
    at: nowIso(),
    workflowId: params.workflow?.id ?? null,
    workflowType: params.workflow?.type ?? null,
    score: assessment.score,
    confidence: assessment.confidence,
    shouldLearn: assessment.shouldLearn,
    reason: assessment.reason,
    trigger: assessment.trigger,
    lesson: assessment.lesson,
  });

  if (!assessment.shouldLearn) return assessment;

  const record: KhalaLearningRecord = {
    version: LEARNING_VERSION,
    id: makeId("khala-learn"),
    timestamp: nowIso(),
    source: "auto",
    workflowType: params.workflow?.type,
    workflowId: params.workflow?.id,
    actionTaken: [],
    repoKey,
    status: "active",
    ...assessment,
  };
  await persistKhalaLearningRecord(paths, record);

  notify(
    params.ctx,
    `khala learned: ${record.trigger} (score=${record.score.toFixed(2)})`,
    "info",
  );
  return assessment;
}

async function runSelfImprovementReview(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  workflow: PendingWorkflow | null;
  userText: string;
  assistantText: string;
  assessment: KhalaLearningAssessment | null;
}): Promise<void> {
  const loadedSkills = params.workflow?.loadedSkills ?? [];
  const assessment = params.assessment;
  const skillPatchSignal = inferSkillPatchSignal(params.assistantText);

  if (
    !shouldRunSelfImprovementReview({
      hasMeaningfulWorkflow: Boolean(
        params.workflow && shouldRunActiveLearningReview(params.workflow),
      ),
      assessment,
      userCorrection: USER_CORRECTION_PATTERN.test(params.userText),
      skillPatchSignal,
    })
  ) {
    return;
  }

  const paths = await ensureLearningStore(params.ctx.cwd, learningPathCache);
  const actions: string[] = [];

  if (
    assessment?.shouldLearn &&
    !assessment.sensitive &&
    assessment.lesson.trim()
  ) {
    const records = await Promise.all(
      loadedSkills.map((skillName) =>
        readLearnedSkillMetadata(paths, skillName),
      ),
    );
    const target = chooseWritableLearnedSkillTarget(records);

    if (target) {
      const original = await readText(target.skillFile);
      const bullet = formatSelfImprovementBullet({
        date: nowIso().slice(0, 10),
        lesson: assessment.lesson,
        trigger: assessment.trigger,
        evidence: summarizeEvidence(
          params.assistantText || params.userText,
          180,
        ),
      });
      await fs.writeFile(
        target.skillFile,
        appendBackgroundReviewLearningSection(original, bullet),
        "utf8",
      );
      const guard = await validateGeneratedSkillDir(target.dir);
      if (!guard.ok) {
        await fs.writeFile(target.skillFile, original, "utf8");
        await appendLine(
          paths.promotionQueue,
          formatSkillPromotionQueueLine({
            date: nowIso().slice(0, 10),
            target: target.metadata.name,
            trigger: assessment.trigger,
            lesson: assessment.lesson,
          }),
        );
        actions.push(
          `Promotion queue updated after ${target.metadata.name} guard failure`,
        );
      } else {
        await markLearnedSkillPatched({
          paths,
          skillName: target.metadata.name,
          nowIso: nowIso(),
        });
        actions.push(`Skill ${target.metadata.name} patched`);
      }
    } else {
      const date = nowIso().slice(0, 10);
      if (assessment.promotable) {
        const preferredSkillName = buildAutonomousSkillName({
          trigger: assessment.trigger,
          fallback: assessment.lesson,
          slugify,
        });
        const reservedNames = new Set(
          (await listLearnedSkillRecords(paths)).map(
            (record) => record.metadata.name,
          ),
        );
        const skillName = chooseAvailableGeneratedSkillName({
          preferredName: preferredSkillName,
          reservedNames,
        });
        const learnedSkill = await ensureLearnedSkillLayout({
          paths,
          skillName,
          nowIso: nowIso(),
          provenance: "background-review-authored",
          sourceRunId: params.workflow?.id ?? null,
        });
        const skillText = buildAutonomousSkillText({
          skillName,
          trigger: assessment.trigger,
          lesson: assessment.lesson,
          evidence: summarizeEvidence(
            params.assistantText || params.userText,
            220,
          ),
          date,
        });
        await fs.writeFile(learnedSkill.skillFile, skillText, "utf8");
        const guard = await validateGeneratedSkillDir(learnedSkill.dir);
        if (!guard.ok) {
          await fs.rm(learnedSkill.dir, { recursive: true, force: true });
          await appendLine(
            paths.promotionQueue,
            formatSkillPromotionQueueLine({
              date,
              target: skillName,
              trigger: assessment.trigger,
              lesson: assessment.lesson,
            }),
          );
          actions.push(
            `Promotion queue updated after ${skillName} guard failure`,
          );
        } else {
          actions.push(`Learned skill ${skillName} created`);
        }
      } else {
        await appendLine(
          paths.promotionQueue,
          formatSkillPromotionQueueLine({
            date,
            target: loadedSkills[0] ?? "existing umbrella skill",
            trigger: assessment.trigger,
            lesson: assessment.lesson,
          }),
        );
        actions.push("Promotion queue updated");
      }
    }
  } else if (
    USER_CORRECTION_PATTERN.test(params.userText) ||
    skillPatchSignal
  ) {
    await appendLine(
      paths.promotionQueue,
      formatSkillReviewQueueLine({
        date: nowIso().slice(0, 10),
        loadedSkills:
          loadedSkills.length > 0 ? loadedSkills : ["existing umbrella skill"],
        evidence: summarizeEvidence(
          params.assistantText || params.userText,
          220,
        ),
      }),
    );
    actions.push("Promotion queue updated");
  }

  if (actions.length === 0) return;
  const summary = Array.from(new Set(actions)).join(" · ");
  params.pi.appendEntry("khala-self-improvement-review", {
    at: nowIso(),
    workflowId: params.workflow?.id ?? null,
    workflowType: params.workflow?.type ?? null,
    actions,
    loadedSkills,
    trigger: assessment?.trigger ?? null,
  });
  notify(params.ctx, `💾 Self-improvement review: ${summary}`, "info");
}

function shouldRunActiveLearningReview(workflow: PendingWorkflow): boolean {
  return (
    workflow.type !== "learn-skill" &&
    (workflow.mutationCount > 0 ||
      workflow.loadedSkills.length > 0 ||
      workflow.type === "debug" ||
      workflow.type === "triage" ||
      workflow.type === "review" ||
      workflow.type === "simplify" ||
      workflow.type === "plan")
  );
}

function isContinuationInput(text: string): boolean {
  return /^(?:continue|go on|proceed|yes|y|ok|okay|tes)$/i.test(text.trim());
}

function resetMemoryGate(reason: string): void {
  memoryGate = {
    hasRead: false,
    toolCallsSinceRead: 0,
    invalidReason: reason,
  };
  latestMemoryRefreshQuery = "";
}

function markMemoryRead(): void {
  memoryGate = {
    hasRead: true,
    toolCallsSinceRead: 0,
    invalidReason: "",
  };
  latestMemoryRefreshQuery = "";
}

function isMemoryFresh(): boolean {
  return (
    memoryGate.hasRead &&
    memoryGate.toolCallsSinceRead < runtimeState.memoryToolCallLimit
  );
}

function staleMemoryReason(): string {
  if (!memoryGate.hasRead) return memoryGate.invalidReason || "task start";
  if (memoryGate.toolCallsSinceRead >= runtimeState.memoryToolCallLimit) {
    return `${memoryGate.toolCallsSinceRead} non-memory tool calls since last memory read (limit=${runtimeState.memoryToolCallLimit})`;
  }
  return "unknown";
}

function buildMemoryRefreshQuery(event: { toolName: string; input?: unknown }): string {
  return [latestTaskInput || latestUserInput, ...toolCallContextParts(event)]
    .filter(Boolean)
    .join(" ")
    .trim();
}

const MEMORY_CONTEXT_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "when",
  "from",
  "into",
  "should",
  "memory",
  "khala",
  "read",
  "write",
  "edit",
]);

function memoryContextTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
      ?.filter((term) => !MEMORY_CONTEXT_STOP_WORDS.has(term)) ?? [],
  );
}

function learningRecordMatchesContext(
  record: KhalaLearningRecord,
  contextQuery: string,
): boolean {
  const queryTokens = memoryContextTokens(contextQuery);
  if (queryTokens.size === 0) return true;
  const recordTokens = memoryContextTokens(
    `${record.trigger} ${record.lesson} ${record.kind} ${record.workflowType ?? ""}`,
  );
  for (const token of queryTokens) {
    if (recordTokens.has(token)) return true;
  }
  return false;
}

function inferSkillPatchSignal(text: string): boolean {
  return /\b(?:workaround|manual step|missing step|stale|incomplete|pitfall|had to)\b/i.test(
    text,
  );
}

async function appendCuratorReportEntry(params: {
  cwd: string;
  workflow: PendingWorkflow;
  assistantText: string;
}): Promise<void> {
  if (!shouldRunActiveLearningReview(params.workflow)) return;

  const paths = await ensureLearningStore(params.cwd, learningPathCache);
  const touched: string[] = [];
  const recommendations: string[] = [];
  const reviewAt = nowIso();

  for (const skillName of params.workflow.loadedSkills) {
    const record = await touchLearnedSkillUsage({
      paths,
      skillName,
      nowIso: reviewAt,
    });
    if (!record) continue;
    touched.push(
      `${skillName} (${record.metadata.provenance}, uses=${record.metadata.useCount})`,
    );

    if (inferSkillPatchSignal(params.assistantText)) {
      recommendations.push(
        record.metadata.provenance === "agent-authored" ||
          record.metadata.provenance === "background-review-authored"
          ? `Patch learned skill \`${skillName}\` from workflow ${params.workflow.id}.`
          : `Propose a patch for read-only learned skill \`${skillName}\` from workflow ${params.workflow.id}.`,
      );
    }
  }

  if (touched.length === 0 && recommendations.length === 0) return;

  const entry = [
    `## ${reviewAt} ${params.workflow.type}/${params.workflow.id}`,
    touched.length > 0 ? `- Loaded learned skills: ${touched.join(", ")}` : "",
    recommendations.length > 0
      ? `- Recommendations: ${recommendations.join(" ")}`
      : "",
    `- Evidence: ${summarizeEvidence(params.assistantText, 220)}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  await appendLine(paths.curatorReport, entry);
}

function ensureBundledExtensions(
  pi: ExtensionAPI,
  ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
): void {
  if (bundledExtensionsInitialized) return;
  bundledExtensionsInitialized = true;

  registerBundledExtension(ctx, "pi-subagents", () => {
    registerSubagentExtension(pi);
  });

  registerBundledExtension(ctx, "@ff-labs/pi-fff", () =>
    registerFffExtension(pi),
  );
}

function isPreflightClarify(value: unknown): value is PreflightClarify {
  return value === "yes" || value === "no";
}

function isPreflightSource(value: unknown): value is PreflightSource {
  return value === "manual" || value === "auto";
}

function setAgentEnabledState(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  enabled: boolean,
): void {
  setAgentEnabled(runtimeState, enabled);
  refreshKhalaModeStatus(ctx);
}

function refreshKhalaModeStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  setKhalaStatus(
    ctx,
    formatKhalaStatusLabel(ctx, runtimeState.firstPrinciplesConfig.responseComplianceMode),
  );
}

function ensureAgentEnabledForCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  source: WorkflowType,
): void {
  if (runtimeState.agentEnabled) return;
  setAgentEnabledState(ctx, true);
  appendAgentStateEntry(pi, true, nowIso(), source);
  notify(ctx, `khala initialized automatically for /${source}.`, "info");
}

function addPolicyEvent(pi: ExtensionAPI, event: PolicyEvent): void {
  appendPolicyEvent(pi, runtimeState, event);
}

function appendHarnessIssueEntry(
  pi: ExtensionAPI,
  issue: {
    code: string;
    title: string;
    block: boolean;
    message: string;
  },
  context: {
    workflow: PendingWorkflow | null;
    userText: string;
  },
): void {
  pi.appendEntry(HARNESS_ISSUE_TYPE, {
    at: nowIso(),
    code: issue.code,
    title: issue.title,
    block: issue.block,
    mode: runtimeState.firstPrinciplesConfig.responseComplianceMode,
    workflowId: context.workflow?.id ?? null,
    workflowType: context.workflow?.type ?? null,
    userSummary: summarizeEvidence(context.userText, 180),
    message: issue.message,
  });
}

async function refreshLearnedResourceCompletions(cwd: string): Promise<void> {
  const paths = await ensureLearningStore(cwd, learningPathCache);
  const [skills, workflows] = await Promise.all([
    listLearnedSkillRecords(paths),
    listLearnedWorkflows(paths),
  ]);
  learnedSkillCompletionCache = skills
    .filter((record) => record.metadata.state !== "archived")
    .map((record) => record.metadata.name)
    .sort();
  learnedWorkflowCompletionCache = workflows.map((workflow) => workflow.name);
}

function completeFromCache(items: string[], prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  const matches = items.filter((item) =>
    item.toLowerCase().startsWith(normalized),
  );
  return matches.length > 0
    ? matches.map((item) => ({ value: item, label: item }))
    : null;
}

function ensureWorkflowSlotAvailable(ctx: ExtensionCommandContext): boolean {
  return ensureWorkflowSlotAvailableForCommand(ctx, pendingWorkflow, notify);
}

async function enqueueWorkflow(
  pi: ExtensionAPI,
  workflowPromptName: string,
  workflowFileName: string,
  sections: string[],
  workflow?: PendingWorkflow,
  cwd?: string,
): Promise<{ loadedSkills: string[]; skillMetadata: PendingWorkflow["skillMetadata"] }> {
  return enqueueWorkflowMessage({
    pi,
    workflowPromptName,
    workflowFileName,
    sections,
    readCommandPrompt: workflowReaders.readCommandPrompt,
    readWorkflow: workflowReaders.readWorkflow,
    readSkill: async (skillName) => {
      if (!cwd) return workflowReaders.readSkill(skillName);
      const paths = await ensureLearningStore(cwd, learningPathCache);
      return readWorkflowSkill({
        name: skillName,
        packageSkillsPath: RUNTIME_PATHS.packageSkillsPath,
        learnedSkillsPath: paths.skillsDir,
        repoSkillsPath: resolveRepoLocalSkillsPath(cwd),
        userSkillsPaths: resolveUserSkillPaths(),
        pluginSkillsPaths: await resolvePluginSkillPaths(),
      });
    },
    onSkillEvent: (event) =>
      recordPendingWorkflowSkillEvent({
        workflow: workflow ?? null,
        event,
        at: nowIso(),
      }),
  });
}

async function beginWorkflowTracking(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  type: string,
  input: string,
  flags: WorkflowFlags,
  workflowSpecOverride?: string,
): Promise<PendingWorkflow> {
  const workflowConfig = Object.hasOwn(activeRuntimeProfile.workflows, type)
    ? getWorkflowConfig(activeRuntimeProfile, type as WorkflowType)
    : null;
  const workflowSpec = workflowConfig
    ? await workflowReaders.readWorkflow(workflowConfig.workflowFile)
    : workflowSpecOverride;
  const pending = await beginTrackedWorkflow({
    pi,
    ctx,
    type,
    input,
    flags,
    workflowSpec,
    source: workflowSourceFromFlags(flags),
    local: workflowLocalContextFromFlags(flags),
    learningVersion: LEARNING_VERSION,
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    makeId,
    nowIso,
    summarizeEvidence,
    runtimeState,
    appendPreflightEntry,
  });
  pendingWorkflow = pending;
  return pending;
}

async function completeWorkflowTracking(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflow: PendingWorkflow,
  assistantText: string,
): Promise<void> {
  await completeTrackedWorkflow({
    pi,
    ctx,
    workflow,
    assistantText,
    learningVersion: LEARNING_VERSION,
    lowConfidenceThreshold: activeRuntimeProfile.lowConfidenceThreshold,
    runtimeState,
    inferOutcomeFromText,
    nowIso,
    extractPostflightFromAssistantText,
    modeOutcome,
    addPolicyEvent,
    appendPostflightEntry,
    summarizeEvidence,
    appendLine,
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    maybeEmitPromotionHint: (paths, observation, context) =>
      maybeEmitPromotionHint({
        paths,
        observation,
        ctx: context,
        promotionMinObservations: PROMOTION_MIN_OBSERVATIONS,
        promotionSuccessThreshold: PROMOTION_SUCCESS_THRESHOLD,
        promotionImprovementThreshold: PROMOTION_IMPROVEMENT_THRESHOLD,
        nowIso,
        summarizeEvidence,
        notify,
      }),
    notify,
    onLowConfidence: (event) => {
      lowConfidenceEvents.push(event);
    },
  });
  try {
    await appendCuratorReportEntry({
      cwd: ctx.cwd,
      workflow,
      assistantText,
    });
    const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
    await refreshCuratorReport({
      paths,
      nowIso: nowIso(),
    });
  } catch (error) {
    notify(
      ctx,
      `Active-learning review failed: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
}

function clipDisplay(text: unknown, maxLength = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

type KhalaToolRenderResult = {
  details?: unknown;
  content?: Array<{ text?: string }>;
};
type KhalaToolTheme = {
  fg: (name: string, value: string) => string;
  bold: (value: string) => string;
};

type LooseExtensionAPI = {
  registerTool: (tool: Record<string, unknown>) => void;
  on: (
    eventName: string,
    handler: (event: unknown, ctx: ExtensionContext) => unknown,
  ) => void;
};

function parseToolJsonDetails<T>(result: KhalaToolRenderResult): T | null {
  if (result.details && typeof result.details === "object")
    return result.details as T;
  const text = result.content?.find(
    (item) => typeof item.text === "string",
  )?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function expandHint(expanded: boolean): string {
  return expanded ? "" : " (ctrl+o to expand)";
}

function renderKhalaAssessResult(
  result: KhalaToolRenderResult,
  expanded: boolean,
  theme: KhalaToolTheme,
): Text {
  const assessment = parseToolJsonDetails<KhalaLearningAssessment>(result);
  if (!assessment)
    return new Text(theme.fg("muted", "assessment complete"), 0, 0);

  const decision = assessment.shouldLearn ? "learn" : "skip";
  let text = `${theme.fg(assessment.shouldLearn ? "success" : "muted", decision)} `;
  text += `${assessment.kind}/${assessment.scope} `;
  text += theme.fg(
    "muted",
    `score=${assessment.score.toFixed(2)} conf=${assessment.confidence.toFixed(2)}`,
  );
  text += ` — ${clipDisplay(assessment.trigger, 90)}${expandHint(expanded)}`;

  if (expanded) {
    text += `\nlesson: ${clipDisplay(assessment.lesson || assessment.reason, 220)}`;
    if (assessment.evidence.length > 0) {
      text += `\nevidence: ${assessment.evidence
        .slice(0, 3)
        .map((item) => clipDisplay(item, 90))
        .join("; ")}`;
      if (assessment.evidence.length > 3)
        text += `; +${assessment.evidence.length - 3} more`;
    }
  }

  return new Text(text, 0, 0);
}

function learningHitToMemoryResult(hit: KhalaLearningSearchHit) {
  return {
    path: `memory/khala-learning.jsonl#${hit.record.id}`,
    kind: "learning" as const,
    score: hit.score,
    title: hit.record.trigger,
    snippet: hit.snippet,
  };
}

function renderKhalaMemoryResult(
  result: KhalaToolRenderResult,
  expanded: boolean,
  theme: KhalaToolTheme,
): Text {
  const payload = parseToolJsonDetails<{
    storeRoot: string;
    contextQuery?: string;
    relevantMemory?: Array<{
      kind: string;
      score: number;
      title: string;
      snippet: string;
    }>;
    memoryTail: string;
    activeLessons: string;
    recentLearnings: Array<{
      trigger: string;
      kind: string;
      confidence: number;
    }>;
  }>(result);
  if (!payload) return new Text(theme.fg("muted", "memory read"), 0, 0);

  const lessonCount = payload.activeLessons.split("\n").filter(Boolean).length;
  const tailCount = payload.memoryTail.split("\n").filter(Boolean).length;
  let text = `${theme.fg("success", "memory read")} `;
  const relevantCount = payload.relevantMemory?.length ?? 0;
  text += theme.fg(
    "muted",
    `${relevantCount} relevant, ${payload.recentLearnings.length} recent, ${lessonCount} active, ${tailCount} tail lines`,
  );
  text += expandHint(expanded);

  if (expanded) {
    text += `\nstore: ${payload.storeRoot}`;
    if (payload.contextQuery) {
      text += `\ncontext: ${clipDisplay(payload.contextQuery, 120)}`;
    }
    for (const item of payload.relevantMemory?.slice(0, 5) ?? []) {
      text += `\n- relevant ${item.kind} ${item.score.toFixed(2)}: ${clipDisplay(item.snippet, 100)}`;
    }
    for (const record of payload.recentLearnings.slice(0, 5)) {
      text += `\n- ${record.kind} ${record.confidence.toFixed(2)}: ${clipDisplay(record.trigger, 100)}`;
    }
  }

  return new Text(text, 0, 0);
}

function renderKhalaMemorySearchResult(
  result: KhalaToolRenderResult,
  expanded: boolean,
  theme: KhalaToolTheme,
): Text {
  const payload = parseToolJsonDetails<{
    query: string;
    results: KhalaMemorySearchResult[];
  }>(result);
  if (!payload) return new Text(theme.fg("muted", "memory search"), 0, 0);

  let text = `${theme.fg("success", "memory search")} `;
  text += theme.fg(
    "muted",
    `${payload.results.length} result${payload.results.length === 1 ? "" : "s"} for ${clipDisplay(payload.query, 70)}`,
  );
  text += expandHint(expanded);

  if (expanded) {
    for (const item of payload.results.slice(0, 5)) {
      text += `\n- ${item.score.toFixed(2)} ${item.kind} ${item.path}: ${clipDisplay(item.snippet, 120)}`;
    }
  }

  return new Text(text, 0, 0);
}

function renderKhalaLearnResult(
  result: KhalaToolRenderResult,
  expanded: boolean,
  theme: KhalaToolTheme,
): Text {
  const record = parseToolJsonDetails<KhalaLearningRecord>(result);
  if (!record)
    return new Text(theme.fg("success", "stored khala learning"), 0, 0);

  let text = `${theme.fg("success", "stored")} ${record.kind}/${record.scope} `;
  text += theme.fg(
    "muted",
    `score=${record.score.toFixed(2)} conf=${record.confidence.toFixed(2)}`,
  );
  text += ` — ${clipDisplay(record.trigger, 90)}${expandHint(expanded)}`;

  if (expanded) {
    text += `\nlesson: ${clipDisplay(record.lesson, 220)}`;
    text += `\nevidence: ${clipDisplay(record.evidenceSnippet, 220)}`;
  }

  return new Text(text, 0, 0);
}

export default function khalaExtension(pi: ExtensionAPI): void {
  ensureBundledExtensions(pi);

  // ── Khala workflow model profile flags ────────────────────────
  pi.registerFlag("khala-workflow-profile", {
    description:
      "Default Khala workflow profile for spawned workflow sessions (e.g., development, planning).",
    type: "string",
    default: "",
  });
  pi.registerFlag("khala-workflow-task", {
    description:
      "Resolve a Khala workflow route (e.g., workon -> development, plan -> planning).",
    type: "string",
    default: "",
  });

  const loosePi = pi as unknown as LooseExtensionAPI;

  loosePi.registerTool({
    name: "khala_assess_learning",
    label: "Khala Assess Learning",
    description:
      "Assess whether a task produced a reusable, non-sensitive lesson worth storing for khala.",
    parameters: KhalaAssessLearningParams,
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("khala_assess_learning"))} ${theme.fg("muted", clipDisplay(args.taskSummary, 90))}`,
        0,
        0,
      ),
    renderResult: (result, { expanded }, theme) =>
      renderKhalaAssessResult(result as KhalaToolRenderResult, expanded, theme),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
      const repoKey = resolveRepoMemoryKey(ctx.cwd);
      const recents = await readRecentKhalaLearningRecords(paths, 20, { repoKey });
      const assessment = assessLearning(params, recents);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(assessment, null, 2),
          },
        ],
        details: assessment,
      };
    },
  });

  loosePi.registerTool({
    name: "khala_read_memory",
    label: "Khala Read Memory",
    description:
      "Read current khala memory context, filtered by current task/edit context when available (active lessons, active runtime rules, relevant memory, and contextual recent learnings).",
    parameters: Type.Object({
      tailLines: Type.Optional(
        Type.Number({
          description:
            "Number of tail lines to include from memory/lessons (default 8, max 50)",
        }),
      ),
      recentLimit: Type.Optional(
        Type.Number({
          description:
            "Number of recent khala learned records to include (default 8, max 50)",
        }),
      ),
      contextQuery: Type.Optional(
        Type.String({
          description:
            "Optional current task/edit context used to filter recent memory and retrieve relevant memory snippets.",
        }),
      ),
    }),
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("khala_read_memory"))} ${theme.fg(
          "muted",
          `tail=${args.tailLines ?? 8} recent=${args.recentLimit ?? 8}`,
        )}`,
        0,
        0,
      ),
    renderResult: (result, { expanded }, theme) =>
      renderKhalaMemoryResult(result as KhalaToolRenderResult, expanded, theme),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const tailLines = clampPositiveInt(params.tailLines, 8, 50);
      const recentLimit = clampPositiveInt(params.recentLimit, 8, 50);
      const contextQuery =
        typeof params.contextQuery === "string" && params.contextQuery.trim()
          ? params.contextQuery.trim()
          : latestMemoryRefreshQuery || latestTaskInput || latestUserInput;
      const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
      const repoKey = resolveRepoMemoryKey(ctx.cwd);
      const [
        memoryTail,
        activeLessons,
        recentRecords,
        activeRules,
        relevantLearningRaw,
        relevantMemoryRaw,
      ] = await Promise.all([
        getLearningMemoryTail(ctx.cwd, learningPathCache, tailLines),
        getActiveLearningLessonsTail(ctx.cwd, learningPathCache, tailLines),
        readRecentKhalaLearningRecords(paths, Math.max(recentLimit, 20), {
          repoKey,
        }),
        readEffectiveRuntimeRules(paths),
        contextQuery
          ? searchKhalaLearningRecords({
              paths,
              query: contextQuery,
              limit: recentLimit,
              repoKey,
            })
          : Promise.resolve([]),
        contextQuery
          ? searchKhalaMemory({
              paths,
              query: contextQuery,
              limit: recentLimit,
              snippetLength: 240,
              includeKinds: ["lesson", "rule", "skill", "workflow", "prompt"],
            })
          : Promise.resolve([]),
      ]);

      const relevantLearningMemory = relevantLearningRaw.map(
        learningHitToMemoryResult,
      );
      const relevantMemory = contextQuery
        ? [
            ...relevantLearningMemory,
            ...relevantMemoryRaw.filter((item) => item.score >= 6),
          ]
            .sort(
              (a, b) => b.score - a.score || a.path.localeCompare(b.path),
            )
            .slice(0, recentLimit)
        : [];

      const contextualRecentRecords = contextQuery
        ? recentRecords
            .filter((record) =>
              learningRecordMatchesContext(record, contextQuery),
            )
            .slice(0, recentLimit)
        : recentRecords.slice(0, recentLimit);

      markMemoryRead();

      const payload = {
        storeRoot: paths.root,
        repoKey,
        contextQuery,
        relevantMemory,
        memoryTail: contextQuery && relevantMemory.length > 0 ? "" : memoryTail,
        activeLessons:
          contextQuery && relevantMemory.length > 0 ? "" : activeLessons,
        activeRules: activeRules.slice(0, tailLines).map((rule) => ({
          id: rule.id,
          scope: rule.scope,
          lifetime: rule.lifetime,
          severity: rule.severity,
          trigger: rule.trigger,
          instruction: rule.instruction,
        })),
        recentLearnings: contextualRecentRecords.map((record) => ({
          timestamp: record.timestamp,
          trigger: record.trigger,
          lesson: record.lesson,
          score: record.score,
          confidence: record.confidence,
          kind: record.kind,
          workflowType: record.workflowType ?? null,
        })),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
        details: payload,
      };
    },
  });

  loosePi.registerTool({
    name: "khala_search_memory",
    label: "Khala Search Memory",
    description:
      "Search khala memory, learned skills, and reviewed workflow artifacts with results sorted by relevance. Use a focused task-specific query to retrieve older relevant memory beyond the recent tail.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Focused task-specific search query including concrete workflow, technology, file, symbol, error, correction, or user intent signals.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum relevant results to return (default 8, max 25)",
        }),
      ),
      snippetLength: Type.Optional(
        Type.Number({
          description:
            "Maximum snippet characters per result (default 220, max 500)",
        }),
      ),
    }),
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("khala_search_memory"))} ${theme.fg(
          "muted",
          clipDisplay(args.query, 90),
        )}`,
        0,
        0,
      ),
    renderResult: (result, { expanded }, theme) =>
      renderKhalaMemorySearchResult(
        result as KhalaToolRenderResult,
        expanded,
        theme,
      ),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new Error("khala_search_memory requires a non-empty query.");
      }
      const queryQuality = memorySearchQueryQuality(query);
      if (!queryQuality.focused) {
        throw new Error(
          `khala_search_memory requires a focused task-specific query: ${queryQuality.reason}`,
        );
      }
      const limit = clampPositiveInt(params.limit, 8, 25);
      const snippetLength = clampPositiveInt(params.snippetLength, 220, 500);
      const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
      const repoKey = resolveRepoMemoryKey(ctx.cwd);
      const learningHits = await searchKhalaLearningRecords({
        paths,
        query,
        limit,
        repoKey,
      });
      const corpusResults = await searchKhalaMemory({
        paths,
        query,
        limit,
        snippetLength,
        includeKinds: ["lesson", "rule", "skill", "workflow", "prompt"],
      });
      const results = [
        ...learningHits.map(learningHitToMemoryResult),
        ...corpusResults,
      ]
        .sort((a, b) =>
          b.score - a.score || a.path.localeCompare(b.path),
        )
        .slice(0, limit);
      const payload = {
        storeRoot: paths.root,
        repoKey,
        query,
        resultCount: results.length,
        results,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
        details: payload,
      };
    },
  });

  loosePi.registerTool({
    name: "khala_learn",
    label: "Khala Learn",
    description:
      "Persist a structured khala learning record when an assessment says it is worth storing.",
    parameters: KhalaLearnParams,
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("khala_learn"))} ${theme.fg(
          "muted",
          `${args.kind ?? "record"}/${args.scope ?? "repo"} — ${clipDisplay(args.trigger, 80)}`,
        )}`,
        0,
        0,
      ),
    renderResult: (result, { expanded }, theme) =>
      renderKhalaLearnResult(result as KhalaToolRenderResult, expanded, theme),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const kind =
        params.kind === "workflow_correction" ||
        params.kind === "preference" ||
        params.kind === "tool_rule" ||
        params.kind === "project_fact"
          ? (params.kind as LearningLesson["type"])
          : "workflow_correction";
      const scope =
        params.scope === "global" || params.scope === "repo"
          ? (params.scope as LearningLesson["scope"])
          : "repo";
      const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
      const repoKey = resolveRepoMemoryKey(ctx.cwd);
      const quality = validateLearningCandidateQuality({
        trigger: params.trigger,
        lesson: params.lesson,
        evidence: [
          params.evidenceSnippet,
          ...(params.actionTaken ?? []),
        ].filter(Boolean),
        hasConcreteEvidence:
          Boolean(params.evidenceSnippet.trim()) ||
          (params.actionTaken?.length ?? 0) > 0,
        evidenceSnippet: params.evidenceSnippet,
      });
      if (!quality.ok) {
        throw new Error(
          `khala_learn rejected low-quality learning candidate: ${quality.issues.join("; ")}`,
        );
      }
      const score = clampUnit(params.score);
      const confidence = clampUnit(params.confidence);
      if (score < 0.75 || confidence < 0.75) {
        throw new Error(
          `khala_learn rejected candidate below storage threshold (score=${score.toFixed(2)}, confidence=${confidence.toFixed(2)}).`,
        );
      }
      const record: KhalaLearningRecord = {
        version: LEARNING_VERSION,
        id: makeId("khala-learn"),
        timestamp: nowIso(),
        source: params.source === "manual" ? "manual" : "auto",
        workflowType: params.workflowType,
        workflowId: params.workflowId,
        actionTaken: params.actionTaken,
        ...(scope === "repo" ? { repoKey } : {}),
        status: "active",
        shouldLearn: true,
        score,
        confidence,
        kind,
        scope,
        trigger: params.trigger,
        lesson: params.lesson,
        reason: "Stored by khala_learn tool.",
        evidence: [],
        evidenceSnippet: params.evidenceSnippet,
        promotable: Boolean(
          params.promotable && score >= 0.9 && confidence >= 0.9,
        ),
        sensitive: false,
        components: {
          reusability: 1,
          evidenceStrength: 1,
          impact: 1,
          novelty: 1,
          clarity: 1,
        },
      };
      await persistKhalaLearningRecord(paths, record);
      return {
        content: [
          {
            type: "text",
            text: `Stored khala learning: ${record.trigger} (score=${record.score.toFixed(2)}, confidence=${record.confidence.toFixed(2)})`,
          },
        ],
        details: record,
      };
    },
  });

  const bashTool = shouldUsePowerShellBashOverride()
    ? createPowerShellBashTool()
    : (createBashTool(process.cwd(), {
        spawnHook: (spawnContext) => {
          if (!runtimeState.agentEnabled) return spawnContext;

          const policy = evaluateSpawnPolicy(spawnContext.command, {
            hookConfig: activeHookConfig,
            hasValidRiskApproval: hasValidRiskApproval(runtimeState),
            nowIso,
          });

          if (policy.riskEvent) {
            runtimeState.riskEvents.push(policy.riskEvent);
          }

          if (policy.consumeRiskApproval) {
            runtimeState.riskApproval = null;
          }

          if (policy.blockedMessage) {
            throw new Error(policy.blockedMessage);
          }

          return {
            ...spawnContext,
            command: prependInterceptedCommandsPath(spawnContext.command),
          };
        },
      }) as unknown as Record<string, unknown>);

  loosePi.registerTool(bashTool);
  loosePi.on("user_bash", () => {
    if (!runtimeState.agentEnabled) return;
    return { operations: createInterceptedUserBashOperations() };
  });

  pi.on("session_start", async (_event, ctx) => {
    setActiveWorkflowRoute({
      profileFlag: (pi.getFlag("khala-workflow-profile") as string) ?? "",
      taskFlag: (pi.getFlag("khala-workflow-task") as string) ?? "",
    });

    // Load workflow model config
    const trustAwareCtx = ctx as typeof ctx & { isProjectTrusted?: () => boolean };
    const workflowModelConfigPath = await resolveWorkflowModelConfigPath(
      ctx.cwd,
      trustAwareCtx.isProjectTrusted?.() ?? false,
    );
    const workflowModelConfig = await loadWorkflowModelConfig(workflowModelConfigPath);
    setWorkflowModelConfig(workflowModelConfig.config, {
      path: workflowModelConfig.path ?? workflowModelConfigPath,
      found: workflowModelConfig.found,
      explicitProfiles: workflowModelConfig.explicitProfiles,
      explicitRoutes: workflowModelConfig.explicitRoutes,
      warnings: workflowModelConfig.warnings,
    });

    const [hookConfig, profileLoad] = await Promise.all([
      loadHooksConfig(RUNTIME_PATHS.hooksConfigPath, DEFAULT_HOOK_CONFIG),
      loadRuntimeProfile(RUNTIME_PATHS.profileConfigPath).catch((error) => ({
        profile: cloneRuntimeProfile(DEFAULT_RUNTIME_PROFILE),
        warnings: [
          `runtime/profile.yaml load error (${error instanceof Error ? error.message : String(error)}); using defaults.`,
        ],
      })),
    ]);

    const profileValidation = await validateRuntimeProfile(
      profileLoad.profile,
      {
        commandsDir: RUNTIME_PATHS.commandsDir,
        skillflowsDir: RUNTIME_PATHS.skillflowsDir,
      },
    );

    const gateConfig = await loadFirstPrinciplesConfig(
      RUNTIME_PATHS.firstPrinciplesConfigPath,
      profileValidation.profile.firstPrinciplesDefaults,
    );

    activeHookConfig = hookConfig.config;
    activeRuntimeProfile = profileValidation.profile;
    sessionFirstPrinciplesDefaults = { ...gateConfig.config };

    const complianceOverride = getComplianceModeFromSession(ctx);
    runtimeState.firstPrinciplesConfig =
      complianceOverride ?? gateConfig.config;

    for (const warning of profileLoad.warnings) {
      notify(ctx, `Profile warning: ${warning}`, "warning");
    }
    for (const warning of profileValidation.warnings) {
      notify(ctx, `Profile validation warning: ${warning}`, "warning");
    }
    for (const warning of hookConfig.warnings) {
      notify(ctx, `Hook config warning: ${warning}`, "warning");
    }
    for (const warning of gateConfig.warnings) {
      notify(ctx, `Gate config warning: ${warning}`, "warning");
    }

    runtimeState.riskApproval = getRiskApprovalFromSession(ctx);
    runtimeState.activePreflight = getPreflightFromSession(ctx, {
      isPreflightClarify,
      isPreflightSource,
    });
    setAgentEnabledState(ctx, getAgentEnabledFromSession(ctx));
    await refreshLearnedResourceCompletions(ctx.cwd).catch((error) => {
      notify(
        ctx,
        `Failed to refresh khala learned resource completions: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    });

    if (runtimeState.agentEnabled) {
      notify(
        ctx,
        `khala resumed (workflows=${profileValidation.enabledWorkflowCount}/${Object.keys(activeRuntimeProfile.workflows).length}, low-confidence=${activeRuntimeProfile.lowConfidenceThreshold.toFixed(2)}, preflight=${runtimeState.firstPrinciplesConfig.preflightMode}, postflight=${runtimeState.firstPrinciplesConfig.postflightMode}, response=${runtimeState.firstPrinciplesConfig.responseComplianceMode})`,
        "info",
      );
    }
  });

  pi.on("resources_discover", async (event, ctx) => {
    const cwd = typeof event.cwd === "string" ? event.cwd : ctx.cwd;
    const paths = await ensureLearningStore(cwd, learningPathCache);
    await refreshLearnedResourceCompletions(cwd);
    return {
      skillPaths: [paths.skillsDir],
      promptPaths: [paths.promptsDir],
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!runtimeState.agentEnabled) return;
    await interruptPendingWorkflow({
      reason: "Khala session shut down before workflow completion.",
      notifyContext: ctx,
    });
    pendingWorkflow = null;
    const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
    await clearSessionRules(paths);
    await runSessionEndHooks({
      pi,
      ctx,
      activeHookConfig,
      hooksDir: RUNTIME_PATHS.hooksDir,
      runtimeDailyLogPath: RUNTIME_PATHS.runtimeDailyLogPath,
      runtimeState,
      lowConfidenceEvents,
      notify,
      nowIso,
    });
    lowConfidenceEvents = [];
    setAgentEnabledState(ctx, false);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!runtimeState.agentEnabled) return;
    const bootstrap = await getBootstrapPayload({
      cwd: ctx.cwd,
      runtimeDir: RUNTIME_PATHS.runtimeDir,
      hooksDir: RUNTIME_PATHS.hooksDir,
      activeHookConfig,
      learningPathCache,
      memoryTailLines: MEMORY_TAIL_LINES,
      memoryToolCallLimit: runtimeState.memoryToolCallLimit,
      lowConfidenceThreshold: activeRuntimeProfile.lowConfidenceThreshold,
      harnessLimits: activeRuntimeProfile.harnessLimits,
      ruleQuery: latestUserInput,
      workflowType: pendingWorkflow?.type,
      workflowId: pendingWorkflow?.id,
      loadedSkills: pendingWorkflow?.loadedSkills,
      policyWarnings: pendingWorkflow?.policyWarnings,
    });
    if (!bootstrap.trim()) return;
    return {
      systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${bootstrap}`,
    };
  });

  pi.on("input", async (event, _ctx) => {
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (!text) return;
    latestUserInput = text;
    if (!isContinuationInput(text)) {
      latestTaskInput = text;
      taskToolCallCount = 0;
      resetMemoryGate("new task or scope change");
    }

    const preflight = parsePreflightLine(text, nowIso);
    if (preflight) {
      const scopedPreflight = pendingWorkflow
        ? { ...preflight, workflowId: pendingWorkflow.id }
        : preflight;
      runtimeState.activePreflight = scopedPreflight;
      appendPreflightEntry(pi, scopedPreflight);
      return;
    }

    const postflight = parsePostflightLine(text, nowIso);
    if (postflight) {
      runtimeState.latestPostflight = postflight;
      appendPostflightEntry(pi, postflight);
      return;
    }

    if (!runtimeState.agentEnabled) return;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!runtimeState.agentEnabled) return;

    const counters = getToolInterceptionCounters(event);
    if (counters.incrementTaskToolCall) {
      taskToolCallCount += 1;
    }
    if (counters.incrementMemoryToolCallsSinceRead) {
      memoryGate.toolCallsSinceRead += 1;
    }
    if (counters.isMemoryRead) {
      markMemoryRead();
      await recordPendingWorkflowToolCall({
        workflow: pendingWorkflow,
        toolName: event.toolName,
        input: event.input,
        at: nowIso(),
      });
      return;
    }

    const needsFreshMemory = requiresFreshMemoryToolCall(event);
    if (needsFreshMemory && !isMemoryFresh()) {
      latestMemoryRefreshQuery = buildMemoryRefreshQuery(event);
      return {
        block: true,
        reason: `MEMORY READ REQUIRED\n\nMemory context is stale for this task (${staleMemoryReason()}). Call khala_read_memory, then immediately retry the non-memory mutation. Khala memory tools are allowed without memory refresh. Read-only inspection is allowed without memory refresh.`,
      };
    }

    if (!isMutationToolCall(event)) {
      await recordPendingWorkflowToolCall({
        workflow: pendingWorkflow,
        toolName: event.toolName,
        input: event.input,
        at: nowIso(),
      });
      if (counters.persistsMemory) {
        resetMemoryGate("memory was updated");
      }
      return;
    }

    const decision = evaluateMutationPreflightPolicy({
      preflightMode: runtimeState.firstPrinciplesConfig.preflightMode,
      preflight: runtimeState.activePreflight,
      toolName: event.toolName,
      activeWorkflowId: pendingWorkflow?.id ?? null,
    });

    addPolicyEvent(pi, {
      at: nowIso(),
      phase: "preflight",
      mode: runtimeState.firstPrinciplesConfig.preflightMode,
      outcome: decision.outcome,
      detail: decision.detail,
      toolName: event.toolName,
    });

    if (decision.warningMessage) {
      pendingWorkflow?.policyWarnings.push(decision.warningMessage);
      notify(ctx, decision.warningMessage, "warning");
    }

    if (decision.blockReason) {
      return {
        block: true,
        reason: decision.blockReason,
      };
    }

    await recordPendingWorkflowToolCall({
      workflow: pendingWorkflow,
      toolName: event.toolName,
      input: event.input,
      at: nowIso(),
    });
  });

  loosePi.on("agent_end", async (event, ctx) => {
    const workflow = pendingWorkflow;
    const messages = (
      event as { messages: Parameters<typeof extractLastAssistantText>[0] }
    ).messages;
    const lastAssistantMessage = getLastAssistantMessage(messages);
    const assistantText = extractLastAssistantText(messages);
    const text = assistantText || "No assistant output captured.";
    const userText = extractLastUserText(messages);
    const hasWorkflowFooter = hasRequiredWorkflowFooter(assistantText);
    const pendingMemoryGateRecovery = findPendingMemoryGateRecovery(messages);
    let harnessIssues: HarnessTurnIssue[] = [];

    if (isEmptyTerminalAssistantResponse(messages)) {
      const emptyResponseKey = `empty:${normalizeLoopGuardText(userText)}`;
      const loopGuard = evaluateObligationLoopGuard({
        current: {
          key: runtimeState.lastEmptyResponseBlockKey,
          count: runtimeState.lastEmptyResponseBlockCount,
        },
        key: emptyResponseKey,
        blockThreshold: REPEATED_BLOCK_GUARD_THRESHOLD,
      });
      runtimeState.lastEmptyResponseBlockKey = loopGuard.next.key;
      runtimeState.lastEmptyResponseBlockCount = loopGuard.next.count;
      const emptyReason = [
        "EMPTY ASSISTANT RESPONSE",
        "",
        "The assistant stopped without visible output or a tool call.",
        "Continue with the next tool call or send a final user-visible response.",
        workflow
          ? "If this is the workflow conclusion, include the required `Bias Check (Tier 1)`, `Result:`, and `Confidence:` footer."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!loopGuard.block) {
        notify(
          ctx,
          [
            emptyReason,
            "",
            "Loop guard: repeated identical empty-response block detected; downgraded to warning for this turn.",
          ].join("\n"),
          "warning",
        );
        return;
      }
      return {
        block: true,
        reason: emptyReason,
      };
    }

    runtimeState.lastEmptyResponseBlockKey = null;
    runtimeState.lastEmptyResponseBlockCount = 0;

    if (
      pendingMemoryGateRecovery &&
      lastAssistantMessage?.stopReason === "stop"
    ) {
      runtimeState.lastObligationBlockKey = null;
      runtimeState.lastObligationBlockCount = 0;
      const memoryGateReason = [
        "MEMORY GATE RECOVERY INCOMPLETE",
        "",
        `A previous ${pendingMemoryGateRecovery.blockedToolName} was blocked by MEMORY READ REQUIRED.`,
        "You already called khala_read_memory.",
        `Immediately retry the blocked ${pendingMemoryGateRecovery.blockedToolName} in the same assistant turn.`,
        "Do not switch to explanation, next-turn promises, or ask the user to continue.",
      ].join("\n");
      const memoryGateBlockKey = `${pendingMemoryGateRecovery.blockedToolName}:${normalizeLoopGuardText(userText)}`;
      const loopGuard = evaluateObligationLoopGuard({
        current: {
          key: runtimeState.lastMemoryGateBlockKey,
          count: runtimeState.lastMemoryGateBlockCount,
        },
        key: memoryGateBlockKey,
        blockThreshold: REPEATED_BLOCK_GUARD_THRESHOLD,
      });
      runtimeState.lastMemoryGateBlockKey = loopGuard.next.key;
      runtimeState.lastMemoryGateBlockCount = loopGuard.next.count;

      if (!loopGuard.block) {
        notify(
          ctx,
          [
            memoryGateReason,
            "",
            "Loop guard: repeated identical memory-gate block detected; downgraded to warning for this turn.",
          ].join("\n"),
          "warning",
        );
        return;
      }

      return {
        block: true,
        reason: memoryGateReason,
      };
    }

    runtimeState.lastMemoryGateBlockKey = null;
    runtimeState.lastMemoryGateBlockCount = 0;

    const obligation = inferTurnObligation(userText);
    if (
      runtimeState.agentEnabled &&
      lastAssistantMessage?.stopReason === "stop" &&
      isActionOrApprovalObligation(obligation.obligation) &&
      !assistantMessageHasToolCall(lastAssistantMessage) &&
      !assistantTurnHasToolCallSinceLatestUser(messages) &&
      !isAssistantClarificationAllowedForObligation(
        lastAssistantMessage,
        obligation.obligation,
      )
    ) {
      const reason = [
        "TURN OBLIGATION NOT SATISFIED",
        "",
        `The latest user request requires action before a final response (${obligation.reason}).`,
        "Retry this turn with at least one relevant tool call, or ask one blocking clarification or approval question if no safe tool action exists.",
        "Do not acknowledge or promise future work without a tool call.",
      ].join("\n");

      if (
        shouldBlockUnsatisfiedTurnObligation({
          mode: runtimeState.firstPrinciplesConfig.responseComplianceMode,
          obligation: obligation.obligation,
        })
      ) {
        const obligationBlockKey = `${obligation.obligation}:${normalizeLoopGuardText(userText)}`;
        const loopGuard = evaluateObligationLoopGuard({
          current: {
            key: runtimeState.lastObligationBlockKey,
            count: runtimeState.lastObligationBlockCount,
          },
          key: obligationBlockKey,
          blockThreshold: REPEATED_BLOCK_GUARD_THRESHOLD,
        });
        runtimeState.lastObligationBlockKey = loopGuard.next.key;
        runtimeState.lastObligationBlockCount = loopGuard.next.count;

        if (!loopGuard.block) {
          notify(
            ctx,
            [
              reason,
              "",
              "Loop guard: repeated identical obligation block detected; downgraded to warning for this turn.",
            ].join("\n"),
            "warning",
          );
          return;
        }
        return { block: true, reason };
      }

      notify(ctx, reason, "warning");
      runtimeState.lastObligationBlockKey = null;
      runtimeState.lastObligationBlockCount = 0;
    } else {
      runtimeState.lastObligationBlockKey = null;
      runtimeState.lastObligationBlockCount = 0;
    }

    if (
      runtimeState.agentEnabled &&
      lastAssistantMessage?.stopReason === "stop"
    ) {
      harnessIssues = evaluateHarnessTurn({
        messages,
        userText,
        assistantText,
        lowConfidenceThreshold: activeRuntimeProfile.lowConfidenceThreshold,
        responseComplianceMode:
          runtimeState.firstPrinciplesConfig.responseComplianceMode,
        harnessLimits: activeRuntimeProfile.harnessLimits,
      });

      for (const issue of harnessIssues) {
        if (issue.code !== "skill_routing") continue;
        await recordSkillUsedWithoutLoadEvents({
          workflow,
          assistantText,
          reason: issue.message,
          at: nowIso(),
        });
      }

      for (const issue of harnessIssues) {
        appendHarnessIssueEntry(pi, issue, { workflow, userText });
        if (issue.block) return { block: true, reason: issue.message };
        notify(ctx, issue.message, "warning");
      }
    }

    if (workflow && !hasWorkflowFooter) {
      if (
        runtimeState.firstPrinciplesConfig.responseComplianceMode ===
          "enforce" &&
        lastAssistantMessage?.stopReason === "stop"
      ) {
        return {
          block: true,
          reason: [
            "HARNESS COMPLIANCE FAILED",
            "",
            "Workflow response is missing the required final Bias Check or footer lines.",
            "Add all required final fields and retry:",
            "- Bias Check (Tier 1)",
            "- Result: success|partial|failed",
            "- Confidence: 0..1",
          ].join("\n"),
        };
      }

      if (lastAssistantMessage?.stopReason === "stop") {
        const awaitingUserAction = isAssistantClarification(lastAssistantMessage);
        await advanceTrackedWorkflowForTurnBoundary({
          workflow,
          at: nowIso(),
          assistantText,
          awaitingUserAction,
        });
        markWorkflowWaitingForFooter(
          workflow,
          awaitingUserAction,
        );
        notify(
          ctx,
          `Workflow ${workflow.type} still active; waiting for final Bias Check plus Result/Confidence footer. Reply in this workflow to continue, or include the footer to complete it before starting another workflow.`,
          "info",
        );
      }
      return;
    }

    if (
      workflow &&
      workflow.type === "learn-skill" &&
      workflow.flags.dryRun !== true
    ) {
      const targetSkill =
        typeof workflow.flags.targetSkill === "string"
          ? workflow.flags.targetSkill
          : null;
      if (targetSkill) {
        const paths = await ensureLearningStore(ctx.cwd, learningPathCache);
        const record = await readLearnedSkillMetadata(paths, targetSkill);
        if (record) {
          const guard = await validateGeneratedSkillDir(record.dir);
          if (!guard.ok) {
            return {
              block: true,
              reason: [
                "LEARNED SKILL SAFETY CHECK FAILED",
                "",
                ...guard.issues.map(
                  (issue) => `- ${issue.file}: ${issue.reason}`,
                ),
                "",
                "Remove the unsafe content and retry.",
              ].join("\n"),
            };
          }
        }
      }
    }

    try {
      if (workflow) {
        await completeWorkflowTracking(pi, ctx, workflow, text);
      }
      const assessment = await maybeAssessAndLearn({
        pi,
        ctx,
        workflow,
        userText,
        assistantText: text,
        harnessIssueSummaries: harnessIssues.map(
          (issue) => `harness issue: ${issue.code} - ${issue.title}`,
        ),
      });
      await runSelfImprovementReview({
        pi,
        ctx,
        workflow,
        userText,
        assistantText: text,
        assessment,
      });
    } finally {
      pendingWorkflow = null;
    }
  });

  const complianceHandlers = createComplianceCommandHandlers({
    runtimeState,
    notify,
    parseComplianceArgs,
    parseApproveRiskArgs,
    parsePreflightArgs: (args) =>
      parsePreflightArgs(args, (line) => parsePreflightLine(line, nowIso)),
    parsePostflightArgs: (args) =>
      parsePostflightArgs(args, (line) => parsePostflightLine(line, nowIso)),
    nowIso,
    getDefaultFirstPrinciplesConfig: () => sessionFirstPrinciplesDefaults,
    appendComplianceModeEntry: (record) =>
      appendComplianceModeEntry(pi, record),
    onComplianceModeChanged: refreshKhalaModeStatus,
    appendRiskApprovalEntry: (approval) =>
      appendRiskApprovalEntry(pi, approval),
    appendPreflightEntry: (record) => appendPreflightEntry(pi, record),
    appendPostflightEntry: (record) => appendPostflightEntry(pi, record),
    getActiveWorkflowId: () => pendingWorkflow?.id ?? null,
  });

  const workflowHandlers = createWorkflowCommandHandlers({
    pi,
    notify,
    nowIso,
    slugify,
    normalizeWhitespace,
    ensureWorkflowSlotAvailable,
    ensureAgentEnabledForCommand,
    resolveWorkflowConfig: (type) =>
      getWorkflowConfig(activeRuntimeProfile, type),
    beginWorkflowTracking: (pi, ctx, type, input, flags) =>
      beginWorkflowTracking(pi, ctx, type, input, flags) as Promise<
        import("./workflows/engine").PendingWorkflow<WorkflowType, WorkflowFlags>
      >,
    enqueueWorkflow,
    notifyWorkflowStarted,
    clearPendingWorkflow: async () => {
      await interruptPendingWorkflow({
        reason: "Workflow command failed before completion.",
      });
      pendingWorkflow = null;
    },
    parseDebugArgs,
    parseReviewArgs,
    buildReviewTarget,
    loadProjectReviewGuidelines,
    parsePlanArgs,
    parseAuditArgs,
    parseTriageArgs,
    parseAddressOpenIssuesArgs,
    parseInboxArgs,
    parseWorkonArgs: parseWorkonArgs as never,
    parseLearnSkillArgs,
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    ensureLearnedSkillLayout: async (cwd, skillName, sourceRunId) => {
      const paths = await ensureLearningStore(cwd, learningPathCache);
      return ensureLearnedSkillLayout({
        paths,
        skillName,
        nowIso: nowIso(),
        provenance: "agent-authored",
        sourceRunId,
      });
    },
    exists,
    readText,
    buildSkillTemplate,
    chooseAvailableSkillName,
    packageSkillsPath: RUNTIME_PATHS.packageSkillsPath,
    buildSimplifyTarget,
    constants: {
      POSTFLIGHT_INSTRUCTION,
      REQUIRED_WORKFLOW_FOOTER_INSTRUCTION,
      REVIEW_COMMAND_SOURCE,
      GIT_REVIEW_COMMAND_SOURCE,
      SIMPLIFY_COMMAND_SOURCE,
      PLAN_COMMAND_SOURCE,
      AUDIT_COMMAND_SOURCE,
      SHIP_COMMAND_SOURCE,
      INBOX_COMMAND_SOURCE,
      WORKON_COMMAND_SOURCE,
      TRIAGE_COMMAND_SOURCE,
      ADDRESS_OPEN_ISSUES_COMMAND_SOURCE,
    },
  });

  const curatorHandlers = createCuratorCommandHandlers({
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    nowIso,
    notify,
  });

  const learnedWorkflowHandlers = createLearnedWorkflowCommandHandlers({
    pi,
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    notify,
    beginWorkflowTracking: (ctx, workflowName, input, flags, workflowSpec) =>
      beginWorkflowTracking(pi, ctx, workflowName, input, flags, workflowSpec),
  });

  const runLedgerHandlers = createRunLedgerCommandHandlers({
    pi,
    nowIso,
    notify,
  });

  const ruleHandlers = createRuleCommandHandlers({
    ensureLearningStore: (cwd) => ensureLearningStore(cwd, learningPathCache),
    nowIso,
    notify,
  });

  const khalaHandlers = createKhalaCommandHandlers({
    runtimeState,
    notify,
    runCompliancePreset: (preset, ctx) => complianceHandlers.compliance(preset, ctx),
  });
  const khalaHubHandlers = createKhalaHubCommandHandlers({
    pi,
    homeDir: homedir(),
    packageSkillsPath: RUNTIME_PATHS.packageSkillsPath,
    notify,
  });

  const { compliance: _unusedComplianceHandler, ...complianceGateHandlers } =
    complianceHandlers;

  registerCommands({
    pi,
    handlers: {
      ...complianceGateHandlers,
      ...workflowHandlers,
      ...curatorHandlers,
      ...learnedWorkflowHandlers,
      ...runLedgerHandlers,
      ...ruleHandlers,
      ...khalaHandlers,
      ...khalaHubHandlers,
    },
    completions: {
      learnedSkills: (prefix) =>
        completeFromCache(learnedSkillCompletionCache, prefix),
      learnedWorkflows: (prefix) =>
        completeFromCache(learnedWorkflowCompletionCache, prefix),
    },
  });
}
