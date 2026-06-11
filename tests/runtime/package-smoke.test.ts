import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const requiredPackageFiles = [
  "khala/index.ts",
  "khala/harness.ts",
  "extensions/index.ts",
  "extensions/runtime/escalation.ts",
  "runtime/profile.yaml",
  "runtime/RULES.md",
  "commands/review-workflow.md",
  "prompts/fresh-eyes.md",
  "workflows/review-workflow.yaml",
  "skills/code-review/SKILL.md",
  "intercepted-commands/python",
  "package.json",
  "README.md",
];

const forbiddenPackageFiles = [
  "tests/runtime/escalation.test.ts",
  "tests/runtime/harness-replay.test.ts",
  "tests/runtime/fixtures/harness-replay.json",
  "tests/runtime/package-smoke.test.ts",
  "tests/learning/search.test.ts",
  ".pi/khala/rules/RULES.md",
  ".codex/settings.json",
  "runtime/memory/log.jsonl",
  "examples/basic.md",
  "extensions/package-lock.json",
];

type PackageEntry = {
  filename: string;
  files: Array<{ path: string }>;
};

function findPackageFileProblems(files: Set<string>): string[] {
  const missing = requiredPackageFiles
    .filter((file) => !files.has(file))
    .map((file) => `missing required package file: ${file}`);
  const includedForbidden = forbiddenPackageFiles
    .filter((file) => files.has(file))
    .map((file) => `forbidden package file included: ${file}`);
  return [...missing, ...includedForbidden];
}

test("package smoke exposes harness through packed package surface", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-package-smoke-"));

  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", tempDir],
      { maxBuffer: 1024 * 1024 * 10 },
    );
    const [pack] = JSON.parse(stdout) as PackageEntry[];
    const packedFiles = new Set(pack.files.map((file) => file.path));

    assert.deepEqual(findPackageFileProblems(packedFiles), []);
    assert.match(
      findPackageFileProblems(
        new Set([...packedFiles].filter((file) => file !== "runtime/RULES.md")),
      )[0],
      /missing required package file: runtime\/RULES\.md/,
    );

    const extractDir = path.join(tempDir, "extract");
    await mkdir(extractDir);
    await execFileAsync("tar", ["-xzf", path.join(tempDir, pack.filename), "-C", extractDir]);

    const packageRoot = path.join(extractDir, "package");
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      exports?: Record<string, string>;
      pi?: {
        prompts?: string[];
      };
    };
    assert.deepEqual(packageJson.pi?.prompts, ["./prompts"]);
    const harnessEntry = packageJson.exports?.["./harness"];
    assert.equal(harnessEntry, "./khala/harness.ts");

    const harness = (await import(
      pathToFileURL(path.join(packageRoot, harnessEntry)).href
    )) as {
      evaluateHarnessTurn: (params: {
        assistantText: string;
        lowConfidenceThreshold: number;
        messages: Array<{
          role: string;
          content: Array<
            | { type: "text"; text: string }
            | { type: "toolCall"; id: string; name: string; arguments: unknown }
          >;
        }>;
        responseComplianceMode: string;
        userText: string;
      }) => Array<{ code: string }>;
      evaluateHarnessTurnMetrics: (params: {
        messages: Array<{
          role: string;
          content: Array<
            | { type: "text"; text: string }
            | { type: "toolCall"; id: string; name: string; arguments: unknown }
          >;
        }>;
      }) => { toolCallCount: number; skillLoads: number };
    };

    const userText = "Use the TypeScript skill before answering.";
    const messages = [
      { role: "user", content: [{ type: "text" as const, text: userText }] },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "call-read-skill",
            name: "read",
            arguments: { path: "skills/typescript/SKILL.md" },
          },
        ],
      },
      {
        role: "toolResult",
        content: [{ type: "text" as const, text: "TypeScript skill guidance" }],
      },
    ];

    assert.deepEqual(
      harness
        .evaluateHarnessTurn({
          assistantText: "I used the TypeScript skill.",
          lowConfidenceThreshold: 0.7,
          messages,
          responseComplianceMode: "enforce",
          userText,
        })
        .map((issue) => issue.code),
      [],
    );
    assert.deepEqual(
      harness
        .evaluateHarnessTurn({
          assistantText: "I answered without loading the requested skill.",
          lowConfidenceThreshold: 0.7,
          messages: [messages[0]],
          responseComplianceMode: "enforce",
          userText,
        })
        .map((issue) => issue.code),
      ["skill_routing"],
    );

    assert.deepEqual(harness.evaluateHarnessTurnMetrics({ messages }), {
      scopedMessageCount: 2,
      toolCallCount: 1,
      memorySearches: { total: 0, focused: 0, successful: 0 },
      skillLoads: 1,
      externalEvidenceCalls: 0,
      commandEvidenceCalls: 0,
      mutationCalls: 0,
      learningCaptures: 0,
      modelEscalations: 0,
      wasteSignals: {
        duplicateEvidence: false,
        inefficientShell: false,
        shellQuotingRepairLoop: false,
        fullSessionArtifactRead: false,
        broadQuery: false,
        duplicateLearning: false,
        count: 0,
      },
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
