import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createComplianceCommandHandlers } from "../../extensions/commands/compliance.ts";
import { parseComplianceArgs, parseKhalaModeArgs } from "../../extensions/commands/parsers.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";
import type { RuntimeState } from "../../extensions/state/runtime.ts";

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
  assert.match(messages[0], /compliance: preflight=warn, postflight=warn, response=warn/);
  assert.match(messages[0], /Model profiles/);
  assert.match(messages[0], /OK planning/);
  assert.match(messages[0], /model: github-copilot\/gpt-5\.5/);
  assert.match(messages[0], /thinking: medium/);
});

test("compliance mode changes refresh khala-mode status", async () => {
  const refreshed: string[] = [];
  const runtimeState = {
    agentEnabled: true,
    memoryToolCallLimit: 15,
    firstPrinciplesConfig: {
      preflightMode: "warn",
      postflightMode: "warn",
      responseComplianceMode: "warn",
    },
  } as RuntimeState;
  const handlers = createComplianceCommandHandlers({
    runtimeState,
    notify: () => undefined,
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
    onComplianceModeChanged: () => {
      refreshed.push(runtimeState.firstPrinciplesConfig.responseComplianceMode);
    },
    appendRiskApprovalEntry: () => undefined,
    appendPreflightEntry: () => undefined,
    appendPostflightEntry: () => undefined,
  });

  await handlers.compliance("enforce", { cwd: process.cwd() } as never);

  assert.deepEqual(refreshed, ["enforce"]);
});

test("parseKhalaModeArgs recognizes aliases and rejects status", () => {
  assert.deepEqual(parseKhalaModeArgs(""), { preset: "status" });
  assert.deepEqual(parseKhalaModeArgs("enforce"), { preset: "enforce" });
  assert.deepEqual(parseKhalaModeArgs("warn"), { preset: "warn" });
  assert.deepEqual(parseKhalaModeArgs("ignore"), { preset: "ignore" });
  assert.deepEqual(parseKhalaModeArgs("status"), {
    preset: "status",
    error: "Usage: /khala-mode [enforce|warn|ignore] or /khala-health for status",
  });
  assert.deepEqual(parseKhalaModeArgs("monitor"), {
    preset: "status",
    error: "Usage: /khala-mode [enforce|warn|ignore] or /khala-health for status",
  });
});
