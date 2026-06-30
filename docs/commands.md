# Command Reference

Khala commands are Pi slash commands. The README lists the common path; this
page keeps the full command surface and policy details.

## Workflow Commands

| Command                             | Purpose                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/debug <problem>`                  | Investigate an unreported maintainer-observed symptom and draft an issue-ready brief                     |
| `/triage <issue-url\|request>`      | Convert rough issue/request text into a `/workon`-ready packet                                           |
| `/plan <topic>`                     | Turn a maintainer idea into scoped work with risks, slices, acceptance criteria, and a Reviewer Two pass |
| `/workon <issue-url\|issue-number>` | Start autonomous implementation from a ready issue packet                                                |
| `/review [scope]`                   | Review uncommitted changes, branches, commits, PRs, files, folders, or paths                             |
| `/git-review`                       | Inspect git-history signals before reading implementation code                                           |
| `/simplify [scope]`                 | Perform behavior-preserving cleanup and slop removal                                                     |
| `/ship [instruction]`               | Validate, commit, push, and open or confirm a PR/MR                                                      |
| `/inbox [flags]`                    | Show a read-only maintainer dashboard from local, forge, and session signals                             |
| `/audit <claim>`                    | Run an anti-confirmation-bias audit against a claim or plan                                              |
| `/address-open-issues [flags]`      | Sweep open issues through triage, workon, review, and remediation                                        |
| `/learn-skill <topic>`              | Create or refine a reusable skill in the learning store                                                  |

Common `/workon` flags:

```text
--repo owner/repo
--forge auto|github|gitlab|all
--multiplexer auto|none|zellij|tmux
--dry-run
--heartbeat HOURS  # defaults to 0.0834, about 5 minutes
--model provider/model
```

`/workon` uses a generic multiplexer handoff boundary. `auto` launches through
Zellij when `$ZELLIJ` is active, through tmux when `$TMUX` is active and Zellij
is not, and otherwise uses direct Worktrunk worktree creation. Use
`--multiplexer none` to force the direct Worktrunk path without Pi or heartbeat
pane/window launch.

Common `/plan` flags:

```text
--review-model provider/model
--review-thinking off|minimal|low|medium|high|xhigh
--review-loops 1|2
--no-review
```

Use `/inbox` from a non-repository directory for a global side-terminal
dashboard. Inside a repository, it defaults to repo scope; pass `--global` or
`--scope global` for the global view.

Workflow model routing for `/workon`, `/plan`, and other child sessions is
configured through Khala workflow profiles. See
[workflow-model-routing.md](workflow-model-routing.md) for flags, durable YAML
config, precedence, and builtin defaults.

## Run Ledger Commands

Khala records durable workflow runs under `~/.pi/khala/runs/`.

| Command                                   | Purpose                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/run-list [filter]`                      | List durable runs. Useful filters include `active`, `resumable`, and `needs_operator_review` |
| `/run-show <run-id\|path>`                | Show workflow state, recent events, skill activity, checkpoints, and recovery classification |
| `/run-resume <run-id\|path>`              | Queue a resume prompt only when the ledger is classified as safe to resume                   |
| `/run-checkpoint <run-id\|path> [reason]` | Record an operator-verified safe checkpoint                                                  |

Resume is intentionally conservative. Unknown, shell, mutation, forge, external,
or metadata-less mutation events after the latest checkpoint require operator
review before Khala will resume automatically.

## Policy Commands

| Command                                                                       | Purpose                                                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/khala-health`                                                               | Report read-only Khala health/status, including session enablement, memory tool limit, compliance modes, workflow config, and model profiles |
| `/khala-hub [--path <path\|git-ref> [--subdir <relative-path>]]`              | Report or set the Khala hub path for the LLM wiki. Default storage is `~/.pi/khala/hub/`                                                     |
| `/khala-mode [enforce\|warn\|ignore]`                                         | With no arguments, report read-only status. With a mode argument, change all compliance modes                                                |
| `/approve-risk <reason> [--ttl MINUTES]`                                      | Approve one high-risk command. TTL is 1-120 minutes and defaults to 20                                                                       |
| `/preflight Preflight: skill=<name\|none> reason="<short>" clarify=<yes\|no>` | Record manual mutation intent                                                                                                                |
| `/postflight Postflight: verify="<command>" result=<pass\|fail\|not-run>`     | Record verification evidence                                                                                                                 |

Run `/khala-health` to inspect profile resolution. Health output includes:

- **Session**: enabled status, memory tool limit, and compliance modes.
- **Model profiles**: per-profile `OK`/`ERROR` status with resolved model,
  thinking level, used-by routes, problems, and fix steps.

If the resolved development profile is invalid or unresolved, `/workon` refuses
to emit handoff evidence and points operators back to `/khala-health` instead of
silently falling back to the planning model.

## Mutation Preflight

Khala preflight is the intent record checked before mutation tools such as
`write`, `edit`, `apply_patch`, and mutating shell commands. It is not a user
approval prompt and it does not run validation. It gives the harness a compact,
parseable record of why a mutation is about to happen:

```text
Preflight: skill=<name|none> reason="<short>" clarify=<yes|no>
```

The fields mean:

| Field     | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| `skill`   | Primary skill or workflow that justifies the mutation, or `none` when no skill applies    |
| `reason`  | Short mutation intent summary, limited to one quoted line                                 |
| `clarify` | `yes` when the agent still needs a blocking clarification before mutating; otherwise `no` |

Preflight mode controls how strictly Khala treats missing or invalid records:

| Mode      | Behavior                                                              |
| --------- | --------------------------------------------------------------------- |
| `ignore`  | Do not enforce preflight                                              |
| `warn`    | Allow the mutation and emit a policy warning when preflight is absent |
| `enforce` | Block the mutation until a valid preflight has been recorded          |

Agents can record preflight in either of these ways:

- Send `/preflight Preflight: ...` as a Pi command before mutating.
- Emit `Preflight: ...` as assistant text immediately before the retrying
  mutation tool call in the same assistant turn.

When a blocked agent sends only the `Preflight: ...` line as a recovery turn,
Khala records it as control traffic and does not require unrelated evidence or
memory-search work for that turn.

Benchmark-suite `--preflight` is separate: it validates saved harness benchmark
input before scoring and does not satisfy the runtime mutation gate.

## Learning, Skills, and Rules

| Command                                                 | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `/skill-status <name>`                                  | Show learned skill provenance and lifecycle state           |
| `/skill-report`                                         | Regenerate the learned skill curator report                 |
| `/pin-skill <name> [on\|off]`                           | Pin or unpin a learned skill                                |
| `/archive-skill <name>`                                 | Archive a learned skill without deleting it                 |
| `/restore-skill <name>`                                 | Restore an archived learned skill                           |
| `/khala-reload`                                         | Reload learned skills and workflow prompts into Pi          |
| `/workflow-list`                                        | List reviewed learned workflows                             |
| `/workflow-show <name>`                                 | Show a learned workflow artifact and prompt template        |
| `/workflow-run <name> [--model provider/model] [input]` | Run a learned workflow with a durable run ledger            |
| `/rule-list [--all]`                                    | List active runtime rules                                   |
| `/rule-add <trigger> => <instruction>`                  | Add a durable runtime rule                                  |
| `/rule-session <trigger> => <instruction>`              | Add a temporary session-only rule                           |
| `/rule-promote <candidate-id>`                          | Promote a candidate rule                                    |
| `/rule-replace <id> key=value [...]`                    | Replace a rule by appending a new record                    |
| `/rule-disable <id> <reason>`                           | Disable a rule                                              |
| `/rule-audit [--limit N]`                               | Show recent rule activity                                   |
| `/rule-reload`                                          | Reload hand-edited `rules/RULES.md` from the learning store |

Rule examples:

```text
/rule-add mutation work => Search task-specific memory before editing files. --warn
/rule-add destructive commands => Ask before destructive filesystem or git operations. --enforce
/rule-session current debug task => Prefer root-cause evidence before fixes. --advisory
```
