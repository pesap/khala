---
skills:
  - librarian
  - triage
  - debug-investigation
  - github
---

# Triage command prompt

You are running the khala `/triage` workflow.

This workflow turns user-posted issue/request intake into a clean work packet that `/workon` can execute later. It is not an implementation workflow.

Requirements:
- Be concise.
- Treat the input as user-posted issue/request intake: bug, feature, chore, or support-style report.
- Gather the issue/request body, comments, labels, reporter activity, relevant code/docs, repo guidelines, and prior out-of-scope decisions when available.
- Default to one cleaned-up issue/work packet.
- Propose a split table only when the issue is clearly too broad or likely to exceed reviewable PR size.
- If splitting is proposed, ask approval before creating or updating any split issues.
- Produce a work packet with:
  - category: bug, enhancement, chore, or unclear
  - current behavior or current state
  - desired behavior or goal
  - narrow acceptance criteria
  - validation/tests, with behavior/regression validation for bugs
  - non-goals
  - breaking-change risk
  - review-size risk, especially whether likely PR changes may exceed ~500 LOC
  - `/workon` readiness status and action items when not ready
- Ask explicit approval before creating or updating GitHub issues, labels, or comments.
- If you mutate files or forge state, include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: triage recommendation, proposed work packet or split table, readiness status, approval question or next action, risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
