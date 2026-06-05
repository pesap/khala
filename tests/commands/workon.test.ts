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
      const stdout = outputs[key];
      return stdout === undefined
        ? { ok: false, stdout: "", stderr: `missing fake output for ${key}` }
        : { ok: true, stdout, stderr: "" };
    },
  };
}

function issueViewOutput(number: number, title: string, body = ""): string {
  return JSON.stringify({
    number,
    title,
    url: `https://github.com/pesap/agents/issues/${number}`,
    state: "OPEN",
    body,
    labels: [{ name: "enhancement" }],
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
    assert.match(capsule, /^\/feature Continue pesap\/agents#63/m);
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
      },
      runner,
    );

    assert.equal(calls.some((call) => call.startsWith("repo view")), false);
    assert.match(sections.join("\n"), /Source issue: pesap\/agents#64/);
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
      "wt switch --create feat/65-detect-local-worktrees-and-stale-sessions": "Created /tmp/worktrunk.feat-65\n",
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
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.ok(calls.includes("wt --version"));
    assert.ok(
      calls.includes(
        "wt switch --create feat/65-detect-local-worktrees-and-stale-sessions",
      ),
    );
    assert.match(rendered, /Worktree status: started/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk.feat-65/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
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
      },
      runner,
    );
    const rendered = sections.join("\n");
    const switchCall = calls.find((call) => call.startsWith("wt switch --create"));
    const listTabsCall = calls.find((call) => call === "zellij action list-tabs --json");
    const focusCall = calls.find((call) => call.startsWith("zellij action go-to-tab-name"));
    const paneCall = calls.find((call) => call.startsWith("zellij action new-pane"));

    assert.equal(calls.some((call) => call.includes(" -x pi ")), false);
    assert.equal(calls.some((call) => call.startsWith("zellij run")), false);
    assert.ok(switchCall);
    assert.ok(listTabsCall);
    assert.ok(focusCall);
    assert.ok(paneCall);
    assert.ok(calls.indexOf(switchCall) < calls.indexOf(listTabsCall));
    assert.ok(calls.indexOf(listTabsCall) < calls.indexOf(focusCall));
    assert.ok(calls.indexOf(focusCall) < calls.indexOf(paneCall));
    assert.match(paneCall, /^zellij action new-pane --tab-id 12 --name pi --cwd \/tmp\/worktrunk\.feat-65 -- pi --name feat\/65/);
    assert.match(paneCall, /@.+github\.com\/pesap\/agents\/capsule\.md/);
    assert.match(paneCall, /\/feature Continue pesap\/agents#65/);
    assert.match(rendered, /Worktree status: launched/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane/);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Worktree status: launched/);
    assert.match(capsule, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(capsule, /Pi handoff command: zellij action new-pane/);
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

test("reports freeform topics as graceful gaps", async () => {
  const { calls, runner } = fakeGhRunner({ "auth status": "" });

  const sections = await prepareWorkonBootstrap(
    {
      cwd: process.cwd(),
      target: "implement the dashboard",
      repo: "pesap/agents",
      forge: "github",
      mode: "prepare",
      capsuleRoot: process.cwd(),
      nowIso: "2026-06-05T00:00:00.000Z",
      launchInZellij: false,
    },
    runner,
  );

  assert.deepEqual(calls, ["auth status"]);
  assert.match(sections.join("\n"), /freeform topic detected/);
});
