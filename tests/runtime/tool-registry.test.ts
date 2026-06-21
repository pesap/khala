import assert from "node:assert/strict";
import test from "node:test";

import {
  getToolMetadata,
  isMemoryRefreshToolName,
  isMutationToolCall,
  isSkillMemoryReadToolCall,
  requiresFreshMemoryToolCall,
} from "../../extensions/runtime/tool-registry.ts";

test("tool registry classifies khala memory tools with gate metadata", () => {
  assert.deepEqual(getToolMetadata({ toolName: "khala_read_memory" }), {
    name: "khala_read_memory",
    evidenceClass: "memory",
    mutationClass: "none",
    sideEffectClass: "read_only",
    replaySafe: true,
    memoryRefreshRequirement: "exempt",
    gateSatisfaction: {
      countsTaskToolCall: false,
      agesMemory: false,
      satisfiesMemoryRead: true,
      persistsMemory: false,
    },
  });

  const learn = getToolMetadata({ toolName: "khala_learn" });
  assert.equal(learn.evidenceClass, "memory");
  assert.equal(learn.mutationClass, "memory");
  assert.equal(learn.sideEffectClass, "tool_side_effect");
  assert.equal(learn.replaySafe, false);
  assert.equal(learn.memoryRefreshRequirement, "exempt");
  assert.equal(learn.gateSatisfaction.persistsMemory, true);
});

test("tool registry classifies apply_patch as local filesystem mutation", () => {
  for (const toolName of ["apply_patch", "functions.apply_patch"] as const) {
    assert.deepEqual(getToolMetadata({ toolName }), {
      name: toolName,
      evidenceClass: "local",
      mutationClass: "filesystem",
      sideEffectClass: "mutation",
      replaySafe: false,
      memoryRefreshRequirement: "required_before_mutation",
      gateSatisfaction: {
        countsTaskToolCall: true,
        agesMemory: true,
        satisfiesMemoryRead: false,
        persistsMemory: false,
      },
    });
  }
});

test("tool registry distinguishes memory refresh from memory search and persistence", () => {
  assert.equal(isMemoryRefreshToolName("khala_read_memory"), true);
  assert.equal(isMemoryRefreshToolName("khala_search_memory"), false);
  assert.equal(isMemoryRefreshToolName("khala_learn"), false);
});

test("tool registry centralizes skill file memory-read detection", () => {
  assert.equal(
    isSkillMemoryReadToolCall({ name: "read", args: { path: "skills/review/SKILL.md" } }),
    true,
  );
  assert.equal(
    isSkillMemoryReadToolCall({
      toolName: "read",
      input: { path: "/home/user/.agents/skills/grill-me/SKILL.md" },
    }),
    true,
  );
  assert.equal(
    isSkillMemoryReadToolCall({ toolName: "read", input: { path: "package.json" } }),
    false,
  );
});

test("tool registry preserves mutation and memory-refresh policy decisions", () => {
  const edit = { toolName: "edit", input: { path: "README.md" } };
  const readOnlyBash = {
    toolName: "bash",
    input: { command: "git merge-base HEAD origin/main" },
  };
  const mutatingBash = {
    toolName: "bash",
    input: { command: "git add package.json" },
  };

  assert.equal(isMutationToolCall(edit as never), true);
  assert.equal(requiresFreshMemoryToolCall(edit as never), true);
  assert.equal(getToolMetadata(edit).mutationClass, "filesystem");
  assert.equal(getToolMetadata(edit).replaySafe, false);

  assert.equal(isMutationToolCall(readOnlyBash as never), false);
  assert.equal(requiresFreshMemoryToolCall(readOnlyBash as never), false);
  assert.equal(getToolMetadata(readOnlyBash).sideEffectClass, "read_only");
  assert.equal(getToolMetadata(readOnlyBash).replaySafe, true);

  assert.equal(isMutationToolCall(mutatingBash as never), true);
  assert.equal(requiresFreshMemoryToolCall(mutatingBash as never), true);
  assert.equal(getToolMetadata(mutatingBash).mutationClass, "shell");
  assert.equal(getToolMetadata(mutatingBash).sideEffectClass, "shell");
  assert.equal(getToolMetadata(mutatingBash).replaySafe, false);
  for (const command of [
    "npm install",
    "npm ci",
    "pnpm add vite",
    "pip install pytest",
    "echo updated > file.txt",
    "echo updated >> file.txt",
    'node -e "require(\\"fs\\").writeFileSync(\\"file.txt\\", \\"updated\\")"',
    'python -c "open(\\"file.txt\\", \\"w\\").write(\\"updated\\")"',
    'python -c "Path(\\"file.txt\\").write_text(\\"updated\\")"',
    'ruby -e "File.write(\\"file.txt\\", \\"updated\\")"',
  ]) {
    const metadata = getToolMetadata({ toolName: "bash", input: { command } });
    assert.equal(metadata.mutationClass, "shell", command);
    assert.equal(metadata.sideEffectClass, "shell", command);
    assert.equal(metadata.replaySafe, false, command);
    assert.equal(metadata.memoryRefreshRequirement, "required_before_mutation", command);
  }
  for (const command of [
    'node -e "console.log(1)"',
    'python -c "print(1)"',
    'ruby -e "puts 1"',
  ]) {
    const metadata = getToolMetadata({ toolName: "bash", input: { command } });
    assert.equal(metadata.mutationClass, "none", command);
    assert.equal(metadata.sideEffectClass, "read_only", command);
    assert.equal(metadata.replaySafe, true, command);
    assert.equal(metadata.memoryRefreshRequirement, "not_required", command);
  }
});

test("tool registry classifies exec command input like shell commands", () => {
  for (const toolName of ["exec_command", "functions.exec_command"] as const) {
    const readOnly = getToolMetadata({ toolName, input: { cmd: "ls" } });
    assert.equal(readOnly.evidenceClass, "local", toolName);
    assert.equal(readOnly.mutationClass, "none", toolName);
    assert.equal(readOnly.sideEffectClass, "read_only", toolName);
    assert.equal(readOnly.replaySafe, true, toolName);
    assert.equal(readOnly.memoryRefreshRequirement, "not_required", toolName);

    const mutating = getToolMetadata({ toolName, input: { cmd: "npm install" } });
    assert.equal(mutating.mutationClass, "shell", toolName);
    assert.equal(mutating.sideEffectClass, "shell", toolName);
    assert.equal(mutating.replaySafe, false, toolName);
    assert.equal(mutating.memoryRefreshRequirement, "required_before_mutation", toolName);

    const commandField = getToolMetadata({ toolName, input: { command: "echo hi > file.txt" } });
    assert.equal(commandField.mutationClass, "shell", toolName);
    assert.equal(commandField.sideEffectClass, "shell", toolName);
  }
});

test("tool registry classifies common forge and external tools conservatively", () => {
  const github = getToolMetadata({ toolName: "github.create_pull_request" });
  assert.equal(github.evidenceClass, "forge");
  assert.equal(github.mutationClass, "forge");
  assert.equal(github.sideEffectClass, "forge");
  assert.equal(github.replaySafe, false);
  assert.equal(github.memoryRefreshRequirement, "required_before_mutation");

  const web = getToolMetadata({ toolName: "web.search_query" });
  assert.equal(web.evidenceClass, "external");
  assert.equal(web.sideEffectClass, "external");
  assert.equal(web.replaySafe, false);
  assert.equal(web.memoryRefreshRequirement, "not_required");

  const customWrite = getToolMetadata({ toolName: "custom.apply_patch" });
  assert.equal(customWrite.sideEffectClass, "mutation");
  assert.equal(customWrite.memoryRefreshRequirement, "required_before_mutation");
});
