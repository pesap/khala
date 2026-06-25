#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  evaluateHarnessBenchmark,
  formatHarnessBenchmarkMarkdown,
  parseHarnessBenchmarkSuite,
} from "../khala/harness-benchmark.ts";

interface CliArgs {
  json: boolean;
  suitePath: string;
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/harness-benchmark.ts [--json] <suite.json>",
    "",
    "Scores candidate model transcripts against the Khala harness.",
  ].join("\n");
}

function parseArgs(args: string[]): CliArgs {
  let json = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      paths.push(arg);
    }
  }

  if (paths.length !== 1) {
    throw new Error(usage());
  }

  return { json, suitePath: paths[0] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(await readFile(args.suitePath, "utf8")) as unknown;
  const suite = parseHarnessBenchmarkSuite(payload);
  const report = evaluateHarnessBenchmark(suite);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatHarnessBenchmarkMarkdown(report));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
