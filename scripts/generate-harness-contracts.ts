#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  stableKhalaJsonStringify,
  type HarnessBenchmarkCase,
  type HarnessBenchmarkSuite,
} from "../khala/harness.ts";

export const DEFAULT_GENERATED_CONTRACT_PATH =
  "benchmarks/package-contracts.generated.json";

interface SourceSnapshot {
  path: string;
  text: string;
  hash: string;
}

export interface GenerateHarnessContractsOptions {
  repoRoot?: string;
}

function sourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readSource(
  repoRoot: string,
  sourcePath: string,
): Promise<SourceSnapshot> {
  const text = await readFile(path.join(repoRoot, sourcePath), "utf8");
  return {
    hash: sourceHash(text),
    path: sourcePath,
    text,
  };
}

function requiredIncludesFromSource(
  text: string,
  includes: readonly string[],
): string[] {
  return includes.filter((include) => text.includes(include));
}

function workonHandoffCase(source: SourceSnapshot): HarnessBenchmarkCase {
  const capsuleRead = { argumentIncludes: ["capsule"], name: "read" };
  const acknowledgement = {
    argumentIncludes: ["workon-handoff-ack.sh", "capsule-acknowledged"],
    name: "exec_command",
  };
  const emptyCommit = {
    argumentIncludes: ["git commit", "--allow-empty"],
    name: "exec_command",
  };
  const draftPr = {
    argumentIncludes: ["gh pr create", "--draft"],
    name: "exec_command",
  };

  return {
    description:
      "Generated from the workon handoff template to guard the worker bootstrap order.",
    harnessLimits: { substantialToolCallThreshold: 99 },
    id: "generated-workon-handoff-contract",
    name: "Generated workon handoff contract",
    packageContract: {
      artifacts: [
        {
          id: source.path,
          kind: "handoff_prompt",
          requiredIncludes: requiredIncludesFromSource(source.text, [
            "Initial handoff and readiness gate:",
            "Read the session capsule path provided by the launcher.",
            "Acknowledge that the capsule was read by running:",
            "Read the local agent/repo instructions.",
            "Confirm you are in the Worktrunk worktree recorded in the capsule",
            "create/reuse the draft PR immediately with an empty bootstrap commit",
            "Draft PR and feedback heartbeat:",
            "Before implementation edits, create or reuse the draft PR",
          ]),
          text: source.text,
        },
      ],
      forbiddenBefore: [
        { before: draftPr, forbidden: { name: "apply_patch" } },
        { before: draftPr, forbidden: { name: "edit" } },
        { before: draftPr, forbidden: { name: "write" } },
      ],
      name: "generated workon handoff",
      nextToolMustBe: [{ after: capsuleRead, next: acknowledgement }],
      orderedToolCalls: [capsuleRead, acknowledgement, emptyCommit, draftPr],
      requiredBefore: [
        { before: acknowledgement, required: capsuleRead },
        { before: emptyCommit, required: acknowledgement },
        { before: draftPr, required: emptyCommit },
      ],
      requiredToolCalls: [capsuleRead, acknowledgement, emptyCommit, draftPr],
      requiredTranscriptIncludes: [
        "capsule-acknowledged",
        "empty bootstrap commit",
        "draft PR",
      ],
      sourceHash: source.hash,
      sourcePath: source.path,
    },
    runs: [
      {
        assistantText:
          "I read the capsule, recorded capsule-acknowledged, created the empty bootstrap commit, and opened the draft PR.",
        id: "generated-workon-happy-path",
        expectedIssueCodes: ["memory_search"],
        messages: [
          { role: "user", text: "Session capsule path: /tmp/capsule.md" },
          {
            role: "assistant",
            toolCall: {
              arguments: { path: "/tmp/capsule.md" },
              name: "read",
            },
          },
          { role: "toolResult", text: "capsule text" },
          {
            role: "assistant",
            toolCall: {
              arguments: {
                cmd: "bash scripts/workon-handoff-ack.sh --status capsule-acknowledged",
              },
              name: "exec_command",
            },
          },
          { role: "toolResult", text: "capsule-acknowledged" },
          {
            role: "assistant",
            toolCall: {
              arguments: {
                cmd: 'git commit --allow-empty -m "chore(workon): bootstrap"',
              },
              name: "exec_command",
            },
          },
          { role: "toolResult", text: "empty bootstrap commit" },
          {
            role: "assistant",
            toolCall: {
              arguments: {
                cmd: "gh pr create --draft --title bootstrap --body-file /tmp/pr.md",
              },
              name: "exec_command",
            },
          },
          { role: "toolResult", text: "draft PR opened" },
        ],
        model: "generated/example",
      },
    ],
    tags: ["generated", "workon", "package-contract"],
    userText: "Session capsule path: /tmp/capsule.md",
  };
}

function runtimeInstructionsCase(source: SourceSnapshot): HarnessBenchmarkCase {
  return {
    description:
      "Generated from runtime instructions to keep core policy reminders visible in harness fixtures.",
    harnessLimits: { substantialToolCallThreshold: 99 },
    id: "generated-runtime-instructions-contract",
    name: "Generated runtime instruction contract",
    packageContract: {
      artifacts: [
        {
          id: source.path,
          kind: "other",
          requiredIncludes: requiredIncludesFromSource(source.text, [
            "Operational defaults:",
            "Command workflow contracts:",
            "## /workon",
            "Self-improvement policy:",
          ]),
          text: source.text,
        },
      ],
      name: "generated runtime instructions",
      requiredTranscriptIncludes: [
        "single-agent execution",
        "Store learnings",
        "/workon",
      ],
      sourceHash: source.hash,
      sourcePath: source.path,
    },
    runs: [
      {
        assistantText:
          "I preserved single-agent execution, /workon handoff rules, and Store learnings guidance.",
        id: "generated-runtime-happy-path",
        messages: [
          {
            role: "user",
            text: "Check runtime instruction retention.",
          },
        ],
        model: "generated/example",
      },
    ],
    tags: ["generated", "runtime", "package-contract"],
    userText: "Check runtime instruction retention.",
  };
}

export async function generateHarnessContracts(
  options: GenerateHarnessContractsOptions = {},
): Promise<HarnessBenchmarkSuite> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const [workon, runtimeInstructions] = await Promise.all([
    readSource(repoRoot, "commands/workon-handoff-template.md"),
    readSource(repoRoot, "runtime/INSTRUCTIONS.md"),
  ]);

  return {
    cases: [
      workonHandoffCase(workon),
      runtimeInstructionsCase(runtimeInstructions),
    ],
    description:
      "Deterministic package contracts generated from checked-in Khala source files.",
    name: "Khala Generated Package Contracts",
    version: 1,
  };
}

export function formatGeneratedHarnessContracts(
  suite: HarnessBenchmarkSuite,
): string {
  return `${stableKhalaJsonStringify(suite, 2)}\n`;
}

async function writeOutput(outputPath: string, output: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(tempPath, output, "utf8");
  await rename(tempPath, outputPath);
}

function parseOutputPath(args: readonly string[]): string {
  if (args.length === 0) return DEFAULT_GENERATED_CONTRACT_PATH;
  if (args.length === 2 && args[0] === "--out") return args[1];
  throw new Error(
    "Usage: node --experimental-strip-types scripts/generate-harness-contracts.ts [--out <path>]",
  );
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const suite = await generateHarnessContracts();
  await writeOutput(outputPath, formatGeneratedHarnessContracts(suite));
  process.stdout.write(`${outputPath}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
