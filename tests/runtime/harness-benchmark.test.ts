import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  benchmarkMessagesToKhalaTranscript,
  estimateJsonTokens,
  estimateKhalaBudget,
  estimateTextTokens,
  evaluateHarnessBenchmark,
  formatHarnessBenchmarkMarkdown,
  parseHarnessBenchmarkSuite,
  preflightHarnessBenchmarkSuite,
  type HarnessBenchmarkSuite,
} from "../../khala/harness.ts";
import {
  evaluateHarnessBenchmarkCiFailures,
  parseHarnessBenchmarkCliArgs,
} from "../../scripts/harness-benchmark.ts";
import {
  parseHarnessPiDriftArgs,
  parseHarnessPiDriftModelFile,
  parseHarnessPiDriftModelTargets,
} from "../../scripts/harness-pi-drift.ts";
import {
  formatGeneratedHarnessContracts,
  generateHarnessContracts,
} from "../../scripts/generate-harness-contracts.ts";

test("harness benchmark ranks cleaner candidate transcripts ahead of divergent runs", () => {
  const suite: HarnessBenchmarkSuite = {
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Review task routes through the review skill",
        runs: [
          {
            assistantText: "I reviewed the change for regressions.",
            id: "missing-skill",
            messages: [
              { role: "user", text: "Review this change for regressions." },
            ],
            model: "model-a",
          },
          {
            assistantText: "Findings first, then residual risk and verdict.",
            id: "loaded-skill",
            messages: [
              { role: "user", text: "Review this change for regressions." },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "skills/design-quality-review/SKILL.md" },
                  name: "read",
                },
              },
              {
                role: "toolResult",
                text: "Code review skill loaded with prioritized actionable findings and verdict instructions.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    query:
                      "Review this change regressions design-quality-review skill",
                  },
                  name: "khala_search_memory",
                },
              },
              {
                role: "toolResult",
                text: "Memory: code review regression tasks require design-quality-review skill instructions before findings.",
              },
            ],
            model: "model-a",
          },
        ],
        userText: "Review this change for regressions.",
      },
    ],
  };

  const report = evaluateHarnessBenchmark(suite);

  assert.equal(report.runCount, 2);
  assert.equal(report.results[0].runId, "loaded-skill");
  assert.deepEqual(report.results[0].issueCodes, []);
  assert.equal(report.results[0].complianceScore, 100);
  assert.ok(report.results[0].transcriptEventCount > 0);

  const missingSkill = report.results.find(
    (result) => result.runId === "missing-skill",
  );
  assert.ok(missingSkill);
  assert.deepEqual(missingSkill.issueCodes, ["skill_routing"]);
  assert.equal(missingSkill.blockingIssueCount, 1);
  assert.ok(missingSkill.complianceScore < 100);
});

test("harness benchmark reports expected issue distance and Markdown output", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        expectedIssueCodes: [],
        name: "Repeated read",
        runs: [
          {
            assistantText: "I inspected README.md twice.",
            id: "duplicate-read",
            messages: [
              { role: "user", text: "Inspect README.md." },
              {
                role: "assistant",
                toolCall: { arguments: { path: "README.md" }, name: "read" },
              },
              { role: "toolResult", text: "README contents" },
              {
                role: "assistant",
                toolCall: { arguments: { path: "README.md" }, name: "read" },
              },
              { role: "toolResult", text: "README contents" },
            ],
            model: "model-b",
          },
        ],
        userText: "Inspect README.md.",
      },
    ],
  });

  assert.deepEqual(report.results[0].issueCodes, ["tool_efficiency"]);
  assert.deepEqual(report.results[0].unexpectedIssueCodes, ["tool_efficiency"]);
  assert.equal(report.results[0].expectedIssueDistance, 1);
  assert.equal(report.results[0].metrics.wasteSignals.duplicateEvidence, true);

  const markdown = formatHarnessBenchmarkMarkdown(report);
  assert.match(markdown, /# Khala harness benchmark/);
  assert.match(markdown, /model-b/);
  assert.match(markdown, /tool_efficiency/);
  assert.match(markdown, /Events/);
});

test("harness benchmark accepts transcript fixtures without message arrays", () => {
  const transcript = benchmarkMessagesToKhalaTranscript({
    assistantText: "I inspected README.md.",
    messages: [
      { role: "user", text: "Inspect README.md." },
      {
        role: "assistant",
        toolCall: { arguments: { path: "README.md" }, name: "read" },
      },
      { role: "toolResult", text: "README contents" },
    ],
  });
  const suite = parseHarnessBenchmarkSuite({
    cases: [
      {
        name: "Transcript-only run",
        runs: [
          {
            id: "transcript-only",
            model: "model-transcript",
            transcript,
          },
        ],
        userText: "Inspect README.md.",
      },
    ],
  });

  const report = evaluateHarnessBenchmark(suite);

  assert.equal(report.runCount, 1);
  assert.equal(report.results[0].runId, "transcript-only");
  assert.equal(
    report.results[0].transcriptEventCount,
    transcript.events.length,
  );
  assert.deepEqual(report.results[0].metrics.toolCallCount, 1);
});

test("harness preflight reports package, expected-code, and recovery key problems", () => {
  const report = preflightHarnessBenchmarkSuite({
    cases: [
      {
        expectedIssueCodes: ["not_a_real_issue" as never],
        id: "case-a",
        name: "Problem case",
        packageContract: {
          artifacts: [
            {
              forbiddenIncludes: ["stale"],
              id: "capsule",
              requiredIncludes: ["must keep"],
              text: "stale package text",
            },
          ],
        },
        runs: [
          {
            id: "same-run",
            messages: [],
            model: "model-a",
          },
          {
            id: "same-run",
            messages: [{ role: "user", text: "Do the task." }],
            model: "model-b",
          },
        ],
        userText: "Do the task.",
      },
      {
        id: "case-a",
        name: "Duplicate case",
        runs: [
          {
            assistantText: "Done.",
            messages: [{ role: "user", text: "Do the task." }],
          },
        ],
        userText: "Do the task.",
      },
    ],
  });

  assert.equal(report.ok, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.runCount, 3);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [
      "unknown_expected_issue_code",
      "package_artifact_missing_required_text",
      "package_artifact_contains_forbidden_text",
      "run_without_messages",
      "run_without_assistant_output",
      "duplicate_run_id",
      "run_without_assistant_output",
      "duplicate_case_id",
    ],
  );
});

test("harness benchmark checks handoff package artifacts and acknowledgement behavior", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        name: "Workon handoff acknowledgement",
        packageContract: {
          artifacts: [
            {
              id: "capsule",
              kind: "capsule",
              requiredIncludes: [
                "Initial handoff and readiness gate:",
                "create/reuse the draft PR immediately with an empty bootstrap commit",
              ],
              text: [
                "# Workon session capsule",
                "Initial handoff and readiness gate:",
                "- Read the session capsule path provided by the launcher.",
                "- If no blocker is found, create/reuse the draft PR immediately with an empty bootstrap commit, then start work without waiting for another operator instruction.",
              ].join("\n"),
            },
          ],
          forbiddenToolCalls: [{ name: "apply_patch" }],
          requiredToolCalls: [
            { argumentIncludes: ["capsule.md"], name: "read" },
            {
              argumentIncludes: [
                "workon-handoff-ack.sh",
                "capsule-acknowledged",
              ],
              name: "exec_command",
            },
            {
              argumentIncludes: ["git commit", "--allow-empty"],
              name: "exec_command",
            },
            {
              argumentIncludes: ["gh pr create", "--draft"],
              name: "exec_command",
            },
          ],
          requiredTranscriptIncludes: [
            "capsule-acknowledged",
            "empty bootstrap commit",
            "draft PR",
          ],
        },
        runs: [
          {
            assistantText:
              "I read the capsule, recorded capsule-acknowledged, created the empty bootstrap commit, and opened the draft PR.",
            id: "ack",
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
                    cmd: 'git commit --allow-empty -m "chore(workon): bootstrap #63"',
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
              {
                role: "toolResult",
                text: "draft PR https://github.com/pesap/agents/pull/63",
              },
            ],
            model: "model-c",
          },
          {
            assistantText: "I implemented the patch.",
            id: "early-edit",
            messages: [
              { role: "user", text: "Session capsule path: /tmp/capsule.md" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/index.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched" },
            ],
            model: "model-c",
          },
        ],
        userText: "Session capsule path: /tmp/capsule.md",
      },
    ],
  });

  const ack = report.results.find((result) => result.runId === "ack");
  const earlyEdit = report.results.find(
    (result) => result.runId === "early-edit",
  );

  assert.ok(ack);
  assert.deepEqual(ack.packageIssues, []);
  assert.equal(ack.packageDivergenceScore, 0);

  assert.ok(earlyEdit);
  assert.ok(earlyEdit.packageDivergenceScore > 0);
  assert.ok(
    earlyEdit.packageIssues.some(
      (issue) => issue.code === "package_run_missing_required_tool_call",
    ),
  );
  assert.ok(
    earlyEdit.packageIssues.some(
      (issue) => issue.code === "package_run_used_forbidden_tool_call",
    ),
  );
});

test("harness benchmark enforces temporal package assertions", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Temporal workon contract",
        packageContract: {
          forbiddenBefore: [
            {
              before: {
                argumentIncludes: ["gh pr create", "--draft"],
                name: "exec_command",
              },
              forbidden: { name: "apply_patch" },
            },
          ],
          nextToolMustBe: [
            {
              after: { argumentIncludes: ["capsule.md"], name: "read" },
              next: {
                argumentIncludes: [
                  "workon-handoff-ack.sh",
                  "capsule-acknowledged",
                ],
                name: "exec_command",
              },
            },
          ],
          orderedToolCalls: [
            { argumentIncludes: ["capsule.md"], name: "read" },
            {
              argumentIncludes: [
                "workon-handoff-ack.sh",
                "capsule-acknowledged",
              ],
              name: "exec_command",
            },
            {
              argumentIncludes: ["git commit", "--allow-empty"],
              name: "exec_command",
            },
            {
              argumentIncludes: ["gh pr create", "--draft"],
              name: "exec_command",
            },
          ],
          requiredBefore: [
            {
              before: {
                argumentIncludes: [
                  "workon-handoff-ack.sh",
                  "capsule-acknowledged",
                ],
                name: "exec_command",
              },
              required: { argumentIncludes: ["capsule.md"], name: "read" },
            },
            {
              before: {
                argumentIncludes: ["gh pr create", "--draft"],
                name: "exec_command",
              },
              required: {
                argumentIncludes: ["git commit", "--allow-empty"],
                name: "exec_command",
              },
            },
          ],
        },
        runs: [
          {
            assistantText: "I acknowledged before reading the capsule.",
            id: "ack-before-read",
            messages: [
              { role: "user", text: "Session capsule path: /tmp/capsule.md" },
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
                  arguments: { path: "/tmp/capsule.md" },
                  name: "read",
                },
              },
              { role: "toolResult", text: "capsule" },
            ],
          },
          {
            assistantText: "I opened the draft PR before the empty commit.",
            id: "draft-before-commit",
            messages: [
              { role: "user", text: "Session capsule path: /tmp/capsule.md" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "/tmp/capsule.md" },
                  name: "read",
                },
              },
              { role: "toolResult", text: "capsule" },
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
                  arguments: { cmd: "gh pr create --draft --title bootstrap" },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "draft PR" },
            ],
          },
          {
            assistantText: "I edited before opening the draft PR.",
            id: "edit-before-pr",
            messages: [
              { role: "user", text: "Session capsule path: /tmp/capsule.md" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "/tmp/capsule.md" },
                  name: "read",
                },
              },
              { role: "toolResult", text: "capsule" },
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
                    cmd: "git commit --allow-empty -m bootstrap",
                  },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "empty bootstrap commit" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/index.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { cmd: "gh pr create --draft --title bootstrap" },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "draft PR" },
            ],
          },
        ],
        userText: "Session capsule path: /tmp/capsule.md",
      },
    ],
  });

  assert.deepEqual(
    report.results
      .find((result) => result.runId === "ack-before-read")
      ?.packageIssues.map((issue) => issue.code),
    [
      "package_run_tool_order_violation",
      "package_run_required_tool_missing_before_anchor",
      "package_run_next_tool_mismatch",
    ],
  );
  assert.deepEqual(
    report.results
      .find((result) => result.runId === "draft-before-commit")
      ?.packageIssues.map((issue) => issue.code),
    [
      "package_run_tool_order_violation",
      "package_run_required_tool_missing_before_anchor",
    ],
  );
  assert.deepEqual(
    report.results
      .find((result) => result.runId === "edit-before-pr")
      ?.packageIssues.map((issue) => issue.code),
    ["package_run_forbidden_tool_before_anchor"],
  );
  assert.match(
    formatHarnessBenchmarkMarkdown(report),
    /package_run_next_tool_mismatch/,
  );
});

test("harness budget estimates are deterministic and advisory", () => {
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcde"), 2);
  assert.equal(
    estimateJsonTokens({ b: 2, a: 1 }),
    estimateJsonTokens({ a: 1, b: 2 }),
  );

  const budget = estimateKhalaBudget({
    bootstrapContext: "bootstrap",
    runtimeRules: "memory before mutation",
    warningThresholdTokens: 1,
    workflowPrompt: "Update README.md",
  });

  assert.ok(budget.totalTokens > 1);
  assert.deepEqual(
    budget.warnings.map((warning) => warning.code),
    ["budget_total_exceeds_threshold"],
  );

  const report = evaluateHarnessBenchmark(
    {
      cases: [
        {
          budgetWarningThreshold: 1,
          name: "Budget warning case",
          runs: [
            {
              assistantText: "Done.",
              messages: [{ role: "user", text: "Summarize." }],
            },
          ],
          userText: "Summarize.",
        },
      ],
    },
    { budgetWarningThreshold: 1 },
  );

  assert.ok(report.results[0].budget.totalTokens > 0);
  assert.match(formatHarnessBenchmarkMarkdown(report), /Budget Warnings/);
});

test("harness benchmark CI gates pass and fail expected threshold cases", () => {
  const args = parseHarnessBenchmarkCliArgs([
    "--fail-on-blocking-regression",
    "--must-pass-tag",
    "golden",
    "--max-divergence",
    "0",
    "suite.json",
  ]);
  const clean = evaluateHarnessBenchmark({
    cases: [
      {
        name: "Clean golden",
        runs: [
          {
            assistantText: "Done.",
            messages: [{ role: "user", text: "Say done." }],
          },
        ],
        tags: ["golden"],
        userText: "Say done.",
      },
    ],
  });
  assert.deepEqual(
    evaluateHarnessBenchmarkCiFailures({ args, report: clean }),
    [],
  );

  const regressed = evaluateHarnessBenchmark({
    cases: [
      {
        lowConfidenceThreshold: 0.7,
        name: "Regressed golden",
        runs: [
          {
            assistantText: "Probably done.\nConfidence: 0.51",
            messages: [{ role: "user", text: "Answer uncertainly." }],
          },
        ],
        tags: ["golden"],
        userText: "Answer uncertainly.",
      },
    ],
  });
  const failures = evaluateHarnessBenchmarkCiFailures({
    args,
    baseline: clean,
    report: regressed,
  });

  assert.ok(failures.some((failure) => failure.code === "blocking_regression"));
  assert.ok(
    failures.some((failure) => failure.code === "must_pass_tag_failed"),
  );
  assert.ok(
    failures.some((failure) => failure.code === "max_divergence_exceeded"),
  );
});

test("generated workon package contracts are stable", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const generated = await generateHarnessContracts({ repoRoot });
  const checkedIn = await readFile(
    new URL(
      "../../benchmarks/package-contracts.generated.json",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(formatGeneratedHarnessContracts(generated), checkedIn);
  const workon = generated.cases.find(
    (benchmarkCase) => benchmarkCase.id === "generated-workon-handoff-contract",
  );
  assert.ok(workon?.packageContract?.sourceHash);
  assert.ok((workon.packageContract.orderedToolCalls?.length ?? 0) > 0);
  assert.ok((workon.packageContract.forbiddenBefore?.length ?? 0) > 0);
  assert.ok(
    workon.packageContract.requiredToolCalls?.some(
      (check) =>
        check.name === "exec_command" &&
        check.argumentIncludes?.includes("gh pr create"),
    ),
  );
});

test("checked-in harness sandbox fixture parses and produces ranked results", async () => {
  const payload = JSON.parse(
    await readFile(
      new URL("../../benchmarks/harness-sandbox.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;

  const suite = parseHarnessBenchmarkSuite(payload);
  const report = evaluateHarnessBenchmark(suite);

  assert.equal(report.suiteName, "Khala Harness Sandbox Seed Suite");
  assert.equal(report.caseCount, 5);
  assert.equal(report.runCount, 10);
  assert.ok(
    report.results.some((result) =>
      result.issueCodes.includes("skill_routing"),
    ),
  );
  assert.ok(
    report.results.some((result) =>
      result.issueCodes.includes("tool_efficiency"),
    ),
  );
  assert.ok(
    report.results.some((result) => result.packageDivergenceScore > 0),
    "expected at least one seed run to diverge from the package contract",
  );
  assert.ok(
    report.results.some((result) => result.complianceScore === 100),
    "expected at least one fully compliant seed run",
  );
});

test("pi drift runner requires explicit user-selected models", () => {
  assert.throws(
    () => parseHarnessPiDriftArgs(["benchmarks/harness-sandbox.json"]),
    /--model or --model-file is required/,
  );
  assert.throws(
    () =>
      parseHarnessPiDriftArgs([
        "benchmarks/harness-sandbox.json",
        "--model",
        "provider/model-a",
        "--resume",
      ]),
    /--resume requires --out/,
  );

  const parsed = parseHarnessPiDriftArgs([
    "benchmarks/harness-sandbox.json",
    "--model",
    "provider/model-a, provider/model-b:high",
    "--thinking",
    "medium",
    "--prompt-mode",
    "both",
    "--repeat",
    "3",
    "--out",
    ".tmp/pi-drift/latest.json",
    "--resume",
    "--state-dir",
    ".tmp/pi-drift/state",
  ]);

  assert.equal(parsed.suitePath, "benchmarks/harness-sandbox.json");
  assert.equal(parsed.thinking, "medium");
  assert.equal(parsed.repeat, 3);
  assert.equal(parsed.resume, true);
  assert.equal(parsed.outputPath, ".tmp/pi-drift/latest.json");
  assert.equal(parsed.stateDir, ".tmp/pi-drift/state");
  assert.deepEqual(parsed.modelEntries, [
    "provider/model-a",
    "provider/model-b:high",
  ]);
  assert.deepEqual(parsed.promptModes, ["raw", "packaged"]);

  assert.deepEqual(
    parseHarnessPiDriftModelTargets(parsed.modelEntries, parsed.thinking),
    [
      { id: "provider/model-a", thinking: "medium" },
      { id: "provider/model-b", thinking: "high" },
    ],
  );
});

test("pi drift runner accepts reusable model files", () => {
  assert.deepEqual(
    parseHarnessPiDriftModelFile(
      `
      # Provider smoke set
      provider/model-a
      provider/model-b:low
      `,
      "off",
    ),
    [
      { id: "provider/model-a", thinking: "off" },
      { id: "provider/model-b", thinking: "low" },
    ],
  );

  assert.deepEqual(
    parseHarnessPiDriftModelFile(
      JSON.stringify([
        "provider/model-c:high",
        { model: "provider/model-d", thinking: "minimal" },
        { id: "provider/model-e" },
      ]),
      "medium",
    ),
    [
      { id: "provider/model-c", thinking: "high" },
      { id: "provider/model-d", thinking: "minimal" },
      { id: "provider/model-e", thinking: "medium" },
    ],
  );
});
