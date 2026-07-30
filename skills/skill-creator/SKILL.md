---
name: skill-creator
description:
  Create or improve reusable agent skills with strong trigger descriptions, safe
  boundaries, progressive disclosure, and optional bundled resources/scripts.
  Use when users ask to create, write, refine, or review a skill, even if they
  only ask to "learn a skill".
license: MIT
---

## Use when

- User wants a new reusable skill.
- User wants to improve an existing `SKILL.md`.
- User asks for better trigger behavior, boundaries, or output structure.
- User runs `/learn-skill`.

## Avoid when

- Task is not about skills (feature work, bugfixes, one-off prompt help).
- Scope is intentionally fixed and user does not want skill changes.

## Workflow

1. **Gather requirements and evidence**
   - Clarify: domain/task, key use cases, optional scripts, reference materials,
     target agent/runtime, and where the skill should be saved.
   - If the save location is not explicit, ask before writing files. Offer
     common choices when useful: repo skill (`skills/<name>/`), local khala
     skill (`.pi/khala/skills/<name>/`), or another user-specified path.
   - Prefer real source material over generic best practices: successful task
     transcripts, user corrections, runbooks, issue history, code review
     comments, specs, or existing docs.
   - If creating from scratch, ask what recurring failure, workflow, or
     expertise gap the skill should address.
   - Classify the skill pattern before drafting:
     - capability primitive: the agent needs a deterministic tool or script
     - process primitive: the agent needs a better method, checklist, or loop
2. **Choose portability target and save path**
   - Decide whether this is a local-only skill or an Agent Skills–portable
     skill.
   - Confirm the exact target directory before mutation; the frontmatter `name`
     should match the directory basename.
   - When portability matters, follow the Agent Skills spec and standard layout.
3. **Draft skill artifacts**
   - Create/update `SKILL.md` with concise operational instructions.
   - Do not re-teach generic model knowledge, include human-facing README-style
     docs, use time-sensitive claims, or rely on absolute paths.
   - Add state-check-before-action steps for setup-dependent skills.
   - Add a verify/fix/re-verify loop when completion quality can be checked.
   - Use standard optional directories when needed:
     - `references/` for deep docs and on-demand detail
     - `assets/` for templates, schemas, examples, or static resources
     - `scripts/` for deterministic helper logic
     - `evals/` for evaluation fixtures when iteration matters
4. **Optimize frontmatter and trigger description**
   - Validate `name` against spec expectations: lowercase, hyphenated, <=64
     chars, and matching the directory name.
   - Keep `description` <=1024 chars.
   - Description is the trigger surface: describe capability and explicit "Use
     when ..." conditions.
   - Include what the skill does, when to use it, and how it differs from nearby
     skills. Do not summarize step-by-step workflow in the description; that
     causes agents to follow the summary instead of loading the body.
   - Focus on user intent, including implicit phrasing and near-synonyms.
   - Include optional frontmatter only when justified: `license`,
     `compatibility`, `metadata`, `allowed-tools`.
5. **Apply progressive disclosure**
   - Keep `SKILL.md` short and high-signal.
   - Put detailed references in `references/REFERENCE.md` or other focused
     files.
   - Tell the agent when to read each extra file; do not dump all detail into
     `SKILL.md`.
   - Keep reference chains one level deep: link directly from `SKILL.md` to the
     file an agent should read.
   - Read `references/effective-agent-skills.md` when doing a deep skill review,
     importing a third-party skill, or debugging trigger/execution failures.
6. **Design evaluation plan**
   - Trigger evals: prepare realistic should-trigger and should-NOT-trigger
     prompts.
   - Prefer a broader eval set (about 8-10 positive and 8-10 negative prompts)
     when refining an important skill.
   - Include phrasing variation, implicit-intent prompts, and near-miss
     negatives.
   - If reliability matters, split trigger prompts into train/validation sets.
   - Test against the weakest model likely to use the skill, not only the best
     model available.
   - Separate routing failures from execution failures: routing failures usually
     mean the description is wrong; execution failures usually mean the body is
     underspecified.
   - Output-quality evals: optionally scaffold `evals/evals.json` with prompts,
     expected outputs, files, and draft assertions.
7. **Score Agent Skills alignment**
   - Score the skill against the Agent Skills spec and best practices before
     calling it done.
   - Use this rubric (0-10 each, weighted): spec compliance 25%, progressive
     disclosure 20%, trigger quality 20%, scope/boundary clarity 15%,
     reference/resource quality 10%, eval readiness 10%.
   - Report the weighted total and the biggest gaps preventing a higher score.
   - For repo-wide audits, run `scripts/score_skills.py <skills-dir>` and use
     the output to prioritize the lowest-scoring, highest-traffic skills.
8. **Refine from execution, not just drafting**
   - Compare with-skill behavior against a baseline when practical.
   - Inspect false triggers, missed triggers, failed assertions, execution
     traces, and human review comments.
   - Generalize from failures; do not overfit descriptions to a few keywords.
9. **Add scripts only with evidence**
   - Add scripts when evals or traces show repeated mechanical work, fragile
     formatting, or validation logic that code can do more reliably than prose.
   - Scripts should be deterministic, self-contained or clearly
     dependency-scoped, non-interactive, and produce agent-friendly errors.
10. **Audit safety and trust boundaries**

- For third-party skills, read every file in the skill folder before import or
  activation when practical.
- Check scripts/references for unexpected network calls, access outside the
  expected scope, prompt injection, typosquatting, and hidden instructions.

11. **Review and save**

- Present draft, eval plan, save path, and key tradeoffs, then write/update
  files.

12. **Learn**

- Persist concise notes on triggers, boundaries, eval outcomes, and why
  scripts/resources were or were not added.

## Skill structure (default)

```text
skill-name/
├── SKILL.md
├── scripts/          (optional)
├── references/       (optional)
├── assets/           (optional)
├── evals/            (optional)
└── ...
```

## When to add scripts

- Evals or traces show the agent repeatedly reinvents the same logic.
- Validation, parsing, transformation, or formatting is more reliable in code
  than prose.
- The workflow needs explicit error handling or machine-checkable verification.

## LLM-aware formatting

Keep active `SKILL.md` files raw-markdown friendly: use headings, lists, tables,
and code blocks as structural signals; avoid decorative bolding and long prose
when concrete examples or validation contracts would be more useful. For a full
formatting cleanup pass, read `references/llm-aware-formatting.md`.

## Output format

- Skill summary
- Generated artifacts (paths + what changed)
- Save location
- Portability target (`local-only|agent-skills-portable`)
- Agent Skills alignment score (weighted total + category breakdown)
- Trigger eval plan (positive + near-miss negatives)
- Output-quality eval plan (if applicable)
- Learnings
- `Result: success|partial|failed`
- `Confidence: 0..1`
