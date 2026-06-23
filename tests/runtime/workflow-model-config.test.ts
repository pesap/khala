import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUILTIN_WORKFLOW_PROFILES,
  BUILTIN_WORKFLOW_ROUTES,
  formatProfileEntry,
  getWorkflowModelConfigPath,
  loadWorkflowModelConfig,
  parseProfileEntry,
  writeWorkflowModelConfig,
} from "../../extensions/runtime/workflow-model-config.ts";

test("parseProfileEntry parses valid model:thinking strings", () => {
  const result = parseProfileEntry("github-copilot/gpt-5.5:xhigh");
  assert.deepEqual(result, {
    modelId: "github-copilot/gpt-5.5",
    thinkingLevel: "xhigh",
  });

  const result2 = parseProfileEntry("github-copilot/gpt-5.4-mini:medium");
  assert.deepEqual(result2, {
    modelId: "github-copilot/gpt-5.4-mini",
    thinkingLevel: "medium",
  });
});

test("parseProfileEntry defaults to medium thinking when suffix is missing or invalid", () => {
  const result = parseProfileEntry("github-copilot/gpt-5.5");
  assert.deepEqual(result, {
    modelId: "github-copilot/gpt-5.5",
    thinkingLevel: "medium",
  });

  const result2 = parseProfileEntry("github-copilot/gpt-5.4-mini:invalid");
  assert.deepEqual(result2, {
    modelId: "github-copilot/gpt-5.4-mini",
    thinkingLevel: "medium",
  });
});

test("parseProfileEntry returns null for invalid inputs", () => {
  assert.equal(parseProfileEntry(""), null);
  assert.equal(parseProfileEntry("   "), null);
  assert.equal(parseProfileEntry("no-slash"), null);
  assert.equal(parseProfileEntry("provider/:thinking"), null);
});

test("formatProfileEntry builds correct strings", () => {
  assert.equal(
    formatProfileEntry("github-copilot/gpt-5.5", "xhigh"),
    "github-copilot/gpt-5.5:xhigh",
  );
  assert.equal(
    formatProfileEntry("github-copilot/gpt-5.4-mini", "medium"),
    "github-copilot/gpt-5.4-mini:medium",
  );
});

test("loadWorkflowModelConfig returns builtin defaults when no config path", async () => {
  const result = await loadWorkflowModelConfig();
  assert.deepEqual(result.config.profiles, BUILTIN_WORKFLOW_PROFILES);
  assert.deepEqual(result.config.routes, BUILTIN_WORKFLOW_ROUTES);
  assert.ok(result.warnings.length > 0);
  assert.match(result.warnings[0]!, /no workflow model config path/i);
});

test("loadWorkflowModelConfig returns builtin defaults when config file does not exist", async () => {
  const result = await loadWorkflowModelConfig("/nonexistent/path.yaml");
  assert.deepEqual(result.config.profiles, BUILTIN_WORKFLOW_PROFILES);
  assert.ok(result.warnings.length > 0);
  assert.match(result.warnings[0]!, /not found/i);
});

test("loadWorkflowModelConfig merges config over builtins", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-config-"));
  const configPath = path.join(tempDir, "workflow-model.yaml");
  try {
    await writeFile(
      configPath,
      [
        "profiles:",
        '  planning: "anthropic/claude-sonnet-4:high"',
        "routes:",
        '  workon: "planning"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await loadWorkflowModelConfig(configPath);
    // Config overrides specific keys
    assert.equal(
      result.config.profiles.planning,
      "anthropic/claude-sonnet-4:high",
    );
    // Builtin remains for non-overridden keys
    assert.equal(result.config.profiles.development, BUILTIN_WORKFLOW_PROFILES.development);
    // Config overrides route
    assert.equal(result.config.routes.workon, "planning");
    // Builtin route remains for non-overridden keys
    assert.equal(result.config.routes.plan, BUILTIN_WORKFLOW_ROUTES.plan);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadWorkflowModelConfig validates profile entries and rejects invalid ones", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-config-"));
  const configPath = path.join(tempDir, "workflow-model.yaml");
  try {
    await writeFile(
      configPath,
      [
        "profiles:",
        '  planning: "valid/model:high"',
        '  invalid_profile: "no-slash"',
        '  broken: ""',
        "routes:",
        '  workon: "development"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await loadWorkflowModelConfig(configPath);
    // Valid profile is accepted
    assert.equal(result.config.profiles.planning, "valid/model:high");
    // Invalid profiles fall back to builtin
    assert.equal(result.config.profiles.development, BUILTIN_WORKFLOW_PROFILES.development);
    // There should be warnings about invalid entries
    assert.ok(result.warnings.some((w) => w.includes("invalid_profile")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadWorkflowModelConfig validates route references", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-config-"));
  const configPath = path.join(tempDir, "workflow-model.yaml");
  try {
    await writeFile(
      configPath,
      [
        "profiles:",
        '  planning: "valid/model:high"',
        "routes:",
        '  workon: "nonexistent_profile"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await loadWorkflowModelConfig(configPath);
    // Unknown profile route falls back to builtin
    assert.equal(result.config.routes.workon, BUILTIN_WORKFLOW_ROUTES.workon);
    assert.ok(result.warnings.some((w) => w.includes("nonexistent_profile")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeWorkflowModelConfig writes and can be read back", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "workflow-model-config-"));
  const configPath = path.join(tempDir, "workflow-model.yaml");
  try {
    const config = {
      profiles: {
        planning: "github-copilot/gpt-5.5:xhigh",
        custom: "anthropic/claude-sonnet-4:high",
      },
      routes: {
        workon: "custom",
        plan: "planning",
      },
    };

    await writeWorkflowModelConfig(config, configPath);

    // Read it back
    const result = await loadWorkflowModelConfig(configPath);
    assert.equal(result.config.profiles.custom, "anthropic/claude-sonnet-4:high");
    assert.equal(result.config.routes.workon, "custom");
    // Builtins merged for non-overridden keys
    assert.equal(result.config.profiles.development, BUILTIN_WORKFLOW_PROFILES.development);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getWorkflowModelConfigPath joins correctly", () => {
  const result = getWorkflowModelConfigPath("/tmp/khala-store");
  assert.equal(result, "/tmp/khala-store/workflow-model.yaml");
});
