import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunLedgerCommandHandlers } from "../../extensions/commands/run-ledger.ts";
import {
  appendRunLedgerEvent,
  buildRunLedgerRecord,
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
            id: "skills-1:skill_loaded:code-review:2026-06-20T00:01:00.000Z",
            at: "2026-06-20T00:01:00.000Z",
            type: "skill_loaded",
            summary: "skill_loaded: code-review source=packaged.",
            data: {
              skill: {
                name: "code-review",
                source: "packaged",
              },
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
      /Skills: skill_loaded=1 skill_missing=1 sources=packaged,unknown missing=debugging/,
    );
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
    assert.match(messages[0] ?? "", /- debug-1 started debug at=2026-06-20T00:00:00.000Z recovery=resumable input=investigate failing test/);
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
    assert.match(messages[0] ?? "", /ledger event ids\/timestamps\/text/);
    assert.match(messages[0] ?? "", /skill metadata/);
    assert.match(messages[0] ?? "", /tool metadata/);
    assert.match(messages[0] ?? "", /\/run-list needs_operator_review/);
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
            command: "npm test",
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
    assert.match(messages[0] ?? "", /review_reason=Run has uncertain/);
    assert.doesNotMatch(messages[0] ?? "", /debug-1/);

    messages.length = 0;
    await handlers.runList("uncertain mutation", fakeCtx(tempDir));

    assert.match(messages[0] ?? "", /Khala run ledger matching "uncertain mutation":/);
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
      toolName: "apply_patch",
      sideEffectClass: "mutation",
      replaySafe: false,
      data: {
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
      /tool_call tool=apply_patch side_effect=mutation replay_safe=false input_keys=path,query/,
    );
    assert.match(
      messages[0] ?? "",
      /evidence=none mutation=filesystem side_effect=mutation replay_safe=false memory_refresh=required_before_mutation/,
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
        startedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await markRunInterrupted({
      runFile,
      at: "2026-06-20T00:01:00.000Z",
      eventId: "review-1:interrupted",
      reason: "stopped after read-only work",
    });

    const sent: string[] = [];
    const handlers = createRunLedgerCommandHandlers({
      pi: { sendUserMessage: (message: string) => sent.push(message) } as never,
      runLedgerDir,
      nowIso: () => "2026-06-20T00:10:00.000Z",
      notify: () => undefined,
    });

    await handlers.runResume("review-1", fakeCtx(tempDir));

    assert.match(sent[0] ?? "", /Resume Khala run `review-1` conservatively/);
    assert.match(sent[0] ?? "", /Do not repeat uncertain mutation/);
    assert.match(sent[0] ?? "", /Next action: /);
    const persisted = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(persisted.events.at(-1).type, "resume_attempted");
    assert.equal(persisted.events.at(-1).data.recovery.classification, "resumable");
    assert.deepEqual(persisted.events.at(-1).data.recovery.unsafeEventIds, []);
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
            command: "npm test",
            cwd: "/repo/agents",
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
      /ship-1:mutation tool=bash side_effect=shell replay_safe=false/,
    );
    assert.match(notifications[0]?.message ?? "", /input_keys=command,cwd/);
    assert.match(
      notifications[0]?.message ?? "",
      /evidence=local mutation=filesystem side_effect=shell replay_safe=false memory_refresh=not_required/,
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
