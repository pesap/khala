import test from "node:test";
import assert from "node:assert/strict";

import {
  collectInboxEvidence,
  type InboxCommandRunner,
} from "../../extensions/commands/inbox.ts";

function fakeGhRunner(outputs: Record<string, string>): {
  calls: string[];
  runner: InboxCommandRunner;
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

test("collects read-only GitHub inbox evidence for authenticated user", async () => {
  const { calls, runner } = fakeGhRunner({
    "auth status": "",
    "api user --jq .login": "pesap\n",
    "api graphql -F first=5 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes": JSON.stringify([
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
    "search prs --review-requested=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
      {
        number: 12,
        title: "review me",
        url: "https://github.com/org/repo/pull/12",
        repository: { nameWithOwner: "org/repo" },
        updatedAt: "2026-06-01T00:00:00Z",
        isDraft: false,
      },
    ]),
    "search prs --author=@me --state=open --checks=failure --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
      {
        number: 9,
        title: "fix failing ci",
        url: "https://github.com/pesap/agents/pull/9",
        repository: { nameWithOwner: "pesap/agents" },
        updatedAt: "2026-06-02T00:00:00Z",
        isDraft: false,
      },
    ]),
    "search prs --author=@me --state=open --checks=pending --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search issues --assignee=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
      {
        number: 61,
        title: "collect inbox",
        url: "https://github.com/pesap/agents/issues/61",
        repository: { nameWithOwner: "pesap/agents" },
        updatedAt: "2026-06-05T00:00:00Z",
      },
    ]),
    "search issues --author=@me --state=open --limit 5 --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 5,
      repo: "",
      user: "@me",
      forge: "github",
      focus: "all",
    },
    runner,
  );
  const rendered = sections.join("\n");

  assert.match(rendered, /Repository discovery:/);
  assert.match(rendered, /pesap\/agents/);
  assert.match(rendered, /Needs you now \(1\):/);
  assert.match(rendered, /source=review-requested-pr repo=org\/repo title="#12: review me" updated=2026-06-01T00:00:00Z/);
  assert.match(rendered, /My work is broken \(1\):/);
  assert.match(rendered, /source=authored-pr-ci-failure repo=pesap\/agents title="#9: fix failing ci" updated=2026-06-02T00:00:00Z/);
  assert.match(rendered, /New work needs shaping \(1\):/);
  assert.match(rendered, /source=assigned-issue repo=pesap\/agents title="#61: collect inbox" updated=2026-06-05T00:00:00Z/);
  assert.match(rendered, /Top 3 next commands:\n1\. \/review pr https:\/\/github.com\/org\/repo\/pull\/12\n2\. \/inbox --repo pesap\/agents --focus ci\n3\. \/triage-issue https:\/\/github.com\/pesap\/agents\/issues\/61/);
  assert.match(rendered, /NatLabRockies\/arco/);
  assert.ok(
    calls.includes(
      "api graphql -F first=5 -f query=query($first: Int!) { viewer { repositories(first: $first, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { nameWithOwner url updatedAt isPrivate isArchived viewerPermission } } } } --jq .data.viewer.repositories.nodes",
    ),
  );
});

test("renders canonical buckets in stable priority order", async () => {
  const { runner } = fakeGhRunner({
    "auth status": "",
    "repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission": JSON.stringify({
      nameWithOwner: "pesap/agents",
      url: "https://github.com/pesap/agents",
      isPrivate: false,
    }),
    "search prs --review-requested=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
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
    "search prs --author=@me --state=open --checks=failure --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
      {
        number: 1,
        title: "ci failed",
        url: "https://github.com/pesap/agents/pull/1",
        repository: { nameWithOwner: "pesap/agents" },
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ]),
    "search prs --author=@me --state=open --checks=pending --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search issues --assignee=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search issues --author=@me --state=open --limit 10 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": JSON.stringify([
      {
        number: 4,
        title: "shape this",
        url: "https://github.com/pesap/agents/issues/4",
        repository: { nameWithOwner: "pesap/agents" },
        updatedAt: "2026-06-04T00:00:00Z",
      },
    ]),
  });

  const sections = await collectInboxEvidence(
    {
      cwd: process.cwd(),
      limit: 10,
      repo: "pesap/agents",
      user: "",
      forge: "github",
      focus: "all",
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
  const { calls, runner } = fakeGhRunner({
    "auth status": "",
    "repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission": JSON.stringify({
      nameWithOwner: "pesap/agents",
      url: "https://github.com/pesap/agents",
      isPrivate: false,
      viewerPermission: "ADMIN",
    }),
    "search prs --review-requested=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search prs --author=@me --state=open --checks=failure --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search prs --author=@me --state=open --checks=pending --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search issues --assignee=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
    "search issues --author=@me --state=open --limit 3 --repo pesap/agents --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
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

  assert.ok(calls.includes("repo view pesap/agents --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission"));
  assert.equal(calls.some((call) => call.startsWith("repo list ")), false);
  assert.match(rendered, /repo override provided; user repository discovery intentionally skipped/);
});

test("review focus collects review requests without CI or issue searches", async () => {
  const { calls, runner } = fakeGhRunner({
    "auth status": "",
    "repo view --json nameWithOwner,url,updatedAt,isArchived,isPrivate,viewerPermission": JSON.stringify({
      nameWithOwner: "pesap/agents",
      url: "https://github.com/pesap/agents",
      isPrivate: false,
    }),
    "search prs --review-requested=@me --state=open --limit 2 --json number,title,url,repository,updatedAt,isDraft,labels": "[]",
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
      "search prs --review-requested=@me --state=open --limit 2 --json number,title,url,repository,updatedAt,isDraft,labels",
    ),
  );
  assert.equal(calls.some((call) => call.includes("--checks=")), false);
  assert.equal(calls.some((call) => call.startsWith("search issues")), false);
});

test("skips GitHub collection for GitLab-only inbox scope", async () => {
  const { calls, runner } = fakeGhRunner({});

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

  assert.deepEqual(calls, []);
  assert.match(sections.join("\n"), /GitHub collector skipped for forge=gitlab/);
});
