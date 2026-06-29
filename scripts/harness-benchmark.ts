#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateHarnessBenchmark,
  formatHarnessBenchmarkMarkdown,
  parseHarnessBenchmarkSuite,
  preflightHarnessBenchmarkSuite,
  type HarnessBenchmarkPreflightReport,
  type HarnessBenchmarkSuite,
} from "../khala/harness-benchmark.ts";

interface CliArgs {
  cases: string[];
  failOnDivergence: boolean;
  json: boolean;
  models: string[];
  outputPath?: string;
  preflight: boolean;
  suitePath: string;
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

function parseArgs(args: string[]): CliArgs {
  const parsed: Omit<CliArgs, "suitePath"> = {
    cases: [],
    failOnDivergence: false,
    json: false,
    models: [],
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

  const cases = selectedCases.map((benchmarkCase) => ({
    ...benchmarkCase,
    runs:
      modelFilter.size === 0
        ? benchmarkCase.runs
        : benchmarkCase.runs.filter((run) =>
            modelFilter.has(run.model ?? "unknown-model"),
          ),
  }));

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
  const args = parseArgs(process.argv.slice(2));
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
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatHarnessBenchmarkMarkdown(report);
  if (args.outputPath) await writeOutput(args.outputPath, output);
  process.stdout.write(output);

  if (
    args.failOnDivergence &&
    report.results.some((result) => result.divergenceScore > 0)
  ) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliExit && error.exitCode === 0) {
    process.stdout.write(`${message}\n`);
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof CliExit ? error.exitCode : 1;
});
