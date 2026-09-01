# MVP design

## Purpose

This document specifies the Khala MVP.
It uses [glossary](glossary.md) terms and narrows the [lifecycle](lifecycle.md).
Khala governs isolated, code-writing Pi sessions without consuming or interrupting the User conversation.
Conclave, Observer, Executor, and Oracle run outside the User session through role-specific prompts.
Prompt identity is persisted for Executions, Observer bindings, and Oracle reviews.
Conclave wake identity is transient because the wake is not itself a durable lifecycle object.
Role settings change Khala's persisted role configuration and never change the User's active Pi model or settings.

The Archive is authoritative.
Runtime, Git, code-host APIs, models, and views provide evidence or projections.
They do not directly change lifecycle state.
Every lifecycle mutation has an actor, expected Work revision, and idempotency key.
Role settings are configuration changes rather than lifecycle mutations.
Tool visibility is not authority because the application service validates actor capability and current state.

## Primitives and roles

Khala has four durable primitives.

- Work is the stable User goal with terminal states `succeeded` and `stopped`.
- A stopped Work stores `stopReason` as either `failed` or `cancelled`.
- Mission is one immutable contract containing objective, scope, acceptance criteria, constraints, validation requirements, permitted paths, and authoritative context references.
- Execution is one bounded attempt at a Mission containing model, thinking mode, prompt identity, token allowance, sandbox, and Pi RPC binding.
- Record is one immutable Archive fact containing actor, bindings, payload version, summary, and evidence references.

User, Conclave, Observer, Executor, and Oracle are roles rather than durable primitives.
An Executor's implementation plan is transient child output.
Executor Signals and validation records bind to an Execution.
Observer assessments and provider observations are Work-level evidence and do not change Mission identity.
A Mission has at most one active Execution.
Historical Executions remain available through Archive records.

A User may amend Work terms before admission through `amend-terms`.
The Conclave may amend an inactive Mission through `amend-mission`.
Mission amendment creates a successor Mission with `predecessorMissionId` and a `mission-change` Record.
The predecessor is retained in Archive evidence and the successor becomes the current Mission projection.
Model or thinking changes apply to future Executions.
Runtime recovery rebinds the same Execution rather than creating a replacement.
A Work budget amendment creates a `work-amended` Record.

## Submission, input, and admission

A submission requires a title, objective, and at least one acceptance criterion.
It may provide context, scope, constraints, validation requirements, permitted paths, and a maximum token budget.
The default scope is repository-wide work.
The default validation command is `npm run check`; submissions can provide different commands when the project uses another validation workflow.
The default permitted path is the entire repository.
The default Work budget is 20,000 tokens and the default project concurrency is two Executions.

A Conclave can place submitted Work in `needs-input` with `request-input` when the intent is insufficient.
The request stores a reason and optional missing-field list as Archive evidence.
The User can answer through `amend-terms` while the Mission is not admitted.
Admission is available only after the Work returns to `submitted`.
Missing repository facts may launch one read-only Observer.
The Observer is not charged against the Work token budget and is bounded by a 120-second child-turn timeout.
Before admission it reads the submitted `allowedPaths`; the default is the entire repository.
The Observer records one bounded, evidence-backed `assessment` and stops.
It may discover facts, but it cannot invent objective, acceptance criteria, scope boundaries, constraints, or authorization.

The Conclave admits only safe, bounded Work with complete Mission terms and a resolved Work budget cap.
Admission is a role decision, while the service enforces state, capability, revision, and input contracts.
Before Execution reservation the service verifies the target branch, sandbox base, prompt binding, token allowance, and validation contract.
Permitted paths are stored as normalized repository-relative paths.
Direct `write` and `edit` calls outside those paths are blocked in the Executor session, including symlink escapes.
Executors do not receive arbitrary shell access.
They commit through the governed workspace action and run only the declared validation commands through the workspace adapter.
The service also rejects publication and ready evidence when the Git change set contains an outside path.

Each Execution reserves half of the configured Work token cap, rounded down with a minimum of one token.
The reservation is released when the Execution ends.
Observed input and output tokens are charged against the reservation as turns complete.
Each Execution has a fixed hard limit of 500 added code lines across the aggregate diff from its sandbox base, including multiple commits.
Commit, publication, and ready-Signal actions reject changes above that limit without discarding sandbox changes.
Cache counters remain usage metadata and are not added a second time to the budget total.
A turn that reaches its allowance puts the Execution in `blocked` with `blockReason` `budget-exhausted`.
The Conclave must replace that Execution or amend the Work budget.
Pi does not expose a per-session output-limit flag, so a single provider turn may overshoot the allowance before Khala can observe and stop it.

Admitted Work is scheduled FIFO by Archive sequence when the budget reservation and project concurrency permit it.
Parallel Work is assumed independent.
The MVP has no priority, dependency, peer-conflict, or User-override model.
The Work picker shows queue order, reservation, allowance, and the waiting reason.

## Lifecycle

```text
Submission -> needs-input | admission -> immutable Mission -> queued Execution
  -> running Executor -> draft review request -> ready Signal -> optional Oracle
  -> handoff Verdict -> awaiting review -> authorized feedback loop
  -> provider-confirmed merge -> succeeded Outcome
```

```text
Work:      submitted <-> needs-input; submitted -> queued -> active <-> awaiting-review
           -> succeeded | stopped
Mission:   admitted -> active <-> awaiting-review -> succeeded | rejected | superseded
Execution: queued -> running <-> awaiting-review -> completed | blocked | failed | stopped
```

A `ready` Signal requires nonempty evidence and current successful validation evidence when the workspace adapter supports governed validation.
A `ready` Signal and `handoff` Verdict are review handoff evidence rather than acceptance.
Only provider-confirmed merge evidence plus an explicit Conclave Outcome creates `succeeded`.
A provider may merge while Work is active or awaiting review.
The Conclave can record the Outcome from either state after verifying the reviewed head and merge commit.
Closure, rejection, failed CI, and monitor failures require reconciliation or an explicit decision.
An explicit failure or cancellation stops Work and preserves the decision in `stopReason`.

A blocked Execution does not end its Mission unless the Conclave rejects or replaces it.
A budget-exhausted Execution cannot be continued with a `continue` Verdict.
A failed or stopped Execution can be replaced under unchanged Mission terms.
Authorized review feedback can return an awaiting-review Execution to `running`.
Only the Conclave creates Verdicts.
`continue` preserves a non-exhausted Execution.
`replace` ends the current Execution and creates a replacement under the same Mission.
`handoff` enters User review after a ready Signal and open review request.
`reject` ends the current Mission without by itself failing or cancelling Work.

An inactive Mission can be amended only when its current Execution is absent, failed, or stopped.
The amendment records the predecessor, successor, reason, evidence, and disposition.
The successor resets review and Execution bindings and returns the Work to the FIFO queue.

## Signals, review, and monitoring

Only the current Executor sends `progress`, `blocked`, or `ready` Signals.
A `progress` Signal reports a meaningful implementation, publication, validation, or remediation phase change.
A `blocked` Signal reports why the current Execution cannot continue.
A `ready` Signal requires a current review request, head, diff, validation, and permitted-path evidence.

A draft review request is created through a reconciled application action before `ready`.
Khala commits and publishes the sandbox branch, then passes the branch and current head to the provider adapter.
Khala refreshes the configured remote target branch before creating an Execution and before publication.
The target branch must still point to the Execution's base commit at publication time.
GitHub Pull Requests and GitLab Merge Requests are supported review-request types.
`gh` and `glab` use their own authenticated sessions.
Khala stores no provider credentials.

Provider capabilities are checked before publication.
The built-in GitHub and GitLab adapters support draft review requests and merge observation.
GitHub polling records normalized checks, issue comments, submitted reviews, inline comments, and provider outcomes.
Failed checks wake the Conclave for reconciliation, and provider base/head drift blocks ready handoff.
GitLab polling records normalized CI/review status and provider outcomes but does not normalize comments or checks.
Feedback delivery is therefore GitHub-only in the MVP.

Monitoring emits observations rather than Signals or Verdicts.
Observation kinds are `ci-status`, `review-comment`, `feedback-delivery`, `monitor-failure`, and `provider-outcome`.
The User-facing `khala_poll_provider` adapter records changed observations and merge evidence.
Unchanged nonterminal polls update an in-memory heartbeat.
An unsettled provider merge is durably requeued for Conclave settlement.
Provider observations can wake the Conclave through the transactional outbox.
The autonomous monitor runs once per minute while the parent service is alive.
Monitor failures are retained as retryable evidence without an exhaustion threshold.

Provider text is untrusted evidence.
At publication Khala records the provider-native principal ID.
GitHub feedback is actionable only when it has a trusted author association and, for review records, is a submitted actionable review.
The authenticated principal is retained as review-request ownership evidence, not as a restriction that excludes other trusted reviewers.
The User may inspect provider text even when it is not eligible for delivery.
Eligible feedback is not a direct instruction.
The Conclave checks Mission fit and creates one bounded Delivery for an observation.
Replay cannot redeliver a completed Delivery.
Failed delivery remains pending or becomes attention evidence and does not automatically end the Execution or Mission.

After `ready` and before `handoff`, the Conclave may call `khala_run_oracle`.
The packet contains the Mission, review diff, declared validation commands, and the latest bounded provider observation summary when one exists.
It excludes the Executor prompt, transcript, and conclusion.
The no-tools Oracle returns advisory findings only.
The Oracle Record stores its prompt identity and parsed result.
The Conclave records the disposition by issuing the final Verdict.

## Pi-native interaction and supervision

`/khala` is quiet and on demand.
It opens no view unprompted and emits no child-session traffic into the User conversation.
Role settings never change the User's active model or settings.

The first view lists Work by title.
Each row is a Work rather than a Mission.
Selecting Work opens an overview with Work, Mission, Execution, runtime state, linked review request, next action, and navigation to Actions, Evidence, Peer-Review, and Archive.
The overview omits repeated revision, budget, and token metadata.
Actions shows only enabled actions.
Evidence is derived from relevant Archive records.
Archive lists all records newest first with complete metadata and structured fields.
Provider comments appear in Peer-Review.
Empty values and sections are omitted.

Navigation never writes.
State is communicated by labels as well as color.
Recovery rereads Archive state and reconciles runtime, workspace, model, and provider bindings.
Recovery updates one in-TUI panel and remains non-dismissible until the operation finishes.

The parent supervisor consumes durable outbox effects and owns Executor launches.
A Conclave child cannot kill the Executor during its own shutdown.
The supervisor exists only for the lifetime of the hosting User Pi session.
Closing that session waits for monitor, effect, and runtime operations before closing the Archive.
A new User Pi session opens the same project Archive.
The Pi command `/khala-recover` drains pending effects and reconciles persisted runtime bindings.
The autonomous monitor performs the same reconciliation on its next cycle.

Runtime liveness is an observation rather than lifecycle state.
The supported values are `working`, `pending`, `idle`, `unreachable`, and `unknown`.
It is derived from the persisted session binding and a bounded Pi RPC probe.
A PID alone never proves that Work is active.
A running Mission with an unreachable Executor remains active until recovery, replacement, or explicit Work failure.

## Application interface

The current application service surface is:

```text
submitWork(input, meta)                         -> WorkView
listWork()                                      -> readonly WorkSummary[]
inspectWork(workId)                             -> WorkView
inspectRuntime(workId, meta?)                   -> Promise<WorkView>
availableActions(workId, actor, revision?, runtimeState?)   -> readonly Action[]
perform(command)                                -> Promise<ServiceResult<WorkView>>
readRecords(query, meta, cursor?)               -> Page<RecordView>
readRecordSummaries(query, meta)                 -> Page<RecordSummaryView>
pollProvider(workId, meta)                      -> Promise<WorkView>
```

The Pi tools are `khala_submit_work`, `khala_read_archive`, `khala_poll_provider`, `khala_inspect_runtime`, `khala_perform_action`, `khala_record_signal`, `khala_record_assessment`, and `khala_run_oracle`.

Every lifecycle mutation uses `CommandMeta` with `commandId`, actor, expected Work revision, schema version, and role binding fields when applicable.
Repeated command IDs return the previous result for the same Work.
Revision conflicts require a reread and never trigger an implicit semantic retry.

`Action` exposes an opaque ID, Work scope, action kind, label, enabled state, disabled reason, and expected revision.
The current implementation does not populate input schemas or confirmation metadata.
`RecordView` exposes sequence, record numbers, opaque ID, kind, actor, bindings, payload version, summary, evidence references, timestamp, and bounded payload.
`ErrorEnvelope` exposes code, summary, retryability, remediation, evidence references, and optional learning data.

Record queries support Work, Mission, Execution, kind, state, and time filters.
Filters compose with AND.
Repeated kind and state values compose with OR.
Results are ordered by Archive sequence.
An Archive cursor binds normalized filters, an as-of sequence, and the last returned sequence.
The service revalidates actor and role scope on every page rather than embedding authorization in the Archive cursor.

## Ports and external effects

The service uses narrow ports for Archive, runtime, workspace, code host, models, and Oracle behavior.

```text
ArchivePort       append, updateCommandProjection, findCommand,
                  pendingEffects, completeEffect, releaseEffect, renewEffect,
                  query, querySummaries, project, findObservation, findLatestObservation,
                  listProjects, close
AgentRuntimePort  ensureSession, send, getState, requestStop, close
WorkspacePort     preflight, ensureSandbox, inspectHead, inspectAddedLines,
                  inspectChanges, commitSandbox?, runValidation?, publishSandbox,
                  removeSandbox
CodeHostPort      capabilities, identity, ensureReviewRequest, poll,
                  inspectOutcome
ModelCatalogPort  listScoped, resolve
OraclePort        review
```

Local Git belongs to `WorkspacePort`.
Remote review requests belong to `CodeHostPort`.
The repository origin selects the GitHub or GitLab adapter.
Every external effect has a stable Khala ID and uses ensure or reconcile semantics where the provider supports them.
After an unknown result, recovery reconciles before retrying.

Replacing, failing, cancelling, or completing an Execution removes its local worktree and local branch after active turns finish.
Remote review requests and remote branches are retained for audit and provider history.
The MVP does not automatically close or delete those remote objects.

## Configuration, errors, and persistence

Global configuration is read from `~/.pi/agent/khala.json` or the directory selected by `PI_CODING_AGENT_DIR`.
A trusted project may override it with `.pi/khala.json`.
Untrusted project-local configuration is ignored.
Configuration precedence and defaults are documented in [Operations](operations.md).

Expected failures use the typed `ErrorEnvelope` when they pass through `perform`.
A direct submission error is converted to a tool error by the Pi adapter.
Khala may retry idempotent transport calls.
It never silently retries semantic decisions, substitutes a model, increases an allowance, merges code, changes scope, or redelivers completed feedback.
Failed feedback remains durable evidence and requires an explicit retry after reconciliation.

The first Archive creation writes an initialization marker beside the SQLite file.
If that marker remains while the SQLite file is missing, Khala fails closed instead of creating a replacement Archive.
Archive integrity failure also fails closed because Khala has no in-process restore mechanism.
The SQLite Archive uses WAL mode and short `BEGIN IMMEDIATE` transactions.
Each append checks the expected Work revision, writes the Record, updates the projection, and enqueues external effects atomically.
Opening an older Archive may add missing command/projection columns, migrate repository-wide path scopes, normalize legacy terminal Work states, and allocate missing record numbers.
These startup migrations are the supported mutations of historical storage.
Archive backup and restore are operator responsibilities; preserve the SQLite database and initialization marker, and do not copy database or WAL files independently during active writes.

## MVP exclusions

The MVP excludes automatic merge, automatic token top-up, generic semantic retry, priority controls, dependencies, peer-conflict detection, non-Git VCS, provider webhooks, and more than one active Execution per Mission.
It supports GitHub and GitLab review requests.
It supports GitHub feedback delivery.
It supports GitLab status and merge observation without GitLab feedback delivery.
It supports parallel assumed-independent Work within token and concurrency limits.
