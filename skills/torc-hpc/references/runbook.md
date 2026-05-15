# Torc HPC runbook

## Goal
Use the documented Torc flow for the chosen mode. Prefer Torc-native commands first, then fall back to helper scripts only when the docs-supported path is not enough.

## 1. Local smoke test
Use this first for syntax, wrapper, and dependency sanity checks.

### Fastest path
```bash
torc -s --in-memory run workflow.yaml
```

### When to use a persistent local server
Use a server/client split only when you need repeated inspection, TUI usage, or multi-step interaction:
```bash
torc-server run --database torc.db --host localhost --completion-check-interval-secs 5
TORC_API_URL=http://localhost:8080/torc-service/v1 torc workflows list
```

Notes:
- Distinguish **standalone/server lifecycle** from **execution mode** (`local`, `remote workers`, `slurm`).
- Use `invocation_script` when environment setup should be outside the job command itself.

## 2. Invocation script workflow
Use this when jobs require modules, conda, env vars, or other site setup.

Pattern:
```bash
#!/usr/bin/env bash
set -euo pipefail
source /etc/profile.d/modules.sh 2>/dev/null || true
source <site-module-env-if-needed>
module purge
module load <site-modules>
source <conda-hook-if-needed>
conda activate <env>
exec "$@"
```

Kestrel/NREL pattern from `NatLabRockies/HPC`:
```bash
#!/usr/bin/env bash
set -euo pipefail
source /etc/profile.d/modules.sh
source /nopt/nrel/apps/env.sh
module load gams/51.3.0 xpressmp/9.7.0 conda/2024.06.1
exec "$@"
```

Reference examples under `kestrel/mpi_version_check/load_NREL_*.sh` and `kestrel/Toolchains/Code/Makefiles/Intel/makefile` first source `/nopt/nrel/apps/env.sh`, then purge/load NREL modules. This is required in non-login Slurm job shells so NREL module trees are added to `MODULEPATH`.

Then in the workflow:
```yaml
jobs:
  - name: job1
    command: python run.py
    invocation_script: bash setup.sh
```

Rules:
- keep environment setup in the wrapper, not repeated in job commands
- test the wrapper with a tiny Slurm module preflight before blaming Torc payloads
- use absolute paths when portability across nodes matters
- on Kestrel, do not rely on login-shell inherited `MODULEPATH`; source `/nopt/nrel/apps/env.sh` inside the job/invocation script before `module load`

## 3. Remote workers over SSH
Use this when jobs should run on SSH-accessible machines without Slurm.

### Preconditions
- Torc installed on all machines with matching versions
- SSH key auth works without prompts
- server reachable from all workers

### Typical flow
```bash
torc create workflow.yaml
torc remote add-workers <workflow-id> user@host1 user@host2
torc remote run <workflow-id>
torc remote status <workflow-id>
torc remote collect-logs <workflow-id> --local-output-dir ./logs
```

Key rules:
- use `torc remote ...` for worker lifecycle, not custom ssh loops
- verify `TORC_API_URL` uses the full API base URL when needed
- use `--skip-version-check` only as a temporary debugging escape hatch
- `collect-logs --delete` deletes remote logs/output after collection; it does not manage worker binaries or repo state

## 4. Slurm/HPC submission
Use this for scheduler-backed cluster workflows.

### Login-node boundary
Do not run build, solve, dependency-install, or benchmark smoke commands on login nodes. Login nodes are for lightweight orchestration only:
- inspect `torc`, `sbatch`, `squeue`, `ml/module`, and paths
- load modules only to verify names and exported environment
- create Git refs/worktrees
- run `torc submit`, which delegates work to Slurm allocations

Let Slurm compute allocations perform `uv` installs/builds and solver execution through the Torc job commands.

### Canonical flow
```bash
torc hpc detect
torc hpc partitions <profile-name>
torc slurm generate --account <acct> workflow.yaml -o workflow_slurm.yaml
torc submit workflow_slurm.yaml
```

### Remote/tunneled server flow
If the server runs on the cluster or behind a tunnel:
```bash
export TORC_API_URL=http://<host>:<port>/torc-service/v1
torc slurm generate --account <acct> workflow.yaml -o workflow_slurm.yaml
torc submit workflow_slurm.yaml
```

If the shared/remote Torc server is already configured and reachable from the local machine, use local `torc` for workflow status instead of SSHing to the cluster:

```bash
export TORC_API_URL=http://<host>:<port>/torc-service/v1
torc status <workflow-id>
torc workflows list
```

SSH is only needed for cluster-local details that Torc does not expose, such as Slurm queue/accounting, remote worktree files, or job log artifacts.

Rules:
- submit the **generated** spec, not the source spec, unless the workflow spec already contains explicit `slurm_schedulers` and `schedule_nodes` actions
- prefer `torc submit` as the normal submission path
- do not add an outer shell orchestration layer around normal submit flows
- if using a documented self-contained Slurm job pattern, follow that specific doc rather than general submit guidance
- use the full API base path, for example `http://torc.hpc.nrel.gov:8080/torc-service/v1`, not `torc-service-v1`

## 5. Git-backed remote code execution
Use this when the user wants to run a specific branch, tag, or commit remotely.

Core rule: **code travels by Git; data stays remote**. Jobs must reference data that already exists on the HPC filesystem, for example `/scratch/$USER/data/...` or `/projects/team/datasets/...`.

### Configure `git push hpc`
Create or reuse a bare Git repository on the cluster and add it as a local remote. Use the site's load-balanced login hostname when available, not a direct login node. For NLR Kestrel, use `kestrel.hpc.nlr.gov`.

```bash
skills/torc-hpc/scripts/setup-hpc-git-remote.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --remote-name hpc
```

Then publish code for a run:

```bash
git push hpc HEAD:refs/heads/runs/<run-id>
SHA=$(git rev-parse HEAD)
```

If push fails with `git-lfs-authenticate: command not found`, the plain SSH bare repo does not support Git LFS. For small run-critical artifacts only, add a narrow `.gitattributes` override so that exact path is stored as a normal Git blob on the run branch, then push with `GIT_LFS_SKIP_PUSH=1`:

```gitattributes
# after broader *.gz LFS rules
tests/framework_comparison/vendor/*.tar.gz -filter -diff -merge -text
```

```bash
GIT_LFS_SKIP_PUSH=1 git push hpc HEAD:refs/heads/runs/<run-id>
```

Do not broadly disable LFS for large datasets.

### Push, run a repo script, and clean up
Use this when you want one local command to push the current commit or an explicit commit, materialize that exact SHA remotely, run a lightweight repo script, fetch logs/artifacts, and remove only the temporary `src` worktree after success.

```bash
skills/torc-hpc/scripts/push-run-cleanup.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --script scripts/submit_torc.sh \
  --out-dir ./artifacts \
  --fetch out \
  -- --workflow workflows/run.slurm.yaml
```

To run a specific commit instead of `HEAD`:

```bash
skills/torc-hpc/scripts/push-run-cleanup.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --sha <commit-sha> \
  --script scripts/submit_torc.sh
```

The script creates/reuses the remote bare repo, pushes to `refs/heads/runs/<run-id>`, prepares `<run-parent>/<run-id>/src`, runs the script from that worktree with `RUN_ROOT`, `RUN_SRC`, `RUN_OUT`, `RUN_LOGS`, `RUN_SHA`, and `RUN_REF` exported, fetches requested artifacts when `--out-dir` is set, then removes only the temporary `src` worktree by default after success. Use `--cleanup always` for cleanup after failures, `--cleanup never` to inspect the worktree, and `--delete-ref` only when the run ref is no longer needed.

Do not use this wrapper to run solver/build/benchmark payloads on login nodes. The repo script should do lightweight orchestration, such as submitting a Torc/Slurm workflow.

### Prepare and submit an exact-SHA Torc Slurm run
If the commit already exists in the remote bare repo, prefer the wrapper script over hand-written SSH blocks:

```bash
skills/torc-hpc/scripts/deploy-git-torc-slurm.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --sha "$SHA" \
  --run-id "$RUN_ID" \
  --workflow tests/framework_comparison/torc_solver_matrix.slurm.yaml \
  --torc-api-url http://torc.hpc.nrel.gov:8080/torc-service/v1 \
  --modules 'gams/51.3.0 xpressmp/9.7.0 conda/2024.06.1' \
  --remote-torc-bin /scratch/$USER/torc/0.30.3/torc
```

The wrapper calls `prepare-git-run.sh`, verifies the exact SHA on the remote worktree, checks `torc`/`sbatch`, exports `TORC_API_URL` and optional module env, then runs `torc submit`. Prefer `--remote-torc-bin` for user-installed Torc versions; `--remote-path-prefix` is only a convenience for PATH setup. The helper writes a small remote script and executes it with `ssh host 'bash -s'` to avoid positional-argument shifting bugs from spaces in module lists. It does not commit, push, build, install dependencies, or run solver payloads on login nodes.

To only materialize the pushed commit into an isolated run directory:

```bash
skills/torc-hpc/scripts/prepare-git-run.sh \
  --host user@login.cluster \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --sha "$SHA" \
  --run-root /scratch/$USER/torc-runs/my-run
```

This creates:

```text
/scratch/$USER/torc-runs/my-run/src   # exact SHA worktree
/scratch/$USER/torc-runs/my-run/out   # intended outputs
/scratch/$USER/torc-runs/my-run/logs  # intended logs
/scratch/$USER/torc-runs/my-run/metadata.env
```

Run Torc/Slurm from `src` and point jobs at remote data paths. Submit only from a login shell; do not run job payloads on the login node.

```bash
cd /scratch/$USER/torc-runs/my-run/src
export TORC_API_URL=http://torc.hpc.nrel.gov:8080/torc-service/v1
ml load gams/51.3.0 xpressmp/9.7.0

# If the workflow has no Slurm actions yet:
torc slurm generate --account <acct> workflow.yaml -o ../workflow_slurm.yaml
torc submit ../workflow_slurm.yaml

# If the workflow already has slurm_schedulers/actions:
torc submit -o ../out/torc_output workflow.slurm.yaml
```

Rules:
- use a bare Git repo as the receiving `hpc` remote; do not push into a mutable checkout used by jobs
- run jobs from an exact-SHA worktree under a run directory, not from the bare repo or shared checkout
- prefer exact SHA for big dataset runs; branch names are okay only as inputs to locate the SHA
- keep remote data paths explicit; this workflow does not move datasets
- fetch only logs, summaries, and selected artifacts by default; large outputs stay remote unless explicitly requested
- remove temporary worktrees after results are safe
- keep dependency replacement checks out of this skill unless they affect Torc/HPC orchestration directly

## 6. Manual remote command fallback
Use `scripts/run-remote.sh` only when you truly need to launch a non-Torc remote command manually.

Example:
```bash
skills/torc-hpc/scripts/run-remote.sh \
  --host user@cluster \
  --remote-root /scratch/$USER/khala-runs \
  --workdir /projects/repo/worktree-or-checkout \
  --command 'bash invocation_script.sh some-command ...' \
  --fetch output_dir \
  --out-dir ./artifacts
```

Rules:
- `run-remote.sh` is a remote command runner for an existing remote workdir
- it does **not** materialize the repo remotely
- prepare the code remotely first, then run the command there

## 7. Cleanup for versioned remote runs
Use cleanup helpers only when temporary remote worktrees/refs were created for a versioned run.

Preferred cleanup contract:
1. remove only the temporary `src` worktree for each run
2. prune stale worktree metadata in the remote bare repo
3. delete temporary refs only when explicitly requested
4. keep logs, outputs, and metadata artifacts

Preview cleanup first:
```bash
skills/torc-hpc/scripts/cleanup-worktree.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --run-root /scratch/$USER/torc-runs \
  --run-id failed-run-1 \
  --run-id failed-run-2 \
  --keep current-run
```

Execute after reviewing the dry-run output:
```bash
skills/torc-hpc/scripts/cleanup-worktree.sh \
  --host user@kestrel.hpc.nlr.gov \
  --remote-git-dir /scratch/$USER/git/myrepo.git \
  --run-root /scratch/$USER/torc-runs \
  --run-id failed-run-1 \
  --run-id failed-run-2 \
  --keep current-run \
  --execute
```

The helper is dry-run by default, uses SSH, removes only `<run-root>/<run-id>/src`, and avoids `rm -rf` unless `--force-path-delete` is explicitly passed. Use `--delete-ref` only when run refs are no longer needed.

## Debug order
1. Verify the SSH target is the load-balanced login host, not a direct node, unless user explicitly requested direct node access.
2. `command -v torc`
3. `torc --version`
4. `printf '%s\n' "$TORC_API_URL"`
5. `ml spider <module>` / `ml load <module>` / `module list` if modules are involved
6. inspect only lightweight remote state on login nodes: exact SHA, file presence, module paths, Torc server reachability
7. submit with `torc submit`; do not run `uv`, builds, or solver smoke tests on login nodes
8. inspect Torc workflow/job status locally with `TORC_API_URL=... torc status <workflow-id>` when the shared server is reachable
9. SSH only for cluster-local details such as `squeue`/`sacct`, remote files, or logs not exposed by Torc
10. if failed, list failed jobs and results locally first: `torc jobs list <workflow-id> --status failed`, `torc results list <workflow-id>`
11. inspect Slurm queue/accounting with `squeue`/`sacct` when needed
12. inspect remote Torc output logs under the submitted `--output-dir`, especially `job_runner_*.log`, `slurm_output_*.{o,e}`, and `job_stdio/job_wf*_j*_r*_a*.{o,e}`
13. group identical `job_stdio/*.e` failures before reading every file; all jobs failing in seconds usually means environment/bootstrap failure, not model logic
14. if using remote workers, inspect `torc remote status` and collected logs
15. if using versioned remote runs, verify the fetched commit/branch in the remote checkout/worktree before debugging the job itself
16. if using manual remote fallback, inspect pulled `remote-run-state/` logs

## Rules learned from review
- Prefer `torc -s --in-memory run ...` for the first local smoke test.
- Prefer `torc remote ...` for SSH worker workflows.
- Prefer `torc slurm generate ... -o <generated>.yaml` then `torc submit <generated>.yaml` for Slurm.
- For versioned remote runs, prefer remote fetch/worktree preparation over rsyncing the repo.
- For NLR Kestrel, use `kestrel.hpc.nlr.gov` as the SSH entrypoint; avoid direct `kl1`/`kl2`/`kl3` targets.
- Use login nodes only for lightweight orchestration and Torc/Slurm submission, never for builds, dependency installs, benchmark smoke tests, or solver runs.
- `ml spider gams` may reveal GAMS even if a non-login/non-initialized module shell cannot see it; use a login shell/module setup before deciding a module is absent.
- When `TORC_API_URL` points at a reachable shared/remote server, query Torc workflow status from local `torc`; reserve SSH for Slurm-specific state, remote files, and logs.
- For Slurm/Torc failures, distinguish scheduler success from payload failure: `sacct` may show Slurm allocations `COMPLETED 0:0` while every Torc job failed inside the allocation.
- If every job fails immediately with the same stderr from `job_stdio/*.e`, debug the invocation script/module bootstrap first. A successful login-node `ml load` does not prove the compute-node non-login job shell has the same `MODULEPATH`.
- Kestrel startup scripts that need NREL application modules should source `/etc/profile.d/modules.sh` and then `/nopt/nrel/apps/env.sh` before loading modules; this was validated by a tiny Slurm preflight that loaded `gams/51.3.0`, `xpressmp/9.7.0`, and `conda/2024.06.1` on a compute node.
