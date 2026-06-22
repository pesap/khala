import { strict as assert } from "node:assert";
import test from "node:test";

import {
  getRegisteredToolMetadata,
  listToolRegistryEntries,
  TOOL_REGISTRY_TOOL_NAMES,
} from "../../extensions/runtime/tool-registry-catalog.ts";
import {
  APPLY_PATCH_TOOL_NAMES,
  COMMAND_METADATA_TOOL_NAMES,
  FILESYSTEM_MUTATION_TOOL_NAMES,
  KHALA_MEMORY_TOOL_NAMES,
  MEMORY_SEARCH_TOOL_NAMES,
} from "../../extensions/runtime/tool-registry.ts";

test("tool registry catalog exposes canonical typed metadata entries", () => {
  const entries = listToolRegistryEntries();

  assert.equal(entries.length, TOOL_REGISTRY_TOOL_NAMES.length);
  assert.equal(new Set(TOOL_REGISTRY_TOOL_NAMES).size, TOOL_REGISTRY_TOOL_NAMES.length);
  assert.deepEqual(
    entries.map((entry) => entry.toolName),
    TOOL_REGISTRY_TOOL_NAMES,
  );

  for (const entry of entries) {
    assert.equal(typeof entry.metadata.evidenceClass, "string");
    assert.equal(typeof entry.metadata.mutationClass, "string");
    assert.equal(typeof entry.metadata.replaySafe, "boolean");
    assert.equal(typeof entry.metadata.memoryRefreshRequirement, "string");
    assert.equal(typeof entry.metadata.gateSatisfaction, "object");
    assert.equal(typeof entry.metadata.gateSatisfaction.countsTaskToolCall, "boolean");
    assert.equal(typeof entry.metadata.sideEffectClass, "string");
    assert.equal(typeof entry.metadata.gateSatisfaction.agesMemory, "boolean");
    assert.equal(typeof entry.metadata.gateSatisfaction.satisfiesMemoryRead, "boolean");
    assert.equal(typeof entry.metadata.gateSatisfaction.persistsMemory, "boolean");
  }
});

test("tool registry catalog composes exported canonical tool groups", () => {
  for (const toolName of [
    ...APPLY_PATCH_TOOL_NAMES,
    ...COMMAND_METADATA_TOOL_NAMES,
    ...FILESYSTEM_MUTATION_TOOL_NAMES,
    ...KHALA_MEMORY_TOOL_NAMES,
    ...MEMORY_SEARCH_TOOL_NAMES,
  ]) {
    assert.ok(TOOL_REGISTRY_TOOL_NAMES.includes(toolName), toolName);
  }
});

test("tool registry catalog preserves conservative side-effect policy", () => {
  assert.equal(getRegisteredToolMetadata("read").mutationClass, "none");
  assert.equal(getRegisteredToolMetadata("read").replaySafe, true);
  for (const toolName of [
    "ast_search",
    "fff",
    "find",
    "grep",
    "ls",
    "read",
  ] as const) {
    const metadata = getRegisteredToolMetadata(toolName);
    assert.equal(metadata.evidenceClass, "local", toolName);
    assert.equal(metadata.sideEffectClass, "read_only", toolName);
    assert.equal(metadata.mutationClass, "none", toolName);
    assert.equal(metadata.replaySafe, true, toolName);
    assert.equal(metadata.memoryRefreshRequirement, "not_required", toolName);
  }

  for (const toolName of [
    "loadSkill",
    "readSkill",
    "skill_load",
    "skill_read",
  ] as const) {
    const metadata = getRegisteredToolMetadata(toolName);
    assert.equal(metadata.evidenceClass, "local", toolName);
    assert.equal(metadata.sideEffectClass, "read_only", toolName);
    assert.equal(metadata.replaySafe, true, toolName);
  }

  for (const toolName of [
    "edit",
    "functions.edit",
    "functions.write",
    "write",
  ] as const) {
    assert.equal(getRegisteredToolMetadata(toolName).mutationClass, "filesystem", toolName);
    assert.equal(getRegisteredToolMetadata(toolName).replaySafe, false, toolName);
  }
  assert.equal(getRegisteredToolMetadata("apply_patch").mutationClass, "filesystem");
  assert.equal(getRegisteredToolMetadata("functions.apply_patch").mutationClass, "filesystem");
  assert.equal(getRegisteredToolMetadata("functions.apply_patch").replaySafe, false);

  assert.equal(
    getRegisteredToolMetadata("github").mutationClass,
    "forge",
  );
  assert.equal(getRegisteredToolMetadata("github").replaySafe, false);
  assert.equal(
    getRegisteredToolMetadata("github.create_pull_request").mutationClass,
    "forge",
  );
  assert.equal(getRegisteredToolMetadata("github.create_pull_request").replaySafe, false);

  assert.equal(
    getRegisteredToolMetadata("khala_read_memory").gateSatisfaction.satisfiesMemoryRead,
    true,
  );
  assert.equal(
    getRegisteredToolMetadata("khala_search_memory").memoryRefreshRequirement,
    "exempt",
  );
  assert.equal(
    getRegisteredToolMetadata("khala_learn").gateSatisfaction.persistsMemory,
    true,
  );
  assert.equal(getRegisteredToolMetadata("web.search_query").sideEffectClass, "external");
  assert.equal(getRegisteredToolMetadata("web.search_query").replaySafe, false);
  for (const toolName of [
    "browser_open",
    "browser_search",
    "fetch",
    "search",
    "web.run",
    "web.search_query",
    "web_search",
  ] as const) {
    const metadata = getRegisteredToolMetadata(toolName);
    assert.equal(metadata.evidenceClass, "external", toolName);
    assert.equal(metadata.sideEffectClass, "external", toolName);
    assert.equal(metadata.mutationClass, "none", toolName);
    assert.equal(metadata.replaySafe, false, toolName);
    assert.equal(metadata.memoryRefreshRequirement, "not_required", toolName);
  }
});
