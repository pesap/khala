# Operations

This page describes the configuration and operating boundaries of the Khala MVP.
Use [Getting started](getting-started.md) for the first Work workflow.

## Configuration

Khala reads global configuration from `~/.pi/agent/khala.json`.
Set `PI_CODING_AGENT_DIR` to use another agent configuration directory.
A trusted project may add `.pi/khala.json` for project-local overrides.
Project-local configuration is ignored when the project is not trusted.
Project values override global values.

| Setting | Default | Purpose |
| --- | --- | --- |
| `archiveRoot` | `~/.pi/agent/khala` | Directory containing project Archives |
| `worktreeRoot` | `~/worktrees/khala` | Root for Executor Git worktrees |
| `worktreeBranchPrefix` | `khala/` | Prefix for sandbox branches |
| `targetBranch` | `main` | Review request target branch |
| `maxConcurrentExecutions` | `2` | Project-level Execution limit |
| `defaultWorkTokens` | `20000` | Default Work budget |
| `piCommand` | `pi` | Command used for child sessions |

Role models and thinking levels are persisted as `conclaveModel`, `executorModel`, `observerModel`, `oracleModel`, and their matching `*Thinking` settings.
Conclave, Executor, and Oracle models are required for normal governed Work.
The Observer model is required only when repository context gathering is requested.
Role settings apply to future launches.
Existing Executions retain their persisted model, thinking level, and prompt identity.

Each project path maps to an Archive filename derived from its resolved path.
The Archive is not portable between paths unless it is deliberately copied and restored by an operator.

## Limits and timing

The Archive rejects payloads larger than 64 KB and projections larger than 128 KB.
Record payloads are bounded to 16,000 characters when read.
Record summaries are bounded to 500 characters.
Evidence references are limited to 20 entries of 500 characters each.
Provider conversations retain at most eight comments and eight checks.
Provider comment bodies are bounded to 500 characters in conversation details and 2,000 characters in feedback delivery.
Oracle packets and outputs are bounded to 16,000 characters per text field.

Git and provider commands use a 120-second timeout.
Pi RPC requests use a 10-second timeout by default.
Pi agent turns use a 30-minute timeout by default.
The autonomous monitor runs once per minute.
Outbox claims expire after two minutes and are renewed while an effect is running.
A transient Conclave startup failure receives one retry in the runtime and one retry in the outbox worker.
Semantic decisions are never retried automatically.

Work reserves half of its configured token cap for each new Execution, with a minimum allowance of one token.
Khala charges observed input and output tokens as each Executor turn completes.
A budget-exhausted Execution is blocked and requires replacement or a Work budget amendment.
Pi does not provide a per-session output-limit option through the RPC interface, so a single turn can exceed the allowance before Khala records the usage.

## Recovery

The hosting User Pi session owns the parent Khala service.
The parent service is not a standalone daemon.
Closing the User session waits for active monitor, effect, and runtime operations before closing the Archive.

Run `khala-recover` after reopening a project when a child may have been interrupted.
The command drains pending effects and reconciles persisted runtime bindings.
The User recovery action can rebind an unreachable Executor through the parent supervisor.
The autonomous monitor performs the same work on its next cycle.
Child role sessions cannot invoke User recovery tools or impersonate the parent.
A reachable Executor is never replaced by a recovery probe.

If recovery fails, inspect the Work's error and execution records before choosing replacement, Mission amendment, or explicit Work failure.
Do not delete a worktree or session file while Khala may still own its process binding.

## Provider behavior

| Provider | Review request | Status and merge observation | Feedback delivery |
| --- | --- | --- | --- |
| GitHub | Draft Pull Request | Supported | Supported for trusted authenticated review principals |
| GitLab | Draft Merge Request | Supported | Not normalized in the MVP |

Khala discovers the provider from the repository origin.
Only `github.com` and `gitlab.com` origins are supported.
The authenticated `gh` or `glab` session supplies provider identity.
Khala stores provider IDs and URLs but does not store provider credentials.

Khala refreshes the configured remote target branch before creating an Execution and before publishing a review request.
The target branch must still point to the recorded Execution base commit when publication begins.
A changed target branch requires rebasing or replacing the Execution.
Remote review requests and branches remain for audit after local cleanup.
Khala does not automatically close or delete remote review objects.

## Archive backup and privacy

The Archive is an SQLite database in WAL mode.
Back up the main `.sqlite` file together with its WAL file when the service is active, or after closing the hosting Pi session.
Restore only from a trusted copy and verify the project path before reopening it.
Khala fails closed on malformed projections or unsupported Archive integrity failures.

Raw child transcripts are not copied into the Archive.
Pi session files can remain in the sandbox or configured temporary session directory until normal cleanup.
Provider text is stored as bounded untrusted evidence and is quoted before it reaches an Executor.
Review request bodies include the Work objective, acceptance criteria, and validation commands.
Do not submit secrets or sensitive data as Work context or provider feedback.

## Verification checklist

After configuration changes, run `npm run check`.
Before publishing a package, run `npm pack --dry-run` and verify that no Archive, session, or credential files are included.
For behavior changes, run the focused Node test files after rebuilding `dist`.
For Markdown changes, run `npm run check:markdown`.
