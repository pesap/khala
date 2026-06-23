# Common failure signatures

## `module command not available`
Meaning: local shell is not an HPC login shell or module init was not sourced.

Fix:
- source the site module init script if the system uses one
- use the site load-balanced login entrypoint and a login shell when available
- or skip module loading locally and provide equivalent env vars manually

## module appears missing on one login node but `ml spider` shows it elsewhere
Meaning: the shell/module setup or direct-node target is wrong, not necessarily the module name.

Fix:
- use the site's load-balanced login hostname instead of direct login nodes
- start a login shell, then run `ml spider <name>` and `ml load <full/versioned/name>`
- for NLR Kestrel, use `kestrel.hpc.nlr.gov`; `ml spider gams` should show versions such as `gams/51.3.0`

## `conda command not available after module load`
Meaning: the expected module did not expose conda, or the shell hook was not initialized.

Fix:
- verify the loaded modules
- source the conda shell hook
- ensure the expected environment name exists

## `TORC_API_URL` is wrong or unreachable
Meaning: the client/job cannot reach the Torc API server.

Fix:
- verify the full API base URL, e.g. `http://host:port/torc-service/v1`
- check bind host, tunnel, firewall, and routing
- run a lightweight Torc command before debugging the workflow itself

## Remote workers fail version checks
Meaning: Torc versions differ across machines.

Fix:
- install matching Torc versions on all machines
- use `--skip-version-check` only as a temporary debugging escape hatch

## Torc submit or Slurm scheduling fails with missing Slurm tools
Meaning: submission is happening where Slurm CLI tools are unavailable.

Fix:
- generate the Slurm-enabled spec with `torc slurm generate ... -o <generated>.yaml`
- submit from the environment that actually has Slurm access
- use the load-balanced login host when available
- inspect the generated scheduler scripts if needed

## Login-node command starts building, installing, or solving
Meaning: the agent/operator is running payload work on the login node instead of only orchestrating submission.

Fix:
- stop the command
- move build/install/solve work into Torc job commands or Slurm allocations
- on login nodes run only lightweight checks, Git/worktree preparation, `torc submit`, `squeue`, and status inspection

## Submitted the wrong workflow file
Meaning: the source spec was submitted instead of the generated Slurm-backed spec.

Fix:
- submit the generated file from `torc slurm generate -o ...`
- keep source and generated filenames distinct

## Local client cannot drive the remote/tunneled server correctly
Meaning: wrong `TORC_API_URL`, wrong bind host, or the remote side cannot see expected workflow paths.

Fix:
- verify the server bind host and the client URL
- if local `torc status <workflow-id>` works with `TORC_API_URL`, do not SSH just to check Torc workflow status
- confirm the remote environment can access the workflow paths it needs
- debug connectivity before blaming runtime dependencies

## `torc remote run` starts poorly or workers vanish
Meaning: SSH reachability, remote environment, or worker startup is broken.

Fix:
- verify passwordless SSH manually
- re-run `torc remote status`
- collect logs with `torc remote collect-logs`
- confirm matching Torc versions and reachable server URL on each worker

## ssh connects but results never appear locally
Meaning: transfer paths are wrong or `--workdir` does not match the prepared remote location.

Fix:
- confirm `--workdir` matches the intended remote checkout/worktree
- fetch paths relative to that workdir
- inspect pulled `remote-run-state/command.stdout.log` and `command.stderr.log`

## remote run becomes `unknown`
Meaning: remote shell exited and no exit-code file was written.

Fix:
- inspect `remote-run-state/launcher.log`
- verify remote `bash` exists and the remote run directory is writable
- rerun the command directly over ssh once to confirm startup behavior

## repo accumulates stale worktrees or temp refs
Meaning: versioned remote runs create temporary checkouts but cleanup does not always run.

Fix:
- add unconditional cleanup (`trap ... EXIT` or a final janitor step)
- run `git worktree remove --force <path>` and `git worktree prune`
- delete temporary refs after the run
- keep logs and outputs, not the checkout
