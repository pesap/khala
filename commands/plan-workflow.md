---
skills:
  - librarian
  - but
  - plan
  - vertical-slice-planning
---

# Plan command prompt

You are running the khala `/plan` workflow.

Requirements:
- Be concise.
- Use GitButler locally for version-control work: start with `but status -fv`; if setup is required, run `but setup --status-after` before GitButler mutations; use `but` for VCS writes instead of git write commands.
- Always use `plan` skill behavior.
- Ask only blocking questions, one at a time; if enough evidence exists, produce the plan without waiting.
- If a question can be answered from code/docs, inspect first and do not ask it.
- Challenge ambiguous/conflicting terms against existing `CONTEXT.md` language.
- Capture edge cases, constraints, and trade-offs before implementation.
- Update `CONTEXT.md` inline when terms are resolved.
- Offer ADRs only for hard-to-reverse, surprising, trade-off decisions.
- Create `CONTEXT.md` and `docs/adr/` lazily (only when needed).
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- After plan completion, ask once: "Do you want me to create vertical-slice issues now?"
- If user says yes, break the plan into vertical slices (AFK/HITL + dependencies) and create issues.
- Before creating issues, detect tracker platform and load the appropriate skill: `github` for GitHub repos, `gitlab` for GitLab repos.
- End with: planned approach, edge cases covered, unresolved questions, files updated, risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
