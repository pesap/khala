# Operations

Khala should remain understandable when the initiating Pi session is gone.
This document owns target configuration, allowances, state locations, and operator recovery from the [MVP design](mvp-design.md).
The current configuration reference below is explicitly separate from that target.
Use [Getting started](getting-started.md) for the existing provider-review workflow.

## Configuration and state locations

Global configuration is read from `~/.pi/agent/khala.json`, or the directory selected by `PI_CODING_AGENT_DIR`.
A trusted repository may override it through `.pi/khala.json`; untrusted local configuration is ignored.
Overrides apply only to Missions targeting that repository and cannot rewrite global defaults or unrelated Work.

The target has one shared Archive and explicit Khala-owned state locations for child artifacts and managed worktrees outside active User checkouts.
Repository identity remains an access boundary even though storage is shared.
The [data model](data-model.md#repository-and-workspace-identity) defines local and provider identities.
No automatic migration, consolidation, or deletion of existing Archives is authorized by this design.

Role settings affect future launches and never change the User's active model or settings.
Existing Executions retain their recorded model, thinking level, and prompt identity.
Observer and Oracle configuration is needed only when their optional help is used.
Starting Work does not install global tools or open unsolicited terminal panes.

## Allowances and limits

The default Work budget is 20,000 tokens across the complete workflow, including Conclave, Executor, Observer, and Oracle.
Before autonomous launch, an explicit total concurrency limit and finite automatic correction allowance must be resolved from User settings or the submission.
Repository overrides may lower the shared total child-run ceiling, not raise it.
No separate machine-wide resource scheduler is required.

Every child invocation reserves an explicit allowance from the remaining Work budget before launch.
Reservation and usage updates are durable and idempotently bound to its run ID.
Observed input and output tokens are charged as turns complete and inspectable by role and attempt.
Cache counters remain metadata and are not added a second time.
Unspent reservations are released when a run ends; replacement never restores consumed tokens.

After a crash, outstanding reservations remain held until runtime and usage are reconciled.
Unreported in-flight usage is uncertain, not newly spendable budget merely because a process disappeared.
Release requires reconciled evidence or an explicit User decision.
An Executor reaching its allowance becomes blocked with `budget-exhausted`.
Another role exhausting its allowance records the failed decision or operation and exposes the next User action without launching an unbudgeted child.
Only the User can increase the Work budget.

A correction attempt is one Conclave-authorized implementation pass after review or a blocker, whether it resumes or replaces an Execution.
The initial pass does not consume a correction attempt.
Replacement and Mission amendment do not reset consumed correction allowance.
Increasing it requires explicit User authorization.
Insufficient budget or correction allowance stops automatic progress and requests a User decision.
[Lifecycle](lifecycle.md#acceptance-and-settlement) defines accepted-but-unsettled Work when Conclave settlement lacks budget.

A provider turn may overshoot its allowance before Khala can observe and stop it.
The token allowance is an observed stopping limit, not a hard financial spending ceiling.
Model price does not establish runtime memory efficiency.
Measure the process tree, including validation and build subprocesses, separately from token accounting.

Observer turns have a 120-second timeout and consume Work budget.
The autonomous provider monitor runs once per minute while the background supervisor is alive.
Monitoring polls only published Work and uses bounded transport retries, not unlimited model wakes.
Logs, retained context, artifact reads, RPC traffic, and pending requests must remain bounded.
Application resource bounds do not imply a hard aggregate operating-system memory limit.

## Startup and recovery

The [architecture contract](architecture.md#supervision-and-recovery) defines the single shared supervisor, exclusive lock, and restart reconciliation.
Closing or switching the User Pi session disconnects its interface without stopping accepted Work.
A new session reconnects to saved state; runtime probes remain distinct from lifecycle decisions.

An uncertain writer retains workspace ownership until termination of its process tree is confirmed.
Inspect error and execution evidence before choosing recovery, replacement, amendment, or explicit failure.
Never delete a worktree, binding, or session artifact while Khala may still own its writer.
A new Archive does not recover or terminate processes owned by another Archive.
Result retention and permitted cleanup are owned by [Lifecycle](lifecycle.md#cancellation-recovery-and-retention).

The current `/khala-recover` command rereads the project Archive, drains pending effects, and reconciles runtime bindings.
User-initiated runtime recovery requires the session holding Archive supervision; competing User sessions must use that owning session or wait for its shutdown.
Conclave-authorized Executor recovery is queued for the owning supervisor.
The adjacent `.supervision.sqlite` file holds a process-lifetime SQLite lock, not a lease that expires during a long model turn.
Do not delete it to force takeover.
Reload all existing Khala Pi sessions after changing supervision code before retrying stopped Work; source edits do not replace already-loaded services.
The current extension closes its application service when the User Pi session shuts down; independent background continuation remains a target requirement.
There is no `/khala-stop` command in this checkout.
Opening another project does not reconnect to the same shared Archive yet.

## Provider operation

Local delivery requires no provider credentials, fetch, or publication.
Provider delivery requires an authenticated `gh` or `glab` session available to the service, not the child.
The current adapters support `github.com` and `gitlab.com` origins.
The target stores the authorized provider repository and branch in the Mission instead of following later origin changes.

GitHub supports draft requests, status, merge observation, and bounded eligible provider-comment feedback.
GitLab supports draft requests, status, and merge observation without provider-comment normalization.
Eligibility and credential boundaries are defined in [Security](security.md#provider-feedback), not inferred from publication ownership.
Base drift requires the [approved successor path](lifecycle.md#publication-and-base-drift), not an implicit operator rebase.

## Archive backup and privacy

The Archive uses SQLite WAL storage and an adjacent initialization marker.
Back up after stopping its supervisor and confirming child processes have exited, or use SQLite's backup API under a controlled operating procedure.
Preserve the initialization marker with the backup.
Do not independently copy database and WAL files while writes are active.
Restore only a trusted backup and verify Archive and repository identities before reopening.
Integrity failure fails closed; there is no in-process restore, startup migration, or automatic repair.

Raw child transcripts are not copied into the Archive.
Keep retained artifacts private and bounded under the [security contract](security.md#privacy-and-failure-behavior).
Do not include secrets in Work context or provider feedback.
Publication may disclose objective, acceptance criteria, and validation commands in a review-request body, so review scope and publication permission before authorizing it.

## Current configuration reference

These settings describe the existing implementation, not the target shared-Archive and all-role scheduling policy above.
Target settings and their implementation status must be updated here when the corresponding behavior is implemented.

| Setting | Current default | Current meaning |
| --- | --- | --- |
| `archiveRoot` | `~/.pi/agent/khala` | Directory containing project Archives |
| `worktreeRoot` | `~/worktrees/khala` | Root for Executor worktrees |
| `worktreeBranchPrefix` | `khala/` | Sandbox branch prefix |
| `targetBranch` | `main` | Review-request target branch |
| `maxConcurrentExecutions` | `2` | Project-level Execution limit |
| `defaultWorkTokens` | `20000` | Work token cap |
| `piCommand` | `["pi"]` | Child launch arguments |

Role models use `conclaveModel`, `executorModel`, `observerModel`, and `oracleModel`, with matching `*Thinking` settings.
The current workflow requires Conclave, Executor, and Oracle models; the target makes Oracle optional.
Current navigation settings are `roleSettingsKey` (`r`), `commentsKey` (`c`), `refreshKey` (`ctrl+r`), `helpKey` (`?`), and `historyKey` (`h`).
The [target navigation contract](tui-navigation.md) uses configured Pi editing and navigation instead of introducing global letter shortcuts.

Current Archives are named from resolved project paths, and child session, lease, lock, and capability files use project-specific temporary directories.
Current Execution reservations use half the Work cap rather than the target explicit reservation for every role run.
Interrupted Executor implementation turns retain usage reported by completed assistant messages and charge that known usage even when the Work was cancelled before the turn failed.
Interrupted feedback-delivery usage, unreported in-flight usage, and all-role reservation reconciliation remain implementation gaps; recorded usage is not a complete spending estimate after interruption.
Current prompt recovery rejects persisted prompt identities that do not match the installed package.
These implementation constraints do not authorize rewriting existing Work to fit the target.

The current [`KhalaConfig`](../src/config.ts) does not expose settings for total child count or RPC frame/request limits.
`PiRuntimeOptions.maxRpcFrameBytes` bounds each LF-delimited or unterminated RPC frame, including its delimiter, to a positive safe integer of bytes, defaulting to 8 MiB.
Oversized frames and malformed consumed events fail the pending operation rather than accumulating unbounded input.
Larger native Pi events require an explicitly increased finite limit.
The runtime retains at most 16,000 characters of assistant output with an explicit truncation indicator.
The target resource bounds must be implemented and verified before being described as available configuration.
Git/provider commands use 120-second timeouts, RPC requests use 10 seconds, and ordinary child turns use 30 minutes.
Outbox claims expire after two minutes and renew while running.
Current transient Conclave startup failures receive one runtime retry and one outbox retry; semantic decisions are not silently retried.

Current payload limits are 64 KB per Archive payload and 128 KB per projection.
Record reads cap payloads at 16,000 characters, summaries at 500 characters, and evidence references at 20 entries of 500 characters each.
Provider conversation details retain up to eight comments and eight checks; comment bodies are bounded to 500 characters in details and 2,000 in feedback delivery.
Oracle text fields are bounded to 16,000 characters.
Current role-visible status excludes raw Signal text and validation output; full authorized details remain available to the User.

The current workspace adapter runs `npm ci --ignore-scripts --offline` before governed commit and validation when a sandbox contains `package-lock.json`, using sandbox-local binaries without an implicit build.
Dependency hydration and declared validation run inside Linux bubblewrap with a private network, PID namespace, temporary directory, and home.
Bubblewrap must already be installed and user namespaces permitted; Khala does not install it or run validation unrestricted when isolation fails.
The validation path must resolve inside the configured worktree root.
System runtime directories, Node, and the npm package for Node projects are read-only; only the selected workspace is persistently writable.
The host home, credential environment, and npm cache are not exposed.
Offline dependency resolution failures are reported as failed validation rather than retried with network or host-cache access.
This does not isolate service-owned Git hooks or establish complete Pi child-process isolation.

Runtime stop waits for the owned process group to have no live members before removing its lease.
A surviving group blocks session takeover even after its leader exits.
Unattached cleanup with unprovable ownership fails closed and retains the lease for operator reconciliation.
Process-group confirmation does not contain descendants that deliberately create another session.
Windows process-tree cleanup is unsupported rather than treated as confirmed.

## Checks before relying on operations

Exhaust each role's allowance, crash with a held reservation, and verify that reconciliation cannot double-charge or refund uncertain usage.
Verify trusted repository overrides cannot increase global concurrency or change unrelated Work.
Exercise backup and trusted restore without silently creating a replacement for a missing marked Archive.
Use [Development](development.md) for repository check commands rather than duplicating build and test procedures here.
