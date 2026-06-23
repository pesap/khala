import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createKhalaCommandHandlers, formatKhalaHealthStatus } from "../../extensions/commands/khala.ts";
import type { RuntimeState } from "../../extensions/state/runtime.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";
import {
  resetActiveWorkflowRouteForTests,
  setWorkflowModelConfig,
} from "../../extensions/runtime/workflow-model-router.ts";

let fakePiDir: string | null = null;
let previousPath: string | undefined;

before(async () => {
  fakePiDir = await mkdtemp(path.join(tmpdir(), "khala-health-pi-"));
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

function makeHarness(overrides?: Partial<RuntimeState>): {
  runtimeState: RuntimeState;
  messages: string[];
  agentStateEntries: Array<{ enabled: boolean; at: string; source?: string }>;
  compliancePresets: string[];
  handlers: ReturnType<typeof createKhalaCommandHandlers>;
  ctx: never;
} {
  const runtimeState: RuntimeState = {
    agentEnabled: false,
    riskApproval: null,
    riskEvents: [],
    firstPrinciplesConfig: {
      preflightMode: "warn",
      postflightMode: "warn",
      responseComplianceMode: "warn",
    },
    activePreflight: null,
    latestPostflight: null,
    policyEvents: [],
    memoryToolCallLimit: 15,
    lastObligationBlockKey: null,
    lastObligationBlockCount: 0,
    lastMemoryGateBlockKey: null,
    lastMemoryGateBlockCount: 0,
    lastEmptyResponseBlockKey: null,
    lastEmptyResponseBlockCount: 0,
    ...overrides,
  };
  const messages: string[] = [];
  const agentStateEntries: Array<{ enabled: boolean; at: string; source?: string }> = [];
  const compliancePresets: string[] = [];
  const defaultConfig = {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  } as const;

  return {
    runtimeState,
    messages,
    agentStateEntries,
    compliancePresets,
    handlers: createKhalaCommandHandlers({
      runtimeState,
      notify: (_ctx, message) => {
        messages.push(message);
      },
      setAgentEnabledState: (_ctx, enabled) => {
        runtimeState.agentEnabled = enabled;
      },
      appendAgentStateEntry: (enabled, at, source) => {
        agentStateEntries.push({ enabled, at, source });
      },
      nowIso: () => "2026-06-22T00:00:00.000Z",
      runCompliancePreset: async (preset) => {
        compliancePresets.push(preset);
        runtimeState.firstPrinciplesConfig =
          preset === "reset"
            ? { ...defaultConfig }
            : {
                preflightMode: preset as RuntimeState["firstPrinciplesConfig"]["preflightMode"],
                postflightMode: preset as RuntimeState["firstPrinciplesConfig"]["postflightMode"],
                responseComplianceMode: preset as RuntimeState["firstPrinciplesConfig"]["responseComplianceMode"],
              };
      },
    }),
    ctx: {} as never,
  };
}

test("/khala-health is read-only and reports health status", async () => {
  const harness = makeHarness({
    agentEnabled: false,
    memoryToolCallLimit: 17,
  });

  await harness.handlers.khalaHealth(undefined, harness.ctx);

  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0], /Khala health:/);
  assert.match(harness.messages[0], /enabled: no/);
  assert.match(harness.messages[0], /memory_tool_limit: 17/);
  assert.match(harness.messages[0], /compliance: preflight=warn, postflight=warn, response=warn/);
  assert.match(harness.messages[0], /Model profiles ~/);
  assert.match(harness.messages[0], /OK planning/);
  assert.equal(harness.agentStateEntries.length, 0);
  assert.deepEqual(harness.compliancePresets, []);
});

test("/khala status reports durable workflow config without not-set wording", async () => {
  resetActiveWorkflowRouteForTests();
  try {
    setWorkflowModelConfig(
      {
        routes: { workon: "development", plan: "planning" },
        profiles: {
          planning: "openai-codex/gpt-5.5:high",
          development: "openai-codex/gpt-5.4-mini:low",
        },
      },
      {
        path: "/tmp/khala/workflow-model.yaml",
        found: true,
        explicitProfiles: ["planning", "development"],
        explicitRoutes: ["workon", "plan"],
      },
    );
    const harness = makeHarness({
      agentEnabled: true,
      memoryToolCallLimit: 21,
    });

    await harness.handlers.khala("status", harness.ctx);

    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0], /workflow config: found at \/tmp\/khala\/workflow-model\.yaml/);
    assert.match(harness.messages[0], /workflow profile flag: none \(CLI override not set; workflow config still applies\)/);
    assert.match(harness.messages[0], /active profiles: .*planning=openai-codex\/gpt-5\.5:high/);
    assert.match(harness.messages[0], /active profiles: .*development=openai-codex\/gpt-5\.4-mini:low/);
    assert.match(harness.messages[0], /model: openai-codex\/gpt-5\.5/);
    assert.match(harness.messages[0], /model: openai-codex\/gpt-5\.4-mini/);
    assert.doesNotMatch(harness.messages[0], /workflow profile flag: \(not set\)/);
    assert.doesNotMatch(harness.messages[0], /workflow task flag: \(not set\)/);
  } finally {
    resetActiveWorkflowRouteForTests();
  }
});

test("/khala status remains a compatibility alias for /khala-health", async () => {
  const harness = makeHarness({
    agentEnabled: true,
    memoryToolCallLimit: 21,
  });

  await harness.handlers.khalaHealth(undefined, harness.ctx);
  const healthOutput = harness.messages.at(-1);

  await harness.handlers.khala("status", harness.ctx);

  assert.equal(harness.messages.length, 2);
  assert.equal(harness.messages[1], healthOutput);
  assert.equal(harness.agentStateEntries.length, 0);
  assert.deepEqual(harness.compliancePresets, []);
});

test("/khala with no arguments initializes Khala and applies warn compliance", async () => {
  const harness = makeHarness({
    agentEnabled: false,
    memoryToolCallLimit: 15,
  });

  await harness.handlers.khala(undefined, harness.ctx);

  assert.equal(harness.runtimeState.agentEnabled, true);
  assert.equal(harness.agentStateEntries.length, 1);
  assert.deepEqual(harness.agentStateEntries[0], {
    enabled: true,
    at: "2026-06-22T00:00:00.000Z",
    source: "khala",
  });
  assert.deepEqual(harness.compliancePresets, ["warn"]);
  assert.match(harness.messages[0], /khala initialized\. End-of-turn learning assessment is now active\. memory_tool_limit=15/);
});

test("/khala preserves memory tool limit aliases and 1..100 clamping", async () => {
  const harness = makeHarness({
    agentEnabled: true,
    memoryToolCallLimit: 15,
  });

  await harness.handlers.khala("--learn-tool-limit 0", harness.ctx);
  assert.equal(harness.runtimeState.memoryToolCallLimit, 1);
  assert.match(harness.messages[0], /memory_tool_limit=1/);

  await harness.handlers.khala("--memory-tool-limit 101", harness.ctx);
  assert.equal(harness.runtimeState.memoryToolCallLimit, 100);
  assert.match(harness.messages[1], /memory_tool_limit=100/);

  assert.deepEqual(harness.compliancePresets, ["warn", "warn"]);
});

test("/khala-mode with no arguments reports compliance status without mutating session state", async () => {
  const harness = makeHarness({
    agentEnabled: false,
    memoryToolCallLimit: 17,
  });

  await harness.handlers.khalaMode(undefined, harness.ctx);

  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0], /Khala health:/);
  assert.match(harness.messages[0], /compliance: preflight=warn, postflight=warn, response=warn/);
  assert.equal(harness.runtimeState.agentEnabled, false);
  assert.equal(harness.agentStateEntries.length, 0);
  assert.deepEqual(harness.compliancePresets, []);
});

for (const [args, expectedPreset, expectedConfig] of [
  [undefined, "status", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
  ["strict", "enforce", {
    preflightMode: "enforce",
    postflightMode: "enforce",
    responseComplianceMode: "enforce",
  }],
  ["enforce", "enforce", {
    preflightMode: "enforce",
    postflightMode: "enforce",
    responseComplianceMode: "enforce",
  }],
  ["warn", "warn", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
  ["warning", "warn", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
  ["monitor", "monitor", {
    preflightMode: "monitor",
    postflightMode: "monitor",
    responseComplianceMode: "monitor",
  }],
  ["reset", "reset", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
  ["default", "reset", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
  ["defaults", "reset", {
    preflightMode: "warn",
    postflightMode: "warn",
    responseComplianceMode: "warn",
  }],
] as const) {
  test(`/khala-mode ${args ?? "<no args>"} maps to ${expectedPreset}`, async () => {
    const harness = makeHarness();

    await harness.handlers.khalaMode(args, harness.ctx);

    if (expectedPreset === "status") {
      assert.equal(harness.messages.length, 1);
      assert.match(harness.messages[0], /Khala health:/);
      assert.deepEqual(harness.compliancePresets, []);
      assert.equal(harness.runtimeState.agentEnabled, false);
      assert.equal(harness.agentStateEntries.length, 0);
      return;
    }

    assert.equal(harness.messages.length, 0);
    assert.deepEqual(harness.compliancePresets, [expectedPreset]);
    assert.equal(harness.runtimeState.agentEnabled, false);
    assert.equal(harness.agentStateEntries.length, 0);
    assert.deepEqual(harness.runtimeState.firstPrinciplesConfig, expectedConfig);
  });
}

test("/khala-mode status is invalid and points users to /khala-health", async () => {
  const harness = makeHarness();

  await harness.handlers.khalaMode("status", harness.ctx);

  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0], /\/khala-health for status/);
  assert.equal(harness.agentStateEntries.length, 0);
  assert.deepEqual(harness.compliancePresets, []);
});

test("legacy /khala compliance aliases are rejected without mutating state", async () => {
  for (const args of ["strict", "enforce", "warn", "warning", "monitor", "reset", "default", "defaults"] as const) {
    const harness = makeHarness({
      memoryToolCallLimit: 23,
      firstPrinciplesConfig: {
        preflightMode: "warn",
        postflightMode: "warn",
        responseComplianceMode: "warn",
      },
    });

    await harness.handlers.khala(args, harness.ctx);

    assert.equal(harness.messages.length, 1, args);
    assert.match(harness.messages[0], /Usage: \/khala/);
    assert.equal(harness.runtimeState.agentEnabled, false, args);
    assert.equal(harness.runtimeState.memoryToolCallLimit, 23, args);
    assert.deepEqual(harness.runtimeState.firstPrinciplesConfig, {
      preflightMode: "warn",
      postflightMode: "warn",
      responseComplianceMode: "warn",
    }, args);
    assert.equal(harness.agentStateEntries.length, 0, args);
    assert.deepEqual(harness.compliancePresets, [], args);
  }
});

test("formatKhalaHealthStatus includes session state and model profiles", () => {
  const rendered = formatKhalaHealthStatus({
    enabled: true,
    memoryToolLimit: 9,
    firstPrinciplesConfig: {
      preflightMode: "warn",
      postflightMode: "enforce",
      responseComplianceMode: "monitor",
    },
  });

  assert.match(rendered, /Khala health:/);
  assert.match(rendered, /enabled: yes/);
  assert.match(rendered, /memory_tool_limit: 9/);
  assert.match(rendered, /preflight=warn, postflight=enforce, response=monitor/);
  assert.match(rendered, /Model profiles ~/);
  assert.match(rendered, /OK planning/);
  assert.match(rendered, /used by:/);
});
