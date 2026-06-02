---
name: but
description: "Commit, push, branch, and manage version control with GitButler. Use when users ask to commit changes, check status, view diffs, create branches, push, open PRs, edit history, squash, amend, undo commits, merge, stash, or run git write operations that should be translated to `but`."
---

# GitButler CLI Skill

Source: GitButler CLI skill, version 0.19.10.

Use GitButler CLI (`but`) as the default version-control interface.

Skill audit line for meaningful GitButler execution:
- `Skill audit: full-read=yes native-path-confirmed=yes fallback-needed=no|yes`
- Use `fallback-needed=yes` only after checking the documented GitButler-native path in this skill and its references.

## Use when
- User asks for local version-control status, diffs, branch creation, commits, pushes, PR publishing, or history edits.
- A workflow mentions GitButler, `but`, or converting git write operations to GitButler-native commands.
- The task may mutate branch, commit, stack, stash, merge, rebase, or remote state.

## Avoid when
- The task is only explaining Git concepts and requires no repository inspection or mutation.
- The current workspace is not a Git repository; report that GitButler cannot operate there.
- The user explicitly asks to use another VCS tool and no GitButler policy applies.

## Non-Negotiable Rules

1. Use `but` for all write operations. Never run `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, `git stash`, or `git cherry-pick`. If the user says a `git` write command, translate it to `but` and run that.
2. Always add `--status-after` to mutation commands.
3. Use CLI IDs from `but status -fv` / `but diff` / `but show`; never hardcode IDs.
4. Start with `but status -fv` before mutations so IDs and stack state are current.
5. Create a branch for new work with `but branch new <name>` when needed.
6. Before shipping or opening a PR, verify the target branch still contains unique work relative to the default branch. If its changes are already merged, do not push or open a duplicate PR.
7. If a target branch is stale or stacked on already-merged work, update from the default branch and rebuild on a fresh branch from the latest mainline instead of stacking new work on the stale branch.
8. If a branch already had a merged PR (especially after squash merge), do not reuse that branch for follow-up work. Create a fresh branch from the latest default branch and move only the intended current diff.
9. Before committing, verify the edited files live in the current repository/worktree, not in an agent-installed skill directory, cache checkout, or other external copy.
10. Never create an unsigned commit. If signing is unavailable, failing, or cannot be confirmed, stop and ask the user for assistance.
11. Do not ship from an existing branch/stack until you prove it is the correct target for this task and does not carry prior unrelated commits.
12. Before reporting ship success, verify the remote PR/branch invariants on the actual forge artifact: one intended commit, default-branch base, verified signature, plain text/markdown body (no HTML), green checks, and mergeable/non-conflicting status.
13. In GitButler workspaces, never push `HEAD` (workspace ref) to a shared remote branch. Push the explicit branch/stack ref (for example `wjc/opt_package_tests`) and verify the remote tip after push. If a `GitButler Workspace Commit` lands on the target branch, immediately repair with `git push --force-with-lease origin <last-good-sha>:refs/heads/<branch>`.

## Core Flow

**Every write task** should follow this sequence.

```bash
# 1. Inspect state and gather IDs
but status -fv

# 2. If new branch needed:
but branch new <name>

# 3. Edit files (Edit/Write tools)

# 4. Refresh IDs if needed
but status -fv

# 5. Perform mutation with IDs from status/diff/show
but <mutation> ... --status-after
```

## Command Patterns

- Commit: `but commit <branch> -m "<msg>" --changes <id>,<id> --status-after`
- Commit + create branch: `but commit <branch> -c -m "<msg>" --changes <id> --status-after`
- Amend: `but amend <file-id> <commit-id> --status-after`
- Reorder commits: `but move <source-commit-id> <target-commit-id> --status-after` (**commit IDs**, not branch names)
- Stack branches: `but move <branch-name-or-id> <target-branch-name-or-id> --status-after` (**branch names or branch CLI IDs**)
- Tear off a branch: `but move <branch-name-or-id> zz --status-after` (`zz` = unassigned; branch name or branch CLI ID)
- Push: `but push` or `but push <branch-id>`
- Pull: `but pull --check` then `but pull --status-after`

## Task Recipes

### Commit files

1. `but status -fv`
2. Confirm the target branch is the correct fresh branch for this scope:
   - based on the latest default branch
   - not already used by a merged PR
   - not carrying unrelated historical commits for this task
3. Find the CLI ID for each file you want to commit.
4. `but commit <branch> -m "<msg>" --changes <id1>,<id2> --status-after`
   Use `-c` to create the branch if it doesn't exist. Omit IDs you don't want committed.
5. **Check the `--status-after` output** for remaining uncommitted changes. If the file still appears as unassigned or assigned to another branch after commit, it may be dependency-locked. See "Stacked dependency / commit-lock recovery" below.
6. Verify the real branch commit, not just `HEAD`, is signed. In GitButler workspaces, `HEAD` can be an unsigned internal `GitButler Workspace Commit` even when the branch commit is correctly signed.

### Commit signing verification

When investigating signing in a GitButler-managed workspace:

1. Inspect real commit signatures with `git log --show-signature --pretty='%h %G? %GS %s' -10`.
2. Do not treat an unsigned `GitButler Workspace Commit` at `HEAD` as proof that branch commits are unsigned; it is an internal virtual-workspace merge commit.
3. Interpret signature status codes: `G` = good signature, `N` = no signature, `U` = signature exists but is not trusted locally.
4. Treat commit signature verification as separate from CI/test verification. `unverified` on a commit is a signing problem unless forge evidence shows otherwise.
5. For SSH signing, verify the effective config includes `commit.gpgsign=true`, `gpg.format=ssh`, `gitbutler.signCommits=true`, a usable key source such as `gpg.ssh.defaultKeyCommand=ssh-add -L`, and a trusted `gpg.ssh.allowedSignersFile`.
6. If GitButler signing fails even with `gpg.ssh.defaultKeyCommand`, set `user.signingKey` explicitly to the SSH public key from `ssh-add -L`.

### Ship target verification

Before commit/push/PR on a GitButler workspace:

1. Use `but status -fv` to list all applied branches/stacks and unassigned changes.
2. Pick exactly one ship target branch/stack.
3. Before concluding a GitButler-native path is missing, read the relevant reference entries (`references/reference.md`, `references/concepts.md`, `references/examples.md`) for the task.
4. Record a short audit in your summary when this skill materially guided execution: `Skill audit: full-read=yes native-path-confirmed=yes fallback-needed=no|yes`.
5. Update and prove the target is fresh for this task:
   - run `but status --upstream` (or `but status -u`) to inspect upstream work on the target branch
   - run `but pull --check` before push/PR to preview whether active branches rebase cleanly onto the latest target branch
   - if upstream work exists and the check passes, run `but pull --status-after` before push/PR so active branches are rebased onto the latest target branch/base
   - if conflicts appear, resolve them with `but resolve <commit-id>`, edit conflicted files, verify with `but resolve status`, then `but resolve finish`
   - unique relative to the latest default branch
   - merge-base with `origin/<default>` is the current default-branch tip for this task, or you have explicitly rebased/rebuilt onto that tip
   - not already used by a merged PR
   - not carrying unrelated historical commits
6. If the target fails any check, stop reusing it. Rebuild on a fresh branch from the latest default branch.
7. Before claiming success, inspect the forge PR/branch and verify:
   - one intended commit
   - correct base = default branch unless user specified otherwise
   - signature verified on the shipped commit
   - no HTML in PR body/final reported body content
   - checks green
   - PR is mergeable / not conflicting

### Amend into existing commit

1. `but status -fv` (or `but show <branch-id>`)
2. Locate file ID and target commit ID.
3. `but amend <file-id> <commit-id> --status-after`

### Reorder commits

`but move` supports both commit reordering and branch stack operations. Use commit IDs when reordering commits.

1. `but status -fv`
2. `but move <commit-a> <commit-b> --status-after` — uses commit IDs like `c3`, `c5`
3. Refresh IDs from the returned status, then run the inverse: `but move <commit-b> <commit-a> --status-after`

### Stack existing branches

To make one existing branch depend on (stack on top of) another, use top-level `move`:

```bash
but move feature/frontend feature/backend
```

This moves the frontend branch on top of the backend branch in one step.

**DO NOT** use `uncommit` + `branch delete` + `branch new -a` to stack existing branches. That approach fails because git branch names persist even after `but branch delete`. Always use `but move <branch> <target-branch>`.

**To unstack** (make a stacked branch independent again):

```bash
but move feature/logging zz
```

**Note:** branch stack/tear-off operations use branch **names** (like `feature/frontend`) or branch CLI IDs, while commit reordering uses commit **IDs** (like `c3`). Do NOT use `but undo` to unstack — it may revert more than intended and lose commits.

### Stacked dependency / commit-lock recovery

A **dependency lock** occurs when a file was originally committed on branch A, but you're trying to commit changes to it on branch B. Symptoms:
- `but commit` succeeds but the file still appears in `unassignedChanges` in the `--status-after` output
- The file shows as "unassigned" instead of being staged to any branch

**Recovery:** Stack your branch on the dependency branch, then commit:

1. `but status -fv` — identify which branch originally owns the file (check commit history).
2. `but move <your-branch-name> <dependency-branch-name>` — stack your branch on the dependency. Uses full branch **names**, not CLI IDs.
3. `but status -fv` — the file should now be assignable. Commit it.
4. `but commit <branch> -m "<msg>" --changes <id> --status-after`

**If `but move <branch> <target-branch>` fails:** Do NOT try `uncommit`, `squash`, or `undo` to work around it — these will leave the workspace in a worse state. Instead, re-run `but status -fv` to confirm both branches still exist and are applied, then retry with exact branch names from the status output.

### Resolve conflicts after reorder/move

**NEVER use `git add`, `git commit`, `git checkout --theirs`, `git checkout --ours`, or any git write commands during resolution.** Only use `but resolve` commands and edit files directly with the Edit tool.

If `but move` causes conflicts (conflicted commits in status):

1. `but status -fv` — find commits marked as conflicted.
2. `but resolve <commit-id>` — enter resolution mode. This puts conflict markers in the files.
3. **Read the conflicted files** to see the `<<<<<<<` / `=======` / `>>>>>>>` markers.
4. **Edit the files** to resolve conflicts by choosing the correct content and removing markers.
5. `but resolve finish` — finalize. Do NOT run this without editing the files first.
6. Repeat for any remaining conflicted commits.

**Common mistakes:** Do NOT use `but amend` on conflicted commits (it won't work). Do NOT skip step 4 — you must actually edit the files to remove conflict markers before finishing.

## Git-to-But Map

| git | but |
|---|---|
| `git status` | `but status -fv` |
| `git add` + `git commit` | `but commit ... --changes ...` |
| `git checkout -b` | `but branch new <name>` |
| `git push` | `but push` |
| `git rebase -i` | `but move`, `but squash`, `but reword` |
| `git rebase --onto` | `but move <branch> <new-base>` |
| `git cherry-pick` | `but pick` |

## Notes

- Prefer explicit IDs over file paths for mutations.
- `--changes` accepts comma-separated values (`--changes a1,b2`) or repeated flags (`--changes a1 --changes b2`), not space-separated.
- Read-only git inspection (`git log`, `git blame`, `git show --stat`) is allowed.
- After a successful `--status-after`, don't run a redundant `but status -fv` unless you need new IDs.
- Use `but show <branch-id>` to see commit details for a branch, including per-commit file changes and line counts.
- **Per-commit file counts**: `but status` does NOT include per-commit file counts. Use `but show <branch-id>` or `git show --stat <commit-hash>` to get them.
- For ship/review tasks, pair GitButler inspection with git/forge checks when needed: compare the target branch against `origin/<default-branch>` (`git cherry`, `git log origin/<default>..<branch>`, PR lookup) to catch stale or already-merged branches.
- Treat a merged PR on the same head branch as a branch-reuse hazard. After squash merge, Git ancestry may still show old commits on the branch even though the diff was merged; rebuild follow-up work on a fresh branch.
- If `but status -fv` is broken or incomplete in a workspace, treat that as degraded mode: use `but branch list`, `but branch show`, and read-only git/forge inspection, then call out the limitation explicitly.
- Avoid `--help` probes; use this skill and `references/reference.md` first. Only use `--help` after a failed attempt.
- Run `but skill check` only when command behavior diverges from this skill, not as routine preflight.
- For command syntax and flags: `references/reference.md`
- For workspace model: `references/concepts.md`
- For workflow examples: `references/examples.md`
