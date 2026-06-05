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
        return {
          ok: true,
          stdout: `${JSON.stringify({
            status: "launched",
            path: worktreePath,
            tabName: "agents/feat-65-detect-local-worktrees-and-stale-sessions",
            tabId: 12,
            heartbeatCommand: `zellij action new-pane --tab-id 12 --name forge-heartbeat --cwd ${worktreePath} -- bash scripts/workon-forge-heartbeat.sh --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me`,
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
        heartbeat: "1.0",
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
        heartbeat: "0.25",
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
    assert.match(rendered, /Worktree status: launched/);
    assert.match(rendered, /Worktree path: \/tmp\/worktrunk\.feat-65/);
    assert.match(rendered, /Pi handoff command: zellij action new-pane/);
    assert.match(rendered, /Forge heartbeat command: zellij action new-pane/);

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

test("resolves freeform topics to existing GitHub issues", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-freeform-existing-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue list --repo pesap/agents --state open --search implement the dashboard --limit 5 --json number,title,url,state": JSON.stringify([
        {
          number: 80,
          title: "work: implement the dashboard",
          url: "https://github.com/pesap/agents/issues/80",
          state: "OPEN",
        },
      ]),
      "issue view 80 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        80,
        "work: implement the dashboard",
      ),
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

    assert.equal(calls.some((call) => call.startsWith("issue create")), false);
    assert.match(sections.join("\n"), /Source issue: pesap\/agents#80/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("creates GitHub issues for unmatched freeform topics", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-freeform-create-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue list --repo pesap/agents --state open --search Make sure Closes: non uses the source issue --limit 5 --json number,title,url,state": "[]",
      "issue create --repo pesap/agents --title fix: Make sure Closes: non uses the source issue --body ## Problem\n\nMake sure Closes: non uses the source issue\n\n## Acceptance criteria\n\n- Confirm the intended behavior from this topic before implementation.\n- Add or update focused tests for the changed behavior.\n- Keep the implementation scoped to this issue.\n\n## Non-goals\n\n- Do not broaden scope beyond this topic without updating the issue or creating a follow-up.\n\n## Validation\n\n- Run focused tests for the touched path.\n- Run the relevant repo quality gate if public workflow behavior changes.\n\nCreated from /workon freeform topic.\n": "https://github.com/pesap/agents/issues/81\n",
      "issue view 81 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": issueViewOutput(
        81,
        "fix: Make sure Closes: non uses the source issue",
        "## Acceptance criteria\n\n- Confirm the intended behavior from this topic before implementation.",
      ),
    });

    const sections = await prepareWorkonBootstrap(
      {
        cwd: process.cwd(),
        target: "'Make sure Closes: non uses the source issue'",
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

    assert.ok(calls.some((call) => call.startsWith("issue create")));
    assert.match(sections.join("\n"), /Source issue: pesap\/agents#81/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
