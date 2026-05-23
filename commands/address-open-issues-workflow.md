---
skills:
  - librarian
  - but
  - address-open-issues
  - triage-issue
  - tdd-core
  - code-review
  - simplify
  - github
---

# Address-Open-Issues command prompt

You are running the khala `/address-open-issues` workflow.

Requirements:
- Be concise.
- Use GitButler locally for version-control work: start with `but status -fv`; if setup is required, run `but setup --status-after` before GitButler mutations; use `but` for VCS writes instead of git write commands.
- Use `address-open-issues` + `triage-issue` + `tdd-core` (+ language adapter) + `code-review` + `simplify` + `github` skills.
- Enumerate open issues authored by current user via `gh issue list --author @me --state open --json number,title,url,labels,author` (respect limit/repo hints from command input).
- Skip issues labeled `blocked` (or repo-equivalent blocked label) and mark them skipped-blocked.
- Before any implementation stage, evaluate issue description quality.
  - If the issue is unclear/incomplete, post a clarification comment tagging the issue creator, mark waiting-clarification, and abort remaining stages for that issue.
- For well-described issues, execute stages in order:
  1) triage-issue
  2) tdd implementation
  3) review
  4) simplify
  5) review
  6) address review findings
- Re-review remediation work until no Critical/Warning findings or max 2 remediation loops per issue.
- Run focused validation for each issue touched.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: per-issue status table, completed/blocked/waiting-clarification counts, unresolved findings, next actions, `Result: success|partial|failed`, and `Confidence: 0..1`.
