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
      assert.equal(command, "gh");
      const key = args.join(" ");
      calls.push(key);
      const stdout = outputs[key];
      return stdout === undefined
        ? { ok: false, stdout: "", stderr: `missing fake output for ${key}` }
        : { ok: true, stdout, stderr: "" };
    },
  };
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

test("prepares GitHub issue workon capsule from repo and issue number", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 63 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": JSON.stringify({
        number: 63,
        title: "feat(inbox): render deterministic maintainer queue locally",
        url: "https://github.com/pesap/agents/issues/63",
        state: "OPEN",
        body: "## Acceptance criteria\n\n- Render collected inbox items into canonical buckets.\n- Emit top 3 next commands deterministically.",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "pesap" }],
        author: { login: "pesap" },
      }),
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
    assert.match(rendered, /Session capsule: /);

    const capsulePath = rendered.match(/Session capsule: (.+)/)?.[1]?.trim();
    assert.ok(capsulePath);
    const capsule = await readFile(capsulePath, "utf8");
    assert.match(capsule, /Issue number: #63/);
    assert.match(capsule, /Branch: feat\/63-render-deterministic-maintainer-queue-locally/);
    assert.match(capsule, /Render collected inbox items into canonical buckets/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("infers repo and issue from GitHub issue URL", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "khala-workon-url-test-"));
  try {
    const { calls, runner } = fakeGhRunner({
      "auth status": "",
      "issue view 64 --repo pesap/agents --json number,title,url,body,state,author,labels,assignees": JSON.stringify({
        number: 64,
        title: "feat(inbox): add GitLab maintainer queue collector",
        url: "https://github.com/pesap/agents/issues/64",
        state: "OPEN",
        body: "",
      }),
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
      },
      runner,
    );

    assert.equal(calls.some((call) => call.startsWith("repo view")), false);
    assert.match(sections.join("\n"), /Source issue: pesap\/agents#64/);
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
    },
    runner,
  );

  assert.deepEqual(calls, ["auth status"]);
  assert.match(sections.join("\n"), /freeform topic detected/);
});
