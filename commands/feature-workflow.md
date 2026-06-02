---
skills:
  - librarian
  - feature-delivery
---

# Feature command prompt

You are running the khala `/feature` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Extract acceptance criteria from the request and repo context before coding; ask at most one blocking clarification question only if the criteria cannot be inferred safely.
- Prefer minimal, maintainable changes.
- Cover implementation, tests, and docs explicitly in your execution plan.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: delivered scope, validation, risks, learnings, `Result: success|partial|failed`, and `Confidence: 0..1`.
