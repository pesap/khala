import {
  evaluateHarnessTurn,
  evaluateHarnessTurnMetrics,
  type HarnessTurnIssue,
  type HarnessTurnMetrics,
} from "../extensions/runtime/escalation.ts";
import {
  benchmarkMessagesToKhalaTranscript,
  khalaTranscriptSearchText,
  khalaTranscriptToBenchmarkMessages,
  khalaTranscriptToHarnessMessages,
  khalaTranscriptToolCalls,
  latestKhalaAssistantText,
  normalizeKhalaTranscript,
  stableKhalaJsonStringify,
  type KhalaToolCallRequestedEvent,
  type KhalaTranscript,
} from "./harness-events.ts";
import {
  estimateKhalaBudget,
  type KhalaBudgetReport,
} from "./harness-budget.ts";

type HarnessEvaluationParams = Parameters<typeof evaluateHarnessTurn>[0];
type HarnessBenchmarkLimits = Partial<
  NonNullable<HarnessEvaluationParams["harnessLimits"]>
>;

export type HarnessBenchmarkIssueCode = HarnessTurnIssue["code"];

export interface HarnessBenchmarkToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface HarnessBenchmarkMessage {
  role: "assistant" | "user" | "toolResult" | "system" | string;
  text?: string;
  toolCall?: HarnessBenchmarkToolCall;
  content?: unknown;
}

export interface HarnessBenchmarkRun {
  id?: string;
  model?: string;
  assistantText?: string;
  messages?: HarnessBenchmarkMessage[];
  transcript?: KhalaTranscript;
  expectedIssueCodes?: HarnessBenchmarkIssueCode[];
  expectedPackageIssueCodes?: HarnessBenchmarkPackageIssueCode[];
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  harnessLimits?: HarnessBenchmarkLimits;
  budgetWarningThreshold?: number;
}

export type HarnessBenchmarkPackageArtifactKind =
  | "capsule"
  | "handoff_prompt"
  | "ready_packet"
  | "handoff_ledger"
  | "other";

export interface HarnessBenchmarkPackageArtifact {
  id?: string;
  kind?: HarnessBenchmarkPackageArtifactKind;
  text: string;
  requiredIncludes?: string[];
  forbiddenIncludes?: string[];
}

export interface HarnessBenchmarkToolCallCheck {
  name: string;
  argumentIncludes?: string[];
}

export interface HarnessBenchmarkForbiddenToolCallCheck {
  name?: string;
  argumentIncludes?: string[];
}

export interface HarnessBenchmarkForbiddenBeforeCheck {
  forbidden: HarnessBenchmarkForbiddenToolCallCheck;
  before: HarnessBenchmarkToolCallCheck;
}

export interface HarnessBenchmarkRequiredBeforeCheck {
  required: HarnessBenchmarkToolCallCheck;
  before: HarnessBenchmarkToolCallCheck;
}

export interface HarnessBenchmarkNextToolCheck {
  after: HarnessBenchmarkToolCallCheck;
  next: HarnessBenchmarkToolCallCheck;
}

export interface HarnessBenchmarkPackageContract {
  name?: string;
  sourcePath?: string;
  sourceHash?: string;
  artifacts?: HarnessBenchmarkPackageArtifact[];
  requiredTranscriptIncludes?: string[];
  forbiddenTranscriptIncludes?: string[];
  requiredToolCalls?: HarnessBenchmarkToolCallCheck[];
  forbiddenToolCalls?: HarnessBenchmarkForbiddenToolCallCheck[];
  orderedToolCalls?: HarnessBenchmarkToolCallCheck[];
  forbiddenBefore?: HarnessBenchmarkForbiddenBeforeCheck[];
  requiredBefore?: HarnessBenchmarkRequiredBeforeCheck[];
  nextToolMustBe?: HarnessBenchmarkNextToolCheck[];
}

export type HarnessBenchmarkPackageIssueCode =
  | "package_artifact_missing_required_text"
  | "package_artifact_contains_forbidden_text"
  | "package_run_missing_required_text"
  | "package_run_contains_forbidden_text"
  | "package_run_missing_required_tool_call"
  | "package_run_used_forbidden_tool_call"
  | "package_run_tool_order_violation"
  | "package_run_forbidden_tool_before_anchor"
  | "package_run_required_tool_missing_before_anchor"
  | "package_run_next_tool_mismatch";

export interface HarnessBenchmarkPackageIssue {
  code: HarnessBenchmarkPackageIssueCode;
  message: string;
  artifactId?: string;
  text?: string;
  toolName?: string;
  anchorToolName?: string;
}

export interface HarnessBenchmarkCase {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  userText: string;
  assistantText?: string;
  expectedIssueCodes?: HarnessBenchmarkIssueCode[];
  expectedPackageIssueCodes?: HarnessBenchmarkPackageIssueCode[];
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  harnessLimits?: HarnessBenchmarkLimits;
  budgetWarningThreshold?: number;
  packageContract?: HarnessBenchmarkPackageContract;
  runs: HarnessBenchmarkRun[];
}

export interface HarnessBenchmarkSuite {
  version?: 1;
  name?: string;
  description?: string;
  cases: HarnessBenchmarkCase[];
}

export interface HarnessBenchmarkOptions {
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  budgetWarningThreshold?: number;
}

export interface HarnessBenchmarkRunResult {
  caseId?: string;
  caseName: string;
  runId: string;
  model: string;
  issueCodes: HarnessBenchmarkIssueCode[];
  issues: HarnessTurnIssue[];
  metrics: HarnessTurnMetrics;
  expectedIssueCodes: HarnessBenchmarkIssueCode[];
  missingExpectedIssueCodes: HarnessBenchmarkIssueCode[];
  unexpectedIssueCodes: HarnessBenchmarkIssueCode[];
  expectedIssueDistance: number;
  expectedPackageIssueCodes: HarnessBenchmarkPackageIssueCode[];
  missingExpectedPackageIssueCodes: HarnessBenchmarkPackageIssueCode[];
  unexpectedPackageIssueCodes: HarnessBenchmarkPackageIssueCode[];
  expectedPackageIssueDistance: number;
  packageIssues: HarnessBenchmarkPackageIssue[];
  packageDivergenceScore: number;
  transcriptEventCount: number;
  budget: KhalaBudgetReport;
  tags: string[];
  blockingIssueCount: number;
  divergenceScore: number;
  complianceScore: number;
}

export interface HarnessBenchmarkModelSummary {
  model: string;
  runCount: number;
  averageComplianceScore: number;
  totalDivergenceScore: number;
  issueCounts: Partial<Record<HarnessBenchmarkIssueCode, number>>;
  packageIssueCount: number;
}

export interface HarnessBenchmarkCaseSummary {
  caseId?: string;
  caseName: string;
  tags: string[];
  runCount: number;
  totalDivergenceScore: number;
  blockingIssueCount: number;
  packageIssueCount: number;
  budgetWarningCount: number;
  issueCounts: Partial<Record<HarnessBenchmarkIssueCode, number>>;
}

export interface HarnessBenchmarkTagSummary {
  tag: string;
  runCount: number;
  totalDivergenceScore: number;
  blockingIssueCount: number;
  packageIssueCount: number;
  budgetWarningCount: number;
  issueCounts: Partial<Record<HarnessBenchmarkIssueCode, number>>;
}

export interface HarnessBenchmarkReport {
  suiteName: string;
  caseCount: number;
  runCount: number;
  results: HarnessBenchmarkRunResult[];
  modelSummaries: HarnessBenchmarkModelSummary[];
  caseSummaries: HarnessBenchmarkCaseSummary[];
  tagSummaries: HarnessBenchmarkTagSummary[];
}

export type HarnessBenchmarkPreflightSeverity = "error" | "warning";

export type HarnessBenchmarkPreflightIssueCode =
  | "duplicate_case_id"
  | "duplicate_run_id"
  | "unknown_expected_issue_code"
  | "unknown_expected_package_issue_code"
  | "package_artifact_missing_required_text"
  | "package_artifact_contains_forbidden_text"
  | "run_without_assistant_output"
  | "run_without_messages";

export interface HarnessBenchmarkPreflightIssue {
  severity: HarnessBenchmarkPreflightSeverity;
  code: HarnessBenchmarkPreflightIssueCode;
  message: string;
  caseId?: string;
  caseName?: string;
  runId?: string;
  model?: string;
  artifactId?: string;
  text?: string;
}

export interface HarnessBenchmarkPreflightReport {
  ok: boolean;
  caseCount: number;
  runCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: HarnessBenchmarkPreflightIssue[];
}

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_RESPONSE_COMPLIANCE_MODE = "enforce";
const DEFAULT_MODEL_NAME = "unknown-model";
const HARNESS_BENCHMARK_ISSUE_CODE_ORDER: HarnessBenchmarkIssueCode[] = [
  "tool_efficiency",
  "memory_search",
  "learning_capture",
  "skill_routing",
  "evidence_routing",
  "workflow_drift",
  "model_escalation",
];
const HARNESS_BENCHMARK_ISSUE_CODES = new Set<string>(
  HARNESS_BENCHMARK_ISSUE_CODE_ORDER,
);
const HARNESS_BENCHMARK_PACKAGE_ISSUE_CODES =
  new Set<HarnessBenchmarkPackageIssueCode>([
    "package_artifact_contains_forbidden_text",
    "package_artifact_missing_required_text",
    "package_run_contains_forbidden_text",
    "package_run_forbidden_tool_before_anchor",
    "package_run_missing_required_text",
    "package_run_missing_required_tool_call",
    "package_run_next_tool_mismatch",
    "package_run_required_tool_missing_before_anchor",
    "package_run_tool_order_violation",
    "package_run_used_forbidden_tool_call",
  ]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} must be an array of strings when provided`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number when provided`);
  }
  return value;
}

function parsePackageArtifacts(
  value: unknown,
  label: string,
): HarnessBenchmarkPackageArtifact[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((artifact, index) => {
    if (!isRecord(artifact)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      forbiddenIncludes: optionalStringArray(
        artifact.forbiddenIncludes,
        `${label}[${index}].forbiddenIncludes`,
      ),
      id: optionalString(artifact.id, `${label}[${index}].id`),
      kind: optionalString(artifact.kind, `${label}[${index}].kind`) as
        | HarnessBenchmarkPackageArtifactKind
        | undefined,
      requiredIncludes: optionalStringArray(
        artifact.requiredIncludes,
        `${label}[${index}].requiredIncludes`,
      ),
      text: requireString(artifact.text, `${label}[${index}].text`),
    };
  });
}

function parseToolCallCheck(
  value: unknown,
  label: string,
): HarnessBenchmarkToolCallCheck {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    argumentIncludes: optionalStringArray(
      value.argumentIncludes,
      `${label}.argumentIncludes`,
    ),
    name: requireString(value.name, `${label}.name`),
  };
}

function parseToolCallChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkToolCallCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) =>
    parseToolCallCheck(check, `${label}[${index}]`),
  );
}

function parseForbiddenToolCallCheck(
  value: unknown,
  label: string,
): HarnessBenchmarkForbiddenToolCallCheck {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return {
    argumentIncludes: optionalStringArray(
      value.argumentIncludes,
      `${label}.argumentIncludes`,
    ),
    name: optionalString(value.name, `${label}.name`),
  };
}

function parseForbiddenToolCallChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkForbiddenToolCallCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) =>
    parseForbiddenToolCallCheck(check, `${label}[${index}]`),
  );
}

function parseForbiddenBeforeChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkForbiddenBeforeCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      before: parseToolCallCheck(check.before, `${label}[${index}].before`),
      forbidden: parseForbiddenToolCallCheck(
        check.forbidden,
        `${label}[${index}].forbidden`,
      ),
    };
  });
}

function parseRequiredBeforeChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkRequiredBeforeCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      before: parseToolCallCheck(check.before, `${label}[${index}].before`),
      required: parseToolCallCheck(
        check.required,
        `${label}[${index}].required`,
      ),
    };
  });
}

function parseNextToolChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkNextToolCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      after: parseToolCallCheck(check.after, `${label}[${index}].after`),
      next: parseToolCallCheck(check.next, `${label}[${index}].next`),
    };
  });
}

function parsePackageContract(
  value: unknown,
  label: string,
): HarnessBenchmarkPackageContract | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object when provided`);
  }

  return {
    artifacts: parsePackageArtifacts(value.artifacts, `${label}.artifacts`),
    forbiddenBefore: parseForbiddenBeforeChecks(
      value.forbiddenBefore,
      `${label}.forbiddenBefore`,
    ),
    forbiddenToolCalls: parseForbiddenToolCallChecks(
      value.forbiddenToolCalls,
      `${label}.forbiddenToolCalls`,
    ),
    forbiddenTranscriptIncludes: optionalStringArray(
      value.forbiddenTranscriptIncludes,
      `${label}.forbiddenTranscriptIncludes`,
    ),
    name: optionalString(value.name, `${label}.name`),
    nextToolMustBe: parseNextToolChecks(
      value.nextToolMustBe,
      `${label}.nextToolMustBe`,
    ),
    orderedToolCalls: parseToolCallChecks(
      value.orderedToolCalls,
      `${label}.orderedToolCalls`,
    ),
    requiredBefore: parseRequiredBeforeChecks(
      value.requiredBefore,
      `${label}.requiredBefore`,
    ),
    requiredToolCalls: parseToolCallChecks(
      value.requiredToolCalls,
      `${label}.requiredToolCalls`,
    ),
    requiredTranscriptIncludes: optionalStringArray(
      value.requiredTranscriptIncludes,
      `${label}.requiredTranscriptIncludes`,
    ),
    sourceHash: optionalString(value.sourceHash, `${label}.sourceHash`),
    sourcePath: optionalString(value.sourcePath, `${label}.sourcePath`),
  };
}

function parseMessages(
  value: unknown,
  label: string,
): HarnessBenchmarkMessage[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((message, index) => {
    if (!isRecord(message)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const role = requireString(message.role, `${label}[${index}].role`);
    const text = optionalString(message.text, `${label}[${index}].text`);
    const parsed: HarnessBenchmarkMessage = { role };
    if (text !== undefined) parsed.text = text;
    if (message.content !== undefined) parsed.content = message.content;
    if (message.toolCall !== undefined) {
      if (!isRecord(message.toolCall)) {
        throw new Error(`${label}[${index}].toolCall must be an object`);
      }
      parsed.toolCall = {
        arguments: message.toolCall.arguments,
        id: optionalString(
          message.toolCall.id,
          `${label}[${index}].toolCall.id`,
        ),
        name: requireString(
          message.toolCall.name,
          `${label}[${index}].toolCall.name`,
        ),
      };
    }
    return parsed;
  });
}

function parseTranscript(
  value: unknown,
  label: string,
): KhalaTranscript | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeKhalaTranscript(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be a Khala transcript: ${message}`);
  }
}

function parseRuns(value: unknown, label: string): HarnessBenchmarkRun[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  return value.map((run, index) => {
    if (!isRecord(run)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const transcript = parseTranscript(
      run.transcript,
      `${label}[${index}].transcript`,
    );
    const messages =
      run.messages === undefined
        ? transcript
          ? (khalaTranscriptToBenchmarkMessages(
              transcript,
            ) as HarnessBenchmarkMessage[])
          : undefined
        : parseMessages(run.messages, `${label}[${index}].messages`);
    if (messages === undefined) {
      throw new Error(
        `${label}[${index}].messages must be an array unless transcript is provided`,
      );
    }
    return {
      assistantText: optionalString(
        run.assistantText,
        `${label}[${index}].assistantText`,
      ),
      expectedIssueCodes: optionalStringArray(
        run.expectedIssueCodes,
        `${label}[${index}].expectedIssueCodes`,
      ) as HarnessBenchmarkIssueCode[] | undefined,
      expectedPackageIssueCodes: optionalStringArray(
        run.expectedPackageIssueCodes,
        `${label}[${index}].expectedPackageIssueCodes`,
      ) as HarnessBenchmarkPackageIssueCode[] | undefined,
      harnessLimits: run.harnessLimits as HarnessBenchmarkRun["harnessLimits"],
      id: optionalString(run.id, `${label}[${index}].id`),
      budgetWarningThreshold: optionalNumber(
        run.budgetWarningThreshold,
        `${label}[${index}].budgetWarningThreshold`,
      ),
      lowConfidenceThreshold: optionalNumber(
        run.lowConfidenceThreshold,
        `${label}[${index}].lowConfidenceThreshold`,
      ),
      messages,
      model: optionalString(run.model, `${label}[${index}].model`),
      responseComplianceMode: optionalString(
        run.responseComplianceMode,
        `${label}[${index}].responseComplianceMode`,
      ),
      transcript,
    };
  });
}

export function parseHarnessBenchmarkSuite(
  value: unknown,
): HarnessBenchmarkSuite {
  if (!isRecord(value)) {
    throw new Error("benchmark suite must be an object");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("benchmark suite cases must be a non-empty array");
  }

  return {
    cases: value.cases.map((benchmarkCase, index) => {
      if (!isRecord(benchmarkCase)) {
        throw new Error(`cases[${index}] must be an object`);
      }
      return {
        assistantText: optionalString(
          benchmarkCase.assistantText,
          `cases[${index}].assistantText`,
        ),
        description: optionalString(
          benchmarkCase.description,
          `cases[${index}].description`,
        ),
        expectedIssueCodes: optionalStringArray(
          benchmarkCase.expectedIssueCodes,
          `cases[${index}].expectedIssueCodes`,
        ) as HarnessBenchmarkIssueCode[] | undefined,
        expectedPackageIssueCodes: optionalStringArray(
          benchmarkCase.expectedPackageIssueCodes,
          `cases[${index}].expectedPackageIssueCodes`,
        ) as HarnessBenchmarkPackageIssueCode[] | undefined,
        harnessLimits:
          benchmarkCase.harnessLimits as HarnessBenchmarkCase["harnessLimits"],
        id: optionalString(benchmarkCase.id, `cases[${index}].id`),
        budgetWarningThreshold: optionalNumber(
          benchmarkCase.budgetWarningThreshold,
          `cases[${index}].budgetWarningThreshold`,
        ),
        lowConfidenceThreshold: optionalNumber(
          benchmarkCase.lowConfidenceThreshold,
          `cases[${index}].lowConfidenceThreshold`,
        ),
        name: requireString(benchmarkCase.name, `cases[${index}].name`),
        packageContract: parsePackageContract(
          benchmarkCase.packageContract,
          `cases[${index}].packageContract`,
        ),
        responseComplianceMode: optionalString(
          benchmarkCase.responseComplianceMode,
          `cases[${index}].responseComplianceMode`,
        ),
        runs: parseRuns(benchmarkCase.runs, `cases[${index}].runs`),
        tags: optionalStringArray(benchmarkCase.tags, `cases[${index}].tags`),
        userText: requireString(
          benchmarkCase.userText,
          `cases[${index}].userText`,
        ),
      };
    }),
    description: optionalString(value.description, "description"),
    name: optionalString(value.name, "name"),
    version: value.version === undefined ? undefined : 1,
  };
}

function latestAssistantText(
  messages: readonly HarnessBenchmarkMessage[] = [],
): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    if (typeof message.text === "string") return message.text;
  }
  return "";
}

function latestRunAssistantText(run: HarnessBenchmarkRun): string {
  if (run.transcript) {
    const transcriptText = latestKhalaAssistantText(run.transcript);
    if (transcriptText.trim()) return transcriptText;
  }
  return latestAssistantText(run.messages);
}

function isHarnessBenchmarkIssueCode(
  code: string,
): code is HarnessBenchmarkIssueCode {
  return HARNESS_BENCHMARK_ISSUE_CODES.has(code);
}

function isHarnessBenchmarkPackageIssueCode(
  code: string,
): code is HarnessBenchmarkPackageIssueCode {
  return HARNESS_BENCHMARK_PACKAGE_ISSUE_CODES.has(
    code as HarnessBenchmarkPackageIssueCode,
  );
}

function pushPreflightIssue(
  issues: HarnessBenchmarkPreflightIssue[],
  issue: HarnessBenchmarkPreflightIssue,
): void {
  issues.push(issue);
}

function preflightExpectedIssueCodes(params: {
  codes?: HarnessBenchmarkIssueCode[];
  issues: HarnessBenchmarkPreflightIssue[];
  caseId?: string;
  caseName: string;
  runId?: string;
  model?: string;
}): void {
  for (const code of (params.codes ?? []) as string[]) {
    if (isHarnessBenchmarkIssueCode(code)) continue;
    pushPreflightIssue(params.issues, {
      caseId: params.caseId,
      caseName: params.caseName,
      code: "unknown_expected_issue_code",
      message: `unknown expected issue code: ${code}`,
      model: params.model,
      runId: params.runId,
      severity: "error",
      text: code,
    });
  }
}

function preflightExpectedPackageIssueCodes(params: {
  codes?: HarnessBenchmarkPackageIssueCode[];
  issues: HarnessBenchmarkPreflightIssue[];
  caseId?: string;
  caseName: string;
  runId?: string;
  model?: string;
}): void {
  for (const code of (params.codes ?? []) as string[]) {
    if (isHarnessBenchmarkPackageIssueCode(code)) continue;
    pushPreflightIssue(params.issues, {
      caseId: params.caseId,
      caseName: params.caseName,
      code: "unknown_expected_package_issue_code",
      message: `unknown expected package issue code: ${code}`,
      model: params.model,
      runId: params.runId,
      severity: "error",
      text: code,
    });
  }
}

export function preflightHarnessBenchmarkSuite(
  suite: HarnessBenchmarkSuite,
): HarnessBenchmarkPreflightReport {
  const parsedSuite = parseHarnessBenchmarkSuite(suite);
  const issues: HarnessBenchmarkPreflightIssue[] = [];
  const caseIds = new Map<string, string>();
  let runCount = 0;

  for (const benchmarkCase of parsedSuite.cases) {
    if (benchmarkCase.id) {
      const priorCaseName = caseIds.get(benchmarkCase.id);
      if (priorCaseName !== undefined) {
        pushPreflightIssue(issues, {
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "duplicate_case_id",
          message: `case id '${benchmarkCase.id}' is duplicated by '${priorCaseName}' and '${benchmarkCase.name}'`,
          severity: "error",
        });
      } else {
        caseIds.set(benchmarkCase.id, benchmarkCase.name);
      }
    }

    preflightExpectedIssueCodes({
      caseId: benchmarkCase.id,
      caseName: benchmarkCase.name,
      codes: benchmarkCase.expectedIssueCodes,
      issues,
    });
    preflightExpectedPackageIssueCodes({
      caseId: benchmarkCase.id,
      caseName: benchmarkCase.name,
      codes: benchmarkCase.expectedPackageIssueCodes,
      issues,
    });

    for (const [artifactIndex, artifact] of (
      benchmarkCase.packageContract?.artifacts ?? []
    ).entries()) {
      const artifactId =
        artifact.id ?? `${artifact.kind ?? "artifact"}-${artifactIndex + 1}`;
      for (const requiredText of artifact.requiredIncludes ?? []) {
        if (artifact.text.includes(requiredText)) continue;
        pushPreflightIssue(issues, {
          artifactId,
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "package_artifact_missing_required_text",
          message: `${artifactId} is missing required package text: ${requiredText}`,
          severity: "error",
          text: requiredText,
        });
      }
      for (const forbiddenText of artifact.forbiddenIncludes ?? []) {
        if (!artifact.text.includes(forbiddenText)) continue;
        pushPreflightIssue(issues, {
          artifactId,
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "package_artifact_contains_forbidden_text",
          message: `${artifactId} contains forbidden package text: ${forbiddenText}`,
          severity: "error",
          text: forbiddenText,
        });
      }
    }

    const runIds = new Set<string>();
    for (const [runIndex, run] of benchmarkCase.runs.entries()) {
      runCount += 1;
      const runId = run.id ?? `${benchmarkCase.id ?? "case"}-${runIndex + 1}`;
      if (runIds.has(runId)) {
        pushPreflightIssue(issues, {
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "duplicate_run_id",
          message: `run id '${runId}' is duplicated within case '${benchmarkCase.name}'`,
          model: run.model,
          runId,
          severity: "error",
        });
      }
      runIds.add(runId);

      preflightExpectedIssueCodes({
        caseId: benchmarkCase.id,
        caseName: benchmarkCase.name,
        codes: run.expectedIssueCodes,
        issues,
        model: run.model,
        runId,
      });
      preflightExpectedPackageIssueCodes({
        caseId: benchmarkCase.id,
        caseName: benchmarkCase.name,
        codes: run.expectedPackageIssueCodes,
        issues,
        model: run.model,
        runId,
      });

      const transcriptEventCount =
        run.transcript?.events.length ?? run.messages?.length ?? 0;
      if (transcriptEventCount === 0) {
        pushPreflightIssue(issues, {
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "run_without_messages",
          message: `run '${runId}' has no transcript messages`,
          model: run.model,
          runId,
          severity: "warning",
        });
      }
      const assistantText =
        run.assistantText ??
        benchmarkCase.assistantText ??
        latestRunAssistantText(run);
      if (assistantText.trim() === "") {
        pushPreflightIssue(issues, {
          caseId: benchmarkCase.id,
          caseName: benchmarkCase.name,
          code: "run_without_assistant_output",
          message: `run '${runId}' has no assistant text to score`,
          model: run.model,
          runId,
          severity: "warning",
        });
      }
    }
  }

  const errorCount = issues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const warningCount = issues.length - errorCount;
  return {
    caseCount: parsedSuite.cases.length,
    errorCount,
    issueCount: issues.length,
    issues,
    ok: errorCount === 0,
    runCount,
    warningCount,
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return stableKhalaJsonStringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function transcriptText(transcript: KhalaTranscript): string {
  return khalaTranscriptSearchText(transcript);
}

function toolCallArgumentsText(value: unknown): string {
  return stringifyUnknown(value ?? {});
}

function toolCallMatchesRequired(
  toolCall: KhalaToolCallRequestedEvent,
  check: HarnessBenchmarkToolCallCheck,
): boolean {
  if (toolCall.name !== check.name) return false;
  const argumentText = toolCallArgumentsText(toolCall.arguments);
  return (check.argumentIncludes ?? []).every((text) =>
    argumentText.includes(text),
  );
}

function toolCallMatchesForbidden(
  toolCall: KhalaToolCallRequestedEvent,
  check: HarnessBenchmarkForbiddenToolCallCheck,
): boolean {
  if (check.name !== undefined && toolCall.name !== check.name) return false;
  const argumentText = toolCallArgumentsText(toolCall.arguments);
  return (check.argumentIncludes ?? []).every((text) =>
    argumentText.includes(text),
  );
}

function formatToolCallCheck(
  check: HarnessBenchmarkToolCallCheck | HarnessBenchmarkForbiddenToolCallCheck,
): string {
  const args = check.argumentIncludes?.length
    ? ` with arguments including ${check.argumentIncludes.join(", ")}`
    : "";
  return `${check.name ?? "any tool"}${args}`;
}

function firstMatchingToolCall(
  toolCalls: readonly KhalaToolCallRequestedEvent[],
  check: HarnessBenchmarkToolCallCheck,
  afterSeq = 0,
): KhalaToolCallRequestedEvent | undefined {
  return toolCalls.find(
    (toolCall) =>
      toolCall.seq > afterSeq && toolCallMatchesRequired(toolCall, check),
  );
}

function runHasRequiredToolCall(
  transcript: KhalaTranscript,
  check: HarnessBenchmarkToolCallCheck,
): boolean {
  return khalaTranscriptToolCalls(transcript).some((toolCall) =>
    toolCallMatchesRequired(toolCall, check),
  );
}

function runHasForbiddenToolCall(
  transcript: KhalaTranscript,
  check: HarnessBenchmarkForbiddenToolCallCheck,
): boolean {
  return khalaTranscriptToolCalls(transcript).some((toolCall) =>
    toolCallMatchesForbidden(toolCall, check),
  );
}

function evaluatePackageContract(params: {
  contract?: HarnessBenchmarkPackageContract;
  transcript: KhalaTranscript;
}): HarnessBenchmarkPackageIssue[] {
  const contract = params.contract;
  if (!contract) return [];

  const issues: HarnessBenchmarkPackageIssue[] = [];
  for (const [artifactIndex, artifact] of (
    contract.artifacts ?? []
  ).entries()) {
    const artifactId =
      artifact.id ?? `${artifact.kind ?? "artifact"}-${artifactIndex + 1}`;
    for (const requiredText of artifact.requiredIncludes ?? []) {
      if (!artifact.text.includes(requiredText)) {
        issues.push({
          artifactId,
          code: "package_artifact_missing_required_text",
          message: `${artifactId} is missing required package text: ${requiredText}`,
          text: requiredText,
        });
      }
    }
    for (const forbiddenText of artifact.forbiddenIncludes ?? []) {
      if (artifact.text.includes(forbiddenText)) {
        issues.push({
          artifactId,
          code: "package_artifact_contains_forbidden_text",
          message: `${artifactId} contains forbidden package text: ${forbiddenText}`,
          text: forbiddenText,
        });
      }
    }
  }

  const transcript = transcriptText(params.transcript);
  for (const requiredText of contract.requiredTranscriptIncludes ?? []) {
    if (!transcript.includes(requiredText)) {
      issues.push({
        code: "package_run_missing_required_text",
        message: `candidate transcript is missing required package-following text: ${requiredText}`,
        text: requiredText,
      });
    }
  }
  for (const forbiddenText of contract.forbiddenTranscriptIncludes ?? []) {
    if (transcript.includes(forbiddenText)) {
      issues.push({
        code: "package_run_contains_forbidden_text",
        message: `candidate transcript contains forbidden package text: ${forbiddenText}`,
        text: forbiddenText,
      });
    }
  }
  for (const requiredToolCall of contract.requiredToolCalls ?? []) {
    if (!runHasRequiredToolCall(params.transcript, requiredToolCall)) {
      issues.push({
        code: "package_run_missing_required_tool_call",
        message: `candidate transcript did not call required package tool: ${requiredToolCall.name}`,
        toolName: requiredToolCall.name,
      });
    }
  }
  for (const forbiddenToolCall of contract.forbiddenToolCalls ?? []) {
    if (runHasForbiddenToolCall(params.transcript, forbiddenToolCall)) {
      issues.push({
        code: "package_run_used_forbidden_tool_call",
        message: `candidate transcript used forbidden package tool: ${forbiddenToolCall.name ?? "any matching tool"}`,
        toolName: forbiddenToolCall.name,
      });
    }
  }

  const toolCalls = khalaTranscriptToolCalls(params.transcript);
  let orderedCursor = 0;
  for (const orderedToolCall of contract.orderedToolCalls ?? []) {
    const match = firstMatchingToolCall(
      toolCalls,
      orderedToolCall,
      orderedCursor,
    );
    if (!match) {
      issues.push({
        code: "package_run_tool_order_violation",
        message: `candidate transcript did not call ordered package tool after the prior step: ${formatToolCallCheck(
          orderedToolCall,
        )}`,
        toolName: orderedToolCall.name,
      });
      break;
    }
    orderedCursor = match.seq;
  }

  for (const check of contract.forbiddenBefore ?? []) {
    const anchor = firstMatchingToolCall(toolCalls, check.before);
    if (!anchor) continue;
    const forbidden = toolCalls.find(
      (toolCall) =>
        toolCall.seq < anchor.seq &&
        toolCallMatchesForbidden(toolCall, check.forbidden),
    );
    if (forbidden) {
      issues.push({
        anchorToolName: check.before.name,
        code: "package_run_forbidden_tool_before_anchor",
        message: `candidate transcript called forbidden package tool ${formatToolCallCheck(
          check.forbidden,
        )} before ${formatToolCallCheck(check.before)}`,
        toolName: forbidden.name,
      });
    }
  }

  for (const check of contract.requiredBefore ?? []) {
    const anchor = firstMatchingToolCall(toolCalls, check.before);
    if (!anchor) continue;
    const required = toolCalls.find(
      (toolCall) =>
        toolCall.seq < anchor.seq &&
        toolCallMatchesRequired(toolCall, check.required),
    );
    if (!required) {
      issues.push({
        anchorToolName: check.before.name,
        code: "package_run_required_tool_missing_before_anchor",
        message: `candidate transcript did not call required package tool ${formatToolCallCheck(
          check.required,
        )} before ${formatToolCallCheck(check.before)}`,
        toolName: check.required.name,
      });
    }
  }

  for (const check of contract.nextToolMustBe ?? []) {
    const after = firstMatchingToolCall(toolCalls, check.after);
    if (!after) continue;
    const next = toolCalls.find((toolCall) => toolCall.seq > after.seq);
    if (!next || !toolCallMatchesRequired(next, check.next)) {
      issues.push({
        anchorToolName: check.after.name,
        code: "package_run_next_tool_mismatch",
        message: `candidate transcript did not call ${formatToolCallCheck(
          check.next,
        )} immediately after ${formatToolCallCheck(check.after)}`,
        toolName: next?.name ?? check.next.name,
      });
    }
  }

  return issues;
}

function multisetDifference<T extends string>(
  left: readonly T[],
  right: readonly T[],
): T[] {
  const remaining = new Map<T, number>();
  for (const code of right) {
    remaining.set(code, (remaining.get(code) ?? 0) + 1);
  }

  const difference: T[] = [];
  for (const code of left) {
    const count = remaining.get(code) ?? 0;
    if (count > 0) {
      remaining.set(code, count - 1);
    } else {
      difference.push(code);
    }
  }
  return difference;
}

function divergenceScore(params: {
  issues: HarnessTurnIssue[];
  expectedIssueDistance: number;
  metrics: HarnessTurnMetrics;
  packageDivergenceScore: number;
}): number {
  const blockingIssues = params.issues.filter((issue) => issue.block).length;
  const nonBlockingIssues = params.issues.length - blockingIssues;
  return (
    blockingIssues * 12 +
    nonBlockingIssues * 6 +
    params.expectedIssueDistance * 3 +
    params.metrics.wasteSignals.count +
    params.packageDivergenceScore
  );
}

function packageDivergenceScore(
  issues: HarnessBenchmarkPackageIssue[],
): number {
  return issues.reduce((sum, issue) => {
    switch (issue.code) {
      case "package_run_used_forbidden_tool_call":
        return sum + 14;
      case "package_run_forbidden_tool_before_anchor":
      case "package_run_next_tool_mismatch":
      case "package_run_tool_order_violation":
        return sum + 14;
      case "package_run_missing_required_tool_call":
      case "package_run_required_tool_missing_before_anchor":
        return sum + 12;
      case "package_artifact_missing_required_text":
      case "package_artifact_contains_forbidden_text":
        return sum + 10;
      case "package_run_missing_required_text":
      case "package_run_contains_forbidden_text":
        return sum + 8;
    }
    return sum;
  }, 0);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function summarizeModels(
  results: HarnessBenchmarkRunResult[],
): HarnessBenchmarkModelSummary[] {
  const grouped = new Map<string, HarnessBenchmarkRunResult[]>();
  for (const result of results) {
    grouped.set(result.model, [...(grouped.get(result.model) ?? []), result]);
  }

  return [...grouped.entries()]
    .map(([model, modelResults]) => {
      const totalCompliance = modelResults.reduce(
        (sum, result) => sum + result.complianceScore,
        0,
      );
      const totalDivergenceScore = modelResults.reduce(
        (sum, result) => sum + result.divergenceScore,
        0,
      );
      const issueCounts: Partial<Record<HarnessBenchmarkIssueCode, number>> =
        {};
      let packageIssueCount = 0;
      for (const result of modelResults) {
        packageIssueCount += result.packageIssues.length;
        for (const code of result.issueCodes) {
          issueCounts[code] = (issueCounts[code] ?? 0) + 1;
        }
      }
      const orderedIssueCounts: Partial<
        Record<HarnessBenchmarkIssueCode, number>
      > = {};
      for (const code of HARNESS_BENCHMARK_ISSUE_CODE_ORDER) {
        const count = issueCounts[code];
        if (count !== undefined) orderedIssueCounts[code] = count;
      }
      return {
        averageComplianceScore: Number(
          (totalCompliance / modelResults.length).toFixed(1),
        ),
        issueCounts: orderedIssueCounts,
        model,
        packageIssueCount,
        runCount: modelResults.length,
        totalDivergenceScore,
      };
    })
    .sort((left, right) => {
      if (right.averageComplianceScore !== left.averageComplianceScore) {
        return right.averageComplianceScore - left.averageComplianceScore;
      }
      if (left.totalDivergenceScore !== right.totalDivergenceScore) {
        return left.totalDivergenceScore - right.totalDivergenceScore;
      }
      return compareText(left.model, right.model);
    });
}

function orderedIssueCounts(
  results: readonly HarnessBenchmarkRunResult[],
): Partial<Record<HarnessBenchmarkIssueCode, number>> {
  const counts: Partial<Record<HarnessBenchmarkIssueCode, number>> = {};
  for (const result of results) {
    for (const code of result.issueCodes) {
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }

  const ordered: Partial<Record<HarnessBenchmarkIssueCode, number>> = {};
  for (const code of HARNESS_BENCHMARK_ISSUE_CODE_ORDER) {
    const count = counts[code];
    if (count !== undefined) ordered[code] = count;
  }
  return ordered;
}

function summarizeCases(
  results: readonly HarnessBenchmarkRunResult[],
): HarnessBenchmarkCaseSummary[] {
  const grouped = new Map<string, HarnessBenchmarkRunResult[]>();
  for (const result of results) {
    const key = result.caseId ?? result.caseName;
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }

  return [...grouped.values()]
    .map((caseResults) => {
      const first = caseResults[0];
      return {
        blockingIssueCount: caseResults.reduce(
          (sum, result) => sum + result.blockingIssueCount,
          0,
        ),
        budgetWarningCount: caseResults.reduce(
          (sum, result) => sum + result.budget.warnings.length,
          0,
        ),
        caseId: first.caseId,
        caseName: first.caseName,
        issueCounts: orderedIssueCounts(caseResults),
        packageIssueCount: caseResults.reduce(
          (sum, result) => sum + result.packageIssues.length,
          0,
        ),
        runCount: caseResults.length,
        tags: first.tags,
        totalDivergenceScore: caseResults.reduce(
          (sum, result) => sum + result.divergenceScore,
          0,
        ),
      };
    })
    .sort((left, right) =>
      compareText(left.caseId ?? left.caseName, right.caseId ?? right.caseName),
    );
}

function summarizeTags(
  results: readonly HarnessBenchmarkRunResult[],
): HarnessBenchmarkTagSummary[] {
  const grouped = new Map<string, HarnessBenchmarkRunResult[]>();
  for (const result of results) {
    for (const tag of result.tags) {
      grouped.set(tag, [...(grouped.get(tag) ?? []), result]);
    }
  }

  return [...grouped.entries()]
    .map(([tag, tagResults]) => ({
      blockingIssueCount: tagResults.reduce(
        (sum, result) => sum + result.blockingIssueCount,
        0,
      ),
      budgetWarningCount: tagResults.reduce(
        (sum, result) => sum + result.budget.warnings.length,
        0,
      ),
      issueCounts: orderedIssueCounts(tagResults),
      packageIssueCount: tagResults.reduce(
        (sum, result) => sum + result.packageIssues.length,
        0,
      ),
      runCount: tagResults.length,
      tag,
      totalDivergenceScore: tagResults.reduce(
        (sum, result) => sum + result.divergenceScore,
        0,
      ),
    }))
    .sort((left, right) => compareText(left.tag, right.tag));
}

function transcriptForRun(params: {
  benchmarkCase: HarnessBenchmarkCase;
  run: HarnessBenchmarkRun;
  assistantText: string;
  runId: string;
}): KhalaTranscript {
  if (params.run.transcript)
    return normalizeKhalaTranscript(params.run.transcript);
  return benchmarkMessagesToKhalaTranscript({
    assistantText: params.assistantText,
    messages: params.run.messages ?? [],
    metadata: {
      caseId: params.benchmarkCase.id,
      caseName: params.benchmarkCase.name,
      model: params.run.model,
      runId: params.runId,
    },
    userText: params.benchmarkCase.userText,
  });
}

export function evaluateHarnessBenchmark(
  suite: HarnessBenchmarkSuite,
  options: HarnessBenchmarkOptions = {},
): HarnessBenchmarkReport {
  const parsedSuite = parseHarnessBenchmarkSuite(suite);
  const results: HarnessBenchmarkRunResult[] = [];

  for (const benchmarkCase of parsedSuite.cases) {
    for (const [runIndex, run] of benchmarkCase.runs.entries()) {
      const assistantText =
        run.assistantText ??
        benchmarkCase.assistantText ??
        latestRunAssistantText(run);
      const runId = run.id ?? `${benchmarkCase.id ?? "case"}-${runIndex + 1}`;
      const transcript = transcriptForRun({
        assistantText,
        benchmarkCase,
        run,
        runId,
      });
      const messages = khalaTranscriptToHarnessMessages(
        transcript,
      ) as HarnessEvaluationParams["messages"];
      const lowConfidenceThreshold =
        run.lowConfidenceThreshold ??
        benchmarkCase.lowConfidenceThreshold ??
        options.lowConfidenceThreshold ??
        DEFAULT_LOW_CONFIDENCE_THRESHOLD;
      const responseComplianceMode =
        run.responseComplianceMode ??
        benchmarkCase.responseComplianceMode ??
        options.responseComplianceMode ??
        DEFAULT_RESPONSE_COMPLIANCE_MODE;
      const harnessLimits = run.harnessLimits ?? benchmarkCase.harnessLimits;
      const issues = evaluateHarnessTurn({
        assistantText,
        harnessLimits:
          harnessLimits as HarnessEvaluationParams["harnessLimits"],
        lowConfidenceThreshold,
        messages,
        responseComplianceMode,
        userText: benchmarkCase.userText,
      });
      const metrics = evaluateHarnessTurnMetrics({ messages });
      const issueCodes = issues.map((issue) => issue.code);
      const expectedIssueCodes =
        run.expectedIssueCodes ?? benchmarkCase.expectedIssueCodes ?? [];
      const missingExpectedIssueCodes = multisetDifference(
        expectedIssueCodes,
        issueCodes,
      );
      const unexpectedIssueCodes = multisetDifference(
        issueCodes,
        expectedIssueCodes,
      );
      const expectedIssueDistance =
        missingExpectedIssueCodes.length + unexpectedIssueCodes.length;
      const packageIssues = evaluatePackageContract({
        contract: benchmarkCase.packageContract,
        transcript,
      });
      const packageIssueCodes = packageIssues.map((issue) => issue.code);
      const expectedPackageIssueCodes =
        run.expectedPackageIssueCodes ??
        benchmarkCase.expectedPackageIssueCodes ??
        [];
      const missingExpectedPackageIssueCodes = multisetDifference(
        expectedPackageIssueCodes,
        packageIssueCodes,
      );
      const unexpectedPackageIssueCodes = multisetDifference(
        packageIssueCodes,
        expectedPackageIssueCodes,
      );
      const expectedPackageIssueDistance =
        missingExpectedPackageIssueCodes.length +
        unexpectedPackageIssueCodes.length;
      const packageScore = packageDivergenceScore(packageIssues);
      const score = divergenceScore({
        expectedIssueDistance,
        issues,
        metrics,
        packageDivergenceScore: packageScore,
      });
      const budget = estimateKhalaBudget({
        handoffCapsule: benchmarkCase.packageContract?.artifacts?.map(
          (artifact) => ({
            id: artifact.id,
            kind: artifact.kind,
            text: artifact.text,
          }),
        ),
        transcript,
        warningThresholdTokens:
          run.budgetWarningThreshold ??
          benchmarkCase.budgetWarningThreshold ??
          options.budgetWarningThreshold,
      });

      results.push({
        budget,
        blockingIssueCount: issues.filter((issue) => issue.block).length,
        caseId: benchmarkCase.id,
        caseName: benchmarkCase.name,
        complianceScore: Math.max(0, 100 - score),
        divergenceScore: score,
        expectedIssueCodes,
        expectedIssueDistance,
        expectedPackageIssueCodes,
        expectedPackageIssueDistance,
        issueCodes,
        issues,
        metrics,
        missingExpectedIssueCodes,
        missingExpectedPackageIssueCodes,
        model: run.model ?? DEFAULT_MODEL_NAME,
        packageDivergenceScore: packageScore,
        packageIssues,
        runId,
        tags: benchmarkCase.tags ?? [],
        transcriptEventCount: transcript.events.length,
        unexpectedIssueCodes,
        unexpectedPackageIssueCodes,
      });
    }
  }

  results.sort((left, right) => {
    if (right.complianceScore !== left.complianceScore) {
      return right.complianceScore - left.complianceScore;
    }
    if (left.divergenceScore !== right.divergenceScore) {
      return left.divergenceScore - right.divergenceScore;
    }
    return (
      compareText(left.caseId ?? "", right.caseId ?? "") ||
      compareText(left.caseName, right.caseName) ||
      compareText(left.runId, right.runId) ||
      compareText(left.model, right.model)
    );
  });

  return {
    caseSummaries: summarizeCases(results),
    caseCount: parsedSuite.cases.length,
    modelSummaries: summarizeModels(results),
    results,
    runCount: results.length,
    suiteName: parsedSuite.name ?? "Khala harness benchmark",
    tagSummaries: summarizeTags(results),
  };
}

function issueCodeText(codes: HarnessBenchmarkIssueCode[]): string {
  return codes.length === 0 ? "none" : codes.join(", ");
}

function markdownCell(value: string | number): string {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

export function formatHarnessBenchmarkMarkdown(
  report: HarnessBenchmarkReport,
): string {
  const lines = [
    `# ${report.suiteName}`,
    "",
    `Cases: ${report.caseCount}  Runs: ${report.runCount}`,
    "",
    "## Model Summary",
    "",
    "| Model | Runs | Avg Compliance | Divergence | Harness Issues | Package Issues |",
    "| --- | ---: | ---: | ---: | --- | ---: |",
  ];

  for (const summary of report.modelSummaries) {
    const issueText = Object.entries(summary.issueCounts)
      .map(([code, count]) => `${code}:${count}`)
      .join(", ");
    lines.push(
      `| ${markdownCell(summary.model)} | ${summary.runCount} | ${summary.averageComplianceScore.toFixed(
        1,
      )} | ${summary.totalDivergenceScore} | ${markdownCell(
        issueText || "none",
      )} | ${summary.packageIssueCount} |`,
    );
  }

  lines.push(
    "",
    "## Runs",
    "",
    "| Case | Run | Model | Compliance | Divergence | Events | Budget | Harness Issues | Package Divergence | Expected Distance |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
  );

  for (const result of report.results) {
    lines.push(
      `| ${markdownCell(result.caseName)} | ${markdownCell(
        result.runId,
      )} | ${markdownCell(result.model)} | ${result.complianceScore} | ${result.divergenceScore} | ${result.transcriptEventCount} | ${result.budget.totalTokens} | ${markdownCell(
        issueCodeText(result.issueCodes),
      )} | ${result.packageDivergenceScore} | ${result.expectedIssueDistance} |`,
    );
  }

  const packageIssueRows = report.results.flatMap((result) =>
    result.packageIssues.map((issue) => ({ issue, result })),
  );
  if (packageIssueRows.length > 0) {
    lines.push(
      "",
      "## Package Issues",
      "",
      "| Case | Run | Code | Message |",
      "| --- | --- | --- | --- |",
    );
    for (const row of packageIssueRows) {
      lines.push(
        `| ${markdownCell(row.result.caseName)} | ${markdownCell(
          row.result.runId,
        )} | ${row.issue.code} | ${markdownCell(row.issue.message)} |`,
      );
    }
  }

  const budgetWarningRows = report.results.flatMap((result) =>
    result.budget.warnings.map((warning) => ({ result, warning })),
  );
  if (budgetWarningRows.length > 0) {
    lines.push(
      "",
      "## Budget Warnings",
      "",
      "| Case | Run | Tokens | Threshold | Message |",
      "| --- | --- | ---: | ---: | --- |",
    );
    for (const row of budgetWarningRows) {
      lines.push(
        `| ${markdownCell(row.result.caseName)} | ${markdownCell(
          row.result.runId,
        )} | ${row.warning.tokens} | ${row.warning.thresholdTokens} | ${markdownCell(
          row.warning.message,
        )} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
