# Data model reference

Khala stores an append-only Archive in embedded SQLite. `src/model.ts` is the
source of truth for public discriminants and `src/archive.ts` is the durability
implementation.

## Archive

The database uses WAL mode and contains:

- `archive_records`: immutable records with sequence, opaque record ID, actor,
  Work/Mission/Execution bindings, payload version, bounded summary, evidence
  references, payload, and timestamp.
- `work_projection`: the current Work view and revision.
- `outbox`: pending external effects written in the same transaction as their
  causative record.

Every append supplies an expected Work revision and command ID. A repeated
command ID returns its earlier record and projection. A revision mismatch rolls
back the transaction and returns a revision conflict. The Archive never
interprets runtime reachability or provider text as lifecycle authority.

## Durable primitives

### Work

A Work contains User intent and a terminal state: `succeeded`, `failed`, or
`cancelled`. The MVP view also exposes `submitted`, `needs-input`, `queued`,
`active`, and `awaiting-review`. Its budget stores the Work cap, reserved token
allowance, and consumed allowance. USD cost is not part of the budget model
because provider pricing and actual usage are not persisted.

### Mission

Admission creates one immutable Mission with copied terms and Mandate revision
one. Mission terms do not change in place. A later term change must be recorded
as a successor Mission and `mission-change` evidence.

### Execution

An Execution binds one Mission to model, thinking level, token allowance,
prompt identity, Git sandbox, and Pi session. Its states are `queued`, `running`,
`awaiting-review`, `completed`, `blocked`, `failed`, and `stopped`. A Mission has
at most one active `queued`, `running`, or `awaiting-review` Execution. Khala
also records the latest runtime state and cumulative input, output, cache-hit,
and cache-miss token usage reported by Pi.

### Record

Record kinds include `submission`, `assessment`, `learning`, `mission`,
`mission-change`, `execution`, `signal`, `review-request`, `observation`,
`delivery`, `verdict`, `oracle-review`, `outcome`, `error`, and `work-amended`.
Record views are bounded. Queries compose Work, Mission, Execution, kind, state,
and time filters with AND; repeated values within a field use OR. Results are
ordered by Archive sequence. A cursor binds filters and an as-of sequence.

## Provider evidence

GitHub and GitLab review requests are reconciled by deterministic Work markers.
Khala stores provider-native IDs, URLs, branch/head information, validation,
review status, and bounded observations. Provider text is untrusted evidence.
A merged provider observation is required before the Conclave can record the
Work Outcome.

## Runtime bindings

Pi child sessions use JSON-RPC over stdin/stdout. Khala persists the Pi session
ID and session path but never copies the child transcript into the Archive.
`working`, `pending`, `idle`, `unreachable`, and `unknown` are runtime
observations, not lifecycle states.
