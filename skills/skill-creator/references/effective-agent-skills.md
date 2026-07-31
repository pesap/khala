# Effective agent skills checklist

Use this reference for deep reviews, third-party imports, and debugging why a
skill did not trigger or execute well.

Source inspiration: David Ondrej `effective-agent-skills` at
`davidondrej/skills@ce70edaa26247b84c2b9491a0cdb4964f65cf3a5`.

## Core model

- Description routes; body executes.
- Files are cheap; context is scarce. Keep `SKILL.md` lean and move rarely used
  detail into one-hop references.
- Determinism belongs in scripts. Judgment belongs in markdown procedures.
- One skill should cover one capability or one discipline.
- Skills are code: review, test, version, and audit them.

## Pattern choice

| Pattern              | Use when                                                 | Reliability source                          |
| -------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Capability primitive | The agent cannot do a concrete operation without tooling | Deterministic CLI/script examples           |
| Process primitive    | The agent performs the task poorly or inconsistently     | Explicit method, checklist, validation loop |

Avoid combining both into a large framework unless the user explicitly wants a
workflow suite.

## Description audit

A strong description has:

1. What the skill does.
2. When to use it, including phrases users actually say.
3. Differentiator from nearby skills.

Do not put step-by-step workflow summaries in the description. If the workflow
is summarized there, agents may follow the summary and skip loading the body.

## Body audit

Keep instructions concrete and agent-facing:

- Prefer command examples and exact output shapes over prose.
- Add setup/state checks before action.
- Add failure recovery for every likely failure point.
- Add verify/fix/re-verify loops where output quality is checkable.
- Link references directly from `SKILL.md`; avoid nested reference chains.
- Document interfaces between skills when one skill produces artifacts another
  consumes.

Remove or avoid:

- Generic tutorials the model already knows.
- Human-facing README/changelog/install-guide material.
- Time-sensitive claims that will rot.
- Absolute paths; use relative paths or runtime placeholders.
- Style-only tone preferences.
- Bundled third-party library source.

## Test plan

For important skills, prepare:

- 8-10 should-trigger prompts with varied phrasing.
- 8-10 should-not-trigger near misses.
- 3-5 execution evals that check the output or changed files.
- At least one weak-model/manual smoke test when reliability matters.

Debug failures by category:

- Routing failure: description is likely too vague, too broad, or missing user
  trigger language.
- Execution failure: body lacks concrete steps, examples, state checks, or
  validation.
- Over-trigger: description lacks boundaries or differentiator from nearby
  skills.

## Third-party safety audit

Before importing or activating unfamiliar skills:

- Read every file in the skill folder.
- Inspect scripts for network calls, filesystem access outside expected scope,
  command execution, and secret handling.
- Check references for prompt-injection text such as instructions to ignore
  higher-priority rules.
- Verify the skill name is not typosquatting a known skill.
- Pin attribution/source to a specific commit when possible.
