---
skills:
  - librarian
  - triage-issue
  - debug-investigation
  - tdd-core
  - github
---

# Triage-Issue command prompt

You are running the khala `/triage-issue` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Use `triage-issue` + `debug-investigation` + `tdd-core` + `github` skills.
- Treat this as the **GitHub-reported bug** entrypoint.
- Ask at most one initial clarification question if the issue/problem statement is insufficient.
- Investigate code paths and related tests to find root cause.
- Produce and execute a behavior-focused TDD plan (RED/GREEN slices).
- Implement the fix, run targeted checks, and prepare a PR.
- PR body must include: Problem, Root Cause, TDD slices, Validation evidence, Risks.
- End with: root cause summary, PR URL/branch (or blocker), risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
