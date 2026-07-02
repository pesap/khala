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
        expectedBestRunId: "missing-run",
        expectedBestMinDivergenceMargin: -1,
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
      "unknown_expected_best_run_id",
      "invalid_expected_best_margin",
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

test("harness benchmark enforces evidence-before-mutation package assertions", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Implementation reads relevant source before patching",
        packageContract: {
          requiredEvidenceBefore: [
            {
              before: {
                argumentIncludes: ["src/settings.ts"],
                name: "apply_patch",
              },
              evidence: {
                argumentIncludes: ["src/settings.ts"],
                name: "read",
                resultIncludes: ["existing compiler options"],
              },
            },
          ],
        },
        runs: [
          {
            assistantText:
              "I inspected the existing compiler options, then patched src/settings.ts.",
            id: "evidence-before-edit",
            messages: [
              {
                role: "user",
                text: "Update the compiler settings in src/settings.ts.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "read",
                },
              },
              {
                role: "toolResult",
                text: "existing compiler options live in buildCompilerOptions",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
            ],
          },
          {
            assistantText:
              "I patched src/settings.ts, then inspected the compiler settings.",
            id: "edit-before-evidence",
            messages: [
              {
                role: "user",
                text: "Update the compiler settings in src/settings.ts.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "read",
                },
              },
              {
                role: "toolResult",
                text: "existing compiler options live in buildCompilerOptions",
              },
            ],
          },
        ],
        userText: "Update the compiler settings in src/settings.ts.",
      },
    ],
  });

  const evidenceBeforeEdit = report.results.find(
    (result) => result.runId === "evidence-before-edit",
  );
  const editBeforeEvidence = report.results.find(
    (result) => result.runId === "edit-before-evidence",
  );

  assert.ok(evidenceBeforeEdit);
  assert.deepEqual(evidenceBeforeEdit.packageIssues, []);
  assert.equal(evidenceBeforeEdit.packageDivergenceScore, 0);

  assert.ok(editBeforeEvidence);
  assert.deepEqual(
    editBeforeEvidence.packageIssues.map((issue) => issue.code),
    ["package_run_required_evidence_missing_before_anchor"],
  );
  assert.ok(
    editBeforeEvidence.packageDivergenceScore >
      evidenceBeforeEdit.packageDivergenceScore,
  );
  assert.match(
    formatHarnessBenchmarkMarkdown(report),
    /package_run_required_evidence_missing_before_anchor/,
  );
});

test("harness benchmark enforces evidence-after-mutation package assertions", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Implementation validates after patching",
        packageContract: {
          requiredEvidenceAfter: [
            {
              after: {
                argumentIncludes: ["src/settings.ts"],
                name: "apply_patch",
              },
              evidence: {
                argumentIncludes: ["npm run test", "src/settings.test.ts"],
                name: "exec_command",
                resultIncludes: ["tests passed"],
              },
            },
          ],
        },
        runs: [
          {
            assistantText:
              "I patched src/settings.ts, then ran the targeted settings tests.",
            id: "validation-after-edit",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    cmd: "npm run test -- src/settings.test.ts",
                  },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "settings tests passed" },
            ],
          },
          {
            assistantText:
              "I ran the settings tests first, then patched src/settings.ts.",
            id: "validation-before-edit",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    cmd: "npm run test -- src/settings.test.ts",
                  },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "settings tests passed" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
            ],
          },
          {
            assistantText: "I patched src/settings.ts.",
            id: "edit-without-validation",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
            ],
          },
        ],
        userText: "Update src/settings.ts and validate the settings tests.",
      },
    ],
  });

  const validationAfterEdit = report.results.find(
    (result) => result.runId === "validation-after-edit",
  );
  const validationBeforeEdit = report.results.find(
    (result) => result.runId === "validation-before-edit",
  );
  const editWithoutValidation = report.results.find(
    (result) => result.runId === "edit-without-validation",
  );

  assert.ok(validationAfterEdit);
  assert.deepEqual(validationAfterEdit.packageIssues, []);
  assert.equal(validationAfterEdit.packageDivergenceScore, 0);

  assert.ok(validationBeforeEdit);
  assert.deepEqual(
    validationBeforeEdit.packageIssues.map((issue) => issue.code),
    ["package_run_required_evidence_missing_after_anchor"],
  );

  assert.ok(editWithoutValidation);
  assert.deepEqual(
    editWithoutValidation.packageIssues.map((issue) => issue.code),
    ["package_run_required_evidence_missing_after_anchor"],
  );
  assert.ok(
    validationAfterEdit.complianceScore > validationBeforeEdit.complianceScore,
  );
  assert.ok(
    validationAfterEdit.complianceScore > editWithoutValidation.complianceScore,
  );
  assert.match(
    formatHarnessBenchmarkMarkdown(report),
    /package_run_required_evidence_missing_after_anchor/,
  );
});

test("harness benchmark enforces assistant-only package text assertions", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Implementation summary carries scoped proof",
        packageContract: {
          requiredAssistantIncludes: [
            "src/settings.ts",
            "npm run test -- src/settings.test.ts",
          ],
        },
        runs: [
          {
            assistantText:
              "Changed src/settings.ts and verified with npm run test -- src/settings.test.ts.",
            id: "proof-in-summary",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and report the validation.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    cmd: "npm run test -- src/settings.test.ts",
                  },
                  name: "exec_command",
                },
              },
              {
                role: "toolResult",
                text: "npm run test -- src/settings.test.ts passed",
              },
            ],
          },
          {
            assistantText: "Done.",
            id: "proof-only-in-tools",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and report the validation.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    cmd: "npm run test -- src/settings.test.ts",
                  },
                  name: "exec_command",
                },
              },
              {
                role: "toolResult",
                text: "npm run test -- src/settings.test.ts passed",
              },
            ],
          },
        ],
        userText: "Update src/settings.ts and report the validation.",
      },
    ],
  });

  const proofInSummary = report.results.find(
    (result) => result.runId === "proof-in-summary",
  );
  const proofOnlyInTools = report.results.find(
    (result) => result.runId === "proof-only-in-tools",
  );

  assert.ok(proofInSummary);
  assert.deepEqual(proofInSummary.packageIssues, []);
  assert.ok(proofOnlyInTools);
  assert.deepEqual(
    proofOnlyInTools.packageIssues.map((issue) => issue.code),
    [
      "package_run_missing_required_assistant_text",
      "package_run_missing_required_assistant_text",
    ],
  );
  assert.ok(proofInSummary.complianceScore > proofOnlyInTools.complianceScore);
  assert.match(
    formatHarnessBenchmarkMarkdown(report),
    /package_run_missing_required_assistant_text/,
  );
});

test("harness benchmark enforces scoped mutation package assertions", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        harnessLimits: { substantialToolCallThreshold: 99 },
        name: "Implementation keeps mutations scoped to the target file",
        packageContract: {
          allowedMutationToolCalls: [
            {
              argumentIncludes: ["src/settings.ts"],
              name: "apply_patch",
            },
          ],
        },
        runs: [
          {
            assistantText:
              "Changed src/settings.ts and verified with the targeted settings tests.",
            id: "scoped-edit",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: {
                    cmd: "npm run test -- src/settings.test.ts",
                  },
                  name: "exec_command",
                },
              },
              {
                role: "toolResult",
                text: "npm run test -- src/settings.test.ts passed",
              },
            ],
          },
          {
            assistantText:
              "Changed src/settings.ts and also touched README.md.",
            id: "drive-by-apply-patch",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "README.md" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched README.md" },
            ],
          },
          {
            assistantText:
              "Changed src/settings.ts and touched README.md with a shell command.",
            id: "drive-by-shell-mutation",
            messages: [
              {
                role: "user",
                text: "Update src/settings.ts and validate the settings tests.",
              },
              {
                role: "assistant",
                toolCall: {
                  arguments: { path: "src/settings.ts" },
                  name: "apply_patch",
                },
              },
              { role: "toolResult", text: "patched src/settings.ts" },
              {
                role: "assistant",
                toolCall: {
                  arguments: { cmd: "touch README.md" },
                  name: "exec_command",
                },
              },
              { role: "toolResult", text: "touched README.md" },
            ],
          },
        ],
        userText: "Update src/settings.ts and validate the settings tests.",
      },
    ],
  });

  const scopedEdit = report.results.find(
    (result) => result.runId === "scoped-edit",
  );
  const driveByApplyPatch = report.results.find(
    (result) => result.runId === "drive-by-apply-patch",
  );
  const driveByShellMutation = report.results.find(
    (result) => result.runId === "drive-by-shell-mutation",
  );

  assert.ok(scopedEdit);
  assert.deepEqual(scopedEdit.packageIssues, []);
  assert.equal(scopedEdit.packageDivergenceScore, 0);

  assert.ok(driveByApplyPatch);
  assert.deepEqual(
    driveByApplyPatch.packageIssues.map((issue) => issue.code),
    ["package_run_unscoped_mutation_tool_call"],
  );
  assert.equal(driveByApplyPatch.packageDivergenceScore, 14);

  assert.ok(driveByShellMutation);
  assert.deepEqual(
    driveByShellMutation.packageIssues.map((issue) => issue.code),
    ["package_run_unscoped_mutation_tool_call"],
  );
  assert.equal(driveByShellMutation.packageDivergenceScore, 14);
  assert.ok(scopedEdit.complianceScore > driveByApplyPatch.complianceScore);
  assert.ok(scopedEdit.complianceScore > driveByShellMutation.complianceScore);
  assert.match(
    formatHarnessBenchmarkMarkdown(report),
    /package_run_unscoped_mutation_tool_call/,
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

test("harness benchmark reports expected best run mismatches", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        expectedBestRunId: "expected-winner",
        harnessLimits: { substantialToolCallThreshold: 99 },
        id: "winner-case",
        name: "Expected best must rank first",
        runs: [
          {
            assistantText: "I reviewed the change for regressions.",
            id: "expected-winner",
            messages: [
              { role: "user", text: "Review this change for regressions." },
            ],
            model: "candidate/example",
          },
          {
            assistantText: "Findings first, then residual risk and verdict.",
            id: "actual-winner",
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
                text: "Memory: review tasks need design-quality-review skill.",
              },
            ],
            model: "candidate/example",
          },
        ],
        tags: ["golden"],
        userText: "Review this change for regressions.",
      },
    ],
  });

  const summary = report.caseSummaries.find(
    (caseSummary) => caseSummary.caseId === "winner-case",
  );
  const expectedWinner = report.results.find(
    (result) => result.runId === "expected-winner",
  );

  assert.ok(summary);
  assert.equal(summary.expectedBestRunId, "expected-winner");
  assert.equal(summary.actualBestRunId, "actual-winner");
  assert.equal(summary.expectedBestRunMatched, false);
  assert.ok(expectedWinner);
  assert.equal(expectedWinner.bestRunRank, 2);
  assert.equal(expectedWinner.caseBestRunId, "actual-winner");
  assert.match(formatHarnessBenchmarkMarkdown(report), /Expected Best Runs/);

  const failures = evaluateHarnessBenchmarkCiFailures({
    args: parseHarnessBenchmarkCliArgs([
      "--must-pass-tag",
      "golden",
      "suite.json",
    ]),
    report,
  });
  assert.ok(
    failures.some((failure) =>
      failure.message.includes(
        "expected Expected best must rank first/expected-winner to rank first",
      ),
    ),
  );
});

test("harness benchmark reports weak expected best run margins", () => {
  const report = evaluateHarnessBenchmark({
    cases: [
      {
        expectedBestRunId: "a-expected-winner",
        expectedBestMinDivergenceMargin: 1,
        id: "margin-case",
        name: "Expected best must beat tied alternatives",
        runs: [
          {
            assistantText: "Done.",
            id: "a-expected-winner",
            messages: [{ role: "user", text: "Say done." }],
            model: "candidate/example",
          },
          {
            assistantText: "Done.",
            id: "b-tied-run",
            messages: [{ role: "user", text: "Say done." }],
            model: "candidate/example",
          },
        ],
        tags: ["golden"],
        userText: "Say done.",
      },
    ],
  });

  const summary = report.caseSummaries.find(
    (caseSummary) => caseSummary.caseId === "margin-case",
  );

  assert.ok(summary);
  assert.equal(summary.expectedBestRunMatched, true);
  assert.equal(summary.bestRunDivergenceMargin, 0);
  assert.equal(summary.expectedBestMinDivergenceMargin, 1);
  assert.equal(summary.expectedBestMarginMatched, false);

  const failures = evaluateHarnessBenchmarkCiFailures({
    args: parseHarnessBenchmarkCliArgs([
      "--must-pass-tag",
      "golden",
      "suite.json",
    ]),
    report,
  });
  assert.ok(
    failures.some((failure) =>
      failure.message.includes(
        "beat the next run by divergence margin 1, but margin was 0",
      ),
    ),
  );
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
  assert.equal(report.runCount, 14);
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
    report.results.some((result) =>
      result.packageIssues.some(
        (issue) =>
          issue.code === "package_run_required_evidence_missing_before_anchor",
      ),
    ),
    "expected at least one seed run to miss required evidence before mutation",
  );
  assert.ok(
    report.results.some((result) =>
      result.packageIssues.some(
        (issue) =>
          issue.code === "package_run_required_evidence_missing_after_anchor",
      ),
    ),
    "expected at least one seed run to miss required evidence after mutation",
  );
  assert.ok(
    report.results.some((result) =>
      result.packageIssues.some(
        (issue) => issue.code === "package_run_missing_required_assistant_text",
      ),
    ),
    "expected at least one seed run to miss required assistant summary text",
  );
  assert.ok(
    report.results.some((result) =>
      result.packageIssues.some(
        (issue) => issue.code === "package_run_unscoped_mutation_tool_call",
      ),
    ),
    "expected at least one seed run to mutate outside the package scope",
  );
  assert.ok(
    report.results.some((result) => result.complianceScore === 100),
    "expected at least one fully compliant seed run",
  );
  const typeScriptSummary = report.caseSummaries.find(
    (summary) => summary.caseId === "typescript-mutation-routing",
  );
  assert.equal(
    typeScriptSummary?.expectedBestRunId,
    "typescript-focused-route",
  );
  assert.equal(typeScriptSummary?.expectedBestMinDivergenceMargin, 14);
  assert.equal(typeScriptSummary?.actualBestRunId, "typescript-focused-route");
  assert.ok((typeScriptSummary?.bestRunDivergenceMargin ?? 0) >= 14);
  assert.equal(typeScriptSummary?.expectedBestRunMatched, true);
  assert.equal(typeScriptSummary?.expectedBestMarginMatched, true);
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
