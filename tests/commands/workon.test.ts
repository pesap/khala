import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildWorkonBranchName,
  createExecFileRunner,
  DEFAULT_WORKON_MODEL_SELECTION,
  isActiveZellijEnv,
  prepareWorkonBootstrap,
  type WorkonCommandRunner,
} from "../../extensions/commands/workon.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";

let defaultPiPathDir: string | null = null;
let previousPath: string | undefined;

before(async () => {
  defaultPiPathDir = await mkdtemp(path.join(tmpdir(), "khala-workon-default-pi-"));
  previousPath = process.env.PATH;
  await writeFile(
    path.join(defaultPiPathDir, "pi"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\n'
  printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
fi
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${defaultPiPathDir}${path.delimiter}${previousPath ?? ""}`;
  resetKhalaProfileDiscoveryForTests();
});

after(async () => {
  resetKhalaProfileDiscoveryForTests();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (defaultPiPathDir) await rm(defaultPiPathDir, { force: true, recursive: true });
});

function fakeGhRunner(outputs: Record<string, string>): {
  calls: string[];
  runner: WorkonCommandRunner;
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (command, args) => {
      const key = command === "gh" ? args.join(" ") : `${command} ${args.join(" ")}`;
      calls.push(key);
      if (command === "zellij" && args[0] === "action" && args[1] === "new-pane") {
        return { ok: true, stdout: "terminal_99\n", stderr: "" };
      }
      if (command === "bash" && args[0]?.endsWith("scripts/workon-zellij-handoff.sh")) {
        const branch = args[args.indexOf("--branch") + 1];
        const repo = args[args.indexOf("--repo") + 1];
        const heartbeat = args[args.indexOf("--heartbeat") + 1];
        const modelIndex = args.indexOf("--model");
        const model = modelIndex >= 0 ? args[modelIndex + 1] : "";
        const modelArgs = model ? ` --model ${model}` : "";
        const thinkingIndex = args.indexOf("--thinking");
        const thinking = thinkingIndex >= 0 ? args[thinkingIndex + 1] : "";
        const thinkingArgs = thinking ? ` --thinking ${thinking}` : "";
        const worktreePath = "/tmp/worktrunk.feat-65";
        if (branch.includes("tab-created-pi-pane")) {
          return {
            ok: false,
            stdout: `${JSON.stringify({
              status: "blocked",
              reason: "tab-not-found",
              path: worktreePath,
              tabName: "agents/fix-67-tab-created-pi-pane-missing",
            })}\n`,
            stderr: "Zellij Worktrunk tab not found after 50 attempts: agents/fix-67-tab-created-pi-pane-missing\n",
          };
        }
        if (branch.includes("preflight-github-copilot-auth")) {
          const detail = `Pi model auth preflight failed for ${model} with PI_CODING_AGENT_DIR=/tmp/empty-pi-agent (auth path: /tmp/empty-pi-agent/auth.json). Run /login github-copilot using that Pi config directory, set PI_CODING_AGENT_DIR to the intended config, or pass --model for a configured provider.`;
          return {
            ok: false,
            stdout: "",
            stderr: `${JSON.stringify({
              status: "blocked",
              reason: "pi-auth-preflight-failed",
              detail,
            })}\n${detail}\n`,
          };
        }
        if (branch.includes("prevent-zellij-handoff-timeout")) {
          return {
            ok: false,
            stdout: "",
            stderr: "",
            error: `Command failed: bash ${args[0]} --repo ${repo} --branch ${branch} --prompt ## Deterministic /workon route --heartbeat 1.0\n<redacted>`,
            exitCode: "ETIMEDOUT",
            signal: "SIGTERM",
            killed: true,
            timedOut: true,
            timeoutMs: 41_500,
          };
        }
        if (branch.includes("honor-zellij-handoff-timeout")) {
          return {
            ok: false,
            stdout: "",
            stderr: "",
            error: `Command failed: bash ${args[0]} --repo ${repo} --branch ${branch} --prompt ## Deterministic /workon route --heartbeat 1.0\n<redacted>`,
            exitCode: null,
            signal: "SIGTERM",
            killed: true,
            timedOut: true,
            timeoutMs: 41_500,
          };
        }
        if (branch.includes("no-json-handoff-failure")) {
          return {
            ok: false,
            stdout: "",
            stderr: "zellij socket unavailable\n",
            exitCode: 1,
          };
        }
        if (branch.includes("structured-handoff-failure")) {
          const prompt = args[args.indexOf("--prompt") + 1] ?? "";
          const detail = `Zellij Worktrunk tab not found after 1 attempts: agents/fix-182-structured-handoff-failure`;
          return {
            ok: false,
            stdout: "",
            stderr: `${JSON.stringify({
              status: "blocked",
              reason: "tab-not-found",
              detail,
              path: "/tmp/worktrunk.feat-182",
              tabName: "agents/fix-182-structured-handoff-failure",
              tabId: 44,
              piPaneId: "terminal_91",
              piPaneAction: `zellij action new-pane --tab-id 44 --name pi --cwd /tmp/worktrunk.feat-182 -- pi -a --name ${branch}${modelArgs}${thinkingArgs} <clean-prompt>`,
              heartbeatPaneId: "terminal_92",
              heartbeatAction: `zellij action new-pane --tab-id 44 --name forge-heartbeat --cwd /tmp/worktrunk.feat-182 -- bash scripts/workon-forge-heartbeat.sh --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me --notify-pane terminal_99`,
              worktreeAction: `zellij action new-pane --tab-id 44 --name worktree --cwd /tmp/worktrunk.feat-182 -- wt switch --create ${branch} --format json`,
              piHandoffCommand: `zellij action new-pane --tab-id 44 --name pi --cwd /tmp/worktrunk.feat-182 -- pi -a --name ${branch}${modelArgs}${thinkingArgs} <clean-prompt>`,
              heartbeatCommand: `zellij action new-pane --tab-id 44 --name forge-heartbeat --cwd /tmp/worktrunk.feat-182 -- bash scripts/workon-forge-heartbeat.sh --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me --notify-pane terminal_99`,
            })}\n`,
            error: `Command failed: bash ${args[0]} --repo ${repo} --branch ${branch} --prompt ## Deterministic /workon route --heartbeat 1.0\n${prompt}`,
            exitCode: 1,
          };
        }
        return {
          ok: true,
          stdout: `${JSON.stringify({
            status: "launched",
            path: worktreePath,
            tabName: "agents/feat-65-detect-local-worktrees-stale",
            tabId: 12,
            heartbeatCommand: `zellij action new-pane --tab-id 12 --name forge-heartbeat --cwd ${worktreePath} -- bash scripts/workon-forge-heartbeat.sh --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me --notify-pane terminal_99`,
            piHandoffCommand: `zellij action new-pane --tab-id 12 --name pi --cwd ${worktreePath} -- pi -a --name ${branch}${modelArgs}${thinkingArgs} <clean-prompt>`,
            repo,
          })}\n`,
          stderr: "",
        };
      }
      const stdout = outputs[key];
      return stdout === undefined
        ? { ok: false, stdout: "", stderr: `missing fake output for ${key}` }
        : { ok: true, stdout, stderr: "" };
    },
  };
}

function readyIssueBody(title: string, body = ""): string {
  const sections = [body || "## Acceptance criteria\n\n- Add or update focused tests for the changed behavior."];
  if (/\b(fix|bug|broken|fail|failure|error|regression)\b/i.test(title) && !/Reproduction|Current behavior|repro/i.test(body)) {
    sections.push("## Reproduction\n\n- Reproduce the reported behavior with a failing regression test.");
  }
  if (!/Validation|Testing|Test plan/i.test(body)) {
    sections.push("## Validation\n\n- Run the focused regression test for the changed behavior.");
  }
  if (!/Non-goals|Out of scope/i.test(body)) {
    sections.push("## Non-goals\n\n- Do not widen scope beyond this issue.");
  }
  return sections.filter(Boolean).join("\n\n");
}

function issueViewOutput(number: number, title: string, body = ""): string {
  return JSON.stringify({
    number,
    title,
    url: `https://github.com/pesap/agents/issues/${number}`,
    state: "OPEN",
    body: readyIssueBody(title, body),
    labels: [{ name: "enhancement" }],
    assignees: [{ login: "pesap" }],
    author: { login: "pesap" },
  });
}

function enterpriseIssueViewOutput(number: number, title: string, body = ""): string {
  return JSON.stringify({
    number,
    title,
    url: `https://github.nrel.gov/org/repo/issues/${number}`,
    state: "OPEN",
    body: readyIssueBody(title, body),
    labels: [{ name: "enhancement" }],
    assignees: [{ login: "pesap" }],
    author: { login: "pesap" },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROMPT_USAGE_TEXT = "  --prompt TEXT [--heartbeat HOURS] [--model MODEL] [--thinking LEVEL]";

function incompleteIssueViewOutput(number: number, title: string, body = ""): string {
  return JSON.stringify({
    number,
    title,
    url: `https://github.com/pesap/agents/issues/${number}`,
    state: "OPEN",
    body,
    labels: [{ name: "bug" }],
    assignees: [{ login: "pesap" }],
    author: { login: "pesap" },
  });
}

async function readHandoffLedger(rendered: string): Promise<Record<string, unknown>> {
  const ledgerPath = rendered.match(/Handoff ledger: (.+)/)?.[1]?.trim();
  assert.ok(ledgerPath);
  return JSON.parse(await readFile(ledgerPath, "utf8"));
}

test("detects active Zellij from non-empty environment values", () => {
  assert.equal(isActiveZellijEnv(undefined), false);
  assert.equal(isActiveZellijEnv(""), false);
  assert.equal(isActiveZellijEnv("   "), false);
  assert.equal(isActiveZellijEnv("0"), true);
  assert.equal(isActiveZellijEnv(" false "), true);
  assert.equal(isActiveZellijEnv("NO"), true);
  assert.equal(isActiveZellijEnv("off"), true);
  assert.equal(isActiveZellijEnv("1"), true);
  assert.equal(isActiveZellijEnv("/tmp/zellij-session"), true);
});

test("builds bounded Conventional Commit-style branch names", () => {
  assert.equal(
    buildWorkonBranchName({
      number: 63,
      title: "feat(inbox): render deterministic maintainer queue locally",
    }),
    "feat/63-render-deterministic-maintainer-queue",
  );
  assert.equal(
    buildWorkonBranchName({ number: 5, title: "Investigate flaky parser" }),
    "work/5-investigate-flaky-parser",
  );
  assert.equal(
    buildWorkonBranchName([
      { number: 104, title: "fix(workon): improve handoff recovery" },
      { number: 105, title: "fix(workon): validate handoff recovery" },
    ]),
    "fix/104-105-handoff-recovery",
  );
  assert.equal(
    buildWorkonBranchName([
      { number: 93, title: "fix(workon): restore feedback heartbeat" },
      { number: 95, title: "fix(workon): validate feedback heartbeat" },
    ]),
    "fix/93-multi-feedback-heartbeat",
  );
  assert.equal(
    buildWorkonBranchName([
      { number: 170, title: "refactor(workon): simplify workon bootstrap" },
      { number: 171, title: "docs(workon): document workon bootstrap" },
    ]),
    "work/170-171-workon-bootstrap",
  );
});

test("createExecFileRunner honors explicit timeout options", async () => {
  const runner = createExecFileRunner();
  const started = Date.now();
  const result = await runner(
    process.execPath,
    ["-e", "setTimeout(() => {}, 3000)"],
    { cwd: process.cwd(), timeoutMs: 250 },
  );
  const elapsedMs = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.timeoutMs, 250);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.killed, true);
  assert.ok(elapsedMs < 1500, `expected timeout before 1500ms, got ${elapsedMs}ms`);
});

test("prepares GitHub issue workon capsule in global repo path", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 63 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        63,
        "feat(inbox): render deterministic maintainer queue locally",
        "## Acceptance criteria\n\n- Render collected inbox items into canonical buckets.\n- Emit top 3 next commands deterministically.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "63",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.ok(
      calls.includes(
        "issue view 63 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees",
      ),
    );
    assert.match(rendered, /Source issue: pesap\/agents#63/);
    assert.match(
      rendered,
      /Suggested branch: feat\/63-render-deterministic-maintainer-queue/,
    );

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.equal(
      capsulePath,
      path.join(tempDir, "github.com", "pesap", "agents", "capsule.md"),
    );
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Issue number: #63/);
    assert.match(capsule, /Branch: feat\/63-render-deterministic-maintainer-queue/);
    assert.match(capsule, /Worktree status: prepared/);
    assert.match(capsule, /Pi handoff command: \(not launched\)/);
    assert.match(capsule, /Render collected inbox items into canonical buckets/);
    assert.match(capsule, /I want to discuss and possibly work on: feat\(inbox\): render deterministic maintainer queue locally/);
    assert.match(capsule, /Before doing any implementation:/);
    assert.match(capsule, /workon-handoff-ack\.sh/);
    assert.match(capsule, /--status capsule-acknowledged/);
    assert.match(capsule, /Draft PR and feedback heartbeat:/);
    assert.match(capsule, /check the PR\/issue forge for human feedback every 1\.0/);
    assert.match(capsule, /implement the smallest vertical slice for pesap\/agents#63/);
    assert.doesNotMatch(capsule, /combined source issue set/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("stores workon state under the resolved forge host", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-forge-host-test-"));
  try {
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 63 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        63,
        "feat(inbox): render deterministic maintainer queue locally",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "63",
        repo: "pesap/agents",
        forge: "github",
        forgeHost: "github.enterprise.example",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(
      rendered,
      new RegExp(`${escapeRegExp(path.join(tempDir, "github.enterprise.example", "pesap", "agents", "capsule.md"))}`),
    );
    assert.match(
      rendered,
      new RegExp(`${escapeRegExp(path.join(tempDir, "github.enterprise.example", "pesap", "agents", "handoff-ledger.json"))}`),
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("prepares GitHub Enterprise issue URL with host-aware gh repo and state paths", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-enterprise-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status --hostname github.nrel.gov": "",
      "issue view 123 --repo github.nrel.gov/org/repo --json number,title,url,body,state,author,labels,assignees": enterpriseIssueViewOutput(
        123,
        "feat(workon): support enterprise URLs",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "https://github.nrel.gov/org/repo/issues/123",
        repo: "",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.deepEqual(calls.slice(0, 2), [
      "auth status --hostname github.nrel.gov",
      "issue view 123 --repo github.nrel.gov/org/repo --json number,title,url,body,state,author,labels,assignees",
    ]);
    assert.match(rendered, /Source issue: org\/repo#123/);
    assert.match(
      rendered,
      new RegExp(`${escapeRegExp(path.join(tempDir, "github.nrel.gov", "org", "repo", "capsule.md"))}`),
    );
    assert.match(
      rendered,
      new RegExp(`${escapeRegExp(path.join(tempDir, "github.nrel.gov", "org", "repo", "handoff-ledger.json"))}`),
    );

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Issue: https:\/\/github\.nrel\.gov\/org\/repo\/issues\/123/);
    assert.match(capsule, /Handoff ledger: .*github\.nrel\.gov.*handoff-ledger\.json/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("groups multiple GitHub Enterprise issues from one host and repo", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-enterprise-multi-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status --hostname github.nrel.gov": "",
      "issue view 123 --repo github.nrel.gov/org/repo --json number,title,url,body,state,author,labels,assignees": enterpriseIssueViewOutput(
        123,
        "fix(workon): first enterprise issue",
      ),
      "issue view 124 --repo github.nrel.gov/org/repo --json number,title,url,body,state,author,labels,assignees": enterpriseIssueViewOutput(
        124,
        "fix(workon): second enterprise issue",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "https://github.nrel.gov/org/repo/issues/123 https://github.nrel.gov/org/repo/issues/124",
        targets: [
          "https://github.nrel.gov/org/repo/issues/123",
          "https://github.nrel.gov/org/repo/issues/124",
        ],
        repo: "",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call === "auth status --hostname github.nrel.gov").length, 1);
    assert.ok(
      calls.includes(
        "issue view 124 --repo github.nrel.gov/org/repo --json number,title,url,body,state,author,labels,assignees",
      ),
    );
    assert.match(rendered, /Source issues: #123, #124/);
    assert.match(rendered, /github\.nrel\.gov/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("reports a host-specific GitHub Enterprise auth error", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-enterprise-auth-test-"));
  try {
    const { calls, runner } = fakeGhRunner({});

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "https://github.nrel.gov/org/repo/issues/123",
        repo: "",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.deepEqual(calls, ["auth status --hostname github.nrel.gov"]);
    assert.match(rendered, /GitHub authentication for github\.nrel\.gov: missing fake output/);
    assert.doesNotMatch(rendered, /Usage: \/workon/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("uses packaged handoff template when target cwd has no commands directory", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-external-cwd-test-"));
  try {
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 90 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        90,
        "fix: Extension command:workon ENOENT opening workon-handoff-template.md",
        "## Acceptance criteria\n\n- Add or update focused tests for the changed behavior.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: tempDir,
        target: "90",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );

    const rendered = sections.join("\n");
    assert.match(rendered, /Source issue: pesap\/agents#90/);
    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Before doing any implementation:/);
    assert.match(capsule, /workon-handoff-ack\.sh/);
    assert.match(capsule, /--status capsule-acknowledged/);
    assert.match(capsule, /Draft PR and feedback heartbeat:/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("uses package-local Zellij handoff script when target cwd has no scripts directory", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-external-zellij-test-"));
  try {
    const branch = "fix/148-package-handoff-script-robust";
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 148 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        148,
        "fix(workon): use package handoff script and robust Zellij detection",
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: tempDir,
        target: "148",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");
    const scriptCall = calls.find((call) => call.startsWith("bash ") && call.includes("scripts/workon-zellij-handoff.sh"));

    assert.ok(scriptCall);
    assert.match(scriptCall, new RegExp(`^bash ${escapeRegExp(process.cwd())}/scripts/workon-zellij-handoff\\.sh\\b`));
    assert.doesNotMatch(scriptCall, new RegExp(`^bash ${escapeRegExp(tempDir)}/scripts/workon-zellij-handoff\\.sh\\b`));
    assert.match(scriptCall, new RegExp(`--branch ${branch}`));
    assert.match(rendered, /Worktree status: launched/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("ZELLIJ=0 selects Zellij handoff path", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-zero-test-"));
  try {
    const branch = "fix/148-package-handoff-script-robust";
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 148 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        148,
        "fix(workon): use package handoff script and robust Zellij detection",
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: tempDir,
        target: "148",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: isActiveZellijEnv("0"),
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.ok(calls.some((call) => call.startsWith("bash ") && call.includes("workon-zellij-handoff.sh")));
    assert.equal(calls.includes("wt --version"), false);
    assert.equal(calls.includes(`wt switch --create ${branch} --format json`), false);
    assert.match(rendered, /Suggested Worktrunk command: cd .+ && wt switch --create fix\/148-package-handoff-script-robust --format json/);
    assert.match(rendered, /Launch eligibility: active Zellij yes/);
    assert.match(rendered, /Worktree status: launched/);
    assert.doesNotMatch(rendered, /Pi handoff skipped: active Zellij was not detected/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("infers repo and issue from GitHub issue URL", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-url-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 64 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        64,
        "feat(inbox): add GitLab maintainer queue collector",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "https://github.com/pesap/agents/issues/64",
        repo: "",
        forge: "auto",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );

    assert.equal(calls.some((call) => call.startsWith("repo view")), false);
    assert.match(sections.join("\n"), /Source issue: pesap\/agents#64/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("uses current GitHub issue context without a separate repo lookup", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-current-repo-issue-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 63 --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        63,
        "feat(inbox): render deterministic maintainer queue locally",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "63",
        repo: "",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.deepEqual(calls.slice(0, 2), [
      "auth status",
      "issue view 63 --json number,title,url,body,state,author,labels,assignees",
    ]);
    assert.equal(calls.some((call) => call.startsWith("repo view")), false);
    assert.match(rendered, /Source issue: pesap\/agents#63/);
    assert.match(rendered, /Session capsule: .+github\.com\/pesap\/agents\/capsule\.md/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("parses GitHub issue JSON when body contains literal prompt usage text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-issue-json-redaction-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 210 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        210,
        "fix(workon): preserve raw stdout before JSON parsing",
        [
          "## Current behavior",
          "",
          "- The issue body includes literal usage text that must not be interpreted as a prompt flag:",
          PROMPT_USAGE_TEXT,
          "",
          "## Acceptance criteria",
          "",
          "- Parse raw GitHub issue JSON without redaction-driven corruption.",
        ].join("\n"),
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "210",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Source issue: pesap\/agents#210/);
    assert.doesNotMatch(rendered, /failed to parse JSON/);
    assert.ok(calls.includes("issue view 210 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("parses grouped GitHub issue JSON when issue bodies contain literal prompt usage text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-grouped-issue-json-redaction-test-"));
  try {
    const issues = [
      {
        number: 209,
        title: "fix(workon): keep source issue JSON raw",
        body: [
          "## Current behavior",
          "",
          "- Baseline issue body without prompt usage text.",
          "",
          "## Acceptance criteria",
          "",
          "- Keep the source issue JSON parseable.",
          "",
          "## Validation",
          "",
          "- Run the focused workon regression test.",
          "",
          "## Non-goals",
          "",
          "- Do not widen scope beyond the parser fix.",
        ].join("\n"),
      },
      {
        number: 210,
        title: "fix(workon): preserve raw stdout before JSON parsing",
        body: [
          "## Current behavior",
          "",
          "- The issue body includes literal usage text that must not be interpreted as a prompt flag:",
          PROMPT_USAGE_TEXT,
          "",
          "## Acceptance criteria",
          "",
          "- Parse raw GitHub issue JSON without redaction-driven corruption.",
          "",
          "## Validation",
          "",
          "- Run the focused workon regression test.",
          "",
          "## Non-goals",
          "",
          "- Do not widen scope beyond the parser fix.",
        ].join("\n"),
      },
      {
        number: 211,
        title: "fix(workon): keep diagnostic redaction separate",
        body: [
          "## Current behavior",
          "",
          "- Another issue body includes literal usage text that must remain raw until parsing completes:",
          PROMPT_USAGE_TEXT,
          "",
          "## Acceptance criteria",
          "",
          "- Keep redaction in diagnostics without mutating parser input.",
          "",
          "## Validation",
          "",
          "- Run the focused workon regression test.",
          "",
          "## Non-goals",
          "",
          "- Do not widen scope beyond the parser fix.",
        ].join("\n"),
      },
    ];
    const branch = buildWorkonBranchName(issues);
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 209 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        issues[0].number,
        issues[0].title,
        issues[0].body,
      ),
      "issue view 210 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        issues[1].number,
        issues[1].title,
        issues[1].body,
      ),
      "issue view 211 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        issues[2].number,
        issues[2].title,
        issues[2].body,
      ),
      "wt --version": "worktrunk 1.0.0\n",
      [`wt switch --create ${branch} --format json`]: `{"action":"created","branch":"${branch}","path":"/tmp/worktrunk.${branch}"}\n`,
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "209 210 211",
        targets: ["209", "210", "211"],
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call.startsWith("issue view ")).length, 3);
    assert.ok(calls.some((call) => call.startsWith("wt switch --create ")));
    assert.match(rendered, /Source issues: #209, #210, #211/);
    assert.doesNotMatch(rendered, /failed to parse JSON/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks source issue reads when gh issue view returns invalid JSON", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-source-read-invalid-json-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 220 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": "{\"number\":220,\"title\":\"fix(workon): classify source-read parse failures\",\"url\":\"https://github.com/pesap/agents/issues/220\",\"body\":\"unterminated",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "220",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call.startsWith("issue view ")).length, 1);
    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.equal(calls.some((call) => call.startsWith("bash ")), false);
    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Source issue read blocked for pesap\/agents#220: parse failure/);
    assert.match(rendered, /command=gh issue view 220 --repo pesap\/agents --json number,title,url,body,state,author,labels,assignees/);
    assert.match(rendered, /raw-stdout-bytes=\d+/);
    assert.match(rendered, /parse-input-bytes=\d+/);
    assert.match(rendered, /redaction-changed-stdout=false/);
    assert.match(rendered, /parse-input-starts-with-brace=true/);
    assert.match(rendered, /parse-input-ends-with-brace=false/);
    assert.match(rendered, /parse-input-hash=[0-9a-f]{8}/);
    assert.doesNotMatch(rendered, /Only next command: \/triage <issue-url>/);
    assert.doesNotMatch(rendered, /workon-ready/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks source issue reads when gh issue view command fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-source-read-command-failure-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
    });
    const failingRunner: WorkonCommandRunner = async (command, args) => {
      const key = command === "gh" ? args.join(" ") : `${command} ${args.join(" ")}`;
      calls.push(key);
      if (command === "gh" && args[0] === "auth" && args[1] === "status") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          ok: false,
          stdout: "",
          stderr: "gh: issue view failed: not authenticated\n",
          exitCode: 1,
          rawStdout: "",
        };
      }
      return runner(command, args, { cwd: process.cwd() });
    };

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "221",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      failingRunner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call.startsWith("issue view ")).length, 1);
    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Source issue read blocked for pesap\/agents#221: gh: issue view failed: not authenticated/);
    assert.match(rendered, /command-failure=gh: issue view failed: not authenticated/);
    assert.match(rendered, /parse-input-bytes=0/);
    assert.match(rendered, /redaction-changed-stdout=false/);
    assert.doesNotMatch(rendered, /Only next command: \/triage <issue-url>/);
    assert.doesNotMatch(rendered, /workon-ready/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("preserves parseability when stdout is redacted into invalid JSON but raw stdout remains valid", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-source-read-redaction-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
    });
    const issue = {
      number: 222,
      title: "fix(workon): keep raw stdout before parsing",
      body: [
        "## Current behavior",
        "",
        "- The issue body includes literal usage text that can be redacted in diagnostics:",
        PROMPT_USAGE_TEXT,
        "",
        "## Acceptance criteria",
        "",
        "- Parse raw GitHub issue JSON without redaction-driven corruption.",
        "",
        "## Validation",
        "",
        "- Run the focused workon regression test.",
        "",
        "## Non-goals",
        "",
        "- Do not widen scope beyond the parser fix.",
      ].join("\n"),
    };
    const rawStdout = issueViewOutput(issue.number, issue.title, issue.body);
    const redactedStdout = "{\"number\":222,\"title\":\"fix(workon): keep raw stdout before parsing\",\"body\":\"<redacted>";
    const parsingRunner: WorkonCommandRunner = async (command, args) => {
      const key = command === "gh" ? args.join(" ") : `${command} ${args.join(" ")}`;
      calls.push(key);
      if (command === "gh" && args[0] === "auth" && args[1] === "status") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "issue" && args[1] === "view") {
        return {
          ok: true,
          stdout: redactedStdout,
          stderr: "",
          rawStdout,
        };
      }
      return runner(command, args, { cwd: process.cwd() });
    };

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "222",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      parsingRunner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call.startsWith("issue view ")).length, 1);
    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /Route: prepared/);
    assert.match(rendered, /Source issue: pesap\/agents#222/);
    assert.doesNotMatch(rendered, /failed to parse JSON/);
    assert.doesNotMatch(rendered, /Route: blocked/);
    assert.ok(calls.includes("issue view 222 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("groups multiple GitHub issues into one capsule and Worktrunk session", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-multi-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 104 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        104,
        "fix(workon): first issue",
        "## Current behavior\n\n- First issue needs work.\n\n## Acceptance criteria\n\n- Resolve first issue.\n\n## Validation\n\n- Run first focused test.\n\n## Non-goals\n\n- Do not widen first issue scope.",
      ),
      "issue view 105 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        105,
        "fix(workon): second issue",
        "## Current behavior\n\n- Second issue needs work.\n\n## Acceptance criteria\n\n- Resolve second issue.\n\n## Validation\n\n- Run second focused test.\n\n## Non-goals\n\n- Do not widen second issue scope.",
      ),
      "wt --version": "worktrunk 1.0.0\n",
      "wt switch --create fix/104-105-first-issue --format json":
        '{"action":"created","branch":"fix/104-105-first-issue","path":"/tmp/worktrunk.fix-104"}\n',
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "104 105",
        targets: ["104", "105"],
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.filter((call) => call.startsWith("wt switch --create")).length, 1);
    assert.match(rendered, /Source issues: #104, #105/);
    assert.match(rendered, /Suggested branch: fix\/104-105-first-issue/);

    const ledger = await readHandoffLedger(rendered);
    const sourceIssues = ledger.sourceIssues as Array<Record<string, unknown>>;
    assert.deepEqual(
      sourceIssues.map((sourceIssue) => sourceIssue.number),
      [104, 105],
    );
    assert.equal(sourceIssues[0]?.title, "fix(workon): first issue");
    assert.equal(sourceIssues[1]?.url, "https://github.com/pesap/agents/issues/105");
    assert.match(String(sourceIssues[0]?.body), /Resolve first issue/);
    assert.match(String(sourceIssues[1]?.body), /Run second focused test/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /## Combined work scope/);
    assert.match(capsule, /## Source issue details/);
    assert.match(capsule, /### #104: fix\(workon\): first issue[\s\S]*Resolve first issue/);
    assert.match(capsule, /### #105: fix\(workon\): second issue[\s\S]*Run second focused test/);
    assert.match(capsule, /one combined \/workon session/);
    assert.match(capsule, /do not create separate branches, worktrees, capsules, or sessions per issue/);
    assert.match(capsule, /https:\/\/github\.com\/pesap\/agents\/issues\/104 \(#104\) fix\(workon\): first issue/);
    assert.match(capsule, /https:\/\/github\.com\/pesap\/agents\/issues\/105 \(#105\) fix\(workon\): second issue/);
    assert.match(capsule, /## Implementation order/);
    assert.match(capsule, /provided target order unless explicit issue-body evidence supports changing it/);
    assert.match(capsule, /1\. #104: fix\(workon\): first issue/);
    assert.match(capsule, /2\. #105: fix\(workon\): second issue/);
    assert.match(capsule, /Make issue-scoped commits tied to the relevant source issue where practical/);
    assert.match(capsule, /I want to discuss and possibly work on: combined source issue set for pesap\/agents: #104, #105/);
    assert.match(capsule, /Source issues:\n- https:\/\/github\.com\/pesap\/agents\/issues\/104 \(#104\) fix\(workon\): first issue\n- https:\/\/github\.com\/pesap\/agents\/issues\/105 \(#105\) fix\(workon\): second issue/);
    assert.match(capsule, /implement the smallest vertical slice for this combined source-issue set/);
    assert.doesNotMatch(capsule, /implement the smallest vertical slice for pesap\/agents#104\./);
    assert.match(capsule, /Create a separate focused commit for each source issue where practical/);
    assert.match(capsule, /Link the draft PR back to all source issues:/);
    assert.match(capsule, /Validate every source issue expectation, not just #104:/);
    assert.match(capsule, /#104: Run first focused test/);
    assert.match(capsule, /#105: Run second focused test/);
    assert.equal(capsule.match(/## Combined work scope/g)?.length, 1);
    assert.equal(capsule.match(/## Implementation order/g)?.length, 1);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("dry-run prepares capsule and branch suggestion without starting Worktrunk", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-dry-run-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 65 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        65,
        "feat(inbox): detect local worktrees and stale sessions",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "65",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        dryRun: true,
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.equal(calls.some((call) => call.startsWith("bash ")), false);
    assert.match(rendered, /Suggested branch: feat\/65-detect-local-worktrees-stale/);
    assert.match(rendered, /Worktree status: prepared/);
    assert.match(rendered, /Dry run requested: prepared capsule and branch suggestion only/);
    assert.match(rendered, /Bootstrap phase guidance: resolve issue -> prepare capsule -> suggest branch only/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.doesNotMatch(capsule, /Mode: prepare/);
    assert.match(capsule, /Dry run: yes/);
    assert.match(capsule, /Worktree status: prepared/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal(ledger.repo, "pesap/agents");
    assert.equal(ledger.branchName, "feat/65-detect-local-worktrees-stale");
    assert.deepEqual((ledger.worktree as { status: string; path: string | null }).status, "prepared");
    assert.equal((ledger.worktree as { status: string; path: string | null }).path, null);
    assert.equal((ledger.zellij as { status: string }).status, "not-attempted");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.equal((ledger.heartbeat as { status: string }).status, "not-launched");
    assert.equal((ledger.phases as Record<string, string>).capsule, "written");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("starts Worktrunk worktree directly outside Zellij", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-start-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 65 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        65,
        "feat(inbox): detect local worktrees and stale sessions",
      ),
      "wt --version": "worktrunk 1.0.0\n",
      "wt switch --create feat/65-detect-local-worktrees-stale --format json":
        '◎ Running pre-start: direct-hook\n{"action":"created","branch":"feat/65-detect-local-worktrees-stale","path":"/tmp/worktrunk.feat-65"}\npost-start hook complete\n',
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "65",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.ok(calls.includes("wt --version"));
    assert.ok(
      calls.includes(
        "wt switch --create feat/65-detect-local-worktrees-stale --format json",
      ),
    );
    assert.match(
      rendered,
      /Suggested Worktrunk command: cd .+ && wt switch --create feat\/65-detect-local-worktrees-stale --format json/,
    );
    assert.match(rendered, /Launch eligibility: active Zellij no/);
    assert.match(rendered, /Worktree status: started/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk.feat-65/);
    assert.match(rendered, /Route: started/);
    assert.match(rendered, /Recovery command: Retry Zellij handoff from an active Zellij pane/);
    assert.match(rendered, /Handoff recovery:/);
    assert.match(rendered, new RegExp(`Retry Zellij handoff[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));
    assert.doesNotMatch(rendered, /Manual Pi restore/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(
      capsule,
      /Worktree command: cd .+ && wt switch --create feat\/65-detect-local-worktrees-stale --format json/,
    );
    assert.match(capsule, /Worktree status: started/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk.feat-65/);
    assert.match(capsule, /Launch eligibility: active Zellij no/);
    assert.match(capsule, /## Deterministic \/workon route/);
    assert.match(capsule, /Route: started/);
    assert.match(capsule, /## Handoff recovery/);
    assert.match(capsule, new RegExp(`Retry Zellij handoff[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));
    assert.doesNotMatch(capsule, /Manual Pi restore/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string; path: string | null }).status, "started");
    assert.equal((ledger.worktree as { status: string; path: string | null }).path, "/tmp/worktrunk.feat-65");
    assert.equal((ledger.launchEligibility as { activeZellij: boolean }).activeZellij, false);
    assert.equal((ledger.zellij as { status: string }).status, "skipped");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.match(String(ledger.safeNextAction), /Retry Zellij handoff/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("waits for Worktrunk Zellij tab before launching Pi pane", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-test-"));
  try {
    const branch = "feat/65-detect-local-worktrees-stale";
    const worktreePath = "/tmp/worktrunk.feat-65";
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 65 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        65,
        "feat(inbox): detect local worktrees and stale sessions",
      ),
      "wt --version": "worktrunk 1.0.0\n",
      "zellij --version": "zellij 0.43.0\n",
      [`wt switch --create ${branch} --format json`]: `◎ Running pre-start: zellij-tab\n{"action":"created","branch":"${branch}","path":"${worktreePath}"}\n`,
      "zellij action list-tabs --json": JSON.stringify([
        { name: "agents/main", tab_id: 1 },
        { name: "agents/feat-65-detect-local-worktrees-stale", tab_id: 12 },
      ]),
      "zellij action go-to-tab-name agents/feat-65-detect-local-worktrees-stale": "",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "65",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "0.25",
        modelSelection: {
          exactModel: "anthropic/claude-sonnet-4",
          exactThinkingLevel: DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel,
          routingMode: "override",
          routingReason: "explicit --model override with default workon thinking",
        },
      },
      runner,
    );
    const rendered = sections.join("\n");
    const scriptCall = calls.find((call) => call.startsWith("bash ") && call.includes("scripts/workon-zellij-handoff.sh"));

    assert.equal(calls.some((call) => call.includes(" -x pi ")), false);
    assert.equal(calls.some((call) => call.startsWith("zellij run")), false);
    assert.equal(calls.some((call) => call.includes(" @") && call.includes("capsule.md")), false);
    assert.ok(scriptCall);
    assert.match(scriptCall, /--repo pesap\/agents/);
    assert.match(scriptCall, /--branch feat\/65-detect-local-worktrees-stale/);
    assert.match(scriptCall, /--capsule .+github\.com\/pesap\/agents\/capsule\.md/);
    assert.match(scriptCall, /--prompt ## Deterministic \/workon route/);
    assert.match(scriptCall, /Route: launched/);
    assert.match(scriptCall, /I want to discuss and possibly work on:/);
    assert.match(scriptCall, /Draft PR and feedback heartbeat:/);
    assert.match(scriptCall, /--heartbeat 0\.25/);
    assert.match(scriptCall, /--model anthropic\/claude-sonnet-4/);
    assert.match(scriptCall, new RegExp(`--thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(rendered, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Model routing mode: override/);
    assert.match(rendered, /explicit --model override/);
    assert.match(rendered, /Launch eligibility: active Zellij yes/);
    assert.match(rendered, /Worktree status: launched/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane/);
    assert.match(rendered, new RegExp(`-- pi -a --name feat/65-detect-local-worktrees-stale --model anthropic/claude-sonnet-4 --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Forge heartbeat command: zellij action new-pane/);
    assert.match(rendered, /--notify-pane terminal_99/);
    assert.doesNotMatch(rendered, /--prompt I want to discuss and possibly work on:/);
    assert.match(rendered, /--prompt <redacted>/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Worktree status: launched/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(capsule, /Pi handoff command: zellij action new-pane/);
    assert.match(capsule, new RegExp(`-- pi -a --name feat/65-detect-local-worktrees-stale --model anthropic/claude-sonnet-4 --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(capsule, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Model routing mode: override/);
    assert.match(capsule, /Model routing reason: explicit --model override with default workon thinking/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string; path: string | null }).status, "launched");
    assert.equal((ledger.zellij as { status: string; tabId: number }).status, "launched");
    assert.equal((ledger.zellij as { status: string; tabId: number }).tabId, 12);
    assert.equal((ledger.pi as { status: string }).status, "pi-process-started");
    assert.equal((ledger.heartbeat as { status: string }).status, "started");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("pins the default model when launching a Worktrunk Zellij handoff", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-default-model-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 65 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        65,
        "feat(inbox): detect local worktrees and stale sessions",
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "65",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "0.25",
      },
      runner,
    );
    const rendered = sections.join("\n");
    const scriptCall = calls.find((call) => call.startsWith("bash ") && call.includes("scripts/workon-zellij-handoff.sh"));

    assert.ok(scriptCall);
    assert.match(scriptCall, new RegExp(`--model ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}`));
    assert.match(scriptCall, new RegExp(`--thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, new RegExp(`Exact model: ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}`));
    assert.match(rendered, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Model routing mode: default/);
    assert.match(rendered, /development profile/);
    assert.match(rendered, new RegExp(`Pi handoff command: .*--model ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, new RegExp(`Exact model: ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}`));
    assert.match(capsule, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Model routing reason: Khala\/workon development profile/);

    const ledger = await readHandoffLedger(rendered);
    assert.deepEqual(ledger.modelSelection, DEFAULT_WORKON_MODEL_SELECTION);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks before handoff when the default development profile is unresolved", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-unresolved-profile-test-"));
  const previousPath = process.env.PATH;
  try {
    const piPath = path.join(tempDir, "pi");
    await writeFile(
      piPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model\n'
  printf 'github-copilot gpt-5.4\n'
fi
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;
    resetKhalaProfileDiscoveryForTests();

    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 65 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        65,
        "feat(inbox): detect local worktrees and stale sessions",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "65",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "0.25",
      },
      runner,
    );
    const rendered = sections.join("\n");
    const scriptCall = calls.find((call) => call.startsWith("bash ") && call.includes("scripts/workon-zellij-handoff.sh"));

    assert.equal(scriptCall, undefined);
    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /development profile unresolved/);
    assert.match(rendered, /Run \/khala status for model profile setup guidance/);
    assert.match(rendered, /Pi handoff command: \(not launched\)/);
    assert.match(rendered, /Exact model: \(unresolved\)/);
    assert.doesNotMatch(rendered, /Handoff failure:/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string }).status, "blocked");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.equal((ledger.failure as { phase: string }).phase, "bootstrap");
    assert.match(String(ledger.safeNextAction), /\/khala status/);
  } finally {
    resetKhalaProfileDiscoveryForTests();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks before recording Pi started when the handoff auth preflight fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-auth-preflight-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 165 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        165,
        "fix(workon): preflight github-copilot auth before launching child Pi sessions",
        "## Acceptance criteria\n\n- Detect missing auth for the selected exact model before reporting a child Pi session as successfully usable.\n- The failure path does not create misleading Pi started handoff evidence when the child Pi cannot authenticate.\n\n## Validation\n\n- Add a regression test for missing github-copilot auth.\n\n## Non-goals\n\n- Do not change provider authentication globally.",
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "165",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");
    const scriptCall = calls.find((call) => call.startsWith("bash ") && call.includes("scripts/workon-zellij-handoff.sh"));

    assert.ok(scriptCall);
    assert.match(scriptCall, new RegExp(`--model ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}`));
    assert.match(rendered, /Worktree status: blocked/);
    assert.match(rendered, /Pi handoff command: \(not launched\)/);
    assert.match(rendered, new RegExp(`Pi model auth preflight failed for ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} with PI_CODING_AGENT_DIR=/tmp/empty-pi-agent`));
    assert.match(rendered, /Allowed action: report the blocked state and the operator action below/);
    assert.match(rendered, /Recovery command: \(none safe for this blocked state\)/);
    assert.match(rendered, new RegExp(`Next operator action: Human action required: authenticate ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} for Pi, then rerun /workon\\.`));
    assert.match(rendered, new RegExp(`Handoff recovery:\\n- Human action required: authenticate ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} for Pi, then rerun /workon\\.`));
    assert.doesNotMatch(rendered, /Recovery command: Retry Zellij handoff/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, new RegExp(`## Handoff recovery\\n\\n- Human action required: authenticate ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} for Pi, then rerun /workon\\.`));
    assert.match(capsule, new RegExp(`Parent recovery command: Human action required: authenticate ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} for Pi, then rerun /workon\\.`));

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string }).status, "blocked");
    assert.equal((ledger.zellij as { status: string }).status, "blocked");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.match(String(ledger.failureReason), /Pi model auth preflight failed/);
    assert.equal(String(ledger.safeNextAction), `Human action required: authenticate ${DEFAULT_WORKON_MODEL_SELECTION.exactModel} for Pi, then rerun /workon.`);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocked Zellij handoff without JSON still returns recovery and failure context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-no-json-failure-test-"));
  try {
    const branch = "fix/181-no-json-handoff-failure";
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 181 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        181,
        "fix(workon): no json handoff failure",
        [
          "## Current behavior",
          "",
          "/workon reports a blocked Zellij handoff without a recovery command.",
          "",
          "## Acceptance criteria",
          "",
          "- Return a route-owned recovery command when Zellij handoff fails before structured JSON is available.",
          "- Propagate the failed handoff diagnostic into the capsule, ledger, and child prompt.",
          "",
          "## Validation",
          "",
          "- Add a focused regression test for the no-JSON failure path.",
          "",
          "## Non-goals",
          "",
          "- Do not invent alternate Zellij launch paths.",
        ].join("\n"),
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "181",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Allowed action: run or report the one route-owned recovery command/);
    assert.match(rendered, /Worktree status: blocked/);
    assert.match(rendered, /Worktree path: \(not available\)/);
    assert.match(rendered, /Handoff failure: Zellij Pi handoff fix\/181-no-json-handoff-failure: command failed: exit code 1; stderr: zellij socket unavailable/);
    assert.match(rendered, /Recovery command: Retry Zellij handoff from an active Zellij pane/);
    assert.match(rendered, /failed before a Worktrunk path was reported/);
    assert.doesNotMatch(rendered, /Recovery command: \(not available\)/);
    assert.match(rendered, new RegExp(`--branch ${branch}`));

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /## Bootstrap failure/);
    assert.match(capsule, /Zellij Pi handoff fix\/181-no-json-handoff-failure: command failed: exit code 1; stderr: zellij socket unavailable/);
    assert.match(capsule, /Parent failure: Zellij Pi handoff fix\/181-no-json-handoff-failure/);
    assert.match(capsule, /Parent recovery command: Retry Zellij handoff from an active Zellij pane/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string; path: string | null }).status, "blocked");
    assert.equal((ledger.worktree as { status: string; path: string | null }).path, null);
    assert.match(String(ledger.safeNextAction), /Retry Zellij handoff/);
    assert.equal((ledger.failure as { phase: string }).phase, "zellij-handoff");
    assert.equal(
      (ledger.failure as { summary: string }).summary,
      "Zellij Pi handoff fix/181-no-json-handoff-failure: command failed: exit code 1; stderr: zellij socket unavailable",
    );
    assert.equal(
      (ledger.failure as { detail: string | null }).detail,
      "Zellij Pi handoff fix/181-no-json-handoff-failure: command failed: exit code 1; stderr: zellij socket unavailable",
    );
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocked Zellij handoff timeout is classified explicitly and keeps route recovery safe", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-timeout-failure-test-"));
  try {
    const branch = "fix/207-prevent-zellij-handoff-timeout";
    const { runner: baseRunner } = fakeGhRunner({
      "auth status": "",
      "issue view 207 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        207,
        "fix(workon): prevent Zellij handoff timeout from masking startup progress",
        [
          "## Current behavior",
          "",
          "/workon can report a blocked Zellij Pi handoff as a generic shell failure before the handoff script's normal wait window completes.",
          "",
          "## Acceptance criteria",
          "",
          "- Longer timeout budget for the Zellij handoff path.",
          "- Timeout diagnostics include timeout duration and command metadata.",
          "- Route/capsule/ledger identify timeout explicitly.",
          "",
          "## Validation",
          "",
          "- Add a focused regression test for the timeout failure path.",
          "",
          "## Non-goals",
          "",
          "- Do not broaden scope beyond the timeout diagnostic mismatch.",
        ].join("\n"),
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });
    let observedTimeoutMs: number | undefined;
    const runner: WorkonCommandRunner = async (command, args, options) => {
      if (command === "bash" && args[0]?.endsWith("scripts/workon-zellij-handoff.sh")) {
        observedTimeoutMs = options.timeoutMs;
      }
      return baseRunner(command, args, options);
    };

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "207",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Worktree status: blocked/);
    assert.match(rendered, /Worktree path: \(not available\)/);
    assert.match(rendered, /Handoff failure: Zellij Pi handoff fix\/207-prevent-zellij-handoff-timeout: timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(rendered, /Recovery command: Retry Zellij handoff from an active Zellij pane/);
    assert.match(rendered, /timed out while waiting for the Zellij handoff script's normal tab discovery window/);
    assert.equal(observedTimeoutMs, 41_500);
    assert.doesNotMatch(rendered, /Command failed: bash .*--prompt ## Deterministic \/workon route/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Zellij Pi handoff fix\/207-prevent-zellij-handoff-timeout: timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(capsule, /Parent failure: Zellij Pi handoff fix\/207-prevent-zellij-handoff-timeout: timeout:/);
    assert.match(capsule, /Parent recovery command: Retry Zellij handoff from an active Zellij pane/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string; path: string | null }).status, "blocked");
    assert.equal((ledger.worktree as { path: string | null }).path, null);
    assert.equal((ledger.failure as { phase: string }).phase, "zellij-handoff");
    assert.equal((ledger.failure as { reason: string | null }).reason, "timeout");
    assert.match(String((ledger.failure as { summary: string }).summary), /timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(String((ledger.failure as { detail: string | null }).detail), /timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(String(ledger.safeNextAction), /Retry Zellij handoff/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocked Zellij handoff classifies SIGTERM timeout shapes and keeps route recovery safe", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-sigterm-timeout-test-"));
  try {
    const { runner: baseRunner } = fakeGhRunner({
      "auth status": "",
      "issue view 216 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        216,
        "fix(workon): honor Zellij handoff timeout in exec runner",
        [
          "## Current behavior",
          "",
          "`/workon --mode start` can still block the deterministic Zellij handoff route with generic `Command failed: bash ... workon-zellij-handoff.sh ...` output, even after the handoff timeout work from #207.",
          "",
          "## Acceptance criteria",
          "",
          "- Extend `WorkonCommandRunner` options to carry an optional `timeoutMs` or equivalent command-specific timeout.",
          "- `runCommand(..., timeoutMs)` passes the requested timeout to the runner.",
          "- `createExecFileRunner()` uses `options.timeoutMs ?? DEFAULT_TIMEOUT_MS` for `execFileAsync`.",
          "- The Zellij handoff call uses `DEFAULT_ZELLIJ_HANDOFF_TIMEOUT_MS` in the actual `execFile` timeout, not only in returned metadata.",
          "- Timeout diagnostics report the effective timeout budget, signal, killed state, and redacted command.",
          "- Timeout classification treats timeout-killed processes as timeouts when the runner has an effective timeout and the child was killed by timeout, even if `nodeError.code` is `null` and the message lacks `timed out`.",
          "- Existing `--prompt` redaction remains intact in commands, stdout/stderr, errors, ledger, capsule, and final route text.",
          "- Add a regression test that uses or directly exercises `createExecFileRunner()` enough to prove call-site timeout options are honored.",
          "- Add a regression test for timeout classification when the error shape is `signal: \"SIGTERM\"`, `killed: true`, `exitCode/code: null`, and no `timed out` text.",
          "- Preserve the safe route-owned recovery command behavior for blocked handoff routes.",
        ].join("\n"),
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });
    let observedTimeoutMs: number | undefined;
    const runner: WorkonCommandRunner = async (command, args, options) => {
      if (command === "bash" && args[0]?.endsWith("scripts/workon-zellij-handoff.sh")) {
        observedTimeoutMs = options.timeoutMs;
      }
      return baseRunner(command, args, options);
    };

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "216",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(observedTimeoutMs, 41_500);
    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Handoff failure: Zellij Pi handoff fix\/216-honor-zellij-handoff-timeout: timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(rendered, /timed out while waiting for the Zellij handoff script's normal tab discovery window/);
    assert.match(rendered, /Recovery command: Retry Zellij handoff from an active Zellij pane/);
    assert.doesNotMatch(rendered, /Command failed: bash .*--prompt ## Deterministic \/workon route/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.failure as { reason: string | null }).reason, "timeout");
    assert.match(String((ledger.failure as { summary: string }).summary), /timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(String((ledger.failure as { detail: string | null }).detail), /timeout: timed out after 41500ms; killed=true; signal=SIGTERM; command=bash/);
    assert.match(String(ledger.safeNextAction), /Retry Zellij handoff/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocked Zellij handoff preserves structured reason and redacts raw prompt diagnostics", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-structured-failure-test-"));
  try {
    const branch = "fix/182-structured-handoff-failure";
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 182 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        182,
        "fix(workon): structured handoff failure",
        [
          "## Current behavior",
          "",
          "/workon can lose the structured failure reason when execFile includes the raw prompt in its error message.",
          "",
          "## Acceptance criteria",
          "",
          "- Preserve structured handoff reason and detail in rendered evidence and the ledger.",
          "- Redact the multiline handoff prompt from command diagnostics.",
          "",
          "## Validation",
          "",
          "- Add a focused regression test for structured blocked handoff diagnostics.",
          "",
          "## Non-goals",
          "",
          "- Do not change successful launch behavior.",
        ].join("\n"),
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "182",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /reason=tab-not-found/);
    assert.match(rendered, /exit code 1/);
    assert.match(rendered, /detail: Zellij Worktrunk tab not found after 1 attempts/);
    assert.match(rendered, /Handoff failure: Zellij Pi handoff fix\/182-structured-handoff-failure: reason=tab-not-found: exit code 1; detail: Zellij Worktrunk tab not found after 1 attempts: agents\/fix-182-structured-handoff-failure/);
    assert.match(rendered, /Zellij tab name: agents\/fix-182-structured-handoff-failure/);
    assert.match(rendered, /Zellij tab ID: 44/);
    assert.match(rendered, /Pi pane ID: terminal_91/);
    assert.match(rendered, /Heartbeat pane ID: terminal_92/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane --tab-id 44 --name pi --cwd \/tmp\/worktrunk\.feat-182 -- pi -a --name fix\/182-structured-handoff-failure/);
    assert.match(rendered, /Forge heartbeat command: zellij action new-pane --tab-id 44 --name forge-heartbeat --cwd \/tmp\/worktrunk\.feat-182 -- bash scripts\/workon-forge-heartbeat\.sh --repo pesap\/agents --branch fix\/182-structured-handoff-failure/);
    assert.match(rendered, /--prompt <redacted>/);
    assert.doesNotMatch(rendered, /--prompt ## Deterministic \/workon route/);
    assert.doesNotMatch(rendered, /Draft PR and feedback heartbeat:/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.failure as { reason: string | null }).reason, "tab-not-found");
    assert.equal(
      (ledger.failure as { detail: string | null }).detail,
      "Zellij Worktrunk tab not found after 1 attempts: agents/fix-182-structured-handoff-failure",
    );
    assert.match(
      String((ledger.failure as { summary: string | null }).summary),
      /^Zellij Pi handoff fix\/182-structured-handoff-failure: reason=tab-not-found: exit code 1; detail: Zellij Worktrunk tab not found after 1 attempts: agents\/fix-182-structured-handoff-failure/,
    );
    assert.equal((ledger.zellij as { tabName: string | null }).tabName, "agents/fix-182-structured-handoff-failure");
    assert.equal((ledger.zellij as { tabId: number | null }).tabId, 44);
    assert.equal((ledger.worktree as { path: string | null }).path, "/tmp/worktrunk.feat-182");
    assert.equal((ledger.pi as { paneId: string | null }).paneId, "terminal_91");
    assert.equal((ledger.heartbeat as { paneId: string | null }).paneId, "terminal_92");
    assert.match(String((ledger.pi as { handoffCommand: string | null }).handoffCommand), /--tab-id 44 --name pi/);
    assert.match(String((ledger.heartbeat as { command: string | null }).command), /--tab-id 44 --name forge-heartbeat/);
    assert.doesNotMatch(String(ledger.failureReason), /Draft PR and feedback heartbeat:/);
    assert.match(String(ledger.safeNextAction), /Wait for capsule acknowledgement/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks in current session when Zellij tab exists but Pi handoff is not launched", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-partial-test-"));
  try {
    const branch = "fix/67-tab-created-pi-pane";
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 67 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        67,
        "fix: tab created Pi pane missing",
      ),
      "wt --version": "worktrunk 1.0.0\n",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "67",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "0.25",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Worktree status: blocked/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: \(not launched\)/);
    assert.match(rendered, /Route: blocked/);
    assert.match(rendered, /Worktree\/tab was created but Pi was not launched/);
    assert.match(rendered, /Recovery command: Retry Zellij handoff from an active Zellij pane/);
    assert.match(rendered, /Retry Zellij handoff from an active Zellij pane/);
    assert.doesNotMatch(rendered, /Manual Pi restore/);
    assert.doesNotMatch(rendered, /Manual heartbeat restore/);
    assert.match(rendered, new RegExp(`--branch ${branch}`));
    assert.match(rendered, /--prompt <redacted>/);
    assert.doesNotMatch(rendered, /\bwt start\b/);
    assert.doesNotMatch(rendered, /Before doing any implementation:/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Worktree status: blocked/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(capsule, /Parent \/workon route: blocked/);
    assert.match(capsule, /Retry Zellij handoff from an active Zellij pane/);
    assert.doesNotMatch(capsule, /Manual Pi restore/);

    const nextPrompt = capsule.split("## Next prompt")[1] ?? "";
    assert.match(nextPrompt, /Workon child handoff context/);
    assert.match(nextPrompt, /Do not treat the parent blocked bootstrap route as a prohibition/);
    assert.doesNotMatch(nextPrompt, /Forbidden actions: do not improvise alternate launch paths/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string; path: string | null }).status, "blocked");
    assert.equal((ledger.zellij as { status: string }).status, "blocked");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.match(String(ledger.failureReason), /Zellij Pi handoff/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks start mode when Worktrunk is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-missing-wt-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 66 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        66,
        "feat(inbox): add multi-forge repo registry",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "66",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.ok(calls.includes("wt --version"));
    assert.equal(calls.some((call) => call.startsWith("wt switch")), false);
    assert.match(rendered, /Worktree status: blocked/);
    assert.match(rendered, /Worktrunk availability:/);
    assert.match(rendered, /Allowed action: report the blocked state and the operator action below/);
    assert.match(rendered, /Recovery command: \(none safe for this blocked state\)/);
    assert.match(rendered, /Next operator action: No route-owned recovery command is safe/);
    assert.doesNotMatch(rendered, /run or report the one route-owned recovery command/);
    assert.doesNotMatch(rendered, /Recovery command: \(not available\)/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /## Handoff recovery\n\n- No route-owned recovery command is safe/);
    assert.match(capsule, /Parent recovery command: No route-owned recovery command is safe/);

    const ledger = await readHandoffLedger(rendered);
    assert.deepEqual(ledger.recoveryInstructions, []);
    assert.match(String(ledger.safeNextAction), /No route-owned recovery command is safe/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("refuses freeform topics before workon bootstrap", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-freeform-refuse-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "implement the dashboard",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("issue list")), false);
    assert.equal(calls.some((call) => call.startsWith("issue create")), false);
    assert.match(rendered, /Workon target is not an issue URL or issue number/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("does not self-block readiness on quoted review-size keywords in diagnostic sections", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-review-size-quoted-test-"));
  try {
    const issue129RegressionBody = [
      "## Problem statement",
      "",
      "`/workon 129` reports this ready packet as not ready.",
      "",
      "## Reproduction status",
      "",
      "The diagnostic predicate summary shows `review: true` because quoted text mentions `large`, `broad`, `many files`, and `over 500` while explaining the false positive.",
      "",
      "```json",
      '{ "review": true, "matched": "large broad many files over 500" }',
      "```",
      "",
      "## Evidence trail",
      "",
      "- The issue quotes review-size trigger terms while documenting diagnostic behavior.",
      "",
      "## Likely root cause",
      "",
      "The readiness scan treats explanatory text as scope risk.",
      "",
      "## Acceptance criteria",
      "",
      "- Add or update focused tests for the changed behavior.",
      "- Preserve strict readiness blocking for genuine oversized work.",
      "",
      "## Non-goals",
      "",
      "- Do not bypass readiness checks.",
      "",
      "## Validation plan",
      "",
      "- Run npm run test:node -- tests/commands/workon.test.ts",
      "",
      "## /workon readiness notes",
      "",
      "Public-contract risk is low and implementation is localized.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 129 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        129,
        "fix(workon): prevent readiness false positive",
        issue129RegressionBody,
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "129",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.doesNotMatch(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Source issue: pesap\/agents#129/);
    assert.match(rendered, /Session capsule:/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("recognizes bold-label Agent Brief sections during readiness checks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-agent-brief-ready-test-"));
  try {
    const body = [
      "**Current behavior or goal:**",
      "",
      "`/workon` rejects an Agent Brief even though the work packet is ready.",
      "",
      "**Desired behavior:**",
      "",
      "Recognize bold-label Agent Brief sections as work-packet sections.",
      "",
      "**Acceptance criteria:**",
      "",
      "- Add focused regression tests for the changed behavior.",
      "- Preserve existing ATX heading behavior.",
      "",
      "**Validation plan:**",
      "",
      "- Run npm run test:node -- tests/commands/workon.test.ts",
      "",
      "**Non-goals:**",
      "",
      "- Do not rewrite the whole readiness system.",
      "",
      "**Breaking-change risk:**",
      "",
      "Low. No public contract change is expected.",
      "",
      "**Review-size risk:**",
      "",
      "Low and bounded to the parser and focused tests.",
      "",
      "**/workon readiness notes:**",
      "",
      "Ready because scope, validation, non-goals, and risks are explicit.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 160 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        160,
        "fix(workon): recognize bold-label Agent Brief sections in readiness checks",
        body,
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "160",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.doesNotMatch(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Source issue: pesap\/agents#160/);
    assert.match(rendered, /Session capsule:/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("extracts Agent Brief acceptance criteria without leaking validation bullets", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-agent-brief-sectioned-test-"));
  try {
    const body = [
      "> *This was generated by AI during triage.*",
      "",
      "## Agent Brief",
      "",
      "**Category:** enhancement",
      "**Summary:** Add typed column support to `System.show_components()` while preserving existing metadata toggle behavior.",
      "",
      "**Current behavior:**",
      "`System.show_components()` displays component names and optional metadata columns. It does not support user-selected component fields or typed computed columns.",
      "",
      "**Desired behavior:**",
      "`System.show_components()` should accept optional typed column specifications while preserving existing no-column and metadata-toggle behavior.",
      "",
      "**Acceptance criteria:**",
      "- Existing supported calls continue to work: `show_components(ComponentType)`, `show_components(ComponentType, show_uuid=True)`, `show_components(ComponentType, show_time_series=True)`, and `show_components(ComponentType, show_supplemental=True)`.",
      "- `show_components(ComponentType, \"field_name\")` renders that component field as one additional column.",
      "- `show_components(ComponentType, (\"field_a\", \"field_b\"))` renders multiple additional columns.",
      "- A typed `ComponentColumn[T]` or equivalent supports computed columns with callable extractors.",
      "- Invalid field names raise a clear `infrasys` exception that identifies the missing column and component involved.",
      "- Legacy keyword metadata toggles remain keyword-compatible.",
      "",
      "**Validation plan:**",
      "- Add focused regression tests in `tests/test_system.py` for string column input, tuple column input, computed typed column input, metadata toggles, invalid field errors, and existing no-column behavior.",
      "- Run targeted tests: `pytest tests/test_system.py -k show_components`.",
      "- Run project quality checks relevant to the touched Python API: `ruff check src tests` and `mypy src tests`.",
      "",
      "**Non-goals:**",
      "- Numeric aggregation or collapse APIs such as capacity totals by technology or region.",
      "- A new CLI entrypoint.",
      "",
      "**Breaking-change risk:**",
      "Low if metadata toggles remain keyword-compatible and existing no-column calls are preserved.",
      "",
      "**Review-size risk:**",
      "Moderate but likely under ~500 LOC if limited to one typed column spec/normalization path.",
      "",
      "**/workon readiness notes:**",
      "This issue should be `/workon`-ready after this update because it now has explicit validation expectations, narrow acceptance criteria, non-goals, and bounded review-size guidance.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 159 --repo NatLabRockies/infrasys --json number,title,url,body,state,author,labels,assignees": JSON.stringify({
        number: 159,
        title: "Add typed column support to System.show_components",
        url: "https://github.com/NatLabRockies/infrasys/issues/159",
        state: "OPEN",
        body,
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "pesap" }],
        author: { login: "pesap" },
      }),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "159",
        repo: "NatLabRockies/infrasys",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.doesNotMatch(rendered, /Autonomous readiness: not-ready/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    const acceptanceSection = capsule.split("## Acceptance criteria")[1]?.split("## Non-goals")[0] ?? "";
    assert.match(acceptanceSection, /show_components\(ComponentType, "field_name"\).*renders that component field/);
    assert.match(acceptanceSection, /ComponentColumn\[T\].*supports computed columns/);
    assert.match(acceptanceSection, /Legacy keyword metadata toggles remain keyword-compatible/);
    assert.doesNotMatch(acceptanceSection, /Add focused regression tests/);
    assert.doesNotMatch(acceptanceSection, /pytest tests\/test_system\.py -k show_components/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks bold-label Agent Briefs that still lack non-goals", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-agent-brief-missing-nongoals-test-"));
  try {
    const body = [
      "**Current behavior or goal:**",
      "",
      "`/workon` should keep blocking genuinely incomplete work packets.",
      "",
      "**Desired behavior:**",
      "",
      "Recognize present Agent Brief sections without weakening missing-section checks.",
      "",
      "**Acceptance criteria:**",
      "",
      "- Add focused regression tests for the changed behavior.",
      "",
      "**Validation plan:**",
      "",
      "- Run npm run test:node -- tests/commands/workon.test.ts",
      "",
      "**Breaking-change risk:**",
      "",
      "Low. No public contract change is expected.",
      "",
      "**Review-size risk:**",
      "",
      "Low and bounded to the parser and focused tests.",
      "",
      "**/workon readiness notes:**",
      "",
      "Not ready until non-goals are explicit.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 161 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        161,
        "fix(workon): keep blocking missing non-goals",
        body,
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "161",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: true,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.equal(calls.some((call) => call.startsWith("bash ")), false);
    assert.equal(calls.some((call) => call.startsWith("zellij ")), false);
    assert.equal(calls.some((call) => call.startsWith("issue comment")), false);
    assert.match(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Add non-goals or out-of-scope boundaries so autonomous work does not expand scope/);
    assert.match(rendered, /Worktree status: not-started/);
    assert.match(rendered, /Session capsule: not written/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string }).status, "not-started");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.equal((ledger.heartbeat as { status: string }).status, "not-launched");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("accepts resolved public-contract and bounded review-size risk sections", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-resolved-risk-test-"));
  try {
    const body = [
      "## Current behavior",
      "",
      "The workflow rejects a ready issue packet.",
      "",
      "## Acceptance criteria",
      "",
      "- Add focused regression tests for the changed behavior.",
      "",
      "## Validation plan",
      "",
      "- Run npm run test:node -- tests/commands/workon.test.ts",
      "",
      "## Non-goals",
      "",
      "- Do not perform a broad rewrite or touch many files.",
      "",
      "## Breaking-change risk",
      "",
      "Public-contract risk is resolved: no CLI contract change is expected.",
      "",
      "## Review-size risk",
      "",
      "Risk is low and bounded to a focused readiness parser/test patch.",
      "",
      "## /workon readiness notes",
      "",
      "Ready because scope, validation, non-goals, and risks are explicit.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 135 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        135,
        "fix(workon): align readiness and PR handoff with work-package contract",
        body,
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "135",
        repo: "pesap/agents",
        forge: "github",
        mode: "prepare",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.doesNotMatch(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Source issue: pesap\/agents#135/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("handoff template requires source-closing checklist PR body", async () => {
  const template = await readFile(path.join(process.cwd(), "commands/workon-handoff-template.md"), "utf8");

  assert.match(template, /resolved source-closing marker when applicable/i);
  assert.match(template, /Summary/);
  assert.match(template, /checklist-style Acceptance criteria/i);
  assert.match(template, /Deviations from the original plan/);
  assert.match(template, /command-only Testing Strategy/);
  assert.match(template, /References/);
  assert.match(template, /Acknowledge that the capsule was read by running/);
  assert.match(template, /{{ack_command}}/);
  assert.match(template, /use checkbox state, not textual status prefixes/i);
  assert.match(template, /checked means met; unchecked means unmet/i);
  assert.match(template, /nested `Evidence:` lines/i);
  assert.match(template, /For unmet criteria, keep the checkbox unchecked/i);
  assert.doesNotMatch(template, /`Addressed` with evidence/);
  assert.doesNotMatch(template, /`Not addressed` with the reason and follow-up/);
});

test("handoff template requires bounded dirty-tree simplify before implementation commit", async () => {
  const template = await readFile(path.join(process.cwd(), "commands/workon-handoff-template.md"), "utf8");

  assert.match(template, /After implementation edits, run focused validation/i);
  assert.match(template, /Run `\/simplify` only on the dirty tree before creating the implementation commit/);
  assert.match(template, /`\/workon` bootstrap must not invoke `\/simplify`/);
  assert.match(template, /behavior-preserving, source-issue-scoped, and free of drive-by refactors/);
  assert.match(template, /Rerun the focused validation after simplification and before committing/);
  assert.match(template, /do not require a separate simplify commit/);
});

test("still blocks genuinely oversized review-size risk", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-review-size-risk-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 130 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        130,
        "fix: Broad multi-phase readiness refactor",
        [
          "## Acceptance criteria",
          "",
          "- Refactor everything in the readiness flow across many files.",
          "",
          "## Reproduction",
          "",
          "- Reproduce the bug with a focused regression test.",
          "",
          "## Validation",
          "",
          "- Run focused tests.",
          "",
          "## Non-goals",
          "",
          "- Keep unrelated workflows unchanged.",
        ].join("\n"),
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "130",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Narrow or split the issue so the resulting PR is likely under about 500 LOC changed/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("refuses issue targets that are not autonomous-ready", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-readiness-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 81 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        81,
        "fix: Missing readiness fields",
        "The bug is vague.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "81",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /## Deterministic \/workon route/);
    assert.match(rendered, /Route: not_ready/);
    assert.match(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Action items to make the source issue\(s\) \/workon-ready/);
    assert.match(rendered, /Suggested next command\(s\):/);
    assert.match(rendered, /Only next command: \/triage https:\/\/github.com\/pesap\/agents\/issues\/81/);
    assert.match(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/81/);
    assert.doesNotMatch(rendered, /Suggested Worktrunk command/);
    assert.doesNotMatch(rendered, /wt switch --create/);
    assert.doesNotMatch(rendered, /workon-zellij-handoff\.sh/);
    assert.doesNotMatch(rendered, /Pi handoff command/);
    assert.doesNotMatch(rendered, /Forge heartbeat command/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal(ledger.route, "not_ready");
    assert.equal(ledger.safeNextAction, "/triage https://github.com/pesap/agents/issues/81");
    assert.equal((ledger.worktree as { status: string }).status, "not-started");
    assert.equal((ledger.phases as Record<string, string>).readiness, "not-ready");
    assert.deepEqual((ledger.readinessActionItems as string[]).slice(0, 2), [
      "Add narrow, testable acceptance criteria to the issue/work packet.",
      "Add validation or test expectations, preferably a behavior/regression test for changed behavior.",
    ]);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("attributes grouped readiness failures to the blocking source issue", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-grouped-readiness-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 107 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        107,
        "fix: Ready first issue",
      ),
      "issue view 109 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        109,
        "fix: Missing non-goals",
        "## Acceptance criteria\n\n- Add coverage for the behavior.\n\n## Reproduction\n\n- Reproduce the bug.\n\n## Validation\n\n- Run focused tests.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "107",
        targets: ["107", "109"],
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /Source issues: #107, #109/);
    assert.match(rendered, /Autonomous readiness: not ready for https:\/\/github.com\/pesap\/agents\/issues\/109/);
    assert.doesNotMatch(rendered, /Autonomous readiness: not ready for https:\/\/github.com\/pesap\/agents\/issues\/107/);
    assert.match(rendered, /- https:\/\/github.com\/pesap\/agents\/issues\/109\n {2}1\. Add non-goals or out-of-scope boundaries/);
    assert.match(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/109/);
    assert.doesNotMatch(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/107/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("groups grouped readiness failures by each blocking source issue", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-multi-readiness-test-"));
  try {
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 107 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        107,
        "fix: Missing acceptance criteria",
        "## Reproduction\n\n- Reproduce the bug.\n\n## Validation\n\n- Run focused tests.\n\n## Non-goals\n\n- Keep scope narrow.",
      ),
      "issue view 110 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": incompleteIssueViewOutput(
        110,
        "fix: Missing non-goals",
        "## Acceptance criteria\n\n- Add coverage for the behavior.\n\n## Reproduction\n\n- Reproduce the bug.\n\n## Validation\n\n- Run focused tests.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "107",
        targets: ["107", "110"],
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Autonomous readiness: not ready for 2 source issues/);
    assert.match(rendered, /- https:\/\/github.com\/pesap\/agents\/issues\/107\n {2}1\. Add narrow, testable acceptance criteria/);
    assert.match(rendered, /- https:\/\/github.com\/pesap\/agents\/issues\/110\n {2}1\. Add non-goals or out-of-scope boundaries/);
    assert.match(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/107/);
    assert.match(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/110/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("refuses issues whose substantive body defers scope decisions to implementation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-deferral-test-"));
  try {
    const deferredBody = [
      "## Goal",
      "",
      "Add typed Khala model profiles.",
      "",
      "Implementation should verify the exact Pi model ID for '5.4 mini' before relying on it.",
      "",
      "## Acceptance criteria",
      "",
      "- Add a typed model-profile contract.",
      "",
      "## Validation plan",
      "",
      "- Run npm run test:node.",
      "",
      "## Non-goals",
      "",
      "- Do not rewrite the workflow engine broadly.",
    ].join("\n");
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 192 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees":
        incompleteIssueViewOutput(192, "feat: model profiles", deferredBody),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "192",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.equal(calls.some((call) => call.startsWith("wt ")), false);
    assert.match(rendered, /Resolve deferred scope decisions in the issue body/);
    assert.match(rendered, /Autonomous readiness: not-ready/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("allows deferral phrases inside Non-goals or Open questions sections", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-deferral-allowed-test-"));
  try {
    const allowedBody = [
      "## Goal",
      "",
      "Add typed Khala model profiles.",
      "",
      "## Acceptance criteria",
      "",
      "- Add a typed model-profile contract with defaults `planning=copilot/gpt-5.5` and `agents=copilot/gpt-5.4-mini`.",
      "",
      "## Validation plan",
      "",
      "- Run npm run test:node.",
      "",
      "## Non-goals",
      "",
      "- Do not rewrite the workflow engine broadly.",
      "",
      "## Open questions",
      "",
      "- TBD whether to also surface auth status in the same command (tracked separately).",
    ].join("\n");
    const issueJson = JSON.stringify({
      number: 193,
      title: "feat: model profiles",
      url: "https://github.com/pesap/agents/issues/193",
      state: "OPEN",
      body: allowedBody,
      labels: [{ name: "enhancement" }],
      assignees: [{ login: "pesap" }],
      author: { login: "pesap" },
    });
    const { runner } = fakeGhRunner({
      "auth status": "",
      "issue view 193 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueJson,
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "193",
        repo: "pesap/agents",
        forge: "github",
        mode: "start",
        capsuleRoot: tempDir,
        nowIso: "2026-06-05T00:00:00.000Z",
        launchInZellij: false,
        heartbeat: "1.0",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.doesNotMatch(rendered, /Resolve deferred scope decisions/);
    assert.match(rendered, /Autonomous readiness: ready/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
