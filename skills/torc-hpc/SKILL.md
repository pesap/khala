---
name: torc-hpc
version: 0.4.4
description: "Run, debug, and operate Torc workflows across local, remote-worker, and Slurm/HPC modes. Use when users ask how to run Torc locally, submit Slurm workflows, configure remote workers, use invocation scripts, set `TORC_API_URL`, collect logs/artifacts, debug failed runs, run a specific code version remotely from an exact Git SHA/worktree, or handle HPC Git/LFS/module issues without rsyncing the whole repo."
---

## Use when
- User wants to run a Torc workflow locally for smoke testing or development.
- User wants to detect an HPC profile, inspect partitions, or submit Torc workflows to Slurm/HPC with `torc hpc detect`, `torc hpc partitions`, `torc slurm generate`, and `torc submit`.
- User wants to use or debug Torc remote workers over SSH.
- User is wiring or debugging `invocation_script` wrappers, modules, conda, or `TORC_API_URL`.
- User wants to inspect logs, status, resource data, or failure behavior for Torc runs.
- User wants to configure `git push hpc` style code transport through a remote bare Git repository for reproducible HPC runs.
- User wants to run a specific branch/tag/commit remotely from a prepared remote checkout or per-run worktree.
- User needs cleanup guidance for per-run worktrees or temporary refs after versioned remote runs.
- User needs to work around Git LFS, module discovery, or load-balanced HPC login entrypoints for Torc runs.

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
5. For remote/tunneled use, verify the correct `TORC_API_URL` and network reachability before blaming workflow logic. If the remote/shared Torc server is reachable from local `torc`, query workflow status locally; do not SSH just to run `torc status`.
6. For reproducible remote runs, code travels by Git commit/ref and data stays remote. Use a reachable Git remote such as `hpc`, fetch or materialize the exact SHA on the cluster, and require jobs to reference data already present on the remote filesystem.
7. Use the site load-balanced login entrypoint when one exists; do not hardcode direct login nodes unless the user explicitly asks.
8. Do not run build/solve/smoke workload commands on login nodes. Login-node work is limited to lightweight checks, module discovery, Git/worktree preparation, and Torc/Slurm submission. Let Slurm allocations run `uv`, builds, and solver work.
9. When the user wants `git push hpc` setup, use `scripts/setup-hpc-git-remote.sh` to create/reuse the remote bare repo and configure the local remote.
10. When the user wants to run a specific code version remotely, use `scripts/prepare-git-run.sh` to create an isolated exact-SHA worktree under the run directory. Do **not** run jobs from the receiving bare repo or from a shared mutable checkout.
11. Treat `scripts/run-remote.sh` as a remote command runner for an existing remote workdir, not as a repo-sync mechanism.
12. Use `scripts/push-run-cleanup.sh` when the user wants one local command to push HEAD or an explicit SHA to the remote bare repo, create an exact-SHA worktree, run a lightweight repo script there, fetch logs/artifacts, and clean up the temporary worktree.
13. Use preflight checks before launch; use cleanup helpers only when versioned remote runs create temporary worktrees/refs.
14. After failures, inspect Torc-native signals first: workflow/job status, logs, results, resource data, then fallback shell diagnostics.
15. Do not rely on shell-style `${VAR:-default}` interpolation inside workflow `command` or `env`; prefer concrete values or pre-rendered files before submission.

## Progressive disclosure
Read only what fits the mode:
- `references/runbook.md` — mode-by-mode operating guide: local, remote workers, Slurm, versioned remote runs, cleanup
- `references/failure-signatures.md` — common Torc/HPC failure patterns and fixes
- `scripts/doctor.sh` / `scripts/doctor.cmd` — preflight checks for commands, env vars, and optional remote reachability
- `scripts/setup-hpc-git-remote.sh` — create/reuse a remote bare Git repo and configure local `git push hpc` code transport
- `scripts/prepare-git-run.sh` — create an isolated exact-SHA remote worktree under a run directory
- `scripts/deploy-git-torc-slurm.sh` — prepare an exact-SHA worktree and submit a Torc Slurm workflow from it when the commit is already present in the remote bare repo
- `scripts/push-run-cleanup.sh` — push HEAD or an explicit SHA to the remote bare repo, prepare an exact-SHA worktree, run a lightweight repo script there, fetch logs/artifacts, and clean up
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
