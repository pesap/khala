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
2. **Choose portability target and save path**
   - Decide whether this is a local-only skill or an Agent Skills–portable
     skill.
   - Confirm the exact target directory before mutation; the frontmatter `name`
     should match the directory basename.
   - When portability matters, follow the Agent Skills spec and standard layout.
3. **Draft skill artifacts**
   - Create/update `SKILL.md` with concise operational instructions.
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
   - Focus on user intent, including implicit phrasing and near-synonyms.
   - Include optional frontmatter only when justified: `license`,
     `compatibility`, `metadata`, `allowed-tools`.
5. **Apply progressive disclosure**
   - Keep `SKILL.md` short and high-signal.
   - Put detailed references in `references/REFERENCE.md` or other focused
     files.
   - Tell the agent when to read each extra file; do not dump all detail into
     `SKILL.md`.
6. **Design evaluation plan**
   - Trigger evals: prepare realistic should-trigger and should-NOT-trigger
     prompts.
   - Prefer a broader eval set (about 8-10 positive and 8-10 negative prompts)
     when refining an important skill.
   - Include phrasing variation, implicit-intent prompts, and near-miss
     negatives.
   - If reliability matters, split trigger prompts into train/validation sets.
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
10. **Review and save**

- Present draft, eval plan, save path, and key tradeoffs, then write/update
  files.

11. **Learn**

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

LLMs read raw markdown, not rendered output. Every `**` pair adds 2 tokens with
no visual benefit to the model. Use formatting intentionally:

**Strong structural signals (always use):**

- `##` / `###` headings for document hierarchy
- `-` / `1.` list markers for sequences
- `|` tables for lookup data (severity, thresholds, trigger maps)
- Code blocks for output templates

**Marginal signals (use sparingly, only at first occurrence):**

- `**term**` for the first definition of a key concept
- `**code**` for verdict labels (Approved/Rejected) and lookup keys (C0/C1)
- One bolded procedural command per section when it is truly critical

**Waste (never use):**

- Bold in table cells — the `|` delimiter already provides structure
- Bold on list-item labels — the list marker already separates label from value
- Bold for prose emphasis ("do **not** do this")
- Bold on repeated mentions of already-defined terms
- Bold on column headers in tables

**Token cost awareness:** Each `**text**` costs 2 more tokens than `text`. Over
a 200-line skill, aggressive bolding can waste 50-80 tokens with zero semantic
gain. Those tokens are better spent on concrete examples or sharper
instructions.

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
