# Operations

Khala should remain understandable when the initiating Pi session is gone.
This document owns operational configuration, token accounting, state locations, and operator recovery from the [MVP design](mvp-design.md).
Current behavior and target requirements are identified separately.
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
In the Pi extension, Observer and Oracle configuration is optional.
The base Pi workflow uses Conclave and Executor models; configure Observer or Oracle models only when those roles run.
Starting Work does not install global tools or open unsolicited terminal panes.

## Allowances and limits

The default Work cap is 20,000 tokens across Conclave, Executor, Observer, and Oracle invocations.
Work submissions store the resolved `maxCorrections` value, defaulting to 3, separately from this token cap.
The Archive enforces a shared `maxConcurrentRuns` ceiling over reserved and uncertain invocations.
Repository overrides may lower this project-wide ceiling, not raise it.
The current session-owned service polls active provider requests once per minute while the hosting User session is alive.
Independent background polling remains a target requirement.

### Token accounting

The Work token cap applies to every governed role using that Work.
The Archive records aggregate consumed and reserved token counts on the Work and stores each invocation's role, allowance, state, and cumulative usage.
Work details show active run IDs, roles, states, and original allowances; inspect the invocation Record for that run's cumulative usage.

`Consumed tokens` are the sum of observed input plus output tokens for all Work invocations.
Each cumulative report is charged only for its newly observed delta.
Cache hit and cache miss counters are retained as usage metadata and are not added to consumed tokens.

`Held reservations` are the unspent parts of invocations that are still reserved or uncertain.
For an invocation with allowance `A` and observed input plus output `U`, its held amount is `max(0, A - U)`.
A missing usage report leaves the full allowance held.
Partial usage is charged once and reduces the held amount by the same observed amount.

`Available tokens` are `Work cap - consumed tokens - held reservations`.
This value is signed and may be negative after an overrun.
`Observed overrun` is `max(0, consumed tokens - Work cap)`.
The cap is never increased automatically.

### Allowance calculation and dispatch

For a Work with cap `C` and available tokens `V`, an ordinary invocation's Work allowance is `min(max(1, floor(C / 2)), V)` when `V > 0`.
No invocation is dispatched when `V <= 0`.
At Execution creation, `Execution.tokenAllowance` is fixed to the Work allowance then available.
An Executor invocation is limited to the smaller of the current Work allowance and the Execution's remaining allowance.
The Execution's remaining allowance is its token allowance minus its observed input and output usage across its invocations.
Conclave, Observer, and Oracle invocations use the Work allowance without a separate cumulative Execution allowance.

Work dispatch is eligible by budget when available tokens are positive and preparation is not waiting for User recovery.
When preparation is not waiting, available tokens of zero or less with a held invocation reservation put the Work in reservation-waiting.
When preparation is not waiting and no reservation remains, the Work budget is exhausted.
A positive Work allowance does not bypass the separate project run limit, Executor FIFO order, or concurrent Execution limit.
An uncertain invocation keeps its project run slot even if its observed usage has reduced its held token reservation to zero.

Completed invocations release unused reservation and retain all observed consumption.
A known pre-launch failure settles with zero usage and releases its reservation.
An uncertain invocation retains its unspent allowance and run slot until complete usage is reconciled, either from a complete durable receipt during recovery or by User reconciliation with evidence.
Missing or partial usage is not permission to spend the held amount again.
User reconciliation reports cumulative usage; the ledger charges only the increase over the previous observation and releases the remaining reservation.
An Executor that reaches its allowance becomes blocked with `budget-exhausted`.
Another role that reaches its allowance cannot launch an unbudgeted retry.
Only the User can amend the Work cap, and an amendment must be at least current consumed plus held tokens.

### Correction and USD limits

Correction allowance is a count, not a token amount.
The current `correctionCount` increments when Conclave records a `replace` Verdict.
It does not count resumed implementation or feedback turns.
The initial Execution does not consume a correction count.
The count is committed before replacement admission, so a replacement may remain queued for capacity after consuming its correction count.
An amendment or budget increase does not restore that count.
The current count limit is snapshotted on each Work at submission.
The current action set does not amend that per-Work limit; changing `maxCorrections` affects subsequently submitted Work.

Role settings also expose a role-specific `usdMax`, defaulting to $5.
That setting is separate from token allowances and is not charged against the Work cap.
Current invocation code passes a token allowance to the runtime but does not apply `usdMax` as a per-call spending cap.
Do not treat it as a hard USD limit or as permission to increase any token allowance.

### Overshoot and resource limits

The token allowance is a stopping threshold, not a hard cap.
The runtime accumulates usage from completed messages and requests an RPC abort when observed input plus output reaches the allowance.
Usage arrives after a message completes, and another in-flight response may continue before abort acknowledgement.
Settlement waits for the invocation's abort acknowledgement before allowing another prompt.
If Pi does not settle after the allowance stop, the RPC deadline fails the turn rather than waiting for the ordinary turn timeout.
The invocation can therefore exceed its allowance and the Work cap.
Khala charges the full observed input and output, including overshoot, and does not enlarge the cap automatically.
The Work view and Conclave decision evidence show available tokens, observed overrun, held reservations, remaining correction count, and the computed Work dispatch reason.
Both views report combined replacement eligibility and explain whether correction, Work-token, or preparation gates block it.
FIFO, project invocation capacity, and concurrent Execution admission may still defer a replacement after those gates pass.

Model price does not establish runtime memory efficiency.
Measure the process tree, including validation and build subprocesses, separately from token accounting.

Observer turns have a 120-second timeout and consume Work budget.
The current session-owned provider monitor runs once per minute while the hosting User session is alive and stops when that session closes.
Monitoring polls only published Work and uses bounded transport retries, not unlimited model wakes.
Independent background monitoring remains a target requirement.
Logs, retained context, artifact reads, RPC traffic, and pending requests must remain bounded.
Application resource bounds do not imply a hard aggregate operating-system memory limit.

## Startup and recovery

The [architecture contract](architecture.md#supervision-and-recovery) defines the target single shared supervisor, exclusive lock, and restart reconciliation.
Target behavior is for closing or switching the User Pi session to disconnect its interface without stopping accepted Work.
Current behavior is session-owned: closing the hosting User Pi session closes the service and stops its child runtimes.
A new session can reconnect to saved state.
Use the authorized `Recover` action for one Work or `/khala-recover` from the owning User session to reconcile project state.
User-initiated recovery must run in the session holding the Archive's exclusive supervision lock.
Runtime probes remain distinct from lifecycle decisions.

An uncertain writer retains workspace ownership until termination of its process tree is confirmed.
Inspect error and execution evidence before choosing recovery, replacement, amendment, or explicit failure.
Never delete a worktree, binding, or session artifact while Khala may still own its writer.
A new Archive does not recover or terminate processes owned by another Archive.
Result retention and permitted cleanup are owned by [Lifecycle](lifecycle.md#cancellation-recovery-and-retention).

The current `/khala-recover` command runs in the owning User session, which must hold the Archive's exclusive supervision lock.
It rereads the project Archive, drains pending effects, and reconciles runtime bindings.
Recovery continues across individual Work failures and reports each failed Work with its diagnostic and next step.
An unconfirmed Executor restoration is reported as a failure rather than a completed recovery.
Completed durable invocation receipts settle held usage automatically during recovery.
An incomplete receipt keeps its reservation and reports the invocation that needs cumulative usage evidence.
In `/khala`, open the Work's Actions and choose Reconcile held usage.
Choose the Held invocation field, select the invocation from the Work's active invocations, and enter the four cumulative usage fields and Usage evidence in the native editor.
Select the Reconcile held usage submit row and confirm the service-supplied consequence sentence.
Use actual cumulative usage from the provider or retained runtime evidence; do not estimate or substitute the reserved allowance.
Reconciliation verifies that the old owned writer has stopped before settling usage and permitting pending dispatch.
After settlement, use the Work's authorized `Recover` action or run `/khala-recover` to restore an interrupted Executor and continue its existing Execution.
If an Executor ends its turn without a ready or blocked Signal, open the Work's Actions and choose Recover to resume its existing Pi session.
This explicit continuation requires an idle runtime, settled invocations, and remaining Work and Execution allowances.
Khala checks the live runtime and current binding before continuing; a pending ready or blocked Signal still requires a Conclave decision.
Missing ownership proof fails closed and retains the reservation.
User-initiated runtime recovery requires the session holding Archive supervision; competing User sessions must use that owning session or wait for its shutdown.
Recover on cancelled Work returns it to admission only after every invocation settles and the owning supervisor confirms that the prior Executor has stopped or never launched.
Held or uncertain usage and refused stops preserve the cancelled Work and its Execution binding.
Conclave-authorized Executor recovery is queued for the owning supervisor.
The adjacent `.supervision.sqlite` file holds a process-lifetime SQLite lock, not a lease that expires during a long model turn.
Do not delete it to force takeover.
Reload all existing Khala Pi sessions after changing supervision code before retrying stopped Work; source edits do not replace already-loaded services.
The current extension closes its application service when the User Pi session shuts down; independent background continuation remains a target requirement.
There is no `/khala-stop` command in this checkout.
Opening another project does not reconnect to the same shared Archive yet.

## Provider operation

Target local delivery requires no provider credentials, fetch, or publication.
Current delivery is provider-only through draft GitHub Pull Requests and GitLab Merge Requests.
Provider operations currently execute through the role-bound service, and the Executor child can invoke `create-review-request`.
An authenticated `gh` or `glab` session must be available to the process that performs the operation.
Current Pi child launches do not provide OS filesystem isolation, so do not treat provider credential files as inaccessible to the Executor.
The current repository `origin` must be hosted on `github.com` or `gitlab.com` for provider delivery.
The target stores the authorized provider repository and branch in the Mission instead of following later origin changes.

GitHub supports draft requests, status, merge observation, and bounded eligible provider-comment feedback.
GitLab supports draft requests, status, and merge observation without provider-comment normalization.
The current adapter reads pull-request templates from root, `docs`, and `.github` locations; it does not read GitLab's `.gitlab/merge_request_templates` directory.
Eligibility and credential boundaries are defined in [Security](security.md#provider-feedback), not inferred from publication ownership.
Base drift requires the [approved successor path](lifecycle.md#publication-and-base-drift), not an implicit operator rebase.

## Archive backup and privacy

The Archive uses SQLite WAL storage and an adjacent initialization marker.
Back up after stopping its supervisor and confirming child processes have exited, or use SQLite's backup API under a controlled operating procedure.
Preserve the initialization marker with the backup.
Do not independently copy database and WAL files while writes are active.
Restore only a trusted backup and verify Archive and repository identities before reopening.
Integrity failure fails closed; there is no in-process restore or automatic repair.
Writable startup currently applies explicit Archive migrations before integrity validation, as described in [Data model](data-model.md#archive-durability).

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
| `maxConcurrentRuns` | `2` | Total reserved or uncertain role invocations in the project Archive |
| `maxCorrections` | `3` | Replacement Verdict limit recorded with Work |
| `defaultWorkTokens` | `20000` | Work token cap |
| `piCommand` | `["pi"]` | Child launch command and arguments; the command must report Pi version `0.85.0` |

Trusted project configuration may lower `maxConcurrentRuns` but cannot raise the global ceiling.
The Archive enforces the effective ceiling across existing and newly submitted Works.

Role models use `conclaveModel`, `executorModel`, `observerModel`, and `oracleModel`, with matching `*Thinking` settings.
The Pi extension's base workflow requires Conclave and Executor models.
Observer and Oracle models are optional in the Pi extension and are used only when those roles run.
Direct `createApplication` construction validates Conclave, Executor, and Oracle models by default.
Current navigation settings are `roleSettingsKey` (`r`), `commentsKey` (`c`), `refreshKey` (`ctrl+r`), `helpKey` (`?`), and `historyKey` (`ctrl+h`).
The [target navigation contract](tui-navigation.md) uses configured Pi editing and navigation instead of introducing global letter shortcuts.

Current Archives are named from resolved project paths, and child session, lease, lock, and capability files use project-specific temporary directories.
The [Allowances and limits](#allowances-and-limits) section is the canonical reference for Work and Execution allowances, per-invocation reservations, usage settlement, correction counts, USD settings, dispatch waits, and overshoot.
The runtime persists invocation receipts before dispatch and after turn completion; recovery uses complete receipts without launching another model turn.
Incomplete receipts require explicit User reconciliation with cumulative usage and evidence; automatic transcript-based reconstruction is not implemented.
Prompt identities are persisted and passed to recovered sessions, but current recovery does not compare a persisted identity with the installed package.
These implementation constraints do not authorize rewriting existing Work to fit the target.

The current [`KhalaConfig`](../src/config.ts) exposes total role-run capacity but not RPC frame/request limits.
`PiRuntimeOptions.maxRpcFrameBytes` bounds each LF-delimited or unterminated RPC frame, including its delimiter, to a positive safe integer of bytes, defaulting to 8 MiB.
Oversized frames and malformed consumed events fail the pending operation rather than accumulating unbounded input.
Larger native Pi events require an explicitly increased finite limit.
The runtime retains at most 16,000 characters of assistant output with an explicit truncation indicator.
The target resource bounds must be implemented and verified before being described as available configuration.
Git/provider commands use 120-second timeouts, RPC requests use 10 seconds, and ordinary child turns use 30 minutes.
Outbox claims expire after two minutes and renew while running.
Transient child startup failures receive one native runtime retry before a prompt is sent.
Failed Conclave effects retain durable attention and are not automatically replayed by later outbox drains.

Current payload limits are a serialized JSON length of 64,000 for each Archive payload and 128,000 for each projection.
Record reads cap payloads at 16,000 characters, summaries at 500 characters, and evidence references at 20 entries of 500 characters each.
Provider conversation details retain up to eight comments and eight checks; comment bodies are bounded to 500 characters in details and 2,000 in feedback delivery.
Oracle text fields are bounded to 16,000 characters.
Role-visible Archive reads include authorized Signal diagnoses, validation output, preparation diagnostics, and selected record evidence in a 24 KB UTF-8 packet.
Omissions and record continuation cursors are explicit; Work and record freshness are reported separately.
Capabilities, private runtime bindings, and raw transcripts are not model-facing decision evidence.

The workspace adapter prepares dependency artifacts before launching an Executor.
Remote acquisition permits only HTTPS artifacts from `registry.npmjs.org` with pinned SHA-512 integrity and rejects redirects.
Local `file:` artifacts are allowed only when they remain inside the authorized workspace and pass the same integrity and size checks.
Both paths use a private cache under the configured worktree root.
Downloaded tarballs use npm-recognized `.tgz` paths.
Preparation pins npm's project prefix, home, user configuration, and global configuration to private directories so ancestor project configuration cannot affect cache preparation.
Preparation permits two concurrent downloads, 50 MiB per artifact, 500 MiB per preparation, and a 120-second deadline.
Workspace dependency links must remain inside the authorized workspace.
A failed prerequisite records waiting attention and requires explicit User recovery instead of another replacement Executor.
Waiting prerequisites, held reservations, and exhausted budgets prevent model dispatch before launch.
Their attention records are deduplicated durably across polls and restarts, including when another error replaces the overview's current attention.
Held reservations request settlement or reconciliation, not an automatic budget increase.
The scheduler skips ineligible queued Missions, and deferred model effects do not block cleanup.
Explicit preparation recovery or a sufficient User budget amendment rechecks eligibility.
Governed commit and validation use `npm ci --ignore-scripts --offline` against the prepared cache, without an implicit build.
Dependency hydration and declared validation run inside Linux bubblewrap with a private network, PID namespace, temporary directory, and home.
Bubblewrap must already be installed and user namespaces permitted; Khala does not install it or run validation unrestricted when isolation fails.
The validation path must resolve inside the configured worktree root.
System runtime directories, Node, and the npm package for Node projects are read-only; the selected workspace and private dependency cache are persistently writable.
The host home, credential environment, and npm cache are not exposed.
Offline dependency resolution failures are reported rather than retried with unrestricted network or host-cache access.
Discovered Pi extensions, skills, prompt templates, and themes are disabled in role children; native repository context files remain enabled.
Failed Conclave effects retain their original identity rather than creating another wake for the same failure.
A deferred model effect does not prevent later cleanup or unrelated Work effects from being drained.
This does not isolate service-owned Git hooks or establish complete Pi child-process isolation.

Runtime stop waits for the owned process group to have no live members before removing its lease.
Cancellation and explicit failure request Executor stopping even when a resumed feedback or continuation turn occupies the effect pump.
Stop requests for independent Works proceed independently; one refusal does not prevent another stopped Work from receiving its stop request.
A surviving group blocks session takeover even after its leader exits.
Unattached cleanup with unprovable ownership fails closed and retains the lease for operator reconciliation.
Process-group confirmation does not contain descendants that deliberately create another session.
Windows process-tree cleanup is unsupported rather than treated as confirmed.

## Checks before relying on operations

Exhaust each role's allowance, crash with a held reservation, and verify that reconciliation cannot double-charge or refund uncertain usage.
Verify trusted repository overrides cannot increase global concurrency or change unrelated Work.
Exercise backup and trusted restore without silently creating a replacement for a missing marked Archive.
Use [Development](development.md) for repository check commands rather than duplicating build and test procedures here.
