#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateHarnessBenchmark,
  formatHarnessBenchmarkMarkdown,
  parseHarnessBenchmarkSuite,
  preflightHarnessBenchmarkSuite,
  type HarnessBenchmarkReport,
  type HarnessBenchmarkPreflightReport,
  type HarnessBenchmarkSuite,
} from "../khala/harness-benchmark.ts";
import { stableKhalaJsonStringify } from "../khala/harness-events.ts";

export interface HarnessBenchmarkMaxDivergenceTag {
  tag: string;
  maxDivergence: number;
}

export interface CliArgs {
  baselinePath?: string;
  cases: string[];
  failOnDivergence: boolean;
  failOnBlockingRegression: boolean;
  json: boolean;
  maxDivergence?: number;
  maxDivergenceTags: HarnessBenchmarkMaxDivergenceTag[];
  models: string[];
  mustPassTags: string[];
  outputPath?: string;
  preflight: boolean;
  suitePath: string;
  writeBaselinePath?: string;
}

export interface HarnessBenchmarkCiFailure {
  code:
    | "blocking_regression"
    | "must_pass_tag_failed"
    | "max_divergence_exceeded";
  message: string;
  caseName?: string;
  runId?: string;
  model?: string;
  tag?: string;
  current?: number;
  baseline?: number;
  max?: number;
  min?: number;
}

class CliExit extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/harness-benchmark.ts [options] <suite.json>",
    "",
    "Scores candidate model transcripts against the Khala harness.",
    "",
    "Options:",
    "  --case <id[,id...]>       Score only selected case id(s).",
    "  --model <id[,id...]>      Score only selected run model(s).",
    "  --preflight              Validate suite shape and package contracts only.",
    "  --fail-on-divergence     Exit non-zero when any scored run diverges.",
    "  --baseline <path>        Compare against a saved JSON benchmark report.",
    "  --write-baseline <path>  Write the current JSON benchmark report.",
    "  --fail-on-blocking-regression",
    "                           Exit non-zero on a new blocking issue.",
    "  --must-pass-tag <tag>    Require tagged cases to match expected issues.",
    "  --max-divergence <n>     Exit non-zero when any run exceeds divergence n.",
    "  --max-divergence-tag <tag=n>",
    "                           Apply a divergence ceiling to a case tag.",
    "  --out <path>             Write the report to a file as well as stdout.",
    "  --json                   Emit machine-readable JSON.",
    "  -h, --help               Show help.",
  ].join("\n");
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} requires a finite number`);
  }
  return parsed;
}

function parseMaxDivergenceTag(
  value: string,
): HarnessBenchmarkMaxDivergenceTag {
  const separator = value.lastIndexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--max-divergence-tag requires <tag=n>");
  }
  return {
    maxDivergence: parseNumber(
      value.slice(separator + 1),
      "--max-divergence-tag",
    ),
    tag: value.slice(0, separator),
  };
}

export function parseHarnessBenchmarkCliArgs(args: string[]): CliArgs {
  const parsed: Omit<CliArgs, "suitePath"> = {
    cases: [],
    failOnDivergence: false,
    failOnBlockingRegression: false,
    json: false,
    maxDivergenceTags: [],
    models: [],
    mustPassTags: [],
    preflight: false,
  };
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--preflight") {
      parsed.preflight = true;
      continue;
    }
    if (arg === "--fail-on-divergence") {
      parsed.failOnDivergence = true;
      continue;
    }
    if (arg === "--fail-on-blocking-regression") {
      parsed.failOnBlockingRegression = true;
      continue;
    }
    if (arg === "--baseline") {
      const baselinePath = args[++index];
      if (!baselinePath) throw new Error("--baseline requires a path");
      parsed.baselinePath = baselinePath;
      continue;
    }
    if (arg === "--write-baseline") {
      const baselinePath = args[++index];
      if (!baselinePath) throw new Error("--write-baseline requires a path");
      parsed.writeBaselinePath = baselinePath;
      continue;
    }
    if (arg === "--must-pass-tag") {
      parsed.mustPassTags.push(...parseList(args[++index] ?? ""));
      continue;
    }
    if (arg === "--max-divergence") {
      parsed.maxDivergence = parseNumber(
        args[++index] ?? "",
        "--max-divergence",
      );
      continue;
    }
    if (arg === "--max-divergence-tag") {
      parsed.maxDivergenceTags.push(parseMaxDivergenceTag(args[++index] ?? ""));
      continue;
    }
    if (arg === "--case") {
      parsed.cases.push(...parseList(args[++index] ?? ""));
      continue;
    }
    if (arg === "--model") {
      parsed.models.push(...parseList(args[++index] ?? ""));
      continue;
    }
    if (arg === "--out") {
      const outputPath = args[++index];
      if (!outputPath) throw new Error("--out requires a path");
      parsed.outputPath = outputPath;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new CliExit(usage(), 0);
    }
    paths.push(arg);
  }

  if (paths.length !== 1) {
    throw new Error(usage());
  }

  return { ...parsed, suitePath: paths[0] };
}

function resultKey(result: {
  caseId?: string;
  caseName: string;
  runId: string;
  model: string;
}): string {
  return [result.caseId ?? result.caseName, result.runId, result.model].join(
    "\0",
  );
}

function parseBenchmarkReport(
  value: unknown,
  label: string,
): HarnessBenchmarkReport {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as HarnessBenchmarkReport).results)
  ) {
    throw new Error(`${label} must be a harness benchmark JSON report`);
  }
  return value as HarnessBenchmarkReport;
}

function issueExpectationFailed(
  result: HarnessBenchmarkReport["results"][number],
): boolean {
  return (
    result.expectedIssueDistance > 0 || result.expectedPackageIssueDistance > 0
  );
}

function hasUnexpectedBlockingIssue(
  result: HarnessBenchmarkReport["results"][number],
): boolean {
  return result.issues.some(
    (issue) => issue.block && result.unexpectedIssueCodes.includes(issue.code),
  );
}

export function evaluateHarnessBenchmarkCiFailures(params: {
  report: HarnessBenchmarkReport;
  args: Pick<
    CliArgs,
    | "failOnBlockingRegression"
    | "maxDivergence"
    | "maxDivergenceTags"
    | "mustPassTags"
  >;
  baseline?: HarnessBenchmarkReport;
}): HarnessBenchmarkCiFailure[] {
  const failures: HarnessBenchmarkCiFailure[] = [];
  const baselineResults = new Map(
    (params.baseline?.results ?? []).map((result) => [
      resultKey(result),
      result,
    ]),
  );

  if (params.args.failOnBlockingRegression) {
    for (const result of params.report.results) {
      const baseline = baselineResults.get(resultKey(result));
      const regressed = baseline
        ? result.blockingIssueCount > baseline.blockingIssueCount
        : hasUnexpectedBlockingIssue(result);
      if (!regressed) continue;
      failures.push({
        baseline: baseline?.blockingIssueCount ?? 0,
        caseName: result.caseName,
        code: "blocking_regression",
        current: result.blockingIssueCount,
        message: `blocking issue regression in ${result.caseName}/${result.runId}: ${baseline?.blockingIssueCount ?? 0} -> ${result.blockingIssueCount}`,
        model: result.model,
        runId: result.runId,
      });
    }
  }

  for (const tag of params.args.mustPassTags) {
    for (const result of params.report.results) {
      if (!result.tags.includes(tag)) continue;
      if (
        !issueExpectationFailed(result) &&
        !hasUnexpectedBlockingIssue(result)
      ) {
        continue;
      }
      failures.push({
        caseName: result.caseName,
        code: "must_pass_tag_failed",
        current:
          result.expectedIssueDistance + result.expectedPackageIssueDistance,
        message: `must-pass tag '${tag}' failed for ${result.caseName}/${result.runId}`,
        model: result.model,
        runId: result.runId,
        tag,
      });
    }

    for (const summary of params.report.caseSummaries) {
      if (!summary.tags.includes(tag)) continue;
      if (summary.expectedBestRunMatched !== false) continue;
      failures.push({
        caseName: summary.caseName,
        code: "must_pass_tag_failed",
        message: `must-pass tag '${tag}' expected ${summary.caseName}/${summary.expectedBestRunId} to rank first, but ${summary.actualBestRunId} ranked first`,
        runId: summary.expectedBestRunId,
        tag,
      });
    }
    for (const summary of params.report.caseSummaries) {
      if (!summary.tags.includes(tag)) continue;
      if (summary.expectedBestRunMatched === false) continue;
      if (summary.expectedBestMarginMatched !== false) continue;
      failures.push({
        caseName: summary.caseName,
        code: "must_pass_tag_failed",
        current: summary.bestRunDivergenceMargin,
        min: summary.expectedBestMinDivergenceMargin,
        message: `must-pass tag '${tag}' expected ${summary.caseName}/${summary.expectedBestRunId} to beat the next run by divergence margin ${summary.expectedBestMinDivergenceMargin}, but margin was ${summary.bestRunDivergenceMargin}`,
        runId: summary.expectedBestRunId,
        tag,
      });
    }
  }

  if (params.args.maxDivergence !== undefined) {
    for (const result of params.report.results) {
      if (result.divergenceScore <= params.args.maxDivergence) continue;
      failures.push({
        caseName: result.caseName,
        code: "max_divergence_exceeded",
        current: result.divergenceScore,
        max: params.args.maxDivergence,
        message: `divergence ${result.divergenceScore} exceeds ${params.args.maxDivergence} for ${result.caseName}/${result.runId}`,
        model: result.model,
        runId: result.runId,
      });
    }
  }

  for (const threshold of params.args.maxDivergenceTags) {
    for (const result of params.report.results) {
      if (!result.tags.includes(threshold.tag)) continue;
      if (result.divergenceScore <= threshold.maxDivergence) continue;
      failures.push({
        caseName: result.caseName,
        code: "max_divergence_exceeded",
        current: result.divergenceScore,
        max: threshold.maxDivergence,
        message: `divergence ${result.divergenceScore} exceeds ${threshold.maxDivergence} for tag '${threshold.tag}' in ${result.caseName}/${result.runId}`,
        model: result.model,
        runId: result.runId,
        tag: threshold.tag,
      });
    }
  }

  return failures;
}

function filterSuite(
  suite: HarnessBenchmarkSuite,
  args: Pick<CliArgs, "cases" | "models">,
): HarnessBenchmarkSuite {
  const caseFilter = new Set(args.cases);
  const modelFilter = new Set(args.models);
  const selectedCases =
    caseFilter.size === 0
      ? suite.cases
      : suite.cases.filter(
          (benchmarkCase) =>
            benchmarkCase.id !== undefined && caseFilter.has(benchmarkCase.id),
        );

  if (caseFilter.size > 0) {
    const found = new Set(
      selectedCases
        .map((benchmarkCase) => benchmarkCase.id)
        .filter((id): id is string => id !== undefined),
    );
    const missing = [...caseFilter].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`unknown --case id(s): ${missing.join(", ")}`);
    }
  }

  const cases = selectedCases.map((benchmarkCase) => {
    const runs =
      modelFilter.size === 0
        ? benchmarkCase.runs
        : benchmarkCase.runs.filter((run) =>
            modelFilter.has(run.model ?? "unknown-model"),
          );
    const expectedBestRunWasFilteredOut =
      modelFilter.size > 0 &&
      benchmarkCase.expectedBestRunId !== undefined &&
      !runs.some(
        (run, runIndex) =>
          (run.id ?? `${benchmarkCase.id ?? "case"}-${runIndex + 1}`) ===
          benchmarkCase.expectedBestRunId,
      );

    return {
      ...benchmarkCase,
      expectedBestRunId: expectedBestRunWasFilteredOut
        ? undefined
        : benchmarkCase.expectedBestRunId,
      expectedBestMinDivergenceMargin: expectedBestRunWasFilteredOut
        ? undefined
        : benchmarkCase.expectedBestMinDivergenceMargin,
      runs,
    };
  });

  const emptyCases = cases.filter(
    (benchmarkCase) => benchmarkCase.runs.length === 0,
  );
  if (emptyCases.length > 0) {
    throw new Error(
      `selected filters left case(s) without runs: ${emptyCases
        .map((benchmarkCase) => benchmarkCase.id ?? benchmarkCase.name)
        .join(", ")}`,
    );
  }

  return { ...suite, cases };
}

function formatPreflightMarkdown(
  report: HarnessBenchmarkPreflightReport,
): string {
  const lines = [
    "# Khala harness preflight",
    "",
    `Status: ${report.ok ? "ok" : "failed"}`,
    `Cases: ${report.caseCount}  Runs: ${report.runCount}`,
    `Errors: ${report.errorCount}  Warnings: ${report.warningCount}`,
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("No issues found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Severity | Code | Case | Run | Message |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const issue of report.issues) {
    lines.push(
      `| ${issue.severity} | ${issue.code} | ${issue.caseId ?? issue.caseName ?? ""} | ${issue.runId ?? ""} | ${issue.message.replaceAll("|", "\\|")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeOutput(outputPath: string, output: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(tempPath, output, "utf8");
  await rename(tempPath, outputPath);
}

async function main(): Promise<void> {
  const args = parseHarnessBenchmarkCliArgs(process.argv.slice(2));
  const payload = JSON.parse(await readFile(args.suitePath, "utf8")) as unknown;
  const suite = filterSuite(parseHarnessBenchmarkSuite(payload), args);
  const preflightReport = preflightHarnessBenchmarkSuite(suite);

  if (args.preflight) {
    const output = args.json
      ? `${JSON.stringify(preflightReport, null, 2)}\n`
      : formatPreflightMarkdown(preflightReport);
    if (args.outputPath) await writeOutput(args.outputPath, output);
    process.stdout.write(output);
    if (!preflightReport.ok) process.exitCode = 2;
    return;
  }

  if (!preflightReport.ok) {
    process.stderr.write(formatPreflightMarkdown(preflightReport));
    process.exitCode = 2;
    return;
  }

  const report = evaluateHarnessBenchmark(suite);
  const baseline =
    args.baselinePath === undefined
      ? undefined
      : parseBenchmarkReport(
          JSON.parse(await readFile(args.baselinePath, "utf8")) as unknown,
          args.baselinePath,
        );
  const ciFailures = evaluateHarnessBenchmarkCiFailures({
    args,
    baseline,
    report,
  });
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatHarnessBenchmarkMarkdown(report);
  if (args.outputPath) await writeOutput(args.outputPath, output);
  if (args.writeBaselinePath) {
    await writeOutput(
      args.writeBaselinePath,
      `${stableKhalaJsonStringify(report, 2)}\n`,
    );
  }
  process.stdout.write(output);

  if (
    args.failOnDivergence &&
    report.results.some((result) => result.divergenceScore > 0)
  ) {
    process.exitCode = 2;
  }
  if (ciFailures.length > 0) {
    process.stderr.write(
      ciFailures.map((failure) => failure.message).join("\n"),
    );
    process.stderr.write("\n");
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CliExit && error.exitCode === 0) {
      process.stdout.write(`${message}\n`);
      return;
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof CliExit ? error.exitCode : 1;
  });
}
