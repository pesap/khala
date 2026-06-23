import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getActiveWorkflowRoute,
  getMergedProfiles,
  getMergedRoutes,
  resetActiveWorkflowRouteForTests,
  resolveWorkflowRoute,
  setActiveWorkflowRoute,
  setWorkflowModelConfig,
} from "../../extensions/runtime/workflow-model-router.ts";
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
  assert.equal(routes.triage, "planning");
  assert.equal(routes.debug, "planning");
  assert.equal(routes.review, "development");
});

test("getMergedProfiles returns known builtin profiles", () => {
  const profiles = getMergedProfiles();
  assert.ok(profiles.planning.includes("gpt-5.5"));
  assert.ok(profiles.development.includes("gpt-5.4-mini"));
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
      assert.equal(resolved.profile.model, "github-copilot/gpt-5.5");
      assert.equal(resolved.profile.thinkingLevel, "xhigh");
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
      assert.equal(resolved.profileName, "planning");
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

test("resolveWorkflowRoute reports unresolved profile when model not discovered", async () => {
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
      assert.equal(resolved.profile.model, null);
      assert.equal(resolved.profile.status, "unresolved");
    },
  );
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
      assert.equal(resolved.profile.model, "github-copilot/gpt-5.5");
      assert.equal(resolved.profile.thinkingLevel, "xhigh");
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
  assert.equal(merged.triage, "planning");
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
  assert.ok(profiles.planning.includes("gpt-5.5"));
  assert.ok(profiles.development.includes("gpt-5.4-mini"));
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
