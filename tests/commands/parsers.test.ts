import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewTarget,
  parseReviewArgs,
} from "../../extensions/commands/parsers.ts";

test("parses direct GitHub PR URLs as review PR targets", () => {
  const parsed = parseReviewArgs(
    "https://github.com/earendil-works/pi-review/pull/123 --extra security",
    process.cwd(),
  );

  assert.deepEqual(parsed, {
    mode: "pr",
    pr: "123",
    extraInstruction: "security",
  });
});

test("normalizes explicit PR number and URL targets", () => {
  assert.deepEqual(parseReviewArgs("pr 42", process.cwd()), {
    mode: "pr",
    pr: "42",
    extraInstruction: undefined,
  });
  assert.deepEqual(
    parseReviewArgs("pr https://github.com/owner/repo/pull/77", process.cwd()),
    {
      mode: "pr",
      pr: "77",
      extraInstruction: undefined,
    },
  );
});

test("builds PR review instructions with pi-review checkout safeguards", () => {
  const parsed = parseReviewArgs("pr 42", process.cwd());
  assert.ok(!("error" in parsed));

  const target = buildReviewTarget(parsed);

  assert.equal(target.summary, "pull request 42");
  assert.match(target.instruction, /Require GitHub CLI/);
  assert.match(target.instruction, /no staged or unstaged tracked-file changes/);
  assert.match(target.instruction, /compute the merge base/);
});
