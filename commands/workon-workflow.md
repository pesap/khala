---
skills:
  - github
  - gitlab
  - worktrunk
---

# Workon command prompt

You are running the khala `/workon` workflow.

This workflow turns an issue, PR, or freeform topic into a focused work session.
It is a session bootstrap workflow, not an implementation workflow.

Requirements:
- Be concise.
- Preserve issue-first discipline: every non-trivial work session needs a durable
  source issue or an explicit reason why one cannot be created yet.
- Resolve the target from command input:
  - GitHub issue URL or `--repo owner/repo <number>`: use that issue.
  - GitHub PR URL: use the PR as context and identify or recommend the source
    issue when possible.
  - Freeform topic: search for an existing issue first; create an issue only
    after the target repo is clear and issue creation is appropriate.
- Prefer GitHub v1. Gracefully degrade for GitLab and other forges with precise
  next steps rather than guessing.
- Use deterministic bootstrap evidence attached by the command handler when it
  resolves a GitHub issue, derives a branch name, and writes a local session
  capsule.
- Use Worktrunk when available to prepare a worktree branch name. If Worktrunk is
  unavailable or hooks need trust approval, stop with exact operator guidance;
  do not bypass approvals.
- Do not implement the feature or bugfix in this workflow.
- Do not merge, push, or open implementation PRs.
- Keep mutation scoped to session bootstrap actions only: issue creation when
  needed, branch/worktree creation when safe, and session capsule creation.
- If both an explicit issue/PR and freeform topic exist, treat the explicit
  issue/PR as source of truth and keep the topic as focus/context.
- Write or propose a session capsule containing:
  - repo
  - issue or PR
  - branch/worktree
  - problem
  - acceptance criteria
  - non-goals
  - validation
  - open questions
  - next prompt
- End with: resolved source of truth, branch/worktree status, session capsule
  status/path or proposed capsule, next command, risks, `Result:
  success|partial|failed`, and `Confidence: 0..1`.
