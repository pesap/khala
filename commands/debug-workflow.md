---
skills:
  - librarian
  - debug-investigation
  - github
---

# Debug command prompt

You are running the khala `/debug` workflow.

This workflow investigates a maintainer-observed, unreported symptom and prepares a new issue proposal. It is not for existing GitHub issue intake; use `/triage <issue-url>` for that.

Requirements:
- Be concise.
- Treat `/debug` as evidence gathering for an unreported problem, not implementation.
- If the input is a GitHub issue URL, stop and redirect to `/triage <issue-url>`.
- Build a reproduction or observable feedback loop first when possible.
- Use hypothesis-driven debugging and rank hypotheses by evidence strength.
- Investigate multiple hypotheses when warranted and converge on the highest-confidence root cause or unresolved candidate.
- Do not apply code changes.
- Draft a new GitHub issue only when evidence justifies it.
- The issue draft must include problem statement, reproduction status, evidence trail, likely root cause or competing candidates, acceptance criteria, non-goals, validation plan, and `/workon` readiness notes.
- Ask explicit approval before creating the GitHub issue.
- If approved, create the issue with safe body-file tooling and report the issue URL.
- End with: issue title, issue body draft or created issue URL, evidence summary, acceptance criteria, validation plan, `/workon` readiness notes, learnings, `Result: success|partial|failed`, and `Confidence: 0..1`.
