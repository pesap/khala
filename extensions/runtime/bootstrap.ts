import path from "node:path";
import {
  buildLifecycleHookMarkdown,
  type HookConfig,
} from "../hooks/config.ts";
import { readText, readTextIfExists } from "../lib/io.ts";
import {
  getActiveLearningLessonsTail,
  getLearnedSkillsList,
  getLearningMemoryTail,
  ensureLearningStore,
  type LearningPaths,
} from "../learning/store.ts";
import {
  formatRuntimeRulesForPrompt,
  selectRuntimeRules,
} from "../learning/rules.ts";
import {
  parseFirstPrinciplesConfig,
  type FirstPrinciplesConfig,
} from "../policy/first-principles.ts";
import type { HarnessLimits } from "./profile.ts";

export const DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT = 8;
export const DEFAULT_BOOTSTRAP_RUNTIME_RULE_LIMIT = 8;

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
  lowConfidenceThreshold: number;
  harnessLimits?: Pick<
    HarnessLimits,
    "bootstrapMemoryTailLines" | "bootstrapRuntimeRules"
  >;
  ruleQuery?: string;
  workflowType?: string;
  workflowId?: string;
  loadedSkills?: string[];
  policyWarnings?: string[];
}): Promise<string> {
  const bootstrapMemoryTailLines =
    params.harnessLimits?.bootstrapMemoryTailLines ??
    DEFAULT_BOOTSTRAP_MEMORY_TAIL_LINE_LIMIT;
  const bootstrapRuntimeRules =
    params.harnessLimits?.bootstrapRuntimeRules ??
    DEFAULT_BOOTSTRAP_RUNTIME_RULE_LIMIT;
  const [
    rules,
    duties,
    instructions,
    complianceProfile,
    startupHooks,
    memoryTail,
    learnedSkills,
    activeLessons,
    activeRuntimeRules,
  ] = await Promise.all([
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
      Math.min(params.memoryTailLines, bootstrapMemoryTailLines),
    ),
    getLearnedSkillsList(params.cwd, params.learningPathCache),
    getActiveLearningLessonsTail(params.cwd, params.learningPathCache, 8),
    (async () => {
      const paths = await ensureLearningStore(
        params.cwd,
        params.learningPathCache,
      );
      return selectRuntimeRules({
        paths,
        context: {
          query: params.ruleQuery,
          workflowType: params.workflowType,
          workflowId: params.workflowId,
          loadedSkills: params.loadedSkills,
          policyWarnings: params.policyWarnings,
          limit: bootstrapRuntimeRules,
        },
      });
    })(),
  ]);
  const runtimeRules = formatRuntimeRulesForPrompt(activeRuntimeRules);

  return [
    "Khala agent bootstrap context (single-agent runtime):",
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
    "- Before the first non-memory mutation in a task, call khala_read_memory unless memory is already fresh for this task; khala_read_memory, khala_search_memory, and khala_learn themselves must not be blocked on a memory refresh.",
    "- For non-trivial tasks, also call khala_search_memory with a focused task-specific query built from the user request, workflow, loaded skills, files, symbols, technologies, errors, corrections, and user intent so older relevant memory is retrieved by relevance; refresh that search if several non-memory tools run afterward before final synthesis.",
    "- For mutation turns, including mutating shell commands such as `sed -i`, package-manager edits such as `npm install`, VCS writes such as `git commit`, and file-producing commands such as `dd of=README.md`, the latest focused khala_search_memory before the first edit/write/mutating bash must succeed and still be fresh; searching memory after mutation, relying on a stale search after several non-memory tools, or relying on an older success after a later failed search is too late to satisfy task-specific recall.",
    `- Memory becomes stale after about ${params.memoryToolCallLimit} non-memory tool calls, after memory writes, or after a new task/scope change; refresh before further non-memory mutation.`,
    `- If your final answer would be below confidence ${params.lowConfidenceThreshold.toFixed(2)}, or you surface a knowledge gap that matters to correctness, including best-guess/may-be-wrong/cannot-access/knowledge-cutoff/no-web-access/without-seeing-the-file-or-logs/I'd-need-the-logs-to-confirm/no-way-to-verify/no-visibility/not-enough-context language, escalate before finalizing through a stronger advisory path such as subagent oracle/researcher/reviewer with a strong model or high-thinking override; include the concrete uncertainty plus the relevant failure, artifact, API, command, or exact question, then wait for and synthesize the latest substantive advisory result that answers the escalated question.`,
    "- If three tool results fail in one turn, stop guessing and escalate through a stronger advisory path before finalizing, including the failed command/error context, then wait for and synthesize the latest substantive advisory result. A result that merely says `advisory result` or repeats the task is not enough; it must give a root cause, recommendation, verified answer, or evidence-backed finding.",
    "- Do not say you will perform file reads, edits, commands, or other tool work unless you call the relevant tool in the same assistant turn.",
    "- Do not say you read, inspected, searched, browsed, looked up, ran, or executed tool-backed work unless the matching tool succeeded in the same assistant turn; repo/codebase search claims require local evidence, and named command claims must match the named command, not a different successful command.",
    "- Do not claim you updated, modified, patched, wrote, created, fixed, or implemented files/code unless a matching edit/write/apply_patch or mutating command ran in the same turn.",
    "- Do not claim you remembered, stored, saved, or learned a durable lesson unless the latest khala_learn attempt in the same assistant turn succeeded.",
    "- If a mutation is blocked with MEMORY READ REQUIRED, call khala_read_memory and immediately retry the exact blocked mutation in the same assistant turn; do not switch to explanation, next-turn promises, or ask the user to continue.",
    "[CONTEXT BUDGET]",
    `- Bootstrap injects only the most recent ${bootstrapMemoryTailLines} memory lines and ${bootstrapRuntimeRules} active rules so the stable policy prefix stays cache-friendly.`,
    "- Use khala_search_memory for older or task-specific lessons instead of relying on broad startup context.",
    "- For latest/current/source-backed questions, URLs, docs, repositories, paths, files, or assistant source claims, use the cheapest matching evidence tool before answering: local read/search for local artifacts, memory search for stored lessons, and focused web/search/researcher tools that name the requested or claimed external product/API/package/standard/URL and fact category for external, current, URL, or documentation facts. Broad or wrong-target searches like `latest docs`, a React query for a TypeScript question, release notes for a docs claim, or handbook docs for a release question do not satisfy external evidence.",
    "- For local artifact questions or claims, the local evidence tool target must touch the referenced file/path; an unrelated read/search or broad grep pattern that merely mentions the file name does not satisfy evidence routing.",
    "- For generic evidence tools, task-specific memory searches, local artifacts, mutations, command checks, and equivalent external searches, the latest matching evidence attempt must succeed; do not rely on an older success after a later matching failure.",
    "- For official/primary/source requests, the evidence result or opened URL authority must indicate an official, primary, authoritative, or vendor source; adding `official` to a search query is not enough, and results marked unofficial, non-official, third-party, community, forum, blog, mirror, or unverified do not count.",
    "- External researcher/scout/oracle delegation must name the concrete URL, product, library, API, package, standard, organization, or exact fact; vague tasks like `fetch source` do not satisfy evidence routing.",
    "- Do not say you verified, confirmed, checked, browsed, searched, or relied on official docs/source/current facts unless the matching evidence tool ran in the same turn.",
    "- When the user asks for citations, sources, references, or links, include a concrete URL, GitHub link, or referenced local artifact in the final response; the latest matching cited URL evidence attempt must succeed, and cited URL evidence from a subagent must come from a focused researcher/scout/oracle task, not an unrelated reviewer or vague `find source` delegation. Vague phrases like `according to the docs` or a bare `Sources:` label are not citations.",
    "- Tool outputs with only acknowledgements, generic external-source acknowledgements, generic memory-hit summaries, zero-execution summaries, empty nested result containers, or metadata such as `ok`, `page loaded`, `source found`, `relevant memory found`, `Tests: 0 passed, 0 failed`, `[]`, `{\"results\":[]}`, `[{\"results\":[]}]`, `{\"output\":\"\"}`, `{\"stdout\":\"\",\"stderr\":\"\"}`, `{\"success\":true,\"count\":1}`, or `{\"success\":true,\"passed\":0,\"failed\":0}` do not satisfy evidence, memory, skill, citation, mutation, command, or escalation gates.",
    "- Do not claim tests, lint, typecheck, build, postflight, or other command-backed checks passed unless the matching command succeeded in the same turn without failure masking; generic `checks passed` claims require a real check/verify/validate/postflight command rather than a single narrower test command, and help/version/list/collect/watch/dry-run modes such as `npm test -- --help`, `npm test -- --listTests`, `pytest --collect-only`, `npm test -- --watch`, or `tsc --version`, dry-run mismatches such as claiming `npm install` after only `npm install --dry-run`, placeholders like `echo check`, masked or synthetic commands like `npm test || true`, `npm test && echo 'tests passed'`, `npm test | tee test.log`, or `npm test | head -40`, or failing output like `FAIL` or `not ok` do not satisfy verification evidence.",
    "- Avoid broad evidence queries such as `latest docs`, `latest release notes`, `fix repo`, or `review task`; search queries must include concrete products, libraries, files, symbols, errors, standards, URLs, corrections, or user intent.",
    "- Avoid unbounded local evidence dumps such as `cat file`, `nl -ba file`, `bat file`, `less file`, `more file`, scripted dumps like `awk '{print}' file` or `python -c \"print(open('file').read())\"`, bare `rg --files`, command-substitution fanouts like `sed -n '1,80p' $(rg --files)`, bare repo-wide `rg TODO`, raw `git diff`/`git show` patch output, unbounded `git log`/`git reflog` history output, raw unbounded `git status`/`git branch` state checks, broad repo summaries like `tree .` or `du -ah .`, VCS commands that combine summary flags with `-p`/`--patch`, watch/follow commands like `--watch` or `tail -f`, broad `sed -n` print ranges, excessive `head`/`tail` or `grep`/`rg` match limits, `grep -R`, broad `find .` forms like `find . -maxdepth 2 -type f`, or `ls -R`; use bounded read/search tools, summary flags, one-shot test flags, bounded git summaries, focused `rg --files -g` globs or paths, shallow tree limits like `tree -L 2`, focused find predicates like `find . -maxdepth 3 -name package.json`, explicit history limits like `git log -5`, `rg` with small limits, scoped paths, or add small explicit limits when shell is necessary.",
    "- When the user explicitly asks to load, use, read, apply, or invoke a named skill, read that exact SKILL.md before finalizing; backup or nested paths like `SKILL.md.bak` do not count, and a manifest line or different skill is only a routing hint.",
    "- Do not claim you used, applied, followed, loaded, read, or invoked a named skill unless the latest matching same-turn SKILL.md read, exact skill loader target, or explicit skill-assigned delegation succeeded; merely mentioning the skill in a note, reason field, or subagent task is not enough.",
    "- For obvious best-practice task classes, read the relevant packaged SKILL.md before finalizing even if the user did not name it: code review, debugging, TDD, skill creation, security audit, docs authoring, GitHub work, commit work, academic/first-principles review, dependency untangling, data modeling, API design, dead-code proof, type hardening, public API compatibility, feature delivery, Python, pytest, uv, Rust, infrasys, Bash scripts, CLI UX, TypeScript, and simplification.",
    "- When the user explicitly asks you to remember, store, save, or learn a durable rule/preference/correction, including `remember to ...` phrasing, or when you claim a lesson was stored, persist the same requested or claimed lesson through khala_learn with a concrete trigger, lesson, evidence snippet, score, and confidence at or above the storage threshold before finalizing; candidate/draft creation is not durable storage.",
    "- Do not repeat the exact same read/search tool call after the same user turn unless a mutation changed the evidence; reuse the first result or ask a narrower follow-up query.",
    "- Do not repeat local evidence for the same file/path across different tools, such as `read README.md` followed by `sed -n ... README.md`, unless a mutation changed the evidence.",
    "- Do not repeat equivalent khala_search_memory queries with reordered terms or filler words; reuse memory hits unless a mutation changed the task context.",
    "- Do not repeat equivalent external search queries with reordered terms or freshness/source filler words, including repeats hidden inside batched search/open calls; reuse the first source result or narrow the query.",
    "- Do not repeat identical khala_learn storage after a successful write; reuse the stored lesson instead of duplicating durable memory records.",
    "- Substantial tool-backed work and non-memory mutations require khala_search_memory with a focused query; broad queries like `fix repo`, `review task`, `follow-up`, or `current-task` do not satisfy task-specific memory retrieval, substantial non-mutating turns must refresh memory after too many later non-memory tool calls, and mutation turns require the latest focused search before the first non-memory mutation to succeed.",
    runtimeRules ? "[ACTIVE RUNTIME RULES]" : "",
    runtimeRules,
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
