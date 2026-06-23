---
skills:
  - github
  - gitlab
  - worktrunk
---

# Workon command prompt

You are running the khala `/workon` workflow.

This workflow starts or prepares autonomous work from a clear, approved issue/work packet. It is a session bootstrap workflow, not a planning or implementation workflow.

Requirements:
- Before any workon action (including reporting readiness or recovery), read `commands/workon-workflow.md` to refresh the active step checklist and contract for this turn.
- Be concise.
- Accept only an issue URL or issue number. Use `/plan` for maintainer ideas and `/triage` for user-posted issue intake before `/workon`.
- Preserve issue-first discipline: every autonomous work session needs a durable source issue.
- Prefer GitHub v1. Gracefully degrade for GitLab and other forges with precise next steps rather than guessing.
- Default `/workon <issue>` behavior is start mode.
- Treat `--dry-run` as the explicit planning-only no-launch mode: resolve the issue, derive the branch, write/update the capsule, and report the suggested Worktrunk command without starting Worktrunk, Zellij, Pi, or the forge heartbeat.
- Treat `--heartbeat` and `--interval` as equivalent decimal-hour aliases for the forge feedback heartbeat.
- Run the autonomous readiness rubric before starting:
  - reproduction or observable behavior is clear
  - validation/tests are specified, with behavior/regression validation for bugs
  - acceptance criteria are narrow and useful
  - repo guidelines and relevant constraints are acknowledged
  - breaking-change risk is absent or explicitly resolved
  - scope is likely reviewable, targeting <500 LOC changed per PR
  - the work is worth doing now rather than deferring
  - if the issue has an `improve` plan body, its drift check is runnable and its `Workon readiness` section says `Ready for /workon: yes`
- If the readiness rubric fails, do not create a worktree, Pi session, heartbeat, or GitHub comment. Return only concrete action items needed to make the issue `/workon`-ready.
- Use deterministic bootstrap evidence attached by the command handler when it resolves a GitHub issue, derives a branch name, writes a global Pi capsule, and in start mode runs Worktrunk first, waits for the Worktrunk-created Zellij tab, launches Pi in that tab, and starts the forge feedback heartbeat when Zellij is available. Do not spend model/tool tokens recreating issue, branch, capsule, Zellij, or heartbeat evidence the handler already supplied.
- Use Worktrunk when available to prepare or start the worktree. If Worktrunk is unavailable or hooks need trust approval, stop with exact operator guidance; do not bypass approvals.
- Do not redefine issue scope.
- Do not merge, push, or open implementation PRs from this bootstrap workflow.
- Keep mutation scoped to session bootstrap actions only: branch/worktree creation in start mode when safe and session capsule creation.
- Store the active session capsule globally under `~/.pi/khala/github.com/<owner>/<repo>/capsule.md`.
- Write or propose a session capsule containing repo, issue, branch/worktree, problem, acceptance criteria, non-goals, validation, open questions, current readiness status, draft PR and forge heartbeat instructions, and next prompt.
- End with: readiness status, resolved source of truth, branch/worktree status, session capsule status/path or action items, next command, risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
