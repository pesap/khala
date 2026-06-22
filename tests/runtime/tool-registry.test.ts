import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_PATCH_TOOL_NAMES,
  COMMAND_EXECUTION_TOOL_NAMES,
  COMMAND_METADATA_TOOL_NAMES,
  EXTERNAL_OPEN_TOOL_NAMES,
  EXTERNAL_SEARCH_TOOL_NAMES,
  FILESYSTEM_MUTATION_TOOL_NAMES,
  getToolMetadata,
  isDuplicateEvidenceCandidateToolCall,
  isCommandExecutionToolName,
  isEvidenceToolCall,
  isExternalEvidenceToolCall,
  isExternalOpenToolName,
  isExternalSearchToolName,
  isKnownMemoryGateRetryToolName,
  isLocalFileReadToolName,
  KHALA_MEMORY_TOOL_NAMES,
  LOCAL_FILE_READ_TOOL_NAMES,
  MEMORY_GATE_RETRY_TOOL_NAMES,
  MEMORY_PERSISTENCE_TOOL_NAMES,
  MEMORY_REFRESH_TOOL_NAMES,
  MEMORY_SEARCH_TOOL_NAMES,
  TOOL_CONTEXT_INPUT_KEYS,
  isMemoryGateRetryToolCall,
  isLocalEvidenceToolCall,
  isMemoryPersistenceToolName,
  isMemoryRefreshToolName,
  isMemorySearchToolName,
  isMutationToolCall,
  isSkillLoaderToolName,
  isSkillMemoryReadToolCall,
  isUnsafeForConservativeReplay,
  resetsDuplicateEvidenceWindowToolCall,
  toolCallContextParts,
  toolNameLooksLikeExternalEvidence,
  requiresFreshMemoryToolCall,
} from "../../extensions/runtime/tool-registry.ts";

test("tool registry exports canonical exact tool-name groups", () => {
  assert.deepEqual(KHALA_MEMORY_TOOL_NAMES, [
    "khala_read_memory",
    "khala_search_memory",
    "khala_learn",
  ]);
  assert.deepEqual(LOCAL_FILE_READ_TOOL_NAMES, ["read", "read_file"]);
  assert.deepEqual(MEMORY_REFRESH_TOOL_NAMES, ["khala_read_memory"]);
  assert.deepEqual(MEMORY_SEARCH_TOOL_NAMES, ["khala_search_memory"]);
  assert.deepEqual(MEMORY_PERSISTENCE_TOOL_NAMES, ["khala_learn"]);
  assert.deepEqual(EXTERNAL_SEARCH_TOOL_NAMES, [
    "search",
    "web.run",
    "web.search_query",
    "web_search",
    "browser_search",
  ]);
  assert.deepEqual(EXTERNAL_OPEN_TOOL_NAMES, [
    "browser_open",
    "fetch",
    "web.run",
  ]);
  assert.deepEqual(APPLY_PATCH_TOOL_NAMES, ["apply_patch", "functions.apply_patch"]);
  assert.deepEqual(FILESYSTEM_MUTATION_TOOL_NAMES, [
    "edit",
    "functions.edit",
    "functions.write",
    "write",
  ]);
  assert.deepEqual(COMMAND_EXECUTION_TOOL_NAMES, [
    "bash",
    "exec",
    "exec_command",
    "functions.exec_command",
    "shell",
    "run",
  ]);
  assert.deepEqual(COMMAND_METADATA_TOOL_NAMES, [
    "bash",
    "exec",
    "exec_command",
    "functions.exec_command",
    "shell",
    "run",
  ]);
  assert.deepEqual(MEMORY_GATE_RETRY_TOOL_NAMES, [
    "edit",
    "functions.edit",
    "functions.write",
    "write",
    "apply_patch",
    "functions.apply_patch",
    "bash",
    "exec",
    "exec_command",
    "functions.exec_command",
    "shell",
    "run",
  ]);
  assert.deepEqual(TOOL_CONTEXT_INPUT_KEYS, [
    "path",
    "file",
    "cwd",
    "command",
    "cmd",
    "pattern",
    "query",
  ]);
});

test("tool registry builds searchable context parts for memory refresh prompts", () => {
  assert.deepEqual(
    toolCallContextParts({
      toolName: "functions.exec_command",
      input: {
        cwd: "/repo",
        cmd: "npm run typecheck",
        query: "ignored? no, still searchable",
        count: 3,
      },
    }),
    [
      "functions.exec_command",
      "cwd:/repo",
      "cmd:npm run typecheck",
      "query:ignored? no, still searchable",
    ],
  );
});

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

test("tool registry classifies filesystem mutation aliases explicitly", () => {
  for (const toolName of FILESYSTEM_MUTATION_TOOL_NAMES) {
    const metadata = getToolMetadata({ toolName, input: { path: "README.md" } });
    assert.equal(metadata.evidenceClass, "none", toolName);
    assert.equal(metadata.mutationClass, "filesystem", toolName);
    assert.equal(metadata.sideEffectClass, "mutation", toolName);
    assert.equal(metadata.replaySafe, false, toolName);
    assert.equal(metadata.memoryRefreshRequirement, "required_before_mutation", toolName);
    assert.equal(isMutationToolCall({ toolName, input: { path: "README.md" } }), true, toolName);
    assert.equal(
      requiresFreshMemoryToolCall({ toolName, input: { path: "README.md" } }),
      true,
      toolName,
    );
  }
});

test("tool registry distinguishes memory refresh from memory search and persistence", () => {
  assert.equal(isMemoryRefreshToolName("khala_read_memory"), true);
  assert.equal(isMemoryRefreshToolName("khala_search_memory"), false);
  assert.equal(isMemoryRefreshToolName("khala_learn"), false);
  assert.equal(isMemorySearchToolName("khala_search_memory"), true);
  assert.equal(isMemorySearchToolName("khala_read_memory"), false);
  assert.equal(isMemorySearchToolName("khala_learn"), false);
  assert.equal(isMemoryPersistenceToolName("khala_learn"), true);
  assert.equal(isMemoryPersistenceToolName("khala_read_memory"), false);
  assert.equal(isMemoryPersistenceToolName("khala_search_memory"), false);
});

test("tool registry centralizes external search and open tool names", () => {
  for (const toolName of EXTERNAL_SEARCH_TOOL_NAMES) {
    assert.equal(isExternalSearchToolName(toolName), true, toolName);
  }
  assert.equal(isExternalSearchToolName("browser_open"), false);
  assert.equal(isExternalSearchToolName("fetch"), false);

  for (const toolName of EXTERNAL_OPEN_TOOL_NAMES) {
    assert.equal(isExternalOpenToolName(toolName), true, toolName);
  }
  assert.equal(isExternalOpenToolName("search"), false);
  assert.equal(isExternalOpenToolName("browser_search"), false);
});

test("tool registry centralizes memory-gate retry tools", () => {
  for (const toolName of [
    "edit",
    "write",
    "apply_patch",
    "functions.apply_patch",
    "bash",
    "functions.exec_command",
  ]) {
    assert.equal(isKnownMemoryGateRetryToolName(toolName), true, toolName);
  }

  assert.equal(isKnownMemoryGateRetryToolName("khala_learn"), false);
  assert.equal(isMemoryGateRetryToolCall({ toolName: "apply_patch" }), true);
  assert.equal(
    isMemoryGateRetryToolCall({
      toolName: "custom.apply_patch",
      input: { path: "README.md" },
    }),
    true,
  );
  assert.equal(isMemoryGateRetryToolCall({ toolName: "khala_learn" }), false);
});

test("tool registry centralizes skill file memory-read detection", () => {
  assert.equal(isLocalFileReadToolName("read"), true);
  assert.equal(isLocalFileReadToolName("read_file"), true);
  assert.equal(isLocalFileReadToolName("grep"), false);
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
  assert.equal(
    isSkillMemoryReadToolCall({
      toolName: "read_file",
      input: { path: ".codex/skills/code-review/SKILL.md" },
    }),
    true,
  );
  assert.equal(
    isSkillMemoryReadToolCall({
      toolName: "read_file",
      input: { path: "src/code-review.ts" },
    }),
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
    "npm pkg set scripts.test=node --test",
    "cargo add serde",
    "go get example.com/mod",
    "rsync -a src/ dest/",
    "tar xf archive.tar -C dest",
    "unzip archive.zip -d dest",
    "echo updated > file.txt",
    "echo updated >> file.txt",
    'node -e "require(\\"fs\\").writeFileSync(\\"file.txt\\", \\"updated\\")"',
    'python -c "open(\\"file.txt\\", \\"w\\").write(\\"updated\\")"',
    'python -c "Path(\\"file.txt\\").write_text(\\"updated\\")"',
    'python3 -c "from pathlib import Path; Path(\\"file.txt\\").write_text(\\"updated\\")"',
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

test("tool registry classifies command execution input like shell commands", () => {
  for (const toolName of COMMAND_EXECUTION_TOOL_NAMES) {
    const readOnly = getToolMetadata({ toolName, input: { command: "ls" } });
    assert.equal(readOnly.evidenceClass, "local", toolName);
    assert.equal(readOnly.mutationClass, "none", toolName);
    assert.equal(readOnly.sideEffectClass, "read_only", toolName);
    assert.equal(readOnly.replaySafe, true, toolName);
    assert.equal(readOnly.memoryRefreshRequirement, "not_required", toolName);

    const mutating = getToolMetadata({ toolName, input: { command: "npm install" } });
    assert.equal(mutating.mutationClass, "shell", toolName);
    assert.equal(mutating.sideEffectClass, "shell", toolName);
    assert.equal(mutating.replaySafe, false, toolName);
    assert.equal(mutating.memoryRefreshRequirement, "required_before_mutation", toolName);

    const commandField = getToolMetadata({ toolName, input: { command: "echo hi > file.txt" } });
    assert.equal(commandField.mutationClass, "shell", toolName);
    assert.equal(commandField.sideEffectClass, "shell", toolName);

    const missingCommand = getToolMetadata({ toolName });
    assert.equal(missingCommand.evidenceClass, "none", toolName);
    assert.equal(missingCommand.mutationClass, "shell", toolName);
    assert.equal(missingCommand.sideEffectClass, "shell", toolName);
    assert.equal(missingCommand.replaySafe, false, toolName);
    assert.equal(missingCommand.memoryRefreshRequirement, "required_before_mutation", toolName);
  }

  const cmdAlias = getToolMetadata({ toolName: "functions.exec_command", input: { cmd: "ls" } });
  assert.equal(cmdAlias.sideEffectClass, "read_only");
});

test("tool registry centralizes command execution tool names", () => {
  for (const toolName of COMMAND_EXECUTION_TOOL_NAMES) {
    assert.equal(isCommandExecutionToolName(toolName), true, toolName);
  }
  assert.equal(isCommandExecutionToolName("read"), false);
  assert.equal(isCommandExecutionToolName("web.search_query"), false);
  assert.equal(
    getToolMetadata({ toolName: "shell", input: { command: "npm install" } }).sideEffectClass,
    "shell",
  );
  assert.equal(
    getToolMetadata({ toolName: "run", input: { command: "npm install" } }).sideEffectClass,
    "shell",
  );
});

test("tool registry centralizes skill loader tool names", () => {
  for (const toolName of [
    "readSkill",
    "loadSkill",
    "skill_read",
    "skill_load",
    "runtime.readSkill",
    "functions.loadSkill",
    "khala:skill_read",
  ]) {
    assert.equal(isSkillLoaderToolName(toolName), true, toolName);
  }

  assert.equal(isSkillLoaderToolName("read"), false);
  assert.equal(isSkillLoaderToolName("read_skill_file"), false);
  assert.equal(isSkillLoaderToolName("load"), false);
});

test("tool registry centralizes evidence tool predicates", () => {
  assert.equal(isLocalEvidenceToolCall({ toolName: "read" }), true);
  assert.equal(
    isLocalEvidenceToolCall({
      toolName: "functions.exec_command",
      input: { cmd: "git status --short" },
    }),
    true,
  );
  assert.equal(
    isLocalEvidenceToolCall({
      toolName: "functions.exec_command",
      input: { cmd: "npm install" },
    }),
    false,
  );

  assert.equal(isExternalEvidenceToolCall({ toolName: "web.run" }), true);
  assert.equal(isExternalEvidenceToolCall({ toolName: "fetch" }), true);
  assert.equal(isExternalEvidenceToolCall({ toolName: "custom.docs_search" }), true);
  assert.equal(isExternalEvidenceToolCall({ toolName: "khala_search_memory" }), false);

  assert.equal(isEvidenceToolCall({ toolName: "khala_search_memory" }), true);
  assert.equal(isEvidenceToolCall({ toolName: "apply_patch" }), false);
  assert.equal(isEvidenceToolCall({ toolName: "custom.apply_patch" }), false);
  assert.equal(isEvidenceToolCall({ toolName: "custom.docs_search" }), true);

  assert.equal(toolNameLooksLikeExternalEvidence("custom.docs_search"), true);
  assert.equal(toolNameLooksLikeExternalEvidence("khala_read_memory"), false);
});

test("tool registry centralizes duplicate evidence policy", () => {
  assert.equal(isDuplicateEvidenceCandidateToolCall({ toolName: "read" }), true);
  assert.equal(
    isDuplicateEvidenceCandidateToolCall({
      toolName: "custom.docs_search",
    }),
    true,
  );
  assert.equal(
    isDuplicateEvidenceCandidateToolCall({
      toolName: "functions.exec_command",
      input: { cmd: "git status --short" },
    }),
    false,
  );
  assert.equal(isDuplicateEvidenceCandidateToolCall({ toolName: "apply_patch" }), false);

  assert.equal(resetsDuplicateEvidenceWindowToolCall({ toolName: "khala_learn" }), true);
  assert.equal(resetsDuplicateEvidenceWindowToolCall({ toolName: "write" }), true);
  assert.equal(
    resetsDuplicateEvidenceWindowToolCall({
      toolName: "functions.exec_command",
      input: { cmd: "npm install" },
    }),
    true,
  );
  assert.equal(
    resetsDuplicateEvidenceWindowToolCall({
      toolName: "functions.exec_command",
      input: { cmd: "git status --short" },
    }),
    false,
  );
});

test("tool registry centralizes conservative replay safety policy", () => {
  assert.equal(
    isUnsafeForConservativeReplay({
      replaySafe: true,
      sideEffectClass: "read_only",
    }),
    false,
  );
  assert.equal(
    isUnsafeForConservativeReplay({
      replaySafe: false,
      sideEffectClass: "read_only",
    }),
    true,
  );
  for (const sideEffectClass of [
    "mutation",
    "shell",
    "forge",
    "external",
    "tool_side_effect",
    "unknown",
  ] as const) {
    assert.equal(
      isUnsafeForConservativeReplay({
        replaySafe: true,
        sideEffectClass,
      }),
      true,
      sideEffectClass,
    );
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
