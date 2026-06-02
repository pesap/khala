import test from "node:test";
import assert from "node:assert/strict";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isMutationCapableBash } from "../../extensions/policy/first-principles.ts";
import {
  getToolInterceptionCounters,
  isSkillMemoryReadToolCall,
  requiresFreshMemoryToolCall,
} from "../../extensions/runtime/tool-interception.ts";

function event(toolName: string, input: unknown = {}): ToolCallEvent {
  return {
    toolName,
    input,
  } as ToolCallEvent;
}

test("interception counters avoid aging memory for khala memory tools and skill reads", () => {
  assert.deepEqual(getToolInterceptionCounters(event("khala_read_memory")), {
    incrementTaskToolCall: false,
    incrementMemoryToolCallsSinceRead: false,
    isMemoryRead: true,
  });

  assert.deepEqual(getToolInterceptionCounters(event("khala_search_memory")), {
    incrementTaskToolCall: true,
    incrementMemoryToolCallsSinceRead: false,
    isMemoryRead: false,
  });

  assert.deepEqual(getToolInterceptionCounters(event("khala_learn")), {
    incrementTaskToolCall: true,
    incrementMemoryToolCallsSinceRead: false,
    isMemoryRead: false,
  });

  assert.deepEqual(
    getToolInterceptionCounters(event("read", { path: ".pi/khala/skills/debug/SKILL.md" })),
    {
      incrementTaskToolCall: true,
      incrementMemoryToolCallsSinceRead: false,
      isMemoryRead: false,
    },
  );

  assert.deepEqual(getToolInterceptionCounters(event("read", { path: "src/app.ts" })), {
    incrementTaskToolCall: true,
    incrementMemoryToolCallsSinceRead: true,
    isMemoryRead: false,
  });
});

test("skill-memory detection handles noisy inputs without throwing", () => {
  const inputs = [
    undefined,
    null,
    {},
    { path: null },
    { path: 42 },
    { path: "skills/review/SKILL.md" },
    { path: "C:\\repo\\.pi\\khala\\skills\\review\\SKILL.md" },
  ];

  const matches = inputs.map((input) =>
    isSkillMemoryReadToolCall({ toolName: "read", input }),
  );

  assert.deepEqual(matches, [false, false, false, false, false, true, true]);
});

test("bash mutation detection does not treat read-only git merge-base as merge", () => {
  assert.equal(isMutationCapableBash("git merge-base HEAD origin/main"), false);
  assert.equal(
    isMutationCapableBash(
      "git diff --name-only $(git merge-base HEAD origin/main)",
    ),
    false,
  );
  assert.equal(isMutationCapableBash("git merge feature-branch"), true);
  assert.equal(isMutationCapableBash("git merge;git status"), true);
  assert.equal(isMutationCapableBash("git commit&& echo ok"), true);
  assert.equal(isMutationCapableBash("git checkout feature-branch"), true);
});

test("fresh-memory decision exempts khala memory tools", () => {
  assert.equal(requiresFreshMemoryToolCall(event("khala_read_memory")), false);
  assert.equal(requiresFreshMemoryToolCall(event("khala_search_memory")), false);
  assert.equal(requiresFreshMemoryToolCall(event("khala_learn")), false);
  assert.equal(requiresFreshMemoryToolCall(event("edit", { path: "README.md" })), true);
});

test("fresh-memory decision is bounded under many intercepted tool calls", () => {
  const events = Array.from({ length: 100_000 }, (_, index) => {
    if (index % 20 === 0) return event("khala_read_memory");
    if (index % 7 === 0) return event("read", { path: "skills/review/SKILL.md" });
    if (index % 13 === 0) return event("bash", { command: "git add package.json" });
    return event("read", { path: `src/file-${index}.ts` });
  });

  const started = performance.now();
  let taskCount = 0;
  let memoryAgeCount = 0;
  let freshRequired = 0;

  for (const intercepted of events) {
    const counters = getToolInterceptionCounters(intercepted);
    if (counters.incrementTaskToolCall) taskCount += 1;
    if (counters.incrementMemoryToolCallsSinceRead) memoryAgeCount += 1;
    if (requiresFreshMemoryToolCall(intercepted)) freshRequired += 1;
  }

  const elapsedMs = performance.now() - started;
  assert.equal(taskCount, 95_000);
  assert.ok(memoryAgeCount < taskCount);
  assert.ok(freshRequired > 0);
  assert.ok(
    elapsedMs < 1_500,
    `interception helpers took ${elapsedMs.toFixed(1)}ms for ${events.length} events`,
  );
});
