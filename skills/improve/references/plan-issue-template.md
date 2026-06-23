# Plan Issue Template

Use this template when writing a GitHub or GitLab issue body for an improve generated work packet. The issue IS the plan. There is no local plan file.

The canonical `/workon-ready` headings are owned by `extensions/commands/workon-ready-packet.ts`. If this file drifts from that contract, the TypeScript contract wins.

A ready packet has three properties:

1. **Self-contained context** — paths, code excerpts, conventions, commands, and relevant evidence are in the issue body.
2. **Verification gates** — acceptance criteria and validation commands are machine-checkable.
3. **Hard boundaries** — in-scope paths, non-goals, and STOP conditions prevent executor improvisation.

---

## Template

```markdown
# <Imperative title — what will be true after this issue lands>

> **Executor instructions**: Follow this issue step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition is true, stop and report instead of improvising.
>
> **Drift check (run first)**: `git diff --stat <planned-at SHA>..HEAD -- <in-scope paths>`
> If any in-scope file changed since this issue was written, compare the
> Current behavior excerpts against live code before proceeding. If they do not
> match, stop and ask for `/plan` to refresh this issue.

## Status

- **Priority**: P1 | P2 | P3
- **Effort**: S | M | L
- **Risk**: LOW | MED | HIGH
- **Depends on**: #<issue-number> (or "none")
- **Category**: bug | security | perf | tests | tech-debt | migration | dx | docs | direction
- **Planned at**: commit `<short SHA>`, <YYYY-MM-DD>

## Current behavior

Describe the current observable behavior or current code shape. Include short
code excerpts with `file:line` markers so the worker can verify it is looking at
the same code.

Example:

- `src/orders/api.ts` — order-list endpoint; contains the N+1 around lines 130–160.

```ts
// src/orders/api.ts:130-160
<short excerpt>
```

## Desired behavior or Goal

Describe exactly what should be true after the work lands. Include why it matters
and which users or maintainers benefit.

## Acceptance criteria

Plain markdown bullets only. Do not use task-list checkboxes here.

- <observable criterion the worker and reviewer can verify>
- <behavioral or structural criterion>
- <scope criterion, if needed>

## Validation plan

Each bullet is an exact command or check with expected result.

- `<typecheck command>` exits 0.
- `<focused test command>` passes and includes coverage for <case>.
- `<lint command>` exits 0, if relevant.

## Non-goals

- Do not modify `<path>` because <reason>.
- Do not change public response shape because <reason>.
- Do not address <related but separate concern>; file a follow-up if discovered.

## Breaking-change risk

State the risk explicitly. Use `absent`, `low`, or `resolved` when applicable.

Example: `Absent. The public API response shape is unchanged.`

## Review-size risk

State whether the work is expected to stay under about 500 changed lines. If not,
split the packet before publishing.

Example: `Low. Scope is limited to two source files and one focused test file.`

## /workon readiness notes

- **AFK/HITL**: AFK | HITL — <why>
- **Ready for /workon**: yes | no — <one-sentence reason>
- **Repo constraints**: <important conventions from actual code>
- **STOP conditions**:
  - Current behavior excerpts do not match live code after the drift check.
  - A validation command fails twice after a reasonable fix attempt.
  - The fix appears to require touching an out-of-scope path.
  - The assumption `<key assumption>` is false.

## Implementation notes

Optional but recommended for improve generated issues. Keep this section precise.

### Scope

**In scope**:
- `src/orders/api.ts`
- `src/orders/api.test.ts` (create)

**Out of scope**:
- `src/orders/legacy-api.ts` — deprecated path, scheduled for deletion.

### Suggested steps

1. <precise first step>
   - Verify: `<command>` -> <expected result>
2. <precise second step>
   - Verify: `<command>` -> <expected result>

### Test details

- New tests to write, in which file, covering which cases.
- Existing test file to model after, if relevant.

### Maintenance notes

- What future changes will interact with this.
- What a reviewer should scrutinize in the PR.
- Follow-ups explicitly deferred out of this issue.
```

---

## Quality Bar Before Publishing

- The issue has every canonical `/workon-ready` heading from `extensions/commands/workon-ready-packet.ts`.
- `Acceptance criteria` uses plain bullets, not task-list checkboxes.
- `Validation plan` contains exact commands or checks with expected results.
- `Non-goals`, `Breaking-change risk`, `Review-size risk`, and `/workon readiness notes` are explicit.
- `Ready for /workon: yes` is true and justified.
- The drift check is present and its path list matches the in-scope paths.
- No unresolved `TBD`, `to be confirmed`, `implementation should verify`, or similar deferral remains in the substantive body.
- No secret values appear anywhere. Use only locations and credential types.
