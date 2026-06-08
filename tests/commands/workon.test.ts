import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildWorkonBranchName,
  DEFAULT_WORKON_MODEL_SELECTION,
  isActiveZellijEnv,
  prepareWorkonBootstrap,
  type WorkonCommandRunner,
} from "../../extensions/commands/workon.ts";

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
        if (branch.includes("tab-created-pi-pane-missing")) {
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
        if (branch.includes("preflight-github-copilot-auth-before-launching-child-pi")) {
          return {
            ok: false,
            stdout: "",
            stderr: "Pi model auth preflight failed for github-copilot/gpt-5.5 with PI_CODING_AGENT_DIR=/tmp/empty-pi-agent (auth path: /tmp/empty-pi-agent/auth.json). Run /login github-copilot using that Pi config directory, set PI_CODING_AGENT_DIR to the intended config, or pass --model for a configured provider.\n",
          };
        }
        return {
          ok: true,
          stdout: `${JSON.stringify({
            status: "launched",
            path: worktreePath,
            tabName: "agents/feat-65-detect-local-worktrees-and-stale-sessions",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

test("builds issue-numbered branch names from conventional titles", () => {
  assert.equal(
    buildWorkonBranchName({
      number: 63,
      title: "feat(inbox): render deterministic maintainer queue locally",
    }),
    "feat/63-render-deterministic-maintainer-queue-locally",
  );
  assert.equal(
    buildWorkonBranchName({ number: 5, title: "Investigate flaky parser" }),
    "work/5-investigate-flaky-parser",
  );
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
      /Suggested branch: feat\/63-render-deterministic-maintainer-queue-locally/,
    );

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.equal(
      capsulePath,
      path.join(tempDir, "github.com", "pesap", "agents", "capsule.md"),
    );
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Issue number: #63/);
    assert.match(capsule, /Branch: feat\/63-render-deterministic-maintainer-queue-locally/);
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
    const branch = "fix/148-use-package-handoff-script-and-robust-zellij-detection";
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
    const branch = "fix/148-use-package-handoff-script-and-robust-zellij-detection";
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
    assert.equal(calls.includes(`wt switch --create ${branch} --format json`), false);
    assert.match(rendered, /Suggested Worktrunk command: cd .+ && wt switch --create fix\/148-use-package-handoff-script-and-robust-zellij-detection --format json/);
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
      "wt switch --create fix/104-first-issue --format json":
        '{"action":"created","branch":"fix/104-first-issue","path":"/tmp/worktrunk.fix-104"}\n',
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
    assert.match(rendered, /Suggested branch: fix\/104-first-issue/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /## Combined work scope/);
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
    assert.match(rendered, /Suggested branch: feat\/65-detect-local-worktrees-and-stale-sessions/);
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
    assert.equal(ledger.branchName, "feat/65-detect-local-worktrees-and-stale-sessions");
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
      "wt switch --create feat/65-detect-local-worktrees-and-stale-sessions --format json":
        '◎ Running pre-start: direct-hook\n{"action":"created","branch":"feat/65-detect-local-worktrees-and-stale-sessions","path":"/tmp/worktrunk.feat-65"}\npost-start hook complete\n',
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
        "wt switch --create feat/65-detect-local-worktrees-and-stale-sessions --format json",
      ),
    );
    assert.match(
      rendered,
      /Suggested Worktrunk command: cd .+ && wt switch --create feat\/65-detect-local-worktrees-and-stale-sessions --format json/,
    );
    assert.match(rendered, /Launch eligibility: active Zellij no/);
    assert.match(rendered, /Worktree status: started/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk.feat-65/);
    assert.match(rendered, /Handoff recovery:/);
    assert.match(rendered, new RegExp(`Retry Zellij handoff[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));
    assert.match(rendered, new RegExp(`Manual Pi restore: cd '/tmp/worktrunk.feat-65'[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(
      capsule,
      /Worktree command: cd .+ && wt switch --create feat\/65-detect-local-worktrees-and-stale-sessions --format json/,
    );
    assert.match(capsule, /Worktree status: started/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk.feat-65/);
    assert.match(capsule, /Launch eligibility: active Zellij no/);
    assert.match(capsule, /## Handoff recovery/);
    assert.match(capsule, new RegExp(`Retry Zellij handoff[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));
    assert.match(capsule, new RegExp(`Manual Pi restore: cd '/tmp/worktrunk.feat-65'[\\s\\S]*--model '${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}' --thinking '${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}'`));

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
    const branch = "feat/65-detect-local-worktrees-and-stale-sessions";
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
        { name: "agents/feat-65-detect-local-worktrees-and-stale-sessions", tab_id: 12 },
      ]),
      "zellij action go-to-tab-name agents/feat-65-detect-local-worktrees-and-stale-sessions": "",
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
          routingMode: "exact-model",
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
    assert.match(scriptCall, /--branch feat\/65-detect-local-worktrees-and-stale-sessions/);
    assert.match(scriptCall, /--capsule .+github\.com\/pesap\/agents\/capsule\.md/);
    assert.match(scriptCall, /--prompt I want to discuss and possibly work on:/);
    assert.match(scriptCall, /Draft PR and feedback heartbeat:/);
    assert.match(scriptCall, /--heartbeat 0\.25/);
    assert.match(scriptCall, /--model anthropic\/claude-sonnet-4/);
    assert.match(scriptCall, new RegExp(`--thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(rendered, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(rendered, /Model routing mode: exact-model/);
    assert.match(rendered, /explicit --model override/);
    assert.match(rendered, /Launch eligibility: active Zellij yes/);
    assert.match(rendered, /Worktree status: launched/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane/);
    assert.match(rendered, new RegExp(`-- pi -a --name feat/65-detect-local-worktrees-and-stale-sessions --model anthropic/claude-sonnet-4 --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
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
    assert.match(capsule, new RegExp(`-- pi -a --name feat/65-detect-local-worktrees-and-stale-sessions --model anthropic/claude-sonnet-4 --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(capsule, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Model routing mode: exact-model/);
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
    assert.match(rendered, /default-pinned model routing/);
    assert.match(rendered, new RegExp(`Pi handoff command: .*--model ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)} --thinking ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, new RegExp(`Exact model: ${escapeRegExp(DEFAULT_WORKON_MODEL_SELECTION.exactModel)}`));
    assert.match(capsule, new RegExp(`Exact thinking level: ${DEFAULT_WORKON_MODEL_SELECTION.exactThinkingLevel}`));
    assert.match(capsule, /Model routing reason: Khala\/workon default-pinned model routing/);

    const ledger = await readHandoffLedger(rendered);
    assert.deepEqual(ledger.modelSelection, DEFAULT_WORKON_MODEL_SELECTION);
  } finally {
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
    assert.match(rendered, /Pi model auth preflight failed for github-copilot\/gpt-5\.5 with PI_CODING_AGENT_DIR=\/tmp\/empty-pi-agent/);

    const ledger = await readHandoffLedger(rendered);
    assert.equal((ledger.worktree as { status: string }).status, "blocked");
    assert.equal((ledger.zellij as { status: string }).status, "blocked");
    assert.equal((ledger.pi as { status: string }).status, "not-launched");
    assert.match(String(ledger.failureReason), /Pi model auth preflight failed/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("blocks in current session when Zellij tab exists but Pi handoff is not launched", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-zellij-partial-test-"));
  try {
    const branch = "fix/67-tab-created-pi-pane-missing";
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
    assert.match(rendered, /Worktree\/tab was created but Pi was not launched/);
    assert.match(rendered, /Retry Zellij handoff from an active Zellij pane/);
    assert.match(rendered, /Manual Pi restore: cd '\/tmp\/worktrunk\.feat-65' && pi -a --name 'fix\/67-tab-created-pi-pane-missing'/);
    assert.match(rendered, /Manual heartbeat restore: cd '\/tmp\/worktrunk\.feat-65'/);
    assert.match(rendered, new RegExp(`--branch ${branch}`));
    assert.match(rendered, /--prompt <redacted>/);
    assert.doesNotMatch(rendered, /Before doing any implementation:/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Worktree status: blocked/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(capsule, /Retry Zellij handoff from an active Zellij pane/);
    assert.match(capsule, /Manual Pi restore: cd '\/tmp\/worktrunk\.feat-65' && pi -a --name 'fix\/67-tab-created-pi-pane-missing'/);

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
  assert.match(template, /`Addressed` with evidence/);
  assert.match(template, /`Not addressed` with the reason and follow-up/);
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
    assert.match(rendered, /Autonomous readiness: not-ready/);
    assert.match(rendered, /Action items to make the source issue\(s\) \/workon-ready/);
    assert.match(rendered, /Suggested next command\(s\):/);
    assert.match(rendered, /- \/triage https:\/\/github.com\/pesap\/agents\/issues\/81/);

    const ledger = await readHandoffLedger(rendered);
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
