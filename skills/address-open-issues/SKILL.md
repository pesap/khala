---
name: address-open-issues
description: >
  Resolve the caller's open GitHub issues in sequence: triage, TDD
  implementation, design-quality-review, and remediation. Use when users ask to
  sweep their open issues and close as many as possible safely.
license: MIT
---

## Use when

- User asks to address all open issues authored by them.
- User wants a repeatable issue-sweep workflow with review loops.
- User wants orchestration across triage, implementation, and cleanup.

## Avoid when

- Repo is not connected to GitHub or `gh` access is unavailable.
- User wants to work on a single issue only.

## Workflow

1. List open issues authored by the current user
   (`gh issue list --author @me --state open`).
2. Skip issues labeled `blocked` (or equivalent blocked label in the repo) and
   mark them as skipped-blocked.
3. For each remaining issue, check description quality first.
   - If description is unclear/incomplete, add a clarification comment tagging
     the issue creator, mark waiting-clarification, and stop further stages for
     that issue.
4. For well-described issues, run stages in order:
   - triage-issue
   - tdd (via `tdd-core` + language adapter)
   - design-quality-review
   - address review findings
5. Re-review with `design-quality-review` after remediation until no blocking
   findings (severity 0 or 1 in any dimension) or iteration limit reached.
6. Track per-issue status: completed, blocked, waiting-clarification, deferred,
   failed.

- Issue processing table (URL, stage, status)
- Completed vs blocked vs waiting-clarification summary
- Clarification comments posted (issue + requested details)
- Review findings addressed and remaining
- Validation evidence and next actions
