import test from "node:test";
import assert from "node:assert/strict";

import {
  IMPROVE_LABEL,
  WORKON_READY_LABEL,
  WORKON_READY_PACKET_HEADINGS,
  WORKON_READY_PACKET_NORMALIZED_HEADINGS,
  normalizeWorkonPacketHeading,
  workonReadyPacketContractInstruction,
} from "../../extensions/commands/workon-ready-packet.ts";

test("workon-ready packet contract exposes canonical headings and labels", () => {
  assert.equal(IMPROVE_LABEL, "improve");
  assert.equal(WORKON_READY_LABEL, "workon-ready");
  assert.deepEqual(WORKON_READY_PACKET_HEADINGS, [
    "Current behavior",
    "Desired behavior or Goal",
    "Acceptance criteria",
    "Validation plan",
    "Non-goals",
    "Breaking-change risk",
    "Review-size risk",
    "/workon readiness notes",
  ]);
  assert.deepEqual(WORKON_READY_PACKET_NORMALIZED_HEADINGS, [
    "current behavior",
    "desired behavior or goal",
    "acceptance criteria",
    "validation plan",
    "non goals",
    "breaking change risk",
    "review size risk",
    "/workon readiness notes",
  ]);
});

test("normalizes markdown heading variants like workon parser", () => {
  assert.equal(normalizeWorkonPacketHeading("**/workon readiness notes:**"), "/workon readiness notes");
  assert.equal(normalizeWorkonPacketHeading("Breaking-change risk"), "breaking change risk");
});

test("renders packet contract instructions from canonical headings", () => {
  const instruction = workonReadyPacketContractInstruction({
    subject: "draft work packet",
    action: "review",
  });

  for (const heading of WORKON_READY_PACKET_HEADINGS) {
    assert.match(instruction, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(instruction, /readiness blockers/);
});
