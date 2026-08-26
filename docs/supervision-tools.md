# Application actions

Pi tools are thin actor-scoped adapters. They call the application service and
never read SQLite or interpret lifecycle rules themselves.

## User

- `khala_submit_work` records complete User intent and schedules Conclave
  processing.
- `khala_read_archive` reads bounded authorized projections.
- `khala_perform_action` can rename Work, record provider review evidence, or
  explicitly cancel Work.

## Conclave

- `khala_read_archive` reads authoritative records.
- `khala_inspect_runtime` performs a read-only liveness inspection for the
  bound Work.
- `khala_perform_action` admits Work, launches an Observer, starts or replaces
  an Execution, recovers an unreachable Executor, issues a Verdict, delivers
  bounded provider feedback, runs the Oracle, and records a Work Outcome.
- `khala_run_oracle` is a convenience adapter for the bounded Oracle packet.

## Observer and Executor

- `khala_read_archive` is role-filtered.
- `khala_record_assessment` records one bounded Observer assessment.
- `khala_record_signal` records progress, blocked, or ready Executor evidence.
- `khala_perform_action` remains available only for role-authorized actions.

Provider polling records stable GitHub review-comment observations. The Conclave
assesses each new comment against the Mission and may authorize one bounded
delivery to the same Execution. That delivery is queued through the existing
Executor outbox and recovery path, so the User does not need to respond after
polling. A duplicate poll cannot redeliver the same observation.

Oracle sessions have no Khala tools. Monitoring uses the service's provider
ports and records changed observations only.

Every mutation requires:

```text
CommandMeta {
  command_id,
  actor,
  expected_work_revision,
  schema_version
}
```

The service revalidates actor, action, current state, input, and revision. A
repeated command ID returns its earlier result. A revision conflict requires a
reread; it never performs an implicit retry or merges state.

## Autonomous monitoring

The root Khala service runs an unref'ed autonomous cycle without opening or sending to the user's primary Pi session. It polls active review requests, normalizes GitHub conversation, submitted-review, and inline review comments, and records provider-monitor failures in the Archive for retry and inspection. A changed Executor runtime is persisted; an unreachable runtime schedules a Conclave shadow wake with an explicit recovery prompt. A transient Conclave child startup exit is retried once by the runtime and once by the outbox worker; persistent failures remain pending with durable evidence.

Provider feedback authorization creates one pending delivery record and one durable feedback effect per observation. GitHub feedback is actionable only when it comes from the authenticated review principal, a trusted author association, and a submitted actionable review state; other provider text remains evidence. The record becomes delivered: true only after the Executor turn completes; failed sends release the same effect for a later monitor cycle instead of dropping the feedback. Child Conclave and Executor services do not start another root monitor.
