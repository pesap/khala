import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createComplianceCommandHandlers } from "../../extensions/commands/compliance.ts";
import { parseComplianceArgs, parseKhalaModeArgs } from "../../extensions/commands/parsers.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";

let fakePiDir: string | null = null;
let previousPath: string | undefined;

before(async () => {
  fakePiDir = await mkdtemp(path.join(tmpdir(), "khala-compliance-pi-"));
  previousPath = process.env.PATH;
  await writeFile(
    path.join(fakePiDir, "pi"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--list-models gpt-5.4-mini" ]]; then
  printf 'provider model context max-out thinking images\n'
  printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
fi
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${fakePiDir}${path.delimiter}${previousPath ?? ""}`;
  resetKhalaProfileDiscoveryForTests();
});

after(async () => {
  resetKhalaProfileDiscoveryForTests();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (fakePiDir) await rm(fakePiDir, { force: true, recursive: true });
});

test("khala status includes model profile doctor output", async () => {
  const messages: string[] = [];
  const handlers = createComplianceCommandHandlers({
    runtimeState: {
      agentEnabled: false,
      memoryToolCallLimit: 15,
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

test("parseKhalaModeArgs recognizes aliases and rejects status", () => {
  assert.deepEqual(parseKhalaModeArgs(""), { preset: "status" });
  assert.deepEqual(parseKhalaModeArgs("strict"), { preset: "enforce" });
  assert.deepEqual(parseKhalaModeArgs("enforce"), { preset: "enforce" });
  assert.deepEqual(parseKhalaModeArgs("warn"), { preset: "warn" });
  assert.deepEqual(parseKhalaModeArgs("warning"), { preset: "warn" });
  assert.deepEqual(parseKhalaModeArgs("monitor"), { preset: "monitor" });
  assert.deepEqual(parseKhalaModeArgs("reset"), { preset: "reset" });
  assert.deepEqual(parseKhalaModeArgs("default"), { preset: "reset" });
  assert.deepEqual(parseKhalaModeArgs("defaults"), { preset: "reset" });
  assert.deepEqual(parseKhalaModeArgs("status"), {
    preset: "status",
    error: "Usage: /khala-mode [strict|enforce|warn|warning|monitor|reset|default|defaults] or /khala-health for status",
  });
});
