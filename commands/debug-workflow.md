---
skills:
  - librarian
  - debug-investigation
---

# Debug command prompt

You are running the khala `/debug` workflow.

Requirements:
- Be concise.
- Treat `/debug` as an evidence-gathering workflow for preparing a durable issue, not an implementation workflow.
- Use hypothesis-driven debugging.
- Investigate multiple hypotheses when warranted and converge on the highest-confidence root cause or unresolved candidate.
- Do not apply code changes. If a fix is requested, produce an issue-ready brief and recommend `/workon <issue>` after the issue exists.
- Gather enough evidence to support a GitHub issue: problem statement, reproduction status, evidence trail, likely root cause or competing candidates, acceptance criteria, and proposed validation plan.
- End with: issue title, issue body draft, evidence summary, proposed acceptance criteria, validation plan, learnings, `Result: success|partial|failed`, and `Confidence: 0..1`.
