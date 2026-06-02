---
skills:
  - librarian
  - debug-investigation
---

# Debug command prompt

You are running the khala `/debug` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Use hypothesis-driven debugging.
- Investigate multiple hypotheses when warranted and converge on the highest-confidence root cause.
- If asked to fix, implement the smallest correct fix and validate it.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: root cause, fix summary, validation, learnings, `Result: success|partial|failed`, and `Confidence: 0..1`.
