import test from "node:test";
import assert from "node:assert/strict";

import { createComplianceCommandHandlers } from "../../extensions/commands/compliance.ts";
import { parseComplianceArgs } from "../../extensions/commands/parsers.ts";

test("khala status includes model profile doctor output", async () => {
  const messages: string[] = [];
  const handlers = createComplianceCommandHandlers({
    runtimeState: {
      firstPrinciplesConfig: {
        preflightMode: "warn",
        postflightMode: "warn",
        responseComplianceMode: "warn",
      },
    } as never,
    notify: (_ctx, message) => messages.push(message),
    parseComplianceArgs,
    parseApproveRiskArgs: () => ({ reason: "", ttlMinutes: 20 }),
    parsePreflightArgs: () => ({}),
    parsePostflightArgs: () => ({}),
    nowIso: () => "2026-06-12T00:00:00.000Z",
    getDefaultFirstPrinciplesConfig: () => ({
      preflightMode: "warn",
      postflightMode: "warn",
      responseComplianceMode: "warn",
    }) as never,
    appendComplianceModeEntry: () => undefined,
    appendRiskApprovalEntry: () => undefined,
    appendPreflightEntry: () => undefined,
    appendPostflightEntry: () => undefined,
  });

  await handlers.compliance("status", { cwd: process.cwd() } as never);

  assert.equal(messages.length, 1);
  assert.match(messages[0], /Compliance modes \(session\):/);
  assert.match(messages[0], /Model profiles:/);
  assert.match(messages[0], /planning: model=github-copilot\/gpt-5\.5, thinking=xhigh/);
  assert.match(messages[0], /development: model=.*thinking=medium/);
});
