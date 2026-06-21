import assert from "node:assert/strict";
import test from "node:test";

import { workflowLocalContextFromFlags } from "../../extensions/workflows/local.ts";

test("workflowLocalContextFromFlags derives canonical local artifact paths", () => {
  assert.deepEqual(
    workflowLocalContextFromFlags({
      worktreePath: "/tmp/worktrunk.khala",
      capsulePath: "/home/user/.pi/khala/github.com/pesap/agents/capsule.md",
      ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/handoff.json",
    }),
    {
      worktreePath: "/tmp/worktrunk.khala",
      capsulePath: "/home/user/.pi/khala/github.com/pesap/agents/capsule.md",
      ledgerPath: "/home/user/.pi/khala/github.com/pesap/agents/handoff.json",
    },
  );
});

test("workflowLocalContextFromFlags accepts local artifact aliases", () => {
  assert.deepEqual(
    workflowLocalContextFromFlags({
      worktree_path: "/tmp/worktrunk.alias",
      capsule: "/tmp/capsule.md",
      ledger: "/tmp/handoff.json",
    }),
    {
      worktreePath: "/tmp/worktrunk.alias",
      capsulePath: "/tmp/capsule.md",
      ledgerPath: "/tmp/handoff.json",
    },
  );
});

test("workflowLocalContextFromFlags ignores empty local context", () => {
  assert.equal(workflowLocalContextFromFlags({ worktreePath: " ", target: "73" }), undefined);
});
