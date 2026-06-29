import {
  evaluateHarnessTurn,
  evaluateHarnessTurnMetrics,
  type HarnessTurnIssue,
  type HarnessTurnMetrics,
} from "../extensions/runtime/escalation.ts";

type HarnessEvaluationParams = Parameters<typeof evaluateHarnessTurn>[0];
type HarnessMessage = HarnessEvaluationParams["messages"][number];
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
  messages: HarnessBenchmarkMessage[];
  expectedIssueCodes?: HarnessBenchmarkIssueCode[];
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  harnessLimits?: HarnessBenchmarkLimits;
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

export interface HarnessBenchmarkPackageContract {
  name?: string;
  artifacts?: HarnessBenchmarkPackageArtifact[];
  requiredTranscriptIncludes?: string[];
  forbiddenTranscriptIncludes?: string[];
  requiredToolCalls?: HarnessBenchmarkToolCallCheck[];
  forbiddenToolCalls?: HarnessBenchmarkForbiddenToolCallCheck[];
}

export interface HarnessBenchmarkPackageIssue {
  code:
    | "package_artifact_missing_required_text"
    | "package_artifact_contains_forbidden_text"
    | "package_run_missing_required_text"
    | "package_run_contains_forbidden_text"
    | "package_run_missing_required_tool_call"
    | "package_run_used_forbidden_tool_call";
  message: string;
  artifactId?: string;
  text?: string;
  toolName?: string;
}

export interface HarnessBenchmarkCase {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  userText: string;
  assistantText?: string;
  expectedIssueCodes?: HarnessBenchmarkIssueCode[];
  lowConfidenceThreshold?: number;
  responseComplianceMode?: string;
  harnessLimits?: HarnessBenchmarkLimits;
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
  packageIssues: HarnessBenchmarkPackageIssue[];
  packageDivergenceScore: number;
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

export interface HarnessBenchmarkReport {
  suiteName: string;
  caseCount: number;
  runCount: number;
  results: HarnessBenchmarkRunResult[];
  modelSummaries: HarnessBenchmarkModelSummary[];
}

export type HarnessBenchmarkPreflightSeverity = "error" | "warning";

export type HarnessBenchmarkPreflightIssueCode =
  | "duplicate_case_id"
  | "duplicate_run_id"
  | "unknown_expected_issue_code"
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

function parseToolCallChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkToolCallCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      argumentIncludes: optionalStringArray(
        check.argumentIncludes,
        `${label}[${index}].argumentIncludes`,
      ),
      name: requireString(check.name, `${label}[${index}].name`),
    };
  });
}

function parseForbiddenToolCallChecks(
  value: unknown,
  label: string,
): HarnessBenchmarkForbiddenToolCallCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }

  return value.map((check, index) => {
    if (!isRecord(check)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return {
      argumentIncludes: optionalStringArray(
        check.argumentIncludes,
        `${label}[${index}].argumentIncludes`,
      ),
      name: optionalString(check.name, `${label}[${index}].name`),
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
    forbiddenToolCalls: parseForbiddenToolCallChecks(
      value.forbiddenToolCalls,
      `${label}.forbiddenToolCalls`,
    ),
    forbiddenTranscriptIncludes: optionalStringArray(
      value.forbiddenTranscriptIncludes,
      `${label}.forbiddenTranscriptIncludes`,
    ),
    name: optionalString(value.name, `${label}.name`),
    requiredToolCalls: parseToolCallChecks(
      value.requiredToolCalls,
      `${label}.requiredToolCalls`,
    ),
    requiredTranscriptIncludes: optionalStringArray(
      value.requiredTranscriptIncludes,
      `${label}.requiredTranscriptIncludes`,
    ),
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

function parseRuns(value: unknown, label: string): HarnessBenchmarkRun[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  return value.map((run, index) => {
    if (!isRecord(run)) {
      throw new Error(`${label}[${index}] must be an object`);
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
      harnessLimits: run.harnessLimits as HarnessBenchmarkRun["harnessLimits"],
      id: optionalString(run.id, `${label}[${index}].id`),
      lowConfidenceThreshold:
        typeof run.lowConfidenceThreshold === "number"
          ? run.lowConfidenceThreshold
          : undefined,
      messages: parseMessages(run.messages, `${label}[${index}].messages`),
      model: optionalString(run.model, `${label}[${index}].model`),
      responseComplianceMode: optionalString(
        run.responseComplianceMode,
        `${label}[${index}].responseComplianceMode`,
      ),
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
        harnessLimits:
          benchmarkCase.harnessLimits as HarnessBenchmarkCase["harnessLimits"],
        id: optionalString(benchmarkCase.id, `cases[${index}].id`),
        lowConfidenceThreshold:
          typeof benchmarkCase.lowConfidenceThreshold === "number"
            ? benchmarkCase.lowConfidenceThreshold
            : undefined,
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

function benchmarkMessageToHarnessMessage(
  message: HarnessBenchmarkMessage,
): HarnessMessage {
  if (message.content !== undefined) {
    return {
      content: message.content,
      role: message.role,
    };
  }

  if (message.toolCall) {
    return {
      content: [
        {
          arguments: message.toolCall.arguments ?? {},
          id: message.toolCall.id ?? `call-${message.toolCall.name}`,
          name: message.toolCall.name,
          type: "toolCall" as const,
        },
      ],
      role: message.role,
    };
  }

  return {
    content: [{ text: message.text ?? "", type: "text" as const }],
    role: message.role,
  };
}

function latestAssistantText(messages: HarnessBenchmarkMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    if (typeof message.text === "string") return message.text;
  }
  return "";
}

function isHarnessBenchmarkIssueCode(
  code: string,
): code is HarnessBenchmarkIssueCode {
  return HARNESS_BENCHMARK_ISSUE_CODES.has(code);
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

      if (run.messages.length === 0) {
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
        latestAssistantText(run.messages);
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
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function transcriptText(
  run: HarnessBenchmarkRun,
  assistantText: string,
): string {
  const parts = [assistantText];
  for (const message of run.messages) {
    parts.push(message.role);
    if (message.text) parts.push(message.text);
    if (message.toolCall) {
      parts.push(message.toolCall.name);
      parts.push(stringifyUnknown(message.toolCall.arguments));
    }
    if (message.content !== undefined) {
      parts.push(stringifyUnknown(message.content));
    }
  }
  return parts.join("\n");
}

function toolCallArgumentsText(toolCall: HarnessBenchmarkToolCall): string {
  return stringifyUnknown(toolCall.arguments ?? {});
}

function runHasRequiredToolCall(
  run: HarnessBenchmarkRun,
  check: HarnessBenchmarkToolCallCheck,
): boolean {
  return run.messages.some((message) => {
    if (!message.toolCall) return false;
    if (message.toolCall.name !== check.name) return false;
    const argumentText = toolCallArgumentsText(message.toolCall);
    return (check.argumentIncludes ?? []).every((text) =>
      argumentText.includes(text),
    );
  });
}

function runHasForbiddenToolCall(
  run: HarnessBenchmarkRun,
  check: HarnessBenchmarkForbiddenToolCallCheck,
): boolean {
  return run.messages.some((message) => {
    if (!message.toolCall) return false;
    if (check.name !== undefined && message.toolCall.name !== check.name) {
      return false;
    }
    const argumentText = toolCallArgumentsText(message.toolCall);
    return (check.argumentIncludes ?? []).every((text) =>
      argumentText.includes(text),
    );
  });
}

function evaluatePackageContract(params: {
  contract?: HarnessBenchmarkPackageContract;
  run: HarnessBenchmarkRun;
  assistantText: string;
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

  const transcript = transcriptText(params.run, params.assistantText);
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
    if (!runHasRequiredToolCall(params.run, requiredToolCall)) {
      issues.push({
        code: "package_run_missing_required_tool_call",
        message: `candidate transcript did not call required package tool: ${requiredToolCall.name}`,
        toolName: requiredToolCall.name,
      });
    }
  }
  for (const forbiddenToolCall of contract.forbiddenToolCalls ?? []) {
    if (runHasForbiddenToolCall(params.run, forbiddenToolCall)) {
      issues.push({
        code: "package_run_used_forbidden_tool_call",
        message: `candidate transcript used forbidden package tool: ${forbiddenToolCall.name ?? "any matching tool"}`,
        toolName: forbiddenToolCall.name,
      });
    }
  }

  return issues;
}

function multisetDifference(
  left: HarnessBenchmarkIssueCode[],
  right: HarnessBenchmarkIssueCode[],
): HarnessBenchmarkIssueCode[] {
  const remaining = new Map<HarnessBenchmarkIssueCode, number>();
  for (const code of right) {
    remaining.set(code, (remaining.get(code) ?? 0) + 1);
  }

  const difference: HarnessBenchmarkIssueCode[] = [];
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
      case "package_run_missing_required_tool_call":
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

export function evaluateHarnessBenchmark(
  suite: HarnessBenchmarkSuite,
  options: HarnessBenchmarkOptions = {},
): HarnessBenchmarkReport {
  const parsedSuite = parseHarnessBenchmarkSuite(suite);
  const results: HarnessBenchmarkRunResult[] = [];

  for (const benchmarkCase of parsedSuite.cases) {
    for (const [runIndex, run] of benchmarkCase.runs.entries()) {
      const messages = run.messages.map(benchmarkMessageToHarnessMessage);
      const assistantText =
        run.assistantText ??
        benchmarkCase.assistantText ??
        latestAssistantText(run.messages);
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
        assistantText,
        contract: benchmarkCase.packageContract,
        run,
      });
      const packageScore = packageDivergenceScore(packageIssues);
      const score = divergenceScore({
        expectedIssueDistance,
        issues,
        metrics,
        packageDivergenceScore: packageScore,
      });

      results.push({
        blockingIssueCount: issues.filter((issue) => issue.block).length,
        caseId: benchmarkCase.id,
        caseName: benchmarkCase.name,
        complianceScore: Math.max(0, 100 - score),
        divergenceScore: score,
        expectedIssueCodes,
        expectedIssueDistance,
        issueCodes,
        issues,
        metrics,
        missingExpectedIssueCodes,
        model: run.model ?? DEFAULT_MODEL_NAME,
        packageDivergenceScore: packageScore,
        packageIssues,
        runId: run.id ?? `${benchmarkCase.id ?? "case"}-${runIndex + 1}`,
        unexpectedIssueCodes,
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
    caseCount: parsedSuite.cases.length,
    modelSummaries: summarizeModels(results),
    results,
    runCount: results.length,
    suiteName: parsedSuite.name ?? "Khala harness benchmark",
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
    "| Case | Run | Model | Compliance | Divergence | Harness Issues | Package Divergence | Expected Distance |",
    "| --- | --- | --- | ---: | ---: | --- | ---: | ---: |",
  );

  for (const result of report.results) {
    lines.push(
      `| ${markdownCell(result.caseName)} | ${markdownCell(
        result.runId,
      )} | ${markdownCell(result.model)} | ${result.complianceScore} | ${result.divergenceScore} | ${markdownCell(
        issueCodeText(result.issueCodes),
      )} | ${result.packageDivergenceScore} | ${result.expectedIssueDistance} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}
