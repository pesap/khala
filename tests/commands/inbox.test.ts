import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectInboxDashboard,
  collectInboxEvidence,
  collectInboxSnapshot,
  renderInboxSnapshotCompact,
  renderInboxSnapshotJson,
  type InboxCommandRunner,
} from "../../extensions/commands/inbox.ts";
import { parseInboxArgs } from "../../extensions/commands/parsers.ts";

async function emptyCapsuleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "khala-inbox-empty-test-"));
  await mkdir(path.join(root, "github.com"), { recursive: true });
  return root;
}

function fakeCommandRunner(outputs: Record<string, string>): {
  calls: string[];
  runner: InboxCommandRunner;
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      const stdout = outputs[key];
      return stdout === undefined
        ? { ok: false, stdout: "", stderr: `missing fake output for ${key}` }
        : { ok: true, stdout, stderr: "" };
    },
  };
}

test("collects read-only GitHub inbox evidence for authenticated user", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { calls, runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh api user --jq .login": "pesap\n",
    "gh api graphql -F first=5 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes":
      JSON.stringify([
        {
          nameWithOwner: "pesap/agents",
          url: "https://github.com/pesap/agents",
          updatedAt: "2026-06-05T19:33:55Z",
          isPrivate: false,
          viewerPermission: "ADMIN",
        },
        {
          nameWithOwner: "NatLabRockies/arco",
          url: "https://github.com/NatLabRockies/arco",
          updatedAt: "2026-06-05T17:40:37Z",
          isPrivate: false,
          viewerPermission: "ADMIN",
        },
      ]),
    "gh search prs --review-requested=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      JSON.stringify([
        {
          number: 12,
          title: "review me",
          url: "https://github.com/org/repo/pull/12",
          repository: { nameWithOwner: "org/repo" },
          updatedAt: "2026-06-01T00:00:00Z",
          isDraft: false,
        },
      ]),
    "gh search prs --author=@me --state=open --checks=failure --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      JSON.stringify([
        {
          number: 9,
          title: "fix failing ci",
          url: "https://github.com/pesap/agents/pull/9",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-02T00:00:00Z",
          isDraft: false,
        },
      ]),
    "gh search prs --author=@me --state=open --checks=pending --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,labels":
      JSON.stringify([
        {
          number: 61,
          title: "collect inbox",
          url: "https://github.com/pesap/agents/issues/61",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-05T00:00:00Z",
        },
      ]),
    "gh search issues --author=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,labels":
      "[]",
    "git worktree list --porcelain":
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
    "git status --porcelain=v1 -b": "## main...origin/main\n",
    "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 5,
      repo: "",
      user: "@me",
      forge: "github",
      focus: "all",
      capsuleRoot,
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.match(rendered, /Repository discovery:/);
  assert.match(rendered, /pesap\/agents/);
  assert.match(rendered, /Needs you now \(1\):/);
  assert.match(
    rendered,
    /source=review-requested-pr repo=org\/repo title="#12: review me" updated=2026-06-01T00:00:00Z/,
  );
  assert.match(rendered, /My work is broken \(1\):/);
  assert.match(
    rendered,
    /source=authored-pr-ci-failure repo=pesap\/agents title="#9: fix failing ci" updated=2026-06-02T00:00:00Z/,
  );
  assert.match(rendered, /New work needs shaping \(1\):/);
  assert.match(
    rendered,
    /source=assigned-issue repo=pesap\/agents title="#61: collect inbox" updated=2026-06-05T00:00:00Z/,
  );
  assert.match(
    rendered,
    /Top 3 next commands:\n1\. \/review pr https:\/\/github.com\/org\/repo\/pull\/12\n2\. \/inbox --repo pesap\/agents --focus ci\n3\. \/triage https:\/\/github.com\/pesap\/agents\/issues\/61/,
  );
  assert.match(rendered, /NatLabRockies\/arco/);
  assert.ok(
    calls.includes(
      "gh api graphql -F first=5 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes",
    ),
  );
});

test("renders canonical buckets in stable priority order", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission":
      JSON.stringify({
        nameWithOwner: "pesap/agents",
        url: "https://github.com/pesap/agents",
        isPrivate: false,
      }),
    "gh search prs --review-requested=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      JSON.stringify([
        {
          number: 3,
          title: "newer review",
          url: "https://github.com/pesap/agents/pull/3",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-03T00:00:00Z",
        },
        {
          number: 2,
          title: "older review",
          url: "https://github.com/pesap/agents/pull/2",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-02T00:00:00Z",
        },
      ]),
    "gh search prs --author=@me --state=open --checks=failure --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      JSON.stringify([
        {
          number: 1,
          title: "ci failed",
          url: "https://github.com/pesap/agents/pull/1",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-01T00:00:00Z",
        },
      ]),
    "gh search prs --author=@me --state=open --checks=pending --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,labels":
      "[]",
    "gh search issues --author=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,labels":
      JSON.stringify([
        {
          number: 4,
          title: "shape this",
          url: "https://github.com/pesap/agents/issues/4",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-04T00:00:00Z",
        },
      ]),
    "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
    "git worktree list --porcelain":
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
    "git status --porcelain=v1 -b": "## main...origin/main\n",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 10,
      repo: "pesap/agents",
      user: "",
      forge: "github",
      focus: "all",
      capsuleRoot,
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.ok(
    rendered.indexOf("Needs you now (2):") <
      rendered.indexOf("My work is broken (1):"),
  );
  assert.ok(
    rendered.indexOf("My work is broken (1):") <
      rendered.indexOf("Agent/session needs attention (0):"),
  );
  assert.ok(
    rendered.indexOf("Agent/session needs attention (0):") <
      rendered.indexOf("New work needs shaping (1):"),
  );
  assert.ok(
    rendered.indexOf('title="#2: older review"') <
      rendered.indexOf('title="#3: newer review"'),
  );
  assert.match(
    rendered,
    /Top 3 next commands:\n1\. \/review pr https:\/\/github.com\/pesap\/agents\/pull\/2\n2\. \/review pr https:\/\/github.com\/pesap\/agents\/pull\/3\n3\. \/inbox --repo pesap\/agents --focus ci/,
  );
});

test("repo override skips user-wide repository discovery", async () => {
  const { calls, runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission":
      JSON.stringify({
        nameWithOwner: "pesap/agents",
        url: "https://github.com/pesap/agents",
        isPrivate: false,
        viewerPermission: "ADMIN",
      }),
    "gh search prs --review-requested=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=failure --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=pending --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,labels":
      "[]",
    "gh search issues --author=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,labels":
      "[]",
    "git worktree list --porcelain":
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
    "git status --porcelain=v1 -b": "## main...origin/main\n",
    "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 3,
      repo: "pesap/agents",
      user: "pesap",
      forge: "github",
      focus: "all",
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.ok(
    calls.includes(
      "gh repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission",
    ),
  );
  assert.equal(
    calls.some((call) => call.startsWith("gh repo list ")),
    false,
  );
  assert.match(
    rendered,
    /repo override provided; user repository discovery intentionally skipped/,
  );
});

test("review focus collects review requests without CI or issue searches", async () => {
  const { calls, runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh repo view --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission":
      JSON.stringify({
        nameWithOwner: "pesap/agents",
        url: "https://github.com/pesap/agents",
        isPrivate: false,
      }),
    "gh search prs --review-requested=@me --state=open --limit 2 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
  });

  await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 2,
      repo: "",
      user: "",
      forge: "github",
      focus: "reviews",
    },
    runner,
  );

  assert.ok(
    calls.includes(
      "gh search prs --review-requested=@me --state=open --limit 2 --json number,title,url,repository,updatedAt,isDraft,labels",
    ),
  );
  assert.equal(
    calls.some((call) => call.includes("--checks=")),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("gh search issues")),
    false,
  );
});

test("local focus shapes dirty, unpublished, unpushed, and gone worktree signals", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const calls: string[] = [];
  const runner: InboxCommandRunner = async (command, args, options) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(`${options.cwd} ${key}`);
    if (key === "git rev-parse --is-inside-work-tree") {
      return { ok: true, stdout: "true\n", stderr: "" };
    }
    if (key === "git worktree list --porcelain") {
      return {
        ok: true,
        stdout: [
          "worktree /repo/main",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /repo/unpublished",
          "HEAD def",
          "branch refs/heads/feature/unpublished",
          "",
          "worktree /repo/feature",
          "HEAD ghi",
          "branch refs/heads/feature/local",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (
      key === "git status --porcelain=v1 -b" &&
      options.cwd === "/repo/main"
    ) {
      return {
        ok: true,
        stdout: "## main...origin/main\n M README.md\n",
        stderr: "",
      };
    }
    if (
      key === "git status --porcelain=v1 -b" &&
      options.cwd === "/repo/unpublished"
    ) {
      return { ok: true, stdout: "## feature/unpublished\n", stderr: "" };
    }
    if (
      key === "git status --porcelain=v1 -b" &&
      options.cwd === "/repo/feature"
    ) {
      return {
        ok: true,
        stdout: "## feature/local...origin/feature/local [ahead 2, gone]\n",
        stderr: "",
      };
    }
    if (key === "git remote get-url origin") {
      return {
        ok: true,
        stdout: "git@github.com:pesap/agents.git\n",
        stderr: "",
      };
    }
    return { ok: false, stdout: "", stderr: `missing fake output for ${key}` };
  };

  const sections = await collectInboxEvidence(
    {
      cwd: "/repo/main",
      limit: 5,
      repo: "pesap/agents",
      user: "",
      forge: "gitlab",
      focus: "local",
      capsuleRoot,
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.match(rendered, /Agent\/session needs attention \(2\):/);
  assert.match(
    rendered,
    /source=local-worktree repo=pesap\/agents title="#main: uncommitted work at \/repo\/main"/,
  );
  assert.match(
    rendered,
    /source=local-worktree repo=pesap\/agents title="#feature\/unpublished: unpublished work at \/repo\/unpublished"/,
  );
  assert.match(rendered, /My work is broken \(1\):/);
  assert.match(
    rendered,
    /source=local-worktree repo=pesap\/agents title="#feature\/local: unpushed\+missing-upstream work at \/repo\/feature"/,
  );
  assert.equal(
    calls.filter((call) => call.includes("git status --porcelain=v1 -b"))
      .length,
    3,
  );
});

test("session focus discovers stale capsules and correlates branch worktrees", async () => {
  const capsuleRoot = await mkdtemp(path.join(tmpdir(), "khala-inbox-test-"));
  try {
    const capsulePath = path.join(
      capsuleRoot,
      "github.com",
      "pesap",
      "agents",
      "capsule.md",
    );
    await mkdir(path.dirname(capsulePath), { recursive: true });
    await writeFile(
      capsulePath,
      [
        "# Workon session capsule",
        "",
        "Repo: pesap/agents",
        "Issue: https://github.com/pesap/agents/issues/85",
        "Issue number: #85",
        "Branch: feat/85-surface-stale-sessions-and-capsules",
        "Worktree status: launched",
        "Worktree path: (not available)",
        "Created: 2026-06-04T00:00:00.000Z",
        "",
      ].join("\n"),
      "utf8",
    );

    const { runner } = fakeCommandRunner({
      "git worktree list --porcelain": [
        "worktree /repo/main",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/feature-85",
        "HEAD def",
        "branch refs/heads/feat/85-surface-stale-sessions-and-capsules",
        "",
      ].join("\n"),
      "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
    });

    const sections = await collectInboxEvidence(
      {
        cwd: "/repo/main",
        limit: 5,
        repo: "",
        user: "",
        forge: "gitlab",
        focus: "sessions",
        capsuleRoot,
        nowIso: "2026-06-05T13:00:00.000Z",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /Agent\/session needs attention \(1\):/);
    assert.match(
      rendered,
      /source=stale-session-capsule repo=pesap\/agents title="#feat\/85-surface-stale-sessions-and-capsules #85: stale-37h capsule at .* worktree=\/repo\/feature-85"/,
    );
    assert.match(
      rendered,
      /url=https:\/\/github.com\/pesap\/agents\/issues\/85/,
    );
    assert.match(
      rendered,
      /evidence=session capsule metadata; git worktree branch/,
    );
  } finally {
    await rm(capsuleRoot, { recursive: true, force: true });
  }
});

test("session focus reports blocked capsules with deleted worktrees", async () => {
  const capsuleRoot = await mkdtemp(path.join(tmpdir(), "khala-inbox-test-"));
  try {
    const missingWorktree = path.join(capsuleRoot, "deleted-worktree");
    const capsulePath = path.join(
      capsuleRoot,
      "github.com",
      "pesap",
      "agents",
      "capsule.md",
    );
    await mkdir(path.dirname(capsulePath), { recursive: true });
    await writeFile(
      capsulePath,
      [
        "# Workon session capsule",
        "",
        "Repo: pesap/agents",
        "Issue: https://github.com/pesap/agents/issues/85",
        "Issue number: #85",
        "Branch: feat/85-surface-stale-sessions-and-capsules",
        "Worktree status: blocked",
        `Worktree path: ${missingWorktree}`,
        "Created: 2026-06-05T12:30:00.000Z",
        "",
      ].join("\n"),
      "utf8",
    );

    const { runner } = fakeCommandRunner({
      "git worktree list --porcelain":
        "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n",
      "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
    });

    const sections = await collectInboxEvidence(
      {
        cwd: "/repo/main",
        limit: 5,
        repo: "pesap/agents",
        user: "",
        forge: "gitlab",
        focus: "sessions",
        capsuleRoot,
        nowIso: "2026-06-05T13:00:00.000Z",
      },
      runner,
    );
    const rendered = sections.join("\n");

    assert.match(rendered, /My work is broken \(1\):/);
    assert.match(rendered, /blocked\+missing-worktree/);
    assert.match(
      rendered,
      /evidence=session capsule metadata; capsule worktree path/,
    );
  } finally {
    await rm(capsuleRoot, { recursive: true, force: true });
  }
});

test("uses global inbox scope from non-git directories without current-repo git noise", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { calls, runner } = fakeCommandRunner({
    "git rev-parse --is-inside-work-tree": "false\n",
    "gh auth status": "",
    "gh api user --jq .login": "pesap\n",
    "gh api graphql -F first=5 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes":
      "[]",
    "gh search prs --review-requested=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=failure --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=pending --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,labels":
      "[]",
    "gh search issues --author=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,labels":
      "[]",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: "/tmp/not-a-repo",
      limit: 5,
      repo: "",
      user: "",
      forge: "github",
      focus: "all",
      capsuleRoot,
    },
    runner,
  );

  assert.ok(calls.includes("gh api user --jq .login"));
  assert.equal(calls.includes("git remote get-url origin"), false);
  assert.equal(calls.includes("git worktree list --porcelain"), false);
  assert.doesNotMatch(sections.join("\n"), /local git|current repository/);
});

test("explicit global inbox scope skips current-repo worktree collection", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { calls, runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh api user --jq .login": "pesap\n",
    "gh api graphql -F first=3 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes":
      "[]",
    "gh search prs --review-requested=@me --state=open --limit 3 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=failure --limit 3 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=pending --limit 3 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 3 --json number,title,url,repository,updatedAt,labels":
      "[]",
    "gh search issues --author=@me --state=open --limit 3 --json number,title,url,repository,updatedAt,labels":
      "[]",
  });

  await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 3,
      repo: "",
      user: "",
      forge: "github",
      focus: "all",
      scope: "global",
      capsuleRoot,
    },
    runner,
  );

  assert.equal(calls.includes("git rev-parse --is-inside-work-tree"), false);
  assert.equal(calls.includes("git worktree list --porcelain"), false);
});

test("collects typed deterministic inbox snapshot before rendering", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission":
      JSON.stringify({
        nameWithOwner: "pesap/agents",
        url: "https://github.com/pesap/agents",
        updatedAt: "2026-06-05T00:00:00Z",
        isPrivate: false,
        viewerPermission: "ADMIN",
      }),
    "gh search prs --review-requested=@me --state=open --limit 5 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      JSON.stringify([
        {
          number: 2,
          title: "older review",
          url: "https://github.com/pesap/agents/pull/2",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-01T00:00:00Z",
        },
        {
          number: 1,
          title: "newer review",
          url: "https://github.com/pesap/agents/pull/1",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-02T00:00:00Z",
        },
      ]),
  });

  const snapshot = await collectInboxSnapshot(
    {
      cwd: "/repo/main",
      limit: 5,
      repo: "pesap/agents",
      user: "",
      forge: "github",
      focus: "reviews",
      capsuleRoot,
      nowIso: "2026-06-05T00:00:00.000Z",
    },
    runner,
  );

  assert.deepEqual(snapshot.scope, {
    cwd: "/repo/main",
    repo: "pesap/agents",
    user: undefined,
    forge: "github",
    focus: "reviews",
  });
  assert.equal(snapshot.generatedAt, "2026-06-05T00:00:00.000Z");
  assert.equal(snapshot.status, "partial");
  assert.deepEqual(
    snapshot.collectors.map((collector) => ({
      name: collector.name,
      status: collector.status,
    })),
    [
      { name: "github", status: "ok" },
      { name: "local", status: "skipped" },
    ],
  );
  assert.deepEqual(
    snapshot.items.map((item) => item.title),
    ["2: older review", "1: newer review"],
  );
  assert.equal(JSON.parse(renderInboxSnapshotJson(snapshot)).items.length, 2);
});

test("renders compact actionable dashboard from typed snapshot", async () => {
  const rendered = renderInboxSnapshotCompact({
    generatedAt: "2026-06-06T00:12:00.000Z",
    scope: {
      cwd: "/repo/main",
      repo: "pesap/agents",
      forge: "github",
      focus: "all",
    },
    status: "partial",
    collectors: [
      { name: "github", status: "ok", gaps: [], commands: ["gh search prs"] },
      {
        name: "local",
        status: "skipped",
        gaps: ["Local collector skipped for focus=reviews"],
        commands: [],
      },
    ],
    items: [
      {
        bucket: "Needs you now",
        repo: "NatLabRockies/R2X",
        source: "review-requested-pr",
        title: "256: Review request",
        url: "https://github.com/NatLabRockies/R2X/pull/256",
        updatedAt: "2026-06-05T00:00:00Z",
        suggestedCommand: "/review pr https://github.com/NatLabRockies/R2X/pull/256",
        evidence: "gh search prs --review-requested=@me --state=open",
      },
      {
        bucket: "My work is broken",
        repo: "NatLabRockies/arco",
        source: "authored-pr-ci-pending",
        title: "313: Check CI",
        url: "https://github.com/NatLabRockies/arco/pull/313",
        suggestedCommand: "/inbox --repo NatLabRockies/arco --focus ci",
        evidence: "gh search prs --author=@me --state=open --checks=pending",
      },
    ],
  });

  assert.match(rendered, /^Inbox · 2026-06-06 00:12 · partial/);
  assert.match(rendered, /github ok · local skipped/);
  assert.match(rendered, /Do next\n1\. NatLabRockies\/R2X #256: Review request/);
  assert.match(rendered, /2\. NatLabRockies\/arco #313: Check CI/);
  assert.match(rendered, /Counts: reviews 1, broken CI 1, blocked sessions 0, issues 0, local 0/);
  assert.match(rendered, /Gaps: Local collector skipped for focus=reviews/);
  assert.doesNotMatch(rendered, /Read-only commands executed/);
});

test("compact dashboard handles empty partial states", async () => {
  const rendered = renderInboxSnapshotCompact({
    generatedAt: "2026-06-06T00:12:00.000Z",
    scope: { cwd: "/tmp", forge: "github", focus: "all" },
    status: "partial",
    collectors: [
      { name: "github", status: "failed", gaps: ["gh auth status: failed"], commands: [] },
      { name: "local", status: "skipped", gaps: ["Local collector skipped"], commands: [] },
    ],
    items: [],
  });

  assert.match(rendered, /Do next\n- No ranked actions from collected evidence\./);
  assert.match(rendered, /Gaps: gh auth status: failed; Local collector skipped/);
});

test("inbox details flags preserve explicit evidence mode", () => {
  assert.equal(parseInboxArgs("--details").details, true);
  assert.equal(parseInboxArgs("--evidence").details, true);
  assert.equal(parseInboxArgs("--focus reviews").details, false);
});

test("collects compact dashboard by default without command dumps", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission":
      JSON.stringify({ nameWithOwner: "pesap/agents", isPrivate: false }),
    "gh search prs --review-requested=@me --state=open --limit 1 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
  });

  const sections = await collectInboxDashboard(
    {
      cwd: "/repo/main",
      limit: 1,
      repo: "pesap/agents",
      user: "",
      forge: "github",
      focus: "reviews",
      capsuleRoot,
      nowIso: "2026-06-06T00:12:00.000Z",
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.match(rendered, /^Inbox · 2026-06-06 00:12 · partial/);
  assert.doesNotMatch(rendered, /Read-only commands executed/);
});

test("non-git cwd skips local collection while global GitHub searches still run", async (t) => {
  const capsuleRoot = await emptyCapsuleRoot();
  t.after(() => rm(capsuleRoot, { recursive: true, force: true }));
  const { calls, runner } = fakeCommandRunner({
    "gh auth status": "",
    "gh api user --jq .login": "pesap\n",
    "gh api graphql -F first=4 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes":
      "[]",
    "gh search prs --review-requested=@me --state=open --limit 4 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=failure --limit 4 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search prs --author=@me --state=open --checks=pending --limit 4 --json number,title,url,repository,updatedAt,isDraft,labels":
      "[]",
    "gh search issues --assignee=@me --state=open --limit 4 --json number,title,url,repository,updatedAt,labels":
      JSON.stringify([
        {
          number: 104,
          title: "fix inbox",
          url: "https://github.com/pesap/agents/issues/104",
          repository: { nameWithOwner: "pesap/agents" },
          updatedAt: "2026-06-05T00:00:00Z",
        },
      ]),
    "gh search issues --author=@me --state=open --limit 4 --json number,title,url,repository,updatedAt,labels":
      "[]",
  });
  const runnerWithNonRepoGitFailure: InboxCommandRunner = async (
    command,
    args,
    options,
  ) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "git rev-parse --is-inside-work-tree") {
      calls.push(key);
      return {
        ok: false,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
        error: "Command failed: git rev-parse --is-inside-work-tree",
      };
    }
    return runner(command, args, options);
  };

  const sections = await collectInboxEvidence(
    {
      cwd: "/Users/psanchez",
      limit: 4,
      repo: "",
      user: "@me",
      forge: "github",
      focus: "all",
      capsuleRoot,
    },
    runnerWithNonRepoGitFailure,
  );
  const rendered = sections.join("\n");

  assert.doesNotMatch(rendered, /fatal: not a git repository/);
  assert.doesNotMatch(rendered, /Command failed: git rev-parse/);
  assert.match(rendered, /source=assigned-issue repo=pesap\/agents/);
  assert.ok(
    calls.includes(
      "gh search issues --assignee=@me --state=open --limit 4 --json number,title,url,repository,updatedAt,labels",
    ),
  );
  assert.equal(
    calls.some((call) => call.startsWith("git worktree list")),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("gh search issues") && call.includes("isDraft")),
    false,
  );
});

test("skips GitHub collection for GitLab-only inbox scope", async () => {
  const { calls, runner } = fakeCommandRunner({
    "git worktree list --porcelain":
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
    "git status --porcelain=v1 -b": "## main...origin/main\n",
    "git rev-parse --is-inside-work-tree": "true\n",
    "git remote get-url origin": "git@github.com:pesap/agents.git\n",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 10,
      repo: "",
      user: "@me",
      forge: "gitlab",
      focus: "all",
    },
    runner,
  );

  assert.equal(
    calls.some((call) => call.startsWith("gh ")),
    false,
  );
  assert.ok(calls.includes("git worktree list --porcelain"));
  assert.match(
    sections.join("\n"),
    /GitHub collector skipped for forge=gitlab/,
  );
});
