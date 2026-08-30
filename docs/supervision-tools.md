# Application actions

Pi tools are thin actor-scoped adapters.
They call the application service and never read SQLite or interpret lifecycle rules themselves.

## User

- `khala_submit_work` records complete User intent and schedules Conclave processing.
- `khala_read_archive` reads bounded authorized records.
- `khala_inspect_runtime` reads runtime liveness without writing the Archive.
- `khala_poll_provider` records changed provider observations and merge evidence.
- `khala_perform_action` supports pre-admission term amendments, Work renames, budget amendments, review evidence, recovery, cancellation, and explicit failure.

## Conclave

- `khala_read_archive` reads authoritative records for its bound Work.
- `khala_inspect_runtime` performs a read-only liveness inspection for an authorized Work.
- `khala_perform_action` can request User input, admit Work, amend an inactive Mission, launch an Observer, start or replace an Execution, recover an Executor, commit sandbox changes, run declared validation, issue a Verdict, deliver bounded provider feedback, and record a Work Outcome.
- `khala_run_oracle` runs the bounded no-tools Oracle review.

## Observer and Executor

- `khala_read_archive` is role-filtered and scope-bound.
- `khala_record_assessment` records one bounded Observer assessment.
- `khala_record_signal` records progress, blocked, or ready Executor evidence.
- `khala_perform_action` remains available only for role-authorized actions.

Oracle sessions have no Khala tools.
The Oracle receives only the bounded review packet.
Restricted child sessions are deny-by-default for Pi tools.
Conclave receives only its Khala governance tools, Observer receives read-only repository tools plus its assessment tool, and Executor receives read/write repository tools plus its signal and action tools.
The extension rejects unapproved tool calls even if another extension or runtime configuration exposes them.

Every lifecycle mutation requires:

```text
CommandMeta {
  commandId,
  actor,
  expectedWorkRevision,
  schemaVersion,
  roleToken?,
  roleNonce?,
  boundWorkId?,
  boundExecutionId?
}
```

The service revalidates actor, action, current state, input, and revision.
Validation, authorization, revision, and provider failures are surfaced as Pi tool errors rather than successful result objects.
Active tool filtering is only a convenience; every handler also enforces its session role.
A repeated command ID returns the projection captured by the original command and its original record for the same Work.
A revision conflict requires a reread and never performs an implicit semantic retry.
`khala_read_archive` output is capped at 48 KB and 1,800 lines; use its cursor or narrower filters for more records.

## Provider polling

The root service polls active review requests once per minute while its hosting User Pi session is alive.
`khala_poll_provider` can trigger the same poll explicitly.
Polling records changed observations, provider check failures, and provider merge evidence.
A changed provider head or base is surfaced as reconciliation evidence before ready handoff.
It never merges or accepts Work automatically.

GitHub polling normalizes checks, issue comments, submitted reviews, inline comments, and provider outcomes.
GitLab polling normalizes CI/review status and provider outcomes but does not normalize comments or checks.
GitHub feedback can be delivered after Conclave Mission-fit assessment.
Provider feedback is untrusted evidence and is quoted before it reaches an Executor.
GitLab feedback delivery is not part of the MVP.

A changed Executor runtime is persisted.
The parent User recovery action can rebind an unreachable runtime.
Child role sessions cannot invoke User recovery tools or impersonate the parent.
An unreachable runtime schedules a Conclave recovery wake.
A transient Conclave startup exit is retried once by the runtime and once by the outbox worker.
Persistent failures remain pending with durable evidence.

## Outbox and shutdown

Pending effects are processed by one worker pass at a time.
Effect claims expire after two minutes and are renewed while an effect is running.
Provider feedback uses one durable effect per observation.
A failed delivery releases that same effect for a later cycle.
A completed Delivery cannot be redelivered.

The parent supervisor owns Executor launches and child cleanup.
Persistent session leases prevent two supervisors from owning one child session.
Child Conclave and Executor services do not start another root monitor.
Service shutdown waits for monitor, effect, background runtime operations, and in-flight child launches before closing the Runtime or Archive.
