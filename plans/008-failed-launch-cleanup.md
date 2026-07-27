# Plan 008: Clean up sandboxes after failed launches

> **Executor instructions**: Clean only sandboxes that fail before a session is successfully launched. Preserve successfully launched sandboxes until an explicit retention policy exists.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/executor.ts src/vcs.ts src/vcs-git-worktree.ts src/khala-work.ts src/khala-observer.ts src/khala-executor.ts test/khala.test.js` — expected: no output.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: resource | bug
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The starter creates a Git worktree before invoking tmux/Zellij. If the launcher or registration callback fails, the caller marks the execution failed or requeues Work but never removes the newly-created worktree or branch. Repeated failed launches can accumulate orphaned sandboxes and branches.

## Current state

- `src/executor.ts:34-45` creates a Sandbox, calls `onSandboxCreated`, then launches the process; it has no cleanup hook.
- `src/vcs.ts:3-8` exposes only `createSandbox`.
- `src/vcs-git-worktree.ts:24-61` creates a worktree and branch but has no removal method.
- `src/khala-work.ts:257-263` handles launch failure by updating execution state and requeueing only.
- `src/khala-observer.ts:106-113` similarly marks a failed Observer without cleanup.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Git inspection | `git worktree list` | no unexpected test worktrees remain |

## Scope

**In scope**:
- `src/executor.ts`
- `src/vcs.ts`
- `src/vcs-git-worktree.ts`
- launch callers and factories
- tests

**Out of scope**:
- Automatic deletion of successfully launched Executor sandboxes
- User-facing sandbox retention UI
- Non-Git VCS providers not present in this repository

## Steps

### Step 1: Define ownership and cleanup tests

Add fake VCS and Launcher implementations to test the starter. Cover: sandbox creation then launcher failure invokes cleanup; callback failure invokes cleanup; successful launch does not invoke cleanup; cleanup failure preserves the original launch error and is reported.

**Verify**: new tests fail against the current starter because no cleanup occurs.

### Step 2: Add an explicit VCS cleanup capability

Extend the provider-neutral Sandbox/VCS contract with the smallest explicit cleanup operation. Carry enough provider-owned identity to remove the exact created worktree and branch; do not reconstruct branch names from arbitrary user input at the caller.

**Verify**: `npm run check` exits 0 and fake-provider tests compile.

### Step 3: Implement Git worktree cleanup

Implement cleanup using argv-based Git execution, matching the existing `execFile` safety pattern in `src/vcs-git-worktree.ts`. Remove the worktree and its generated branch only for a sandbox created by this launch attempt. Avoid deleting an existing path; creation already rejects one.

**Verify**: an integration test in a temporary Git repository confirms a failed launch leaves no created worktree/branch; `git worktree list` returns only the original worktree.

### Step 4: Make the starter transactional

Wrap registration and launcher launch so any pre-success failure invokes cleanup exactly once, then rethrows the original error with cleanup failure context if necessary. Keep successful launch behavior and Archive status handling unchanged.

**Verify**: `npm test` and `npm run check` exit 0.

## Test plan

Test fake providers for all transaction branches and one real temporary Git worktree cleanup. Ensure cleanup does not run after `Launcher.launch` resolves, even if later status persistence fails; that case needs a separate retention/reconciliation policy.

## Done criteria

- [ ] Pre-launch failures clean their newly-created sandbox.
- [ ] Successful launches retain their sandbox.
- [ ] Cleanup failure never hides the original failure.
- [ ] Git worktree and branch cleanup is tested.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if the desired product behavior is to retain failed pre-launch sandboxes for inspection; document that policy instead of deleting them.
- Stop if cleanup cannot identify the exact created branch safely.
- Stop if a second VCS implementation appears and its cleanup semantics are unknown.

## Maintenance notes

A later sandbox-retention feature should build on explicit lifecycle states rather than reusing pre-launch cleanup. Review cleanup errors carefully because they affect developer recovery and repository integrity.
