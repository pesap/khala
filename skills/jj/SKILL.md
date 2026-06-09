---
name: jj
description: Operate Jujutsu (jj) in Git-backed repos for parallel task sessions, clean change shaping, and GitHub-friendly publishing. Use when users ask about jj setup, parallel workflows without branch clutter, session switching, split/squash/rebase, or shipping jj work to PRs.
license: MIT
---

## Use when
- User asks to use/learn jj in an existing Git repo.
- User wants parallel local workstreams ("sessions") with low branch overhead.
- User needs jj commands for split/squash/rebase/edit/log/bookmark/push.
- User wants jj + GitHub workflow (publish to branch/bookmark, open PR).

## Avoid when
- User wants generic Git help and did not ask for jj.
- Repo cannot install/use jj and user prefers zero tooling changes.
- Task is unrelated to version control workflow.

## Workflow
1. Confirm repo state and jj availability (`jj --version`, `jj status`).
2. If Git repo only, initialize once with `jj git init`.
3. Create focused changes per task (`jj new`, edit, `jj commit -m ...`).
4. Switch sessions with `jj log` + `jj edit <change-id>`.
5. Shape history as needed (`jj split`, `jj squash`, `jj describe`).
6. Sync and publish (`jj git fetch`, rebase as needed, `jj bookmark create`, `jj git push --bookmark ...`).
7. Submit GitHub PR:
   - Ensure default branch is current (`jj git fetch`; rebase if needed).
   - Push bookmark as branch: `jj bookmark create <name>` then `jj git push --bookmark <name>`.
   - Create PR via CLI: `gh pr create --head <name> --base main --fill`.
   - If `gh` unavailable, open GitHub UI and create PR from `<name>` into `main`.

## Guardrails
- Keep one goal per change.
- Prefer small reversible commits.
- Do not run destructive history operations without explicit approval.
- Call out dirty working copy before risky operations.

## Output
- Current state (repo + jj readiness)
- Exact next commands
- Any risks/conflicts and rollback note
