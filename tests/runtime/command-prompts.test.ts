import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePromptSkills(promptText: string): string[] {
  const match = promptText.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return [];
  const parsed = loadYaml(match[1]);
  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) return [];
  return parsed.skills.filter((skill): skill is string => typeof skill === "string");
}

test("command prompt skill frontmatter resolves to packaged skills", async () => {
  const repoRoot = process.cwd();
  const commandsDir = path.join(repoRoot, "commands");
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  const missing: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const promptPath = path.join(commandsDir, entry.name);
    const promptText = await fs.readFile(promptPath, "utf8");

    for (const skillName of parsePromptSkills(promptText)) {
      const skillPath = path.join(repoRoot, "skills", skillName, "SKILL.md");
      try {
        await fs.access(skillPath);
      } catch {
        missing.push(`${entry.name}: ${skillName}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("runtime agent skill registry resolves to packaged skills", async () => {
  const repoRoot = process.cwd();
  const agentYamlPath = path.join(repoRoot, "runtime", "agent.yaml");
  const parsed = loadYaml(await fs.readFile(agentYamlPath, "utf8"));
  const missing: string[] = [];

  if (!isRecord(parsed) || !Array.isArray(parsed.skills)) {
    assert.fail("runtime/agent.yaml must define a skills list");
  }

  for (const skillName of parsed.skills) {
    if (typeof skillName !== "string") {
      missing.push(String(skillName));
      continue;
    }
    const skillPath = path.join(repoRoot, "skills", skillName, "SKILL.md");
    try {
      await fs.access(skillPath);
    } catch {
      missing.push(skillName);
    }
  }

  assert.deepEqual(missing, []);
});

test("command prompts do not contain unconditional clarification stalls", async () => {
  const repoRoot = process.cwd();
  const commandsDir = path.join(repoRoot, "commands");
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  const offenders: string[] = [];
  const unconditionalPatterns = [
    /\bClarify acceptance criteria before coding\b/i,
    /\bAsk one question at a time and wait\b/i,
    /\bAsk clarifying questions when\b/i,
  ];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const promptText = await fs.readFile(path.join(commandsDir, entry.name), "utf8");
    if (unconditionalPatterns.some((pattern) => pattern.test(promptText))) {
      offenders.push(entry.name);
    }
  }

  assert.deepEqual(offenders, []);
});

test("PR templates require source-closing checklist body shape", async () => {
  const repoRoot = process.cwd();
  const templatePaths = [
    ".github/pull_request_template.md",
    "skills/github/pr-template.md",
  ];
  const templateTexts = await Promise.all(
    templatePaths.map((templatePath) => fs.readFile(path.join(repoRoot, templatePath), "utf8")),
  );

  assert.equal(templateTexts[0], templateTexts[1]);

  for (const templateText of templateTexts) {
    assert.doesNotMatch(templateText, /^Closes:\s*non(?:e)?\b/im);
    assert.doesNotMatch(templateText, /Closes #<issue>\s*$/m);
    assert.match(templateText, /Resolve the durable source issue before writing close text/i);
    assert.match(templateText, /Omit close markers entirely when no durable source issue is resolved/i);
    assert.match(templateText, /multiple close markers/i);
    assert.match(templateText, /^## Summary$/m);
    assert.match(templateText, /3–4 line summary/i);
    assert.match(templateText, /^## Acceptance criteria$/m);
    assert.match(templateText, /- \[ \] Source issue criterion/i);
    assert.match(templateText, /Check only criteria that are met/i);
    assert.match(templateText, /^## Deviations from the original plan$/m);
    assert.match(templateText, /unmet criteria/i);
    assert.match(templateText, /^## Testing Strategy$/m);
    assert.match(templateText, /List validation commands only/i);
    assert.match(templateText, /^## References$/m);
    assert.match(templateText, /Original issues:/i);
    assert.match(templateText, /Files:/i);
  }
});

test("ship workflow requires source issue close-marker resolution", async () => {
  const repoRoot = process.cwd();
  const workflowText = await fs.readFile(
    path.join(repoRoot, "workflows", "ship-workflow.yaml"),
    "utf8",
  );

  assert.match(workflowText, /resolve the durable source issue/i);
  assert.match(workflowText, /never contains `Closes: none` or `Closes: non`/);
});

test("public workflow taxonomy does not expose dropped feature or tdd commands", async () => {
  const repoRoot = process.cwd();
  const files = [
    "README.md",
    "runtime/profile.yaml",
    "extensions/commands/register.ts",
    "extensions/runtime/profile.ts",
  ];

  for (const filePath of files) {
    const text = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    assert.doesNotMatch(text, /\/feature\b|\/tdd\b|triage-issue-workflow|tdd-workflow|feature-workflow/);
  }

  await assert.rejects(fs.access(path.join(repoRoot, "commands", "feature-workflow.md")));
  await assert.rejects(fs.access(path.join(repoRoot, "commands", "tdd-workflow.md")));
  await assert.rejects(fs.access(path.join(repoRoot, "commands", "triage-issue-workflow.md")));
  await fs.access(path.join(repoRoot, "commands", "triage-workflow.md"));
});

test("triage guidance enforces plain bullet acceptance criteria", async () => {
  const repoRoot = process.cwd();
  const triagePrompt = await fs.readFile(path.join(repoRoot, "commands", "triage-workflow.md"), "utf8");
  const triageWorkflowHandler = await fs.readFile(path.join(repoRoot, "extensions", "commands", "workflow-handlers.ts"), "utf8");
  const triageAgentBrief = await fs.readFile(path.join(repoRoot, "skills", "triage", "AGENT-BRIEF.md"), "utf8");

  assert.match(
    triagePrompt,
    /narrow acceptance criteria \(plain markdown bullet list items, not task-list `- \[ \]` items\)/,
  );

  assert.match(
    triageWorkflowHandler,
    /acceptance criteria \(plain markdown bullets, not task-list checkboxes\)/i,
  );

  for (const section of triageAgentBrief.match(/\*\*Acceptance criteria:\*\*[\s\S]*?(?:\n\n|```)/g) ?? []) {
    assert.equal(/- \[ \]/.test(section), false);
  }
});

test("workflow handler instructions do not contain unconditional clarification stalls", async () => {
  const repoRoot = process.cwd();
  const handlerText = await fs.readFile(
    path.join(repoRoot, "extensions", "commands", "workflow-handlers.ts"),
    "utf8",
  );
  const unconditionalPatterns = [
    /\bClarify acceptance criteria before coding\b/i,
    /\bAsk one question at a time and wait\b/i,
    /\bAsk clarifying questions when\b/i,
  ];

  assert.equal(
    unconditionalPatterns.some((pattern) => pattern.test(handlerText)),
    false,
  );
});

test("runtime instructions do not require noisy default footers or unconditional clarification", async () => {
  const repoRoot = process.cwd();
  const instructions = await fs.readFile(
    path.join(repoRoot, "runtime", "INSTRUCTIONS.md"),
    "utf8",
  );
  const slopPatterns = [
    /\bClarify acceptance criteria\./i,
    /\bAdd a `Bias Check \(Tier 1\)` footer at the end of every substantive response\b/i,
    /\bMust request approval before applying self-edits\b/i,
  ];

  assert.equal(slopPatterns.some((pattern) => pattern.test(instructions)), false);
});

test("packaged skills do not require approval or clarification before ordinary coding", async () => {
  const repoRoot = process.cwd();
  const skillsDir = path.join(repoRoot, "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const offenders: string[] = [];
  const slopPatterns = [
    /\bConfirm with user what interface changes are needed\b/i,
    /\bConfirm with user which behaviors to test\b/i,
    /\bGet user approval on the plan\b/i,
    /\bClarify acceptance criteria\./i,
    /\bAsk: "What should the public interface look like\?/i,
  ];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      const skillText = await fs.readFile(skillPath, "utf8");
      if (slopPatterns.some((pattern) => pattern.test(skillText))) {
        offenders.push(entry.name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  assert.deepEqual(offenders, []);
});

test("khala_search_memory tool enforces focused query quality before search", async () => {
  const repoRoot = process.cwd();
  const extensionText = await fs.readFile(
    path.join(repoRoot, "extensions", "index.ts"),
    "utf8",
  );

  assert.match(extensionText, /memorySearchQueryQuality\(query\)/);
  assert.match(
    extensionText,
    /khala_search_memory requires a focused task-specific query/,
  );
});
