import test from "node:test";
import assert from "node:assert/strict";

import { HARNESS_ISSUE_TYPE } from "../../extensions/lib/constants.ts";

test("harness issue entries use a stable custom session type", () => {
  assert.equal(HARNESS_ISSUE_TYPE, "khala-harness-issue");
});
