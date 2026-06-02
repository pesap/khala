---
name: commit
description: "Create one intentional Git commit with a concise Conventional Commits-style message and verified scope. Use when users ask to commit current changes, commit selected files, write a commit message, or prepare a local commit without pushing."
---

Create a Git commit for the current changes using a concise Conventional Commits-style subject.

## Avoid when

- User asks to push, open a PR, merge, or publish without explicitly committing; use the broader VCS workflow first.
- The working tree contains unrelated ambiguous changes and the user did not specify scope.
- Commit signing cannot be verified; stop for user assistance before creating the commit.

## Tool

`commit-check.sh` — validates commit message format with commitizen via uvx.

## Format

`<type>(<scope>): <summary>`

- `type` REQUIRED. Use `feat` for new features, `fix` for bug fixes. Other common types: `docs`, `refactor`, `chore`, `test`, `perf`.
- `scope` OPTIONAL. Short noun in parentheses for the affected area (for example `api`, `parser`, `ui`).
- `summary` REQUIRED. Short, imperative, <= 72 chars, no trailing period.

## Notes

- Body is OPTIONAL. If needed, add a blank line after the subject and write short paragraphs.
- Do NOT include breaking-change markers or footers.
- Do NOT add sign-offs (no `Signed-off-by`).
- Never create an unsigned commit. If commit signing is unavailable, failing, or unclear, stop and request user assistance before committing.
- Treat commit signature verification separately from CI/test verification. `unverified` on a commit means a signing problem until proven otherwise.
- Only commit; do NOT push.
- Commit only repo-local changes from the current working tree. If edits landed in an agent-installed skill, cache checkout, or any path outside the current repo, stop and fix scope before committing.
- Do not reuse a branch that already had a merged PR for follow-up work. If the current branch was previously merged or carries historical commits outside the intended scope, stop and create a fresh branch from the latest default branch first.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance. Common patterns:
  - Freeform instructions should influence scope, summary, and body.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Confirm the files to commit are inside the current repository/worktree and match the user's intended scope.
3. Run bounded Git state and diff commands to understand the current changes (limit to argument-specified files if provided).
4. Confirm the target branch is fresh for this task: based on the latest default branch and not already used by a merged PR.
6. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
7. If there are ambiguous extra files, or the requested edits are not present in the repo-local diff, ask for clarification before committing.
8. Verify commit signing is configured and working for this repo/worktree. If signing cannot be confirmed, stop and ask for assistance.
9. Confirm the target commit set is exactly the intended scope for this PR: one logical change, no inherited historical commits, and no reused merged-branch history.
9. Stage only the intended files/hunks and create the commit with `git commit -m "<subject>"` (add body paragraphs if needed).

## Validation

```bash
TOOL=skills/commit/commit-check.sh
$TOOL                # checks HEAD^!
$TOOL HEAD~3..HEAD   # checks a custom range
```
