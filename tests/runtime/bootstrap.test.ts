import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_HOOK_CONFIG } from "../../extensions/hooks/config.ts";
import {
  createWorkflowReaders,
  DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT,
  getBootstrapPayload,
  readWorkflowSkill,
} from "../../extensions/runtime/bootstrap.ts";
import { ensureLearningStore } from "../../extensions/learning/store.ts";

async function makeRuntimeDir(root: string): Promise<{
  runtimeDir: string;
  hooksDir: string;
}> {
  const runtimeDir = path.join(root, "runtime");
  const hooksDir = path.join(runtimeDir, "hooks");
  await fs.mkdir(path.join(runtimeDir, "compliance"), { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(runtimeDir, "RULES.md"), "stable rules\n", "utf8"),
    fs.writeFile(path.join(runtimeDir, "DUTIES.md"), "stable duties\n", "utf8"),
    fs.writeFile(
      path.join(runtimeDir, "INSTRUCTIONS.md"),
      "stable instructions\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(runtimeDir, "compliance", "risk-assessment.md"),
      "stable compliance\n",
      "utf8",
    ),
    fs.writeFile(path.join(hooksDir, "bootstrap.md"), "stable hook\n", "utf8"),
  ]);

  return { runtimeDir, hooksDir };
}

test("workflow readers return packaged skill metadata", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-readers-"));
  try {
    const skillflowsDir = path.join(root, "skillflows");
    const commandsDir = path.join(root, "commands");
    const packageSkillsPath = path.join(root, "skills");
    await fs.mkdir(path.join(packageSkillsPath, "code-review"), { recursive: true });
    await fs.mkdir(skillflowsDir, { recursive: true });
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(packageSkillsPath, "code-review", "SKILL.md"),
      "---\nname: Code Review\ndescription: Review code.\n---\n",
      "utf8",
    );

    const readers = createWorkflowReaders({
      skillflowsDir,
      commandsDir,
      packageSkillsPath,
    });

    const loaded = await readers.readSkill("code-review");

    assert.match(loaded.content, /description: Review code/);
    assert.deepEqual(loaded.metadata, {
      name: "code-review",
      source: "packaged",
      path: path.join(packageSkillsPath, "code-review", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow readers fall back to learned skill metadata", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-readers-learned-"));
  try {
    const skillflowsDir = path.join(root, "skillflows");
    const commandsDir = path.join(root, "commands");
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    await fs.mkdir(skillflowsDir, { recursive: true });
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(path.join(learnedSkillsPath, "repo-helper"), { recursive: true });
    await fs.writeFile(
      path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
      "---\nname: Repo Helper\ndescription: Learned repo helper.\n---\n",
      "utf8",
    );

    const readers = createWorkflowReaders({
      skillflowsDir,
      commandsDir,
      packageSkillsPath,
      learnedSkillsPath,
    });

    const loaded = await readers.readSkill("repo-helper");

    assert.match(loaded.content, /Learned repo helper/);
    assert.deepEqual(loaded.metadata, {
      name: "repo-helper",
      source: "learned",
      path: path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader falls back to learned skills when packaged skill is missing", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-learned-skill-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    await fs.mkdir(path.join(learnedSkillsPath, "repo-helper"), { recursive: true });
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.writeFile(
      path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
      "---\nname: Repo Helper\ndescription: Use repo-specific memory.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "repo-helper",
      packageSkillsPath,
      learnedSkillsPath,
    });

    assert.match(loaded.content, /repo-specific memory/);
    assert.deepEqual(loaded.metadata, {
      name: "repo-helper",
      source: "learned",
      path: path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader keeps packaged skills ahead of learned fallback", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-packaged-skill-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    await fs.mkdir(path.join(packageSkillsPath, "code-review"), { recursive: true });
    await fs.mkdir(path.join(learnedSkillsPath, "code-review"), { recursive: true });
    await fs.writeFile(
      path.join(packageSkillsPath, "code-review", "SKILL.md"),
      "---\nname: Code Review\ndescription: Packaged review.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(learnedSkillsPath, "code-review", "SKILL.md"),
      "---\nname: Code Review\ndescription: Learned review.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "code-review",
      packageSkillsPath,
      learnedSkillsPath,
    });

    assert.match(loaded.content, /Packaged review/);
    assert.deepEqual(loaded.metadata, {
      name: "code-review",
      source: "packaged",
      path: path.join(packageSkillsPath, "code-review", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader falls back to repo-local skills when packaged and learned skills are missing", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-repo-skill-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    await fs.mkdir(path.join(repoSkillsPath, "repo-helper"), { recursive: true });
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.writeFile(
      path.join(repoSkillsPath, "repo-helper", "SKILL.md"),
      "---\nname: Repo Helper\ndescription: Use checked-in repo-local guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "repo-helper",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
    });

    assert.match(loaded.content, /checked-in repo-local guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "repo-helper",
      source: "repo-local",
      path: path.join(repoSkillsPath, "repo-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader keeps learned skills ahead of repo-local fallback", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-learned-before-repo-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(path.join(learnedSkillsPath, "repo-helper"), { recursive: true });
    await fs.mkdir(path.join(repoSkillsPath, "repo-helper"), { recursive: true });
    await fs.writeFile(
      path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
      "---\nname: Repo Helper\ndescription: Learned guidance.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoSkillsPath, "repo-helper", "SKILL.md"),
      "---\nname: Repo Helper\ndescription: Repo-local guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "repo-helper",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
    });

    assert.match(loaded.content, /Learned guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "repo-helper",
      source: "learned",
      path: path.join(learnedSkillsPath, "repo-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader falls back to user skills when local harness roots are missing", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-user-skill-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    const userSkillsPath = path.join(root, ".codex", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.mkdir(repoSkillsPath, { recursive: true });
    await fs.mkdir(path.join(userSkillsPath, "debug-helper"), { recursive: true });
    await fs.writeFile(
      path.join(userSkillsPath, "debug-helper", "SKILL.md"),
      "---\nname: Debug Helper\ndescription: Use personal debug guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "debug-helper",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
      userSkillsPaths: [userSkillsPath],
    });

    assert.match(loaded.content, /personal debug guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "debug-helper",
      source: "user",
      path: path.join(userSkillsPath, "debug-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader keeps repo-local skills ahead of user fallback", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-repo-before-user-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    const userSkillsPath = path.join(root, ".agents", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.mkdir(path.join(repoSkillsPath, "debug-helper"), { recursive: true });
    await fs.mkdir(path.join(userSkillsPath, "debug-helper"), { recursive: true });
    await fs.writeFile(
      path.join(repoSkillsPath, "debug-helper", "SKILL.md"),
      "---\nname: Debug Helper\ndescription: Repo-local debug guidance.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(userSkillsPath, "debug-helper", "SKILL.md"),
      "---\nname: Debug Helper\ndescription: User debug guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "debug-helper",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
      userSkillsPaths: [userSkillsPath],
    });

    assert.match(loaded.content, /Repo-local debug guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "debug-helper",
      source: "repo-local",
      path: path.join(repoSkillsPath, "debug-helper", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader falls back to plugin skills when local and user roots are missing", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-plugin-skill-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    const userSkillsPath = path.join(root, ".codex", "skills");
    const pluginSkillsPath = path.join(root, ".codex", "plugins", "cache", "github", "rev", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.mkdir(repoSkillsPath, { recursive: true });
    await fs.mkdir(userSkillsPath, { recursive: true });
    await fs.mkdir(path.join(pluginSkillsPath, "gh-fix-ci"), { recursive: true });
    await fs.writeFile(
      path.join(pluginSkillsPath, "gh-fix-ci", "SKILL.md"),
      "---\nname: GH Fix CI\ndescription: Use plugin CI repair guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "gh-fix-ci",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
      userSkillsPaths: [userSkillsPath],
      pluginSkillsPaths: [pluginSkillsPath],
    });

    assert.match(loaded.content, /plugin CI repair guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "gh-fix-ci",
      source: "plugin",
      path: path.join(pluginSkillsPath, "gh-fix-ci", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader keeps user skills ahead of plugin fallback", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-user-before-plugin-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    const userSkillsPath = path.join(root, ".agents", "skills");
    const pluginSkillsPath = path.join(root, ".codex", "plugins", "cache", "github", "rev", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.mkdir(repoSkillsPath, { recursive: true });
    await fs.mkdir(path.join(userSkillsPath, "gh-fix-ci"), { recursive: true });
    await fs.mkdir(path.join(pluginSkillsPath, "gh-fix-ci"), { recursive: true });
    await fs.writeFile(
      path.join(userSkillsPath, "gh-fix-ci", "SKILL.md"),
      "---\nname: GH Fix CI\ndescription: User CI repair guidance.\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginSkillsPath, "gh-fix-ci", "SKILL.md"),
      "---\nname: GH Fix CI\ndescription: Plugin CI repair guidance.\n---\n",
      "utf8",
    );

    const loaded = await readWorkflowSkill({
      name: "gh-fix-ci",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
      userSkillsPaths: [userSkillsPath],
      pluginSkillsPaths: [pluginSkillsPath],
    });

    assert.match(loaded.content, /User CI repair guidance/);
    assert.deepEqual(loaded.metadata, {
      name: "gh-fix-ci",
      source: "user",
      path: path.join(userSkillsPath, "gh-fix-ci", "SKILL.md"),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow skill reader reports attempted source kinds for missing skills", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-workflow-missing-skill-sources-"));
  try {
    const packageSkillsPath = path.join(root, "package-skills");
    const learnedSkillsPath = path.join(root, ".pi", "khala", "skills");
    const repoSkillsPath = path.join(root, "repo", "skills");
    const userSkillsPath = path.join(root, ".agents", "skills");
    const pluginSkillsPath = path.join(root, ".codex", "plugins", "cache", "github", "rev", "skills");
    await fs.mkdir(packageSkillsPath, { recursive: true });
    await fs.mkdir(learnedSkillsPath, { recursive: true });
    await fs.mkdir(repoSkillsPath, { recursive: true });
    await fs.mkdir(userSkillsPath, { recursive: true });
    await fs.mkdir(pluginSkillsPath, { recursive: true });

    const loaded = await readWorkflowSkill({
      name: "missing-helper",
      packageSkillsPath,
      learnedSkillsPath,
      repoSkillsPath,
      userSkillsPaths: [userSkillsPath],
      pluginSkillsPaths: [pluginSkillsPath],
    });

    assert.equal(loaded.content, "");
    assert.deepEqual(loaded.attemptedSources, [
      "packaged",
      "learned",
      "repo-local",
      "user",
      "plugin",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bootstrap keeps stable context first and bounds startup memory", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-bootstrap-"));
  const cwd = path.join(root, "repo");
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  const { runtimeDir, hooksDir } = await makeRuntimeDir(root);
  const learningPathCache = new Map();
  const learningPaths = await ensureLearningStore(cwd, learningPathCache);
  const memoryLines = Array.from(
    { length: 12 },
    (_, index) => `- memory line ${index + 1}`,
  );
  await fs.writeFile(
    learningPaths.memoryMd,
    ["# MEMORY", ...memoryLines, ""].join("\n"),
    "utf8",
  );

  const payload = await getBootstrapPayload({
    cwd,
    runtimeDir,
    hooksDir,
    activeHookConfig: DEFAULT_HOOK_CONFIG,
    learningPathCache,
    memoryTailLines: 20,
    memoryToolCallLimit: 15,
    lowConfidenceThreshold: 0.7,
  });

  assert.ok(payload.includes("stable rules"));
  assert.ok(payload.includes("stable duties"));
  assert.ok(payload.includes("stable instructions"));
  assert.ok(
    payload.includes(
      `Bootstrap injects only the most recent ${DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT} memory lines`,
    ),
  );
  assert.equal(payload.includes("memory line 4"), false);
  assert.equal(payload.includes("memory line 5"), true);
  assert.equal(payload.includes("memory line 12"), true);

  const rulesIndex = payload.indexOf("[RULES]");
  const dutiesIndex = payload.indexOf("[DUTIES]");
  const instructionsIndex = payload.indexOf("[INSTRUCTIONS]");
  const turnRulesIndex = payload.indexOf("[TURN EXECUTION RULES]");
  const budgetIndex = payload.indexOf("[CONTEXT BUDGET]");
  const memoryIndex = payload.indexOf("[LEARNING MEMORY TAIL]");

  assert.ok(rulesIndex < dutiesIndex);
  assert.ok(dutiesIndex < instructionsIndex);
  assert.ok(instructionsIndex < turnRulesIndex);
  assert.ok(turnRulesIndex < budgetIndex);
  assert.ok(budgetIndex < memoryIndex);
});

test("bootstrap honors configured harness startup limits", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "khala-bootstrap-config-"));
  const cwd = path.join(root, "repo");
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  const { runtimeDir, hooksDir } = await makeRuntimeDir(root);
  const learningPathCache = new Map();
  const learningPaths = await ensureLearningStore(cwd, learningPathCache);
  await fs.writeFile(
    learningPaths.memoryMd,
    [
      "# MEMORY",
      "- memory line 1",
      "- memory line 2",
      "- memory line 3",
      "",
    ].join("\n"),
    "utf8",
  );

  const payload = await getBootstrapPayload({
    cwd,
    runtimeDir,
    hooksDir,
    activeHookConfig: DEFAULT_HOOK_CONFIG,
    learningPathCache,
    memoryTailLines: 20,
    memoryToolCallLimit: 15,
    lowConfidenceThreshold: 0.7,
    harnessLimits: {
      bootstrapMemoryTailLines: 2,
      bootstrapRuntimeRules: 3,
    },
  });

  assert.equal(
    payload.includes(
      `Bootstrap injects only the most recent ${DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT} memory lines`,
    ),
    false,
  );
  assert.ok(
    payload.includes(
      "Bootstrap injects only the most recent 2 memory lines and 3 active rules",
    ),
  );
  assert.equal(payload.includes("memory line 1"), false);
  assert.equal(payload.includes("memory line 2"), true);
});
