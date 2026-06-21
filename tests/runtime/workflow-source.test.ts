import assert from "node:assert/strict";
import test from "node:test";

import { workflowSourceFromFlags } from "../../extensions/workflows/source.ts";

test("workflowSourceFromFlags derives GitHub issue source context", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "73", repo: "pesap/agents" }), {
    issue: 73,
    url: "https://github.com/pesap/agents/issues/73",
  });
});

test("workflowSourceFromFlags derives source context from issue flags", () => {
  assert.deepEqual(workflowSourceFromFlags({ issue: "196", repo: "pesap/agents" }), {
    issue: 196,
    url: "https://github.com/pesap/agents/issues/196",
  });
  assert.deepEqual(workflowSourceFromFlags({ issueNumber: "197", repo: "pesap/agents" }), {
    issue: 197,
    url: "https://github.com/pesap/agents/issues/197",
  });
  assert.deepEqual(workflowSourceFromFlags({ issue_number: "198", repo: "pesap/agents" }), {
    issue: 198,
    url: "https://github.com/pesap/agents/issues/198",
  });
  assert.deepEqual(workflowSourceFromFlags({ issue: "https://github.com/pesap/agents/issues/199" }), {
    issue: 199,
    url: "https://github.com/pesap/agents/issues/199",
  });
});

test("workflowSourceFromFlags preserves URL source targets", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "https://github.com/pesap/agents/issues/196" }), {
    issue: 196,
    url: "https://github.com/pesap/agents/issues/196",
  });
});

test("workflowSourceFromFlags derives GitHub PR source context", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "https://github.com/pesap/agents/pull/194" }), {
    pr: 194,
    url: "https://github.com/pesap/agents/pull/194",
  });
});

test("workflowSourceFromFlags derives source context from PR flags", () => {
  assert.deepEqual(workflowSourceFromFlags({ pr: "194", repo: "pesap/agents" }), {
    pr: 194,
    url: "https://github.com/pesap/agents/pull/194",
  });
  assert.deepEqual(workflowSourceFromFlags({ pr: "https://github.com/pesap/agents/pull/195" }), {
    pr: 195,
    url: "https://github.com/pesap/agents/pull/195",
  });
});

test("workflowSourceFromFlags preserves non-GitHub URL source targets", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "https://gitlab.example.com/group/project/-/issues/7" }), {
    url: "https://gitlab.example.com/group/project/-/issues/7",
  });
});

test("workflowSourceFromFlags ignores non-source workflow targets", () => {
  assert.equal(workflowSourceFromFlags({ target: "release-notes", repo: "pesap/agents" }), undefined);
});
