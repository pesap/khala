import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunLedgerCommandHandlers,
  isReplaySafeResumeHistoryEvent,
} from "../../extensions/commands/run-ledger.ts";
import {
  appendRunLedgerEvent,
  buildRunLedgerRecord,
  buildRunLedgerWorkflowStartedEvent,
  markRunInterrupted,
  writeRunLedger,
} from "../../extensions/runtime/run-ledger.ts";

function fakeCtx(cwd: string, idle = true): never {
  return {
    cwd,
    hasUI: false,
    ui: undefined,
    isIdle: () => idle,
  } as never;
}

test("resume history includes only explicitly replay-safe non-resume events", () => {
  assert.equal(
    isReplaySafeResumeHistoryEvent({ type: "tool_call", replaySafe: true }),
    true,
  );
  assert.equal(
    isReplaySafeResumeHistoryEvent({ type: "tool_call", replaySafe: false }),
    false,
  );
  assert.equal(
    isReplaySafeResumeHistoryEvent({ type: "tool_call" }),
    false,
  );
  assert.equal(
    isReplaySafeResumeHistoryEvent({ type: "resume_attempted", replaySafe: true }),
    false,
  );
});

test("run-show renders a durable run ledger summary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-show-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: { repo: "pesap/agents" },
        repo: "pesap/agents",
        cwd: "/repo/agents",
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("debug-1", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Run debug-1/);
    assert.match(messages[0] ?? "", /Status: started/);
    assert.match(
      messages[0] ?? "",
      /Next action: /,
    );
    assert.match(messages[0] ?? "", /Repo: pesap\/agents/);
    assert.match(messages[0] ?? "", /Input: investigate failing test/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-show summarizes skill registry activity", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-show-skills-"));
  try {
    const runDir = path.join(tempDir, "runs");
    await mkdir(runDir, { recursive: true });
    const runFile = path.join(runDir, "skills-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "skills-1",
        type: "debug",
        input: "inspect skill routing",
        flags: {
          hasMutation: false,
          hasExternalSideEffect: false,
          hasUnsafeReplay: false,
        },
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "skills-1:skill_routed:code-review:2026-06-20T00:00:30.000Z",
            at: "2026-06-20T00:00:30.000Z",
            type: "skill_routed",
            summary: "skill_routed: code-review source=packaged.",
            data: {
              skill: {
                name: "code-review",
                source: "packaged",
              },
              attemptedSources: ["packaged"],
            },
            sideEffectClass: "read_only",
            replaySafe: true,
          },
          {
            id: "skills-1:skill_loaded:code-review:2026-06-20T00:01:00.000Z",
            at: "2026-06-20T00:01:00.000Z",
            type: "skill_loaded",
            summary: "skill_loaded: code-review source=packaged.",
            data: {
              skill: {
                name: "code-review",
                source: "packaged",
              },
              attemptedSources: ["packaged"],
            },
            sideEffectClass: "read_only",
            replaySafe: true,
          },
          {
            id: "skills-1:skill_missing:debugging:2026-06-20T00:02:00.000Z",
            at: "2026-06-20T00:02:00.000Z",
            type: "skill_missing",
            summary: "skill_missing: debugging source=unknown.",
            data: {
              skill: {
                name: "debugging",
                source: "unknown",
              },
              attemptedSources: ["packaged", "learned", "repo-local"],
            },
            sideEffectClass: "read_only",
            replaySafe: true,
          },
        ],
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir: runDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("skills-1", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Skills: skill_routed=1 skill_loaded=1 skill_missing=1 sources=packaged,unknown attempted_sources=learned,packaged,repo-local routed=code-review loaded=code-review missing=debugging/,
    );
    assert.match(
      messages[0] ?? "",
      /skill_loaded.*skill=code-review.*skill_attempted_sources=packaged/,
    );
    assert.match(
      messages[0] ?? "",
      /skill_missing.*skill=debugging.*skill_attempted_sources=packaged,learned,repo-local/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run commands summarize completion skill metadata when skill events are absent", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-completion-skills-"));
  try {
    const runDir = path.join(tempDir, "runs");
    const runFile = path.join(runDir, "completion-skills-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "completion-skills-1",
        type: "debug",
        input: "inspect completion skill metadata",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "completion-skills-1:workflow_completed:2026-06-20T00:10:00.000Z",
            at: "2026-06-20T00:10:00.000Z",
            type: "workflow_completed",
            summary: "Workflow completed with outcome success.",
            replaySafe: true,
            data: {
              outcome: "success",
              confidence: 0.92,
              structuredCompletion: {
                outcome: "success",
                confidence: 0.92,
                validation: [],
                openQuestions: [],
                learningCandidates: [],
              },
              loadedSkills: ["code-review"],
              skillMetadata: [
                {
                  name: "code-review",
                  source: "packaged",
                  path: "skills/code-review/SKILL.md",
                },
              ],
            },
          },
        ],
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir: runDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("completion-skills-1", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Skills: completion_loaded=1 sources=packaged loaded=code-review/,
    );

    messages.length = 0;
    await handlers.runList("skills/code-review/SKILL.md", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Khala run ledger matching "skills\/code-review\/skill\.md":/,
    );
    assert.match(messages[0] ?? "", /- completion-skills-1 started debug/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list renders durable runs newest first", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    await writeRunLedger(
      path.join(runLedgerDir, "debug-1.json"),
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "debug-1:resume_attempted:2026-06-20T00:05:00.000Z",
            at: "2026-06-20T00:05:00.000Z",
            type: "resume_attempted",
            summary: "Operator requested conservative run resume.",
            replaySafe: true,
          },
        ],
      }),
    );
    await writeRunLedger(
      path.join(runLedgerDir, "ship-1.json"),
      buildRunLedgerRecord({
        version: 1,
        id: "ship-1",
        type: "ship",
        input: "ship branch",
        flags: {},
        startedAt: "2026-06-20T00:10:00.000Z",
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger:/);
    assert.match(messages[0] ?? "", /- ship-1 started ship at=2026-06-20T00:10:00.000Z recovery=resumable input=ship branch/);
    assert.match(messages[0] ?? "", /- debug-1 started debug at=2026-06-20T00:00:00.000Z recovery=resumable resume_attempted=2026-06-20T00:05:00.000Z input=investigate failing test/);
    assert.ok((messages[0] ?? "").indexOf("ship-1") < (messages[0] ?? "").indexOf("debug-1"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list help explains searchable filters", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-help-"));
  try {
    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir: path.join(tempDir, "runs"),
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("--help", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Usage: \/run-list \[filter\]/);
    assert.match(messages[0] ?? "", /Default ledger: .*\/\.pi\/khala\/runs/);
    assert.match(messages[0] ?? "", /status, workflow type, recovery classification/);
    assert.match(messages[0] ?? "", /workflow state/);
    assert.match(messages[0] ?? "", /structured completion text/);
    assert.match(messages[0] ?? "", /completion policy metadata/);
    assert.match(messages[0] ?? "", /ledger event ids\/timestamps\/text/);
    assert.match(messages[0] ?? "", /skill metadata/);
    assert.match(messages[0] ?? "", /skill attempted sources/);
    assert.match(messages[0] ?? "", /tool metadata/);
    assert.match(messages[0] ?? "", /tool workflow-step context/);
    assert.match(messages[0] ?? "", /\/run-list needs_operator_review/);
    assert.match(messages[0] ?? "", /Named views: active, resumable, needs_operator_review\./);
    assert.match(messages[0] ?? "", /source issue\/PR\/url/);
    assert.match(messages[0] ?? "", /local worktree\/capsule\/ledger paths/);
    assert.match(messages[0] ?? "", /next action/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run ledger action commands explain conservative usage", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-action-help-"));
  try {
    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir: path.join(tempDir, "runs"),
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("--help", fakeCtx(tempDir));
    await handlers.runResume("-h", fakeCtx(tempDir));
    await handlers.runCheckpoint("help", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Usage: \/run-show <run-id\|path>/);
    assert.match(messages[0] ?? "", /recovery classification/);
    assert.match(messages[1] ?? "", /Usage: \/run-resume <run-id\|path>/);
    assert.match(messages[1] ?? "", /unsafe mutation, shell, forge, external, or unknown side effects/);
    assert.match(messages[2] ?? "", /Usage: \/run-checkpoint <run-id\|path> \[reason\]/);
    assert.match(messages[2] ?? "", /operator-verified replay-safe checkpoint/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list reports unreadable run files without hiding readable runs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-skipped-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    await writeRunLedger(
      path.join(runLedgerDir, "debug-1.json"),
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await mkdir(runLedgerDir, { recursive: true });
    await writeFile(path.join(runLedgerDir, "broken.json"), "{", "utf8");

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /- debug-1 started debug/);
    assert.match(messages[0] ?? "", /Skipped unreadable run files: 1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list filters by recovery classification", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-filter-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const safeRun = path.join(runLedgerDir, "debug-1.json");
    await writeRunLedger(
      safeRun,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const unsafeRun = path.join(runLedgerDir, "ship-1.json");
    await writeRunLedger(
      unsafeRun,
      buildRunLedgerRecord({
        version: 1,
        id: "ship-1",
        type: "ship",
        input: "ship branch",
        flags: {},
        startedAt: "2026-06-20T00:10:00.000Z",
      }),
    );
    await appendRunLedgerEvent({
      runFile: unsafeRun,
      event: {
        id: "ship-1:shell",
        at: "2026-06-20T00:11:00.000Z",
        type: "tool_call",
        summary: "shell command",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
        data: {
          metadata: {
            name: "bash",
            evidenceClass: "local",
            mutationClass: "filesystem",
            sideEffectClass: "shell",
            replaySafe: false,
            memoryRefreshRequirement: "not_required",
            gateSatisfaction: {
              countsTaskToolCall: true,
              agesMemory: true,
              satisfiesMemoryRead: false,
              persistsMemory: false,
            },
          },
          input: {
            command: "touch changed.txt",
            cwd: "/repo/agents",
          },
        },
      },
    });
    await markRunInterrupted({
      runFile: unsafeRun,
      at: "2026-06-20T00:12:00.000Z",
      eventId: "ship-1:interrupted",
      reason: "stopped after shell",
    });

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("needs_operator_review", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "needs_operator_review":/);
    assert.match(messages[0] ?? "", /- ship-1 needs_operator_review ship/);
    assert.match(messages[0] ?? "", /recovery=needs_operator_review unsafe=1/);
    assert.match(messages[0] ?? "", /unsafe_reason=not explicitly replay-safe; shell side effect/);
    assert.match(messages[0] ?? "", /review_reason=Run has uncertain/);
    assert.doesNotMatch(messages[0] ?? "", /debug-1/);

    messages.length = 0;
    await handlers.runList("uncertain mutation", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "uncertain mutation":/);
    assert.match(messages[0] ?? "", /- ship-1 needs_operator_review ship/);
    assert.doesNotMatch(messages[0] ?? "", /debug-1/);

    messages.length = 0;
    await handlers.runList("shell side effect", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "shell side effect":/);
    assert.match(messages[0] ?? "", /- ship-1 needs_operator_review ship/);
    assert.doesNotMatch(messages[0] ?? "", /debug-1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list filters by structured completion text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-completion-filter-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "debug-1",
      type: "debug",
      input: "investigate failing test",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.structuredCompletion = {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: ["Should resume get a CLI command?"],
      learningCandidates: ["Keep workflow state in run ledgers."],
    };
    await writeRunLedger(path.join(runLedgerDir, "debug-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("npm test passed", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "npm test passed":/);
    assert.match(messages[0] ?? "", /- debug-1 completed debug/);
    assert.match(
      messages[0] ?? "",
      /completion=success confidence=0\.92 validation=1 open_questions=1 learnings=1/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run commands surface completion policy metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-policy-summary-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "policy-1",
      type: "debug",
      input: "ship after validation",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.strictViolation = "Missing required footer field(s): Closes.";
    record.policy = {
      qualityScore: 4,
      mutationCount: 2,
      postflightMissing: true,
      warnings: ["postflight validation missing"],
    };
    record.structuredCompletion = {
      outcome: "success",
      confidence: 0.82,
      validation: [],
      openQuestions: [],
      learningCandidates: [],
    };
    record.events.push({
      id: "policy-1:workflow_completed:2026-06-20T00:10:00.000Z",
      at: "2026-06-20T00:10:00.000Z",
      type: "workflow_completed",
      summary: "Workflow completed with strict-output violation.",
      replaySafe: true,
      data: {
        strictViolation: true,
        strictViolationReason: "Missing required footer field(s): Closes.",
        qualityScore: 4,
        mutationCount: 2,
        postflightMissing: true,
        policyWarnings: ["postflight validation missing"],
      },
    });
    await writeRunLedger(path.join(runLedgerDir, "policy-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("policy-1", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Policy: strict_violation=true quality=4 mutations=2 postflight_missing=true/,
    );
    assert.match(
      messages[0] ?? "",
      /Policy strict violation: Missing required footer field\(s\): Closes\./,
    );
    assert.match(messages[0] ?? "", /Policy warnings: postflight validation missing/);

    messages.length = 0;
    await handlers.runList("missing required footer", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Khala run ledger matching "missing required footer":/,
    );
    assert.match(
      messages[0] ?? "",
      /- policy-1 completed debug .*strict_violation=true quality=4 postflight_missing=true policy_warnings=1/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list renders and filters resume attempt recovery reasons", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-resume-reason-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    await writeRunLedger(
      path.join(runLedgerDir, "resume-visible-1.json"),
      buildRunLedgerRecord({
        version: 1,
        id: "resume-visible-1",
        type: "debug",
        input: "continue local investigation",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        events: [
          {
            id: "resume-visible-1:resume_attempted:2026-06-20T00:05:00.000Z",
            at: "2026-06-20T00:05:00.000Z",
            type: "resume_attempted",
            summary: "Operator requested conservative run resume.",
            replaySafe: true,
            data: {
              recovery: {
                classification: "resumable",
                reason: "operator verified local-only replay boundary",
                recommendedAction: "Resume from the latest safe checkpoint.",
                unsafeEventIds: [],
              },
            },
          },
        ],
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("local-only replay boundary", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Khala run ledger matching "local-only replay boundary":/,
    );
    assert.match(messages[0] ?? "", /- resume-visible-1 started debug/);
    assert.match(messages[0] ?? "", /resume_attempted=2026-06-20T00:05:00.000Z/);
    assert.match(
      messages[0] ?? "",
      /resume_reason=operator verified local-only replay boundary/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list reports no matches for missing structured completion text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-completion-no-match-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "debug-1",
      type: "debug",
      input: "investigate failing test",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.structuredCompletion = {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: [],
      learningCandidates: [],
    };
    await writeRunLedger(path.join(runLedgerDir, "debug-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("missing validation", fakeCtx(tempDir));

    assert.equal(messages[0], 'Khala run ledger: no runs found matching "missing validation".');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list filters by workflow state text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-workflow-state-filter-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-1",
      type: "debug",
      input: "investigate failing test",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.workflow.state = {
      name: "debug-workflow",
      objective: "Investigate and fix the failing test",
      currentStepIndex: 1,
      steps: [
        { index: 0, id: "inspect", action: "gather_evidence", status: "completed" },
        { index: 1, id: "validate", action: "run_tests", status: "active" },
      ],
    };
    await writeRunLedger(path.join(runLedgerDir, "workflow-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("run_tests", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "run_tests":/);
    assert.match(messages[0] ?? "", /- workflow-1 completed debug/);
    assert.match(messages[0] ?? "", /step=2\/2:validate/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list shows completed workflow step progress", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-workflow-complete-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-complete-1",
      type: "debug",
      input: "finish ordered workflow",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      workflowState: {
        currentStepIndex: null,
        steps: [
          { index: 0, id: "inspect", action: "gather_evidence", status: "completed" },
          { index: 1, id: "validate", action: "run_tests", status: "completed" },
        ],
      },
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    await writeRunLedger(path.join(runLedgerDir, "workflow-complete-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /- workflow-complete-1 completed debug/);
    assert.match(messages[0] ?? "", /step=completed:2\/2/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list shows incomplete final workflow step progress", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-workflow-incomplete-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "workflow-failed-1",
      type: "debug",
      input: "finish ordered workflow",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
      workflowState: {
        currentStepIndex: null,
        steps: [
          { index: 0, id: "inspect", action: "gather_evidence", status: "active" },
          { index: 1, id: "validate", action: "run_tests", status: "pending" },
        ],
      },
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.outcome = "failed";
    await writeRunLedger(path.join(runLedgerDir, "workflow-failed-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /- workflow-failed-1 completed debug/);
    assert.match(messages[0] ?? "", /step=incomplete:active=1,pending=1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list filters by ledger event text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-event-filter-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "review-1",
      type: "review",
      input: "review changes",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push({
      id: "review-1:skill_loaded:code-review:2026-06-20T00:01:00.000Z",
      at: "2026-06-20T00:01:00.000Z",
      type: "skill_loaded",
      summary: "skill_loaded: code-review source=packaged path=/repo/skills/code-review/SKILL.md. reason=Workflow declared code-review.",
      replaySafe: true,
      data: {
        skill: {
          name: "code-review",
          source: "packaged",
          path: "/repo/skills/code-review/SKILL.md",
        },
        reason: "Workflow declared code-review.",
      },
    });
    await writeRunLedger(path.join(runLedgerDir, "review-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("code-review", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "code-review":/);
    assert.match(messages[0] ?? "", /- review-1 started review/);

    messages.length = 0;
    await handlers.runList(
      "review-1:skill_loaded:code-review:2026-06-20T00:01:00.000Z",
      fakeCtx(tempDir),
    );

    assert.match(
      messages[0] ?? "",
      /Khala run ledger matching "review-1:skill_loaded:code-review:2026-06-20t00:01:00.000z":/,
    );
    assert.match(messages[0] ?? "", /- review-1 started review/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list filters by tool metadata text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-tool-filter-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "tool-1",
      type: "run",
      input: "edit files",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push({
      id: "tool-1:tool_call",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "tool call completed",
      replaySafe: false,
      data: {
        toolName: "apply_patch",
        metadata: {
          name: "apply_patch",
          evidenceClass: "none",
          mutationClass: "filesystem",
          sideEffectClass: "mutation",
          replaySafe: false,
          memoryRefreshRequirement: "required_before_mutation",
        },
        input: {
          path: "extensions/runtime/run-ledger.ts",
          query: "persist tool input",
        },
        workflowStep: {
          index: 1,
          id: "patch-ledger",
          action: "Persist run ledger tool context",
          status: "active",
          totalSteps: 3,
        },
        skill: {
          name: "python-developer",
          source: "user",
          path: "/home/morgoth/.codex/skills/python-developer/SKILL.md",
        },
        reason: "matched Python workflow",
      },
    });
    await writeRunLedger(path.join(runLedgerDir, "tool-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList("required_before_mutation", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "required_before_mutation":/);
    assert.match(messages[0] ?? "", /- tool-1 started run/);

    messages.length = 0;
    await handlers.runList("persist tool input", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "persist tool input":/);
    assert.match(messages[0] ?? "", /- tool-1 started run/);

    messages.length = 0;
    await handlers.runList("patch-ledger", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "patch-ledger":/);
    assert.match(messages[0] ?? "", /- tool-1 started run/);

    messages.length = 0;
    await handlers.runList("step=2/3:patch-ledger", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "step=2\/3:patch-ledger":/);
    assert.match(messages[0] ?? "", /- tool-1 started run/);

    messages.length = 0;
    await handlers.runList("persist run ledger tool context", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "persist run ledger tool context":/);
    assert.match(messages[0] ?? "", /- tool-1 started run/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-show renders tool metadata on recent events", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-show-tool-metadata-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "tool-show-1",
      type: "run",
      input: "edit files",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push({
      id: "tool-show-1:tool_call",
      at: "2026-06-20T00:01:00.000Z",
      type: "tool_call",
      summary: "applied patch",
      data: {
        toolName: "apply_patch",
        metadata: {
          name: "apply_patch",
          evidenceClass: "none",
          mutationClass: "filesystem",
          sideEffectClass: "mutation",
          replaySafe: false,
          memoryRefreshRequirement: "required_before_mutation",
        },
        input: {
          path: "extensions/runtime/run-ledger.ts",
          query: "persist tool input",
        },
        workflowStep: {
          index: 1,
          id: "patch-ledger",
          action: "Persist run ledger tool context",
          status: "active",
          totalSteps: 3,
        },
        skill: {
          name: "python-developer",
          source: "user",
          path: "/home/morgoth/.codex/skills/python-developer/SKILL.md",
          reason: "matched Python workflow",
        },
      },
    });
    await writeRunLedger(path.join(runLedgerDir, "tool-show-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("tool-show-1", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /tool_call tool=apply_patch evidence=local mutation=filesystem side_effect=mutation replay_safe=false memory_refresh=required_before_mutation gate=counts_task_tool_call,ages_memory input_keys=path,query/,
    );
    assert.match(
      messages[0] ?? "",
      /step=2\/3:patch-ledger step_status=active step_action=Persist run ledger tool context/,
    );
    assert.match(
      messages[0] ?? "",
      /evidence=local mutation=filesystem side_effect=mutation replay_safe=false memory_refresh=required_before_mutation/,
    );
    assert.ok((messages[0] ?? "").includes("skill=python-developer"));
    assert.ok((messages[0] ?? "").includes("skill_source=user"));
    assert.ok((messages[0] ?? "").includes("skill_reason=matched Python workflow"));
    assert.ok(
      (messages[0] ?? "").includes(
        "skill_path=/home/morgoth/.codex/skills/python-developer/SKILL.md",
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-show renders checkpoint summary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-show-checkpoints-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "checkpoint-show-1",
      type: "debug",
      input: "resume from safe state",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push(
      {
        id: "checkpoint-show-1:checkpoint:2026-06-20T00:05:00.000Z",
        at: "2026-06-20T00:05:00.000Z",
        type: "checkpoint",
        summary: "checkpoint: earlier safe state",
        replaySafe: true,
      },
      {
        id: "checkpoint-show-1:checkpoint:2026-06-20T00:10:00.000Z",
        at: "2026-06-20T00:10:00.000Z",
        type: "checkpoint",
        summary: "checkpoint: verified current state",
        replaySafe: true,
        data: {
          reason: "verified current state",
        },
      },
    );
    await writeRunLedger(path.join(runLedgerDir, "checkpoint-show-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("checkpoint-show-1", fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /Checkpoints: count=2 latest=checkpoint-show-1:checkpoint:2026-06-20T00:10:00.000Z at=2026-06-20T00:10:00.000Z reason=verified current state/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-list renders compact checkpoint summary", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-list-checkpoints-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "checkpoint-list-1",
      type: "debug",
      input: "continue after review",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.events.push({
      id: "checkpoint-list-1:checkpoint:2026-06-20T00:05:00.000Z",
      at: "2026-06-20T00:05:00.000Z",
      type: "checkpoint",
      summary: "Checkpoint recorded: operator reviewed local diff",
      replaySafe: true,
    });
    await writeRunLedger(path.join(runLedgerDir, "checkpoint-list-1.json"), record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runList(undefined, fakeCtx(tempDir));

    assert.match(
      messages[0] ?? "",
      /checkpoints=1 latest_checkpoint=2026-06-20T00:05:00.000Z checkpoint_reason=operator reviewed local diff/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-resume queues prompt and records resume attempt for resumable run", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "review-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "review-1",
        type: "review",
        input: "review current diff",
        flags: { repo: "pesap/agents" },
        repo: "pesap/agents",
        cwd: "/repo/agents",
        source: {
          pr: 42,
          url: "https://github.com/pesap/agents/pull/42",
        },
        local: {
          worktreePath: "/repo/agents",
          capsulePath: "/tmp/review-capsule.md",
          ledgerPath: "/tmp/workon-ledger.jsonl",
        },
        startedAt: "2026-06-20T00:00:00.000Z",
        workflowState: {
          name: "review-workflow",
          objective: "Review current diff safely",
          currentStepIndex: 1,
          steps: [
            { index: 0, id: "inspect", action: "read_diff", status: "completed" },
            { index: 1, id: "summarize", action: "write_findings", status: "active" },
          ],
        },
      }),
    );
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "review-1:skill_loaded:code-review:2026-06-20T00:00:10.000Z",
        at: "2026-06-20T00:00:10.000Z",
        type: "skill_loaded",
        summary: "skill_loaded: code-review source=packaged.",
        replaySafe: true,
        data: {
          skill: {
            name: "code-review",
            source: "packaged",
          },
        },
      },
    });
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "review-1:skill_missing:security-audit:2026-06-20T00:00:20.000Z",
        at: "2026-06-20T00:00:20.000Z",
        type: "skill_missing",
        summary: "skill_missing: security-audit source=unknown.",
        replaySafe: true,
        data: {
          skill: {
            name: "security-audit",
            source: "unknown",
          },
        },
      },
    });
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "review-1:checkpoint:2026-06-20T00:00:30.000Z",
        at: "2026-06-20T00:00:30.000Z",
        type: "checkpoint",
        summary: "Checkpoint recorded: operator verified read-only state",
        replaySafe: true,
        data: {
          reason: "operator verified read-only state",
          workflowState: {
            name: "review-workflow",
            objective: "Review current diff from checkpoint",
            currentStepIndex: 0,
            steps: [
              { index: 0, id: "checkpoint-inspect", action: "read_diff", status: "active" },
              { index: 1, id: "checkpoint-summarize", action: "write_findings", status: "pending" },
            ],
          },
        },
      },
    });
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "review-1:tool:2026-06-20T00:00:40.000Z:read_file:1",
        at: "2026-06-20T00:00:40.000Z",
        type: "tool_call",
        summary: "Tool call: read_file.",
        toolName: "read_file",
        sideEffectClass: "read_only",
        replaySafe: true,
        data: {
          input: {
            path: "/repo/agents/README.md",
          },
          workflowStep: {
            index: 0,
            id: "checkpoint-inspect",
            action: "read_diff",
            status: "active",
            totalSteps: 2,
          },
        },
      },
    });
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:01:00.000Z",
      eventId: "review-1:interrupted",
      reason: "stopped after read-only work",
    });

    const sent: string[] = [];
    const notifications: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => notifications.push(message),
    });

    await handlers.runResume("review-1", fakeCtx(tempDir));

    assert.match(sent[0] ?? "", /Resume Khala run `review-1` conservatively/);
    assert.match(sent[0] ?? "", /Do not repeat uncertain mutation/);
    assert.match(sent[0] ?? "", /Next action: /);
    assert.match(sent[0] ?? "", /Safe resume context:/);
    assert.match(
      sent[0] ?? "",
      /Latest checkpoint: review-1:checkpoint:2026-06-20T00:00:30.000Z at=2026-06-20T00:00:30.000Z reason=operator verified read-only state/,
    );
    assert.match(
      sent[0] ?? "",
      /Resume boundary source: checkpoint review-1:checkpoint:2026-06-20T00:00:30.000Z at=2026-06-20T00:00:30.000Z/,
    );
    const resumeContext = (sent[0] ?? "").split("Recovery contract:")[0] ?? "";
    assert.match(resumeContext, /Run context:/);
    assert.match(resumeContext, /- Type: review/);
    assert.match(resumeContext, /- Input: review current diff/);
    assert.match(
      resumeContext,
      /- Source: pr=42 source=https:\/\/github\.com\/pesap\/agents\/pull\/42/,
    );
    assert.match(
      resumeContext,
      /- Local: worktree=\/repo\/agents capsule=\/tmp\/review-capsule\.md ledger=\/tmp\/workon-ledger\.jsonl/,
    );
    assert.match(resumeContext, /Skill context:/);
    assert.match(
      resumeContext,
      /- Skills: skill_loaded=1 skill_missing=1 sources=packaged,unknown loaded=code-review missing=security-audit/,
    );
    assert.match(resumeContext, /Replay boundary:/);
    assert.match(
      resumeContext,
      /- Boundary: checkpoint review-1:checkpoint:2026-06-20T00:00:30.000Z at=2026-06-20T00:00:30.000Z/,
    );
    assert.match(
      resumeContext,
      /Replay-safe history after boundary: review-1:tool:2026-06-20T00:00:40.000Z:read_file:1 tool_call tool=read_file evidence=local mutation=none side_effect=read_only replay_safe=true memory_refresh=not_required input=path=\/repo\/agents\/README\.md step=1\/2:checkpoint-inspect step_status=active step_action=read_diff; review-1:interrupted interrupted evidence=local side_effect=read_only replay_safe=true/,
    );
    assert.match(
      resumeContext,
      /Treat boundary and replay-safe history as already observed; only continue from the next unproven action\./,
    );
    assert.match(resumeContext, /Workflow resume state:/);
    assert.match(resumeContext, /Workflow state source: latest checkpoint snapshot/);
    assert.match(resumeContext, /Workflow state: current_step=1\/2 checkpoint-inspect/);
    assert.match(resumeContext, /Workflow objective: Review current diff from checkpoint/);
    assert.match(
      resumeContext,
      /Workflow steps: 1\.checkpoint-inspect=active; 2\.checkpoint-summarize=pending/,
    );
    assert.match(
      sent[0] ?? "",
      /Resume attempts: latest=2026-06-20T00:10:00.000Z reason=No uncertain side effects recorded after the latest checkpoint\./,
    );
    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.at(-1).type, "resume_attempted");
    assert.equal(persisted.events.at(-1).data.recovery.classification, "resumable");
    assert.deepEqual(persisted.events.at(-1).data.recovery.unsafeEventIds, []);

    await handlers.runShow("review-1", fakeCtx(tempDir));
    assert.match(
      notifications.at(-1) ?? "",
      /Resume attempts: latest=2026-06-20T00:10:00.000Z reason=No uncertain side effects recorded after the latest checkpoint\./,
    );
    assert.match(notifications.at(-1) ?? "", /resume_recovery=resumable/);
    assert.match(notifications.at(-1) ?? "", /resume_unsafe=0/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run commands render and search resume-attempt unsafe recovery details", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-attempt-unsafe-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "resume-history-1.json");
    const record = buildRunLedgerRecord({
      version: 1,
      id: "resume-history-1",
      type: "ship",
      input: "ship branch",
      flags: {},
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:20:00.000Z";
    record.events.push({
      id: "resume-history-1:resume_attempted:2026-06-20T00:10:00.000Z",
      at: "2026-06-20T00:10:00.000Z",
      type: "resume_attempted",
      summary: "Operator requested conservative run resume.",
      replaySafe: true,
      data: {
        recovery: {
          classification: "needs_operator_review",
          reason: "Unsafe side effects require review.",
          recommendedAction:
            "Review unsafe events before resuming; do not repeat uncertain side effects.",
          unsafeEventIds: ["resume-history-1:mutation"],
          unsafeEvents: [
            {
              id: "resume-history-1:mutation",
              reason: "not explicitly replay-safe; shell side effect",
              toolName: "bash",
              sideEffectClass: "shell",
              replaySafe: false,
              mutationClass: "shell",
              memoryRefreshRequirement: "required_before_mutation",
            },
          ],
        },
      },
    });
    await writeRunLedger(runFile, record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:30:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("resume-history-1", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /resume_recovery=needs_operator_review/);
    assert.match(messages[0] ?? "", /resume_unsafe=1/);
    assert.match(
      messages[0] ?? "",
      /resume_unsafe_reason=not explicitly replay-safe; shell side effect/,
    );

    messages.length = 0;
    await handlers.runList("shell side effect", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "shell side effect":/);
    assert.match(messages[0] ?? "", /- resume-history-1 completed ship/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-resume does not queue active started runs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-active-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "active-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "active-1",
        type: "debug",
        input: "continue active investigation",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );

    const sent: string[] = [];
    const notifications: Array<{ message: string; type: string }> = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message, type) => notifications.push({ message, type }),
    });

    await handlers.runResume("active-1", fakeCtx(tempDir));

    assert.deepEqual(sent, []);
    assert.equal(notifications[0]?.type, "error");
    assert.match(notifications[0]?.message ?? "", /Run active-1 is still active/);
    assert.match(notifications[0]?.message ?? "", /Continue the active run/);
    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-resume labels workflow state from initial start snapshot when no checkpoint exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-start-state-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "debug-1.json");
    const workflowState = {
      name: "debug-workflow",
      objective: "Investigate failing test",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "inspect", action: "read_logs", status: "active" },
        { index: 1, id: "validate", action: "run_tests", status: "pending" },
      ],
    };
    await writeRunLedger(
      runFile,
      {
        ...buildRunLedgerRecord({
          version: 1,
          id: "debug-1",
          type: "debug",
          input: "investigate failing test",
          flags: {},
          startedAt: "2026-06-20T00:00:00.000Z",
          events: [
            buildRunLedgerWorkflowStartedEvent({
              workflowId: "debug-1",
              workflowType: "debug",
              at: "2026-06-20T00:00:00.000Z",
              workflowState,
            }),
          ],
        }),
        workflow: {
          type: "debug",
          input: "investigate failing test",
          flags: {},
        },
      },
    );
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:01:00.000Z",
      eventId: "debug-1:interrupted",
      reason: "stopped after read-only planning",
    });

    const sent: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: () => undefined,
    });

    await handlers.runResume("debug-1", fakeCtx(tempDir));

    const resumeContext = (sent[0] ?? "").split("Recovery contract:")[0] ?? "";
    assert.match(resumeContext, /Latest checkpoint: none recorded/);
    assert.match(
      resumeContext,
      /Resume boundary source: workflow_started debug-1:workflow_started at=2026-06-20T00:00:00.000Z/,
    );
    assert.match(resumeContext, /Workflow state source: initial workflow_started snapshot/);
    assert.match(resumeContext, /Workflow state: current_step=1\/2 inspect/);
    assert.match(resumeContext, /Workflow objective: Investigate failing test/);
    assert.match(resumeContext, /Workflow steps: 1\.inspect=active; 2\.validate=pending/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-resume prefers interrupted workflow state when no checkpoint exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-interrupted-state-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "debug-1.json");
    const startedState = {
      name: "debug-workflow",
      objective: "Investigate failing test",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "inspect", action: "read_logs", status: "active" },
        { index: 1, id: "validate", action: "run_tests", status: "pending" },
      ],
    };
    const interruptedState = {
      name: "debug-workflow",
      objective: "Validate the suspected fix",
      currentStepIndex: 1,
      steps: [
        { index: 0, id: "inspect", action: "read_logs", status: "completed" },
        { index: 1, id: "validate", action: "run_tests", status: "active" },
      ],
    };
    await writeRunLedger(
      runFile,
      {
        ...buildRunLedgerRecord({
          version: 1,
          id: "debug-1",
          type: "debug",
          input: "investigate failing test",
          flags: {},
          startedAt: "2026-06-20T00:00:00.000Z",
          events: [
            buildRunLedgerWorkflowStartedEvent({
              workflowId: "debug-1",
              workflowType: "debug",
              at: "2026-06-20T00:00:00.000Z",
              workflowState: startedState,
            }),
          ],
        }),
        workflow: {
          type: "debug",
          input: "investigate failing test",
          flags: {},
        },
      },
    );
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:01:00.000Z",
      eventId: "debug-1:interrupted",
      reason: "stopped after read-only validation planning",
      workflowState: interruptedState,
    });

    const sent: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: () => undefined,
    });

    await handlers.runResume("debug-1", fakeCtx(tempDir));

    const resumeContext = (sent[0] ?? "").split("Recovery contract:")[0] ?? "";
    assert.match(resumeContext, /Latest checkpoint: none recorded/);
    assert.match(
      resumeContext,
      /Resume boundary source: workflow_started debug-1:workflow_started at=2026-06-20T00:00:00.000Z/,
    );
    assert.match(resumeContext, /Workflow state source: latest interrupted snapshot/);
    assert.match(resumeContext, /Workflow state: current_step=2\/2 validate/);
    assert.match(resumeContext, /Workflow objective: Validate the suspected fix/);
    assert.match(resumeContext, /Workflow steps: 1\.inspect=completed; 2\.validate=active/);
    assert.doesNotMatch(resumeContext, /Workflow objective: Investigate failing test/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-resume blocks unsafe interrupted runs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-resume-block-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "ship-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "ship-1",
        type: "ship",
        input: "ship branch",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "ship-1:mutation",
        at: "2026-06-20T00:01:00.000Z",
        type: "mutation",
        summary: "mutating shell",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
        data: {
          metadata: {
            name: "bash",
            evidenceClass: "local",
            mutationClass: "filesystem",
            sideEffectClass: "shell",
            replaySafe: false,
            memoryRefreshRequirement: "not_required",
            gateSatisfaction: {
              countsTaskToolCall: true,
              agesMemory: true,
              satisfiesMemoryRead: false,
              persistsMemory: false,
            },
          },
          input: {
            command: "touch changed.txt",
            cwd: "/repo/agents",
          },
          workflowStep: {
            index: 1,
            id: "publish",
            action: "Create release commit",
            status: "active",
            totalSteps: 3,
          },
        },
      },
    });
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:02:00.000Z",
      eventId: "ship-1:interrupted",
      reason: "stopped after mutation",
    });

    const sent: string[] = [];
    const notifications: Array<{ message: string; type: string }> = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message, type) => notifications.push({ message, type }),
    });

    await handlers.runResume("ship-1", fakeCtx(tempDir));

    assert.match(
      notifications[0]?.message ?? "",
      /ship-1:mutation review_reason=not explicitly replay-safe; shell side effect.*tool=bash evidence=none mutation=shell side_effect=shell replay_safe=false/,
    );
    assert.match(notifications[0]?.message ?? "", /input_keys=command,cwd/);
    assert.match(
      notifications[0]?.message ?? "",
      /step=2\/3:publish step_status=active step_action=Create release commit/,
    );
    assert.match(
      notifications[0]?.message ?? "",
      /evidence=none mutation=shell side_effect=shell replay_safe=false memory_refresh=required_before_mutation/,
    );
    assert.match(notifications[0]?.message ?? "", /gate=counts_task_tool_call,ages_memory/);
    assert.equal(sent.length, 0);
    assert.equal(notifications[0]?.type, "error");
    assert.match(notifications[0]?.message ?? "", /not safe to resume/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-show renders structured completion details for completed runs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-ledger-completion-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "complete-1.json");
    const record = buildRunLedgerRecord({
      version: 7,
      id: "complete-1",
      type: "debug",
      input: "investigate failure",
      flags: {},
      repo: "pesap/agents",
      cwd: "/repo/agents",
      startedAt: "2026-06-20T00:00:00.000Z",
    });
    record.status = "completed";
    record.finishedAt = "2026-06-20T00:10:00.000Z";
    record.structuredCompletion = {
      outcome: "success",
      confidence: 0.92,
      validation: ["npm test passed"],
      openQuestions: ["Should resume get a CLI command?"],
      learningCandidates: ["Keep workflow state in run ledgers."],
    };
    record.workflow.state = {
      name: "debug-workflow",
      objective: "Investigate and fix the failing test",
      currentStepIndex: 1,
      steps: [
        { index: 0, id: "inspect", action: "gather_evidence", status: "completed" },
        { index: 1, id: "validate", action: "run_tests", status: "active" },
      ],
    };
    await writeRunLedger(runFile, record);

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runShow("complete-1", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Completion: outcome=success confidence=0\.92/);
    assert.match(messages[0] ?? "", /Workflow state: current_step=2\/2 validate/);
    assert.match(messages[0] ?? "", /Workflow objective: Investigate and fix the failing test/);
    assert.match(messages[0] ?? "", /Workflow steps: 1\.inspect=completed; 2\.validate=active/);
    assert.match(messages[0] ?? "", /Validation: npm test passed/);
    assert.match(messages[0] ?? "", /Open questions: Should resume get a CLI command\?/);
    assert.match(messages[0] ?? "", /Learning candidates: Keep workflow state in run ledgers\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-checkpoint appends a replay-safe checkpoint event", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-checkpoint-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "investigate failing test",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
        workflowState: {
          objective: "Investigate failing test",
          currentStepIndex: 0,
          steps: [
            { index: 0, id: "inspect", action: "read_logs", status: "active" },
          ],
        },
      }),
    );

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:20:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runCheckpoint("debug-1 validated current state", fakeCtx(tempDir));

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.at(-1).type, "checkpoint");
    assert.equal(persisted.events.at(-1).summary, "Checkpoint recorded: validated current state");
    assert.equal(persisted.events.at(-1).replaySafe, true);
    assert.deepEqual(persisted.events.at(-1).data.workflowState, {
      objective: "Investigate failing test",
      currentStepIndex: 0,
      steps: [
        { index: 0, id: "inspect", action: "read_logs", status: "active" },
      ],
    });
    assert.match(messages[0] ?? "", /Recorded checkpoint debug-1:checkpoint:2026-06-20T00:20:00.000Z/);
    assert.match(messages[0] ?? "", /Recovery: resumable\./);
    assert.match(messages[0] ?? "", /Unsafe events remaining: 0\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-checkpoint refreshes interrupted run recovery classification", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-run-checkpoint-refresh-"));
  try {
    const runLedgerDir = path.join(tempDir, "runs");
    const runFile = path.join(runLedgerDir, "debug-1.json");
    await writeRunLedger(
      runFile,
      buildRunLedgerRecord({
        version: 1,
        id: "debug-1",
        type: "debug",
        input: "debug issue",
        flags: {},
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await appendRunLedgerEvent({
      runFile,
      event: {
        id: "debug-1:shell",
        at: "2026-06-20T00:01:00.000Z",
        type: "tool_call",
        summary: "shell command",
        toolName: "bash",
        sideEffectClass: "shell",
        replaySafe: false,
      },
    });
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:02:00.000Z",
      eventId: "debug-1:interrupted",
      reason: "stopped after shell",
    });

    const messages: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: () => undefined } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:03:00.000Z",
      notify: (_ctx, message) => messages.push(message),
    });

    await handlers.runCheckpoint("debug-1 operator verified checkpoint", fakeCtx(tempDir));

    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.status, "resumable");
    assert.equal(persisted.resume.classification, "resumable");
    assert.deepEqual(persisted.resume.unsafeEventIds, []);
    assert.match(messages[0] ?? "", /Recorded checkpoint debug-1:checkpoint:2026-06-20T00:03:00.000Z/);
    assert.match(messages[0] ?? "", /Recovery: resumable\./);
    assert.match(messages[0] ?? "", /Unsafe events remaining: 0\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
