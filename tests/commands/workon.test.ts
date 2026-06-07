import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildWorkonBranchName,
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
        return {
          ok: true,
          stdout: `${JSON.stringify({
            status: "launched",
            path: worktreePath,
            tabName: "agents/feat-65-detect-local-worktrees-and-stale-sessions",
            tabId: 12,
            heartbeatCommand: `zellij action new-pane --tab-id 12 --name forge-heartbeat --cwd ${worktreePath} -- bash scripts/workon-forge-heartbeat.sh --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me --notify-pane terminal_99`,
            piHandoffCommand: `zellij action new-pane --tab-id 12 --name pi --cwd ${worktreePath} -- pi --name ${branch} <clean-prompt>`,
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
    assert.match(capsule, /Draft PR and feedback heartbeat:/);
    assert.match(capsule, /check the PR\/issue forge for human feedback every 1\.0/);
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
    assert.match(capsule, /Draft PR and feedback heartbeat:/);
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
        "## Acceptance criteria\n\n- Resolve first issue.",
      ),
      "issue view 105 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        105,
        "fix(workon): second issue",
        "## Acceptance criteria\n\n- Resolve second issue.",
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
    assert.equal(capsule.match(/## Combined work scope/g)?.length, 2);
    assert.equal(capsule.match(/## Implementation order/g)?.length, 2);
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
      /Suggested Worktrunk command: wt switch --create feat\/65-detect-local-worktrees-and-stale-sessions --format json/,
    );
    assert.match(rendered, /Worktree status: started/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk.feat-65/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(
      capsule,
      /Worktree command: wt switch --create feat\/65-detect-local-worktrees-and-stale-sessions --format json/,
    );
    assert.match(capsule, /Worktree status: started/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk.feat-65/);
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
          routingMode: "exact-model",
          routingReason: "explicit --model override",
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
    assert.match(rendered, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(rendered, /Model routing mode: exact-model/);
    assert.match(rendered, /explicit --model override/);
    assert.match(rendered, /Worktree status: launched/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane/);
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
    assert.match(capsule, /Exact model: anthropic\/claude-sonnet-4/);
    assert.match(capsule, /Model routing mode: exact-model/);
    assert.match(capsule, /Model routing reason: explicit --model override/);
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
    assert.match(rendered, new RegExp(`--branch ${branch}`));
    assert.match(rendered, /--prompt <redacted>/);
    assert.doesNotMatch(rendered, /Before doing any implementation:/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Worktree status: blocked/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk\.feat-65/);
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
