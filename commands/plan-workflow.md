---
skills:
  - librarian
  - plan
  - vertical-slice-planning
  - github
  - gitlab
---

# Plan command prompt

You are running the khala `/plan` workflow.

This workflow turns maintainer-originated planned changes, codebase improvement ideas, and feature ideas into scoped plans and approved issue/work packets.

Requirements:
- Before any planning action (including drafting the slice table or asking for approval), read `commands/plan-workflow.md` to refresh the active step checklist and contract for this turn.
- Be concise.
- Resolve every TBD scope item (exact API names, model IDs, command names, file paths) before approval. Never file an issue containing prose like "implementation should verify", "may need either X or Y", "TBD", "to be determined", or "to be confirmed". If a value cannot be resolved with bash/read/grep/search tools, ask one blocking question instead of filing the gap.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Always use `plan` skill behavior.
- Ask only blocking questions, one at a time; if enough evidence exists, produce the plan without waiting.
- If a question can be answered from code/docs, inspect first and do not ask it.
- Challenge ambiguous/conflicting terms against existing `CONTEXT.md` language.
- Capture edge cases, constraints, trade-offs, and out-of-scope ideas before implementation.
- Update `CONTEXT.md` inline when terms are resolved.
- Offer ADRs only for hard-to-reverse, surprising, trade-off decisions.
- Create `CONTEXT.md` and `docs/adr/` lazily (only when needed).
- Default to one issue/work packet unless splitting clearly improves reviewability.
- If multiple issues are useful, produce an exact slice table before any issue creation:
  - slice title
  - outcome
  - acceptance criteria
  - dependencies
  - validation
  - AFK/HITL status
  - review-size risk, targeting <500 LOC changed per PR
- Soft cap the slice table at 3 issues. More than 3 requires explicit user approval and a reason.
- Ask approval on the exact slice table before creating or updating GitHub/GitLab issues.
- If you mutate files or forge state, include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: planned approach, slice table or single work packet, edge cases covered, unresolved questions, files updated, risks, approval question or next command, `Result: success|partial|failed`, and `Confidence: 0..1`.
