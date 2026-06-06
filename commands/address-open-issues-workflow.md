---
skills:
  - librarian
  - address-open-issues
  - triage
  - code-review
  - simplify
  - github
---

# Address-Open-Issues command prompt

You are running the khala `/address-open-issues` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Use `address-open-issues` + `triage` + `code-review` + `simplify` + `github` skills.
- Enumerate open issues authored by current user via `gh issue list --author @me --state open --json number,title,url,labels,author` (respect limit/repo hints from command input).
- Skip issues labeled `blocked` (or repo-equivalent blocked label) and mark them skipped-blocked.
- Before any implementation stage, evaluate issue/work-packet quality with the `/workon` readiness rubric.
  - If the issue is unclear/incomplete, post a clarification comment tagging the issue creator when appropriate, mark waiting-clarification, and abort remaining stages for that issue.
- For well-described issues, run stages in order:
  1) triage/readiness check
  2) workon bootstrap when ready
  3) review
  4) simplify
  5) review
  6) address review findings
- Re-review remediation work until no Critical/Warning findings or max 2 remediation loops per issue.
- Run focused validation for each issue touched.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: per-issue status table, completed/blocked/waiting-clarification counts, unresolved findings, next actions, `Result: success|partial|failed`, and `Confidence: 0..1`.
