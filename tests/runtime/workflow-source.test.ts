import assert from "node:assert/strict";
import test from "node:test";

import { workflowSourceFromFlags } from "../../extensions/workflows/source.ts";

test("workflowSourceFromFlags derives GitHub issue source context", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "73", repo: "pesap/agents" }), {
    issue: 73,
    url: "https://github.com/pesap/agents/issues/73",
  });
});

test("workflowSourceFromFlags preserves URL source targets", () => {
  assert.deepEqual(workflowSourceFromFlags({ target: "https://github.com/pesap/agents/issues/196" }), {
    url: "https://github.com/pesap/agents/issues/196",
  });
});

test("workflowSourceFromFlags ignores non-source workflow targets", () => {
  assert.equal(workflowSourceFromFlags({ target: "release-notes", repo: "pesap/agents" }), undefined);
});
