# Application actions

Pi tools are thin actor-scoped adapters. They call the application service and
never read SQLite or interpret lifecycle rules themselves.

## User

- `khala_submit_work` records complete User intent and schedules Conclave
  processing.
- `khala_read_archive` reads bounded authorized projections.
- `khala_perform_action` can record provider review evidence or explicit
  cancellation.

## Conclave

- `khala_read_archive` reads authoritative records.
- `khala_perform_action` admits Work, launches an Observer, starts or replaces
  an Execution, issues a Verdict, runs the Oracle, and records a Work Outcome.
- `khala_run_oracle` is a convenience adapter for the bounded Oracle packet.

## Observer and Executor

- `khala_read_archive` is role-filtered.
- `khala_record_assessment` records one bounded Observer assessment.
- `khala_record_signal` records progress, blocked, or ready Executor evidence.
- `khala_perform_action` remains available only for role-authorized actions.

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
