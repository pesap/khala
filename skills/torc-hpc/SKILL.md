---
name: torc-hpc
version: 0.3.0
description: "Run, debug, and operate Torc workflows across local, remote-worker, and Slurm/HPC modes. Use when users ask how to run Torc locally, use `torc hpc detect` or `torc hpc partitions`, submit Slurm workflows, configure remote workers, use invocation scripts, set `TORC_API_URL`, collect logs/artifacts, debug failed runs, or run a specific code version remotely from an existing checkout/worktree without rsyncing the whole repo."
---

## Use when
- User wants to run a Torc workflow locally for smoke testing or development.
- User wants to detect an HPC profile, inspect partitions, or submit Torc workflows to Slurm/HPC with `torc hpc detect`, `torc hpc partitions`, `torc slurm generate`, and `torc submit`.
- User wants to use or debug Torc remote workers over SSH.
- User is wiring or debugging `invocation_script` wrappers, modules, conda, or `TORC_API_URL`.
- User wants to inspect logs, status, resource data, or failure behavior for Torc runs.
- User wants to run a specific branch/tag/commit remotely from a prepared remote checkout or per-run worktree.
- User needs cleanup guidance for per-run worktrees or temporary refs after versioned remote runs.

## Avoid when
- Task is generic Slurm guidance with no Torc workflow angle.
- Task is solver/model formulation debugging rather than Torc runtime/setup/operations.
- User needs site policy or cluster admin decisions that must come from operators.

## Instructions
1. First isolate the Torc mode:
   - local standalone or local server/client
   - remote workers over SSH
   - Slurm/HPC submission
   - manual remote command fallback
   - versioned remote code execution from a prepared remote checkout/worktree
2. Prefer the smallest runnable smoke test before full workloads.
3. Prefer Torc-native flows over ad hoc shell orchestration:
   - local: `torc -s --in-memory run <workflow>` or documented local server/client flow
   - remote workers: `torc remote ...`
   - Slurm/HPC: `torc slurm generate ... -o <generated>.yaml` then `torc submit <generated>.yaml`
4. Keep site setup in an `invocation_script`, startup script, or job prologue instead of embedding environment setup into every command.
5. For remote/tunneled use, verify the correct `TORC_API_URL` and network reachability before blaming workflow logic.
6. When the user wants to run a specific code version remotely, prefer remote `git fetch` + remote checkout/worktree preparation. Do **not** rsync the whole repo as the primary execution path.
7. Treat `scripts/run-remote.sh` as a remote command runner for an existing remote workdir, not as a repo-sync mechanism.
8. Use preflight checks before launch; use cleanup helpers only when versioned remote runs create temporary worktrees/refs.
9. After failures, inspect Torc-native signals first: workflow/job status, logs, results, resource data, then fallback shell diagnostics.

## Progressive disclosure
Read only what fits the mode:
- `references/runbook.md` — mode-by-mode operating guide: local, remote workers, Slurm, versioned remote runs, cleanup
- `references/failure-signatures.md` — common Torc/HPC failure patterns and fixes
- `scripts/doctor.sh` / `scripts/doctor.cmd` — preflight checks for commands, env vars, and optional remote reachability
- `scripts/run-remote.sh` / `scripts/run-remote.cmd` — fallback manual remote command runner for an existing remote workdir
- `scripts/cleanup-worktree.sh` / `scripts/cleanup-worktree.cmd` — cleanup helper for temporary worktrees/refs in versioned remote runs
- `evals/trigger-prompts.json`, `evals/trigger-prompts-train.json`, `evals/trigger-prompts-validation.json` — trigger QA fixtures for this skill
- `evals/evals.json` — output-quality eval scaffold for mode selection, command choice, and boundary discipline

## Output
- Target Torc mode
- Exact commands/env used
- Blocking dependency or environment gap
- Smallest repro or smoke-test result
- Next fix or verified working path
- Remote artifact/log location when applicable
