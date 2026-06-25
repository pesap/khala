#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  evaluateHarnessBenchmark,
  formatHarnessBenchmarkMarkdown,
  parseHarnessBenchmarkSuite,
  type HarnessBenchmarkCase,
  type HarnessBenchmarkMessage,
  type HarnessBenchmarkPackageArtifact,
  type HarnessBenchmarkPackageContract,
  type HarnessBenchmarkRun,
  type HarnessBenchmarkSuite,
} from "../khala/harness-benchmark.ts";

const execFileAsync = promisify(execFile);

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

type PromptMode = "raw" | "packaged";
type ToolMode = "none" | "read,bash";

export interface HarnessPiDriftModelTarget {
  id: string;
  thinking: string;
}

export interface HarnessPiDriftCliArgs {
  cases: string[];
  json: boolean;
  keepSandbox: boolean;
  limit?: number;
  modelEntries: string[];
  modelFiles: string[];
  outputPath?: string;
  promptModes: PromptMode[];
  suitePath: string;
  thinking: string;
  timeoutMs: number;
  tools: ToolMode;
}

interface MaterializedCase {
  benchmarkCase: HarnessBenchmarkCase;
  prompt: string;
  sandboxDir: string;
}

interface PiJsonContentPart {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

interface PiJsonMessage {
  role?: string;
  content?: PiJsonContentPart[];
  toolCallId?: string;
  toolName?: string;
}

interface PiAgentEndEvent {
  type?: string;
  messages?: PiJsonMessage[];
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/harness-pi-drift.ts [options] <suite.json>",
    "",
    "Runs benchmark cases through `pi -p --mode json`, converts the live transcript",
    "to benchmark runs, and reports package/harness drift.",
    "",
    "Options:",
    "  --model <id[,id...]>       Model(s) to run. Required unless --model-file is provided.",
    "                             Append :thinking to a model for per-model thinking.",
    "  --model-file <path>        Newline, JSON string array, or JSON object array model list.",
    "  --thinking <level>         Default thinking level for models without a suffix. Defaults to off.",
    "  --case <id[,id...]>        Case id(s) to run. Defaults to every suite case.",
    "  --limit <n>                Limit selected cases after filtering.",
    "  --prompt-mode <mode>       raw, packaged, or both. Defaults to packaged.",
    "  --timeout-ms <n>           Per Pi run timeout. Defaults to 60000.",
    "  --tools <mode>             none or read,bash. Defaults to read,bash.",
    "  --out <path>               Write the generated live suite JSON.",
    "  --json                     Emit machine-readable report JSON.",
    "  --keep-sandbox             Do not delete temporary sandbox directories.",
  ].join("\n");
}

function parseHarnessPiDriftList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePromptModes(value: string): PromptMode[] {
  const values =
    value === "both" ? ["raw", "packaged"] : parseHarnessPiDriftList(value);
  for (const mode of values) {
    if (mode !== "raw" && mode !== "packaged") {
      throw new Error(`invalid --prompt-mode value: ${mode}`);
    }
  }
  return [...new Set(values)] as PromptMode[];
}

function assertThinkingLevel(value: string): string {
  if (!THINKING_LEVELS.has(value)) {
    throw new Error(
      `thinking level must be one of: ${[...THINKING_LEVELS].join(", ")}`,
    );
  }
  return value;
}

function parseHarnessPiDriftModelEntry(
  value: string,
  defaultThinking: string,
): HarnessPiDriftModelTarget {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("model entries must be non-empty");
  }
  const delimiterIndex = trimmed.lastIndexOf(":");
  if (delimiterIndex > 0) {
    const suffix = trimmed.slice(delimiterIndex + 1);
    if (THINKING_LEVELS.has(suffix)) {
      const id = trimmed.slice(0, delimiterIndex).trim();
      if (!id) {
        throw new Error("model id must be non-empty");
      }
      return { id, thinking: suffix };
    }
  }
  return { id: trimmed, thinking: defaultThinking };
}

function isModelObject(
  value: unknown,
): value is { model?: unknown; id?: unknown; thinking?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHarnessPiDriftModelFile(
  content: string,
  defaultThinking: string,
): HarnessPiDriftModelTarget[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item, index) => {
      if (typeof item === "string") {
        return parseHarnessPiDriftModelEntry(item, defaultThinking);
      }
      if (isModelObject(item)) {
        const model = item.model ?? item.id;
        if (typeof model !== "string" || model.trim() === "") {
          throw new Error(
            `model-file item ${index + 1} must include a non-empty model or id`,
          );
        }
        const thinking =
          item.thinking === undefined ? defaultThinking : String(item.thinking);
        assertThinkingLevel(thinking);
        return { id: model.trim(), thinking };
      }
      throw new Error(
        `model-file item ${index + 1} must be a string or object`,
      );
    });
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => parseHarnessPiDriftModelEntry(line, defaultThinking));
}

export function parseHarnessPiDriftModelTargets(
  entries: string[],
  defaultThinking: string,
): HarnessPiDriftModelTarget[] {
  const targets = entries.map((entry) =>
    parseHarnessPiDriftModelEntry(entry, defaultThinking),
  );
  const unique = new Map<string, HarnessPiDriftModelTarget>();
  for (const target of targets) {
    unique.set(`${target.id}\0${target.thinking}`, target);
  }
  return [...unique.values()];
}

export function parseHarnessPiDriftArgs(args: string[]): HarnessPiDriftCliArgs {
  const parsed: HarnessPiDriftCliArgs = {
    cases: [],
    json: false,
    keepSandbox: false,
    modelEntries: [],
    modelFiles: [],
    promptModes: ["packaged"],
    suitePath: "",
    thinking: "off",
    timeoutMs: 60_000,
    tools: "read,bash",
  };
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--keep-sandbox") {
      parsed.keepSandbox = true;
      continue;
    }
    if (arg === "--model") {
      parsed.modelEntries.push(...parseHarnessPiDriftList(args[++index] ?? ""));
      continue;
    }
    if (arg === "--model-file") {
      const modelFile = args[++index];
      if (!modelFile) {
        throw new Error("--model-file requires a path");
      }
      parsed.modelFiles.push(modelFile);
      continue;
    }
    if (arg === "--thinking") {
      parsed.thinking = assertThinkingLevel(args[++index] ?? "");
      continue;
    }
    if (arg === "--case") {
      parsed.cases.push(...parseHarnessPiDriftList(args[++index] ?? ""));
      continue;
    }
    if (arg === "--limit") {
      const limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      parsed.limit = limit;
      continue;
    }
    if (arg === "--prompt-mode") {
      parsed.promptModes = parsePromptModes(args[++index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      const timeoutMs = Number(args[++index]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
        throw new Error("--timeout-ms must be an integer >= 1000");
      }
      parsed.timeoutMs = timeoutMs;
      continue;
    }
    if (arg === "--tools") {
      const tools = args[++index];
      if (tools !== "none" && tools !== "read,bash") {
        throw new Error("--tools must be one of: none, read,bash");
      }
      parsed.tools = tools;
      continue;
    }
    if (arg === "--out") {
      parsed.outputPath = args[++index];
      continue;
    }
    paths.push(arg);
  }

  if (paths.length !== 1) {
    throw new Error(usage());
  }
  parsed.suitePath = paths[0];
  if (parsed.modelEntries.length === 0 && parsed.modelFiles.length === 0) {
    throw new Error(
      "--model or --model-file is required for live Pi drift runs",
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function replaceAll(input: string, replacements: Map<string, string>): string {
  let output = input;
  for (const [from, to] of replacements) {
    output = output.split(from).join(to);
  }
  return output;
}

function artifactFileName(artifact: HarnessBenchmarkPackageArtifact): string {
  if (artifact.kind === "capsule") return "capsule.md";
  if (artifact.kind === "ready_packet") return "ready-packet.md";
  if (artifact.kind === "handoff_ledger") return "handoff-ledger.json";
  return `${slug(artifact.id ?? artifact.kind ?? "artifact") || "artifact"}.md`;
}

function materializedArtifactsText(
  artifactPaths: Array<{
    artifact: HarnessBenchmarkPackageArtifact;
    path: string;
  }>,
): string {
  if (artifactPaths.length === 0) return "";
  return [
    "",
    "Sandbox package artifacts:",
    ...artifactPaths.map(
      ({ artifact, path: artifactPath }) =>
        `- ${artifact.id ?? artifact.kind ?? "artifact"} (${artifact.kind ?? "other"}): ${artifactPath}`,
    ),
  ].join("\n");
}

function capsulePath(
  artifactPaths: Array<{
    artifact: HarnessBenchmarkPackageArtifact;
    path: string;
  }>,
): string | undefined {
  return artifactPaths.find(({ artifact }) => artifact.kind === "capsule")
    ?.path;
}

function acknowledgementCommand(
  artifactPaths: Array<{
    artifact: HarnessBenchmarkPackageArtifact;
    path: string;
  }>,
): string | undefined {
  for (const { artifact } of artifactPaths) {
    const match = artifact.text.match(
      /`(bash\s+[^`]*workon-handoff-ack\.sh[^`]*)`/,
    );
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function packagedPrompt(params: {
  contract?: HarnessBenchmarkPackageContract;
  artifactPaths: Array<{
    artifact: HarnessBenchmarkPackageArtifact;
    path: string;
  }>;
  prompt: string;
}): string {
  const requiredText = params.contract?.requiredTranscriptIncludes ?? [];
  const requiredTools = params.contract?.requiredToolCalls ?? [];
  const forbiddenTools = params.contract?.forbiddenToolCalls ?? [];
  const capsule = capsulePath(params.artifactPaths);
  const ackCommand = acknowledgementCommand(params.artifactPaths);
  return [
    "You are running inside an instruction-following sandbox.",
    capsule ? "First-turn required actions:" : "",
    capsule ? `1. Read this file with the read tool: ${capsule}` : "",
    ackCommand
      ? `2. Run this command with the bash tool exactly after reading the file: ${ackCommand}`
      : "",
    requiredText.length > 0
      ? `3. Final answer must include: ${requiredText.join("; ")}`
      : "",
    "Use only the artifact paths and package instructions below.",
    "If an artifact tells you to read a file, use the read tool on that file.",
    "If an artifact tells you to acknowledge by running a script, use the bash tool with the exact rewritten command from that artifact.",
    "Do not edit repository files, run implementation validation, commit, push, or create PRs unless the package explicitly says implementation may begin.",
    requiredTools.length > 0 ? "Required tool evidence:" : "",
    ...requiredTools.map(
      (tool) =>
        `- ${tool.name}: arguments must include ${(tool.argumentIncludes ?? []).join(", ")}`,
    ),
    requiredText.length > 0 ? "Required final-answer evidence:" : "",
    ...requiredText.map((text) => `- ${text}`),
    forbiddenTools.length > 0 ? "Forbidden tool evidence:" : "",
    ...forbiddenTools.map(
      (tool) =>
        `- ${tool.name ?? "any tool"}${tool.argumentIncludes?.length ? ` with arguments including ${tool.argumentIncludes.join(", ")}` : ""}`,
    ),
    params.prompt,
    materializedArtifactsText(params.artifactPaths),
    "",
    "Keep the final answer short. Include only the required final-answer evidence that applies.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function materializeCase(
  benchmarkCase: HarnessBenchmarkCase,
  promptMode: PromptMode,
): Promise<MaterializedCase> {
  const sandboxDir = await mkdtemp(path.join(tmpdir(), "khala-pi-drift-"));
  const ledgerPath = path.join(sandboxDir, "handoff-ledger.json");
  const replacements = new Map([
    ["/tmp/khala/handoff-ledger.json", ledgerPath],
    ["/tmp/khala", sandboxDir],
    ["/repo", process.cwd()],
  ]);
  const artifactPaths: Array<{
    artifact: HarnessBenchmarkPackageArtifact;
    path: string;
  }> = [];
  const packageContract = benchmarkCase.packageContract
    ? ({
        ...benchmarkCase.packageContract,
        artifacts: await Promise.all(
          (benchmarkCase.packageContract.artifacts ?? []).map(
            async (artifact) => {
              const text = replaceAll(artifact.text, replacements);
              const artifactPath = path.join(
                sandboxDir,
                artifactFileName(artifact),
              );
              await mkdir(path.dirname(artifactPath), { recursive: true });
              await writeFile(artifactPath, text, "utf8");
              const materialized = { ...artifact, text };
              artifactPaths.push({
                artifact: materialized,
                path: artifactPath,
              });
              return materialized;
            },
          ),
        ),
      } satisfies HarnessBenchmarkPackageContract)
    : undefined;

  await writeFile(
    ledgerPath,
    JSON.stringify(
      {
        attempts: [],
        phases: { pi: "pi-process-started" },
        pi: { status: "pi-process-started" },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  const prompt = replaceAll(benchmarkCase.userText, replacements);
  return {
    benchmarkCase: {
      ...benchmarkCase,
      packageContract,
      runs: [],
      userText:
        promptMode === "packaged"
          ? packagedPrompt({ artifactPaths, contract: packageContract, prompt })
          : prompt,
    },
    prompt:
      promptMode === "packaged"
        ? packagedPrompt({ artifactPaths, contract: packageContract, prompt })
        : prompt,
    sandboxDir,
  };
}

function textFromContent(content: PiJsonContentPart[] | undefined): string {
  return (content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function mapToolName(name: string): string {
  return name === "bash" ? "exec_command" : name;
}

function piMessagesToBenchmarkMessages(
  messages: PiJsonMessage[],
): HarnessBenchmarkMessage[] {
  const converted: HarnessBenchmarkMessage[] = [];
  for (const message of messages) {
    const role = message.role ?? "unknown";
    if (role === "assistant") {
      const text = textFromContent(message.content);
      if (text) converted.push({ role: "assistant", text });
      for (const part of message.content ?? []) {
        if (part.type !== "toolCall" || typeof part.name !== "string") continue;
        converted.push({
          role: "assistant",
          toolCall: {
            arguments: part.arguments,
            id: typeof part.id === "string" ? part.id : undefined,
            name: mapToolName(part.name),
          },
        });
      }
      continue;
    }
    if (role === "toolResult") {
      converted.push({
        role: "toolResult",
        text: textFromContent(message.content),
      });
      continue;
    }
    converted.push({
      role,
      text: textFromContent(message.content),
    });
  }
  return converted;
}

function parsePiJsonLines(stdout: string): PiAgentEndEvent {
  let agentEnd: PiAgentEndEvent | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || parsed.type !== "agent_end") continue;
    agentEnd = parsed as PiAgentEndEvent;
  }
  if (!agentEnd || !Array.isArray(agentEnd.messages)) {
    throw new Error(
      "Pi JSON output did not include an agent_end messages payload",
    );
  }
  return agentEnd;
}

async function runPiCase(params: {
  benchmarkCase: HarnessBenchmarkCase;
  model: HarnessPiDriftModelTarget;
  prompt: string;
  promptMode: PromptMode;
  timeoutMs: number;
  tools: ToolMode;
}): Promise<HarnessBenchmarkRun> {
  const modelLabel = `${params.model.id}:${params.model.thinking}`;
  const modelRunLabel = `${modelLabel} [${params.promptMode}]`;
  const runId = `${params.benchmarkCase.id ?? slug(params.benchmarkCase.name)}-${slug(modelLabel)}-${params.promptMode}`;
  const toolArgs =
    params.tools === "none" ? ["--no-tools"] : ["--tools", params.tools];
  let stdout = "";
  try {
    const result = await execFileAsync(
      "pi",
      [
        "--no-session",
        "--mode",
        "json",
        ...toolArgs,
        "--model",
        params.model.id,
        "--thinking",
        params.model.thinking,
        "-p",
        params.prompt,
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 20,
        timeout: params.timeoutMs,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    stdout =
      isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
    try {
      const agentEnd = parsePiJsonLines(stdout);
      return {
        assistantText: `Pi run failed after producing a partial transcript for ${modelLabel} (${params.promptMode}).`,
        id: runId,
        messages: piMessagesToBenchmarkMessages(agentEnd.messages ?? []),
        model: modelRunLabel,
      };
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        isRecord(error) &&
        (typeof error.code === "number" || typeof error.code === "string")
          ? `code=${String(error.code)}`
          : "";
      const signal =
        isRecord(error) && typeof error.signal === "string"
          ? `signal=${error.signal}`
          : "";
      const killed =
        isRecord(error) && typeof error.killed === "boolean"
          ? `killed=${String(error.killed)}`
          : "";
      const stderr =
        isRecord(error) && typeof error.stderr === "string"
          ? error.stderr.trim()
          : "";
      return {
        assistantText: [
          `Pi run failed for ${modelLabel} (${params.promptMode}).`,
          message,
          code,
          signal,
          killed,
          stderr,
        ]
          .filter(Boolean)
          .join("\n"),
        id: runId,
        messages: [
          { role: "user", text: params.prompt },
          {
            role: "assistant",
            text: `Pi run failed before a complete transcript was captured: ${message}`,
          },
        ],
        model: modelRunLabel,
      };
    }
  }

  const agentEnd = parsePiJsonLines(stdout);
  const messages = piMessagesToBenchmarkMessages(agentEnd.messages ?? []);
  return {
    id: runId,
    messages,
    model: modelRunLabel,
  };
}

function selectCases(
  suite: HarnessBenchmarkSuite,
  args: HarnessPiDriftCliArgs,
): HarnessBenchmarkCase[] {
  const caseFilter = new Set(args.cases);
  const selected = suite.cases.filter(
    (benchmarkCase) =>
      caseFilter.size === 0 ||
      (benchmarkCase.id !== undefined && caseFilter.has(benchmarkCase.id)),
  );
  return args.limit === undefined ? selected : selected.slice(0, args.limit);
}

async function resolveModelTargets(
  args: HarnessPiDriftCliArgs,
): Promise<HarnessPiDriftModelTarget[]> {
  const targets = [
    ...parseHarnessPiDriftModelTargets(args.modelEntries, args.thinking),
  ];
  for (const modelFile of args.modelFiles) {
    const content = await readFile(modelFile, "utf8");
    targets.push(...parseHarnessPiDriftModelFile(content, args.thinking));
  }
  const unique = new Map<string, HarnessPiDriftModelTarget>();
  for (const target of targets) {
    unique.set(`${target.id}\0${target.thinking}`, target);
  }
  if (unique.size === 0) {
    throw new Error("--model or --model-file must provide at least one model");
  }
  return [...unique.values()];
}

async function main(): Promise<void> {
  const args = parseHarnessPiDriftArgs(process.argv.slice(2));
  const models = await resolveModelTargets(args);
  const payload = JSON.parse(await readFile(args.suitePath, "utf8")) as unknown;
  const sourceSuite = parseHarnessBenchmarkSuite(payload);
  const selectedCases = selectCases(sourceSuite, args);
  if (selectedCases.length === 0) {
    throw new Error("no benchmark cases matched the requested filters");
  }

  const liveCases: HarnessBenchmarkCase[] = [];
  const sandboxDirs: string[] = [];
  try {
    for (const sourceCase of selectedCases) {
      for (const promptMode of args.promptModes) {
        const materialized = await materializeCase(sourceCase, promptMode);
        sandboxDirs.push(materialized.sandboxDir);
        const runs: HarnessBenchmarkRun[] = [];
        for (const model of models) {
          runs.push(
            await runPiCase({
              benchmarkCase: materialized.benchmarkCase,
              model,
              prompt: materialized.prompt,
              promptMode,
              timeoutMs: args.timeoutMs,
              tools: args.tools,
            }),
          );
        }
        liveCases.push({ ...materialized.benchmarkCase, runs });
      }
    }

    const liveSuite: HarnessBenchmarkSuite = {
      cases: liveCases,
      description: `Live Pi drift run from ${sourceSuite.name ?? args.suitePath}`,
      name: "Khala Pi Drift Sandbox",
      version: 1,
    };
    if (args.outputPath) {
      await mkdir(path.dirname(args.outputPath), { recursive: true });
      await writeFile(
        args.outputPath,
        `${JSON.stringify(liveSuite, null, 2)}\n`,
        "utf8",
      );
    }

    const report = evaluateHarnessBenchmark(liveSuite);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatHarnessBenchmarkMarkdown(report));
    }
  } finally {
    if (!args.keepSandbox) {
      await Promise.all(
        sandboxDirs.map((sandboxDir) =>
          rm(sandboxDir, { force: true, recursive: true }),
        ),
      );
    }
  }
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
