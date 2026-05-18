import path from "node:path";
import { buildLifecycleHookMarkdown, type HookConfig } from "../hooks/config.ts";
import { readText, readTextIfExists } from "../lib/io.ts";
import {
  getActiveLearningLessonsTail,
  getLearnedSkillsList,
  getLearningMemoryTail,
  type LearningPaths,
} from "../learning/store.ts";
import {
  parseFirstPrinciplesConfig,
  type FirstPrinciplesConfig,
} from "../policy/first-principles.ts";

export async function loadFirstPrinciplesConfig(
  firstPrinciplesConfigPath: string,
  defaults?: FirstPrinciplesConfig,
): Promise<{ config: FirstPrinciplesConfig; warnings: string[] }> {
  const raw = await readTextIfExists(firstPrinciplesConfigPath);
  return parseFirstPrinciplesConfig(raw, defaults);
}

export function createWorkflowReaders(params: {
  skillflowsDir: string;
  commandsDir: string;
  packageSkillsPath: string;
}): {
  readWorkflow: (name: string) => Promise<string>;
  readCommandPrompt: (name: string) => Promise<string>;
  readSkill: (name: string) => Promise<string>;
} {
  async function readWorkflow(name: string): Promise<string> {
    return readText(path.join(params.skillflowsDir, name));
  }

  async function readCommandPrompt(name: string): Promise<string> {
    return readText(path.join(params.commandsDir, name));
  }

  async function readSkill(name: string): Promise<string> {
    const skillFile = path.resolve(params.packageSkillsPath, name, "SKILL.md");
    const skillsRoot = `${path.resolve(params.packageSkillsPath)}${path.sep}`;
    if (!skillFile.startsWith(skillsRoot)) {
      return "";
    }
    return readTextIfExists(skillFile);
  }

  return { readWorkflow, readCommandPrompt, readSkill };
}

export async function getBootstrapPayload(params: {
  cwd: string;
  runtimeDir: string;
  hooksDir: string;
  activeHookConfig: HookConfig;
  learningPathCache: Map<string, LearningPaths>;
  memoryTailLines: number;
  memoryToolCallLimit: number;
}): Promise<string> {
  const [
    soul,
    rules,
    duties,
    instructions,
    complianceProfile,
    startupHooks,
    memoryTail,
    learnedSkills,
    activeLessons,
  ] = await Promise.all([
    readTextIfExists(path.join(params.runtimeDir, "SOUL.md")),
    readTextIfExists(path.join(params.runtimeDir, "RULES.md")),
    readTextIfExists(path.join(params.runtimeDir, "DUTIES.md")),
    readTextIfExists(path.join(params.runtimeDir, "INSTRUCTIONS.md")),
    readTextIfExists(
      path.join(params.runtimeDir, "compliance", "risk-assessment.md"),
    ),
    buildLifecycleHookMarkdown({
      lifecycle: "on_session_start",
      activeHookConfig: params.activeHookConfig,
      hooksDir: params.hooksDir,
    }),
    getLearningMemoryTail(
      params.cwd,
      params.learningPathCache,
      params.memoryTailLines,
    ),
    getLearnedSkillsList(params.cwd, params.learningPathCache),
    getActiveLearningLessonsTail(params.cwd, params.learningPathCache, 8),
  ]);

  return [
    "Khala agent bootstrap context (single-agent runtime):",
    "",
    "[SOUL]",
    soul.trim(),
    "",
    "[RULES]",
    rules.trim(),
    duties.trim() ? "[DUTIES]" : "",
    duties.trim(),
    "",
    "[INSTRUCTIONS]",
    instructions.trim(),
    complianceProfile.trim() ? "[COMPLIANCE PROFILE]" : "",
    complianceProfile.trim(),
    startupHooks.trim() ? "[LIFECYCLE HOOKS: on_session_start]" : "",
    startupHooks.trim(),
    "[TURN EXECUTION RULES]",
    "- Read-only inspection tools are allowed without a memory refresh.",
    "- Before the first mutation or memory write in a task, call khala_read_memory unless memory is already fresh for this task.",
    "- For non-trivial tasks, also call khala_search_memory with a task-specific query built from the user request, workflow, loaded skills, files, technologies, and errors so older relevant memory is retrieved by relevance.",
    `- Memory becomes stale after about ${params.memoryToolCallLimit} tool calls, after memory writes, or after a new task/scope change; refresh before further mutation.`,
    "- Do not say you will perform file reads, edits, commands, or other tool work unless you call the relevant tool in the same assistant turn.",
    "- If a mutation is blocked with MEMORY READ REQUIRED, call khala_read_memory and immediately retry the exact blocked mutation in the same assistant turn; do not switch to explanation, next-turn promises, or ask the user to continue.",
    memoryTail ? "[LEARNING MEMORY TAIL]" : "",
    memoryTail,
    learnedSkills.length > 0
      ? `[LEARNED SKILLS] ${learnedSkills.join(", ")}`
      : "",
    activeLessons ? "[LEARNED OPERATING RULES]" : "",
    activeLessons,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
