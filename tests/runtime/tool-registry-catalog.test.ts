import { strict as assert } from "node:assert";
import test from "node:test";

import {
  getRegisteredToolMetadata,
  listToolRegistryEntries,
  TOOL_REGISTRY_TOOL_NAMES,
} from "../../extensions/runtime/tool-registry-catalog.ts";

test("tool registry catalog exposes canonical typed metadata entries", () => {
  const entries = listToolRegistryEntries();

  assert.equal(entries.length, TOOL_REGISTRY_TOOL_NAMES.length);
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

test("tool registry catalog preserves conservative side-effect policy", () => {
  assert.equal(getRegisteredToolMetadata("read").mutationClass, "none");
  assert.equal(getRegisteredToolMetadata("read").replaySafe, true);

  assert.equal(getRegisteredToolMetadata("write").mutationClass, "filesystem");
  assert.equal(getRegisteredToolMetadata("write").replaySafe, false);

  assert.equal(
    getRegisteredToolMetadata("github").mutationClass,
    "forge",
  );
  assert.equal(getRegisteredToolMetadata("github").replaySafe, false);

  assert.equal(
    getRegisteredToolMetadata("khala_search_memory").memoryRefreshRequirement,
    "exempt",
  );
});
