import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getActiveWorkflowRoute,
  formatWorkflowRouteStatus,
  getMergedProfiles,
  getMergedRoutes,
  getWorkflowModelConfigStatus,
  resetActiveWorkflowRouteForTests,
  resolveWorkflowRoute,
  setActiveWorkflowRoute,
  setWorkflowModelConfig,
} from "../../extensions/runtime/workflow-model-router.ts";
import { loadWorkflowModelConfig } from "../../extensions/runtime/workflow-model-config.ts";
import { resetKhalaProfileDiscoveryForTests } from "../../extensions/runtime/khala-profiles.ts";

async function withFakePi(script: string, fn: () => void | Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-router-test-"));
  const previousPath = process.env.PATH;
  try {
    const piPath = path.join(tempDir, "pi");
    await writeFile(piPath, script, { mode: 0o755 });
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;
    resetActiveWorkflowRouteForTests();
    resetKhalaProfileDiscoveryForTests();
    await fn();
  } finally {
    resetActiveWorkflowRouteForTests();
    resetKhalaProfileDiscoveryForTests();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("default active workflow route is empty", () => {
  resetActiveWorkflowRouteForTests();
  const route = getActiveWorkflowRoute();
  assert.equal(route.profileFlag, "");
  assert.equal(route.taskFlag, "");
});

test("setActiveWorkflowRoute stores and retrieves flags", () => {
  resetActiveWorkflowRouteForTests();
  setActiveWorkflowRoute({ profileFlag: "development", taskFlag: "workon" });
  const route = getActiveWorkflowRoute();
  assert.equal(route.profileFlag, "development");
  assert.equal(route.taskFlag, "workon");
});

test("getMergedRoutes returns known builtin routes", () => {
  const routes = getMergedRoutes();
  assert.equal(routes.workon, "development");
  assert.equal(routes.plan, "planning");
  assert.equal(routes.triage, "triage");
  assert.equal(routes.debug, "planning");
  assert.equal(routes.review, "peer-review");
  assert.equal(routes["git-review"], "knowledge");
  assert.equal(routes.simplify, "development");
  assert.equal(routes.ship, "development");
  assert.equal(routes.inbox, "lightweight");
  assert.equal(routes.audit, "planning");
  assert.equal(routes["address-open-issues"], "planning");
  assert.equal(routes["learn-skill"], "knowledge");
  assert.equal(routes["peer-review"], "peer-review");
});

test("getMergedProfiles returns known builtin profiles", () => {
  const profiles = getMergedProfiles();
  assert.equal(profiles.planning, "NLR/HALO Nemotron 3 Super:off");
  assert.equal(profiles.development, "NLR/HALO Devstral 123B:off");
  assert.equal(profiles["peer-review"], "NLR/HALO GPT OSS 120b:off");
  assert.equal(profiles.triage, "NLR/HALO Llama 4 Scout:off");
  assert.equal(profiles.knowledge, "NLR/HALO Gemma 4:off");
  assert.equal(profiles.lightweight, "NLR/HALO Nemotron 3 Nano:off");
});

test("resolveWorkflowRoute uses peer-review profile for peer review by default", () => {
  resetActiveWorkflowRouteForTests();
  const resolved = resolveWorkflowRoute("peer-review");
  assert.equal(resolved.source, "builtin");
  assert.equal(resolved.profileName, "peer-review");
  assert.equal(resolved.profile.model, "NLR/HALO GPT OSS 120b");
  assert.equal(resolved.profile.thinkingLevel, "off");
});

test("resolveWorkflowRoute can ignore active implementation workflow flags for peer review defaults", () => {
  resetActiveWorkflowRouteForTests();
  setActiveWorkflowRoute({ profileFlag: "development", taskFlag: "workon" });
  const resolved = resolveWorkflowRoute("peer-review", { ignoreActiveWorkflowFlags: true });
  assert.equal(resolved.source, "builtin");
  assert.equal(resolved.profileName, "peer-review");
  assert.equal(resolved.profile.model, "NLR/HALO GPT OSS 120b");
  assert.equal(resolved.profile.thinkingLevel, "off");
});

test("resolveWorkflowRoute uses --khala-workflow-profile flag when set", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "development", taskFlag: "workon" });
      const resolved = resolveWorkflowRoute("workon");
      assert.equal(resolved.source, "flag");
      assert.equal(resolved.profileName, "development");
      assert.ok(resolved.profile.model);
      assert.match(resolved.description, /--khala-workflow-profile=development/);
    },
  );
});

test("resolveWorkflowRoute uses route table when no profile flag", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "", taskFlag: "" });
      const resolved = resolveWorkflowRoute("plan");
      assert.equal(resolved.source, "builtin");
      assert.equal(resolved.profileName, "planning");
      assert.equal(resolved.profile.model, "NLR/HALO Nemotron 3 Super");
      assert.equal(resolved.profile.thinkingLevel, "off");
    },
  );
});

test("resolveWorkflowRoute respects --khala-workflow-task flag for routing", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "", taskFlag: "workon" });
      const resolved = resolveWorkflowRoute("plan");
      // taskFlag "workon" overrides the "plan" argument when profileFlag is empty
      // But actually looking at the code: when taskFlag is set and profileFlag is empty,
      // it uses taskFlag for routing, not the passed task.
      // Let's verify this behavior.
      assert.equal(resolved.source, "route");
      assert.equal(resolved.profileName, "development");
      assert.match(resolved.description, /route workon -> development/);
    },
  );
});

test("resolveWorkflowRoute defaults to passed task when no flags set", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "", taskFlag: "" });
      const resolved = resolveWorkflowRoute("triage");
      assert.equal(resolved.source, "builtin");
      assert.equal(resolved.profileName, "triage");
      assert.equal(resolved.profile.model, "NLR/HALO Llama 4 Scout");
      assert.equal(resolved.profile.thinkingLevel, "off");
    },
  );
});

test("resolveWorkflowRoute handles profileFlag with resolved model", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "development", taskFlag: "" });
      const resolved = resolveWorkflowRoute("review");
      assert.equal(resolved.source, "flag");
      assert.equal(resolved.profileName, "development");
      assert.ok(resolved.profile.model);
      assert.equal(resolved.profile.status, "ok");
    },
  );
});

test("resolveWorkflowRoute uses builtin NLR development profile without legacy discovery", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "", taskFlag: "workon" });
      const resolved = resolveWorkflowRoute("workon");
      assert.equal(resolved.profileName, "development");
      assert.equal(resolved.profile.model, "NLR/HALO Devstral 123B");
      assert.equal(resolved.profile.thinkingLevel, "off");
      assert.equal(resolved.profile.status, "ok");
    },
  );
});

test("resolveWorkflowRoute uses exact workflow-model.yaml profile overrides", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-router-config-"));
  const configPath = path.join(tempDir, "workflow-model.yaml");
  try {
    await writeFile(
      configPath,
      [
        "profiles:",
        '  planning: "openai-codex/gpt-5.5:high"',
        '  development: "openai-codex/gpt-5.4-mini:low"',
        "routes:",
        '  workon: "development"',
        '  plan: "planning"',
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadWorkflowModelConfig(configPath);
    resetActiveWorkflowRouteForTests();
    setWorkflowModelConfig(loaded.config, {
      path: loaded.path,
      found: loaded.found,
      explicitProfiles: loaded.explicitProfiles,
      explicitRoutes: loaded.explicitRoutes,
    });

    const development = resolveWorkflowRoute("workon");
    assert.equal(development.profileName, "development");
    assert.equal(development.profile.model, "openai-codex/gpt-5.4-mini");
    assert.equal(development.profile.thinkingLevel, "low");
    assert.equal(development.profile.source, "workflow-model-config");

    const planning = resolveWorkflowRoute("plan");
    assert.equal(planning.profileName, "planning");
    assert.equal(planning.profile.model, "openai-codex/gpt-5.5");
    assert.equal(planning.profile.thinkingLevel, "high");
    assert.equal(planning.profile.source, "workflow-model-config");
  } finally {
    resetActiveWorkflowRouteForTests();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("formatWorkflowRouteStatus reports config state and avoids not-set wording", () => {
  resetActiveWorkflowRouteForTests();
  try {
    setWorkflowModelConfig(
      {
        routes: { workon: "development" },
        profiles: { development: "openai-codex/gpt-5.4-mini:low" },
      },
      {
        path: "/tmp/khala/workflow-model.yaml",
        found: true,
        explicitProfiles: ["development"],
        explicitRoutes: ["workon"],
        warnings: ["Ignoring invalid profile entry for 'development': \"bad/model\". Expected format: \"provider/model:thinking\"."],
      },
    );

    const status = formatWorkflowRouteStatus();
    assert.match(status, /workflow config: found at \/tmp\/khala\/workflow-model\.yaml/);
    assert.match(status, /workflow config warnings: Ignoring invalid profile entry for 'development': "bad\/model"\. Expected format: "provider\/model:thinking"\./);
    assert.match(status, /workflow profile flag: none \(CLI override not set; workflow config still applies\)/);
    assert.match(status, /workflow task flag: none \(CLI override not set; command routes still apply\)/);
    assert.match(status, /active profiles: .*development=openai-codex\/gpt-5\.4-mini:low/);
    assert.match(status, /active routes: .*workon->development/);
    assert.doesNotMatch(status, /workflow profile flag: \(not set\)/);
    assert.doesNotMatch(status, /workflow task flag: \(not set\)/);

    const configStatus = getWorkflowModelConfigStatus();
    assert.deepEqual(configStatus.explicitProfiles, ["development"]);
    assert.equal(configStatus.found, true);
    assert.deepEqual(configStatus.warnings, ["Ignoring invalid profile entry for 'development': \"bad/model\". Expected format: \"provider/model:thinking\"."]);
  } finally {
    resetActiveWorkflowRouteForTests();
  }
});

test("resolveWorkflowRoute uses config-overridden routes", async () => {
  await withFakePi(
    `#!/usr/bin/env bash
set -euo pipefail
printf 'provider model context max-out thinking images\n'
printf 'github-copilot gpt-5.4-mini 400K 128K yes yes\n'
`,
    () => {
      setActiveWorkflowRoute({ profileFlag: "", taskFlag: "" });
      setWorkflowModelConfig({
        routes: { workon: "planning" },
        profiles: {},
      });
      const resolved = resolveWorkflowRoute("workon");
      assert.equal(resolved.profileName, "planning");
      assert.equal(resolved.profile.model, "NLR/HALO Nemotron 3 Super");
      assert.equal(resolved.profile.thinkingLevel, "off");
    },
  );
});

test("getMergedRoutes reflects config overrides", () => {
  resetActiveWorkflowRouteForTests();
  setWorkflowModelConfig({
    routes: { workon: "planning" },
    profiles: {},
  });
  const merged = getMergedRoutes();
  assert.equal(merged.workon, "planning");
  // Builtin preserved
  assert.equal(merged.plan, "planning");
  assert.equal(merged.triage, "triage");
});

test("setWorkflowModelConfig preserves builtin defaults for non-overridden keys", () => {
  resetActiveWorkflowRouteForTests();
  setWorkflowModelConfig({
    routes: {},
    profiles: {},
  });
  const routes = getMergedRoutes();
  const profiles = getMergedProfiles();
  assert.equal(routes.workon, "development");
  assert.equal(routes.plan, "planning");
  assert.equal(profiles.planning, "NLR/HALO Nemotron 3 Super:off");
  assert.equal(profiles.development, "NLR/HALO Devstral 123B:off");
});

test("resetWorkflowModelConfigForTests restores builtin defaults", () => {
  resetActiveWorkflowRouteForTests();
  setWorkflowModelConfig({
    routes: { workon: "planning" },
    profiles: {},
  });
  assert.equal(getMergedRoutes().workon, "planning");
  resetActiveWorkflowRouteForTests();
  assert.equal(getMergedRoutes().workon, "development");
});
