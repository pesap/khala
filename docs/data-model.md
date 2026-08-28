# Data model reference

Khala stores an append-only Archive in embedded SQLite. `src/model.ts` is the
source of truth for public discriminants and `src/archive.ts` is the durability
implementation.

## Archive

The database uses WAL mode and contains:

- `archive_records`: immutable records with an internal sequence, opaque record
  ID, actor, Work/Mission/Execution bindings, payload version, bounded summary,
  evidence references, payload, and timestamp.
- `archive_record_numbers`: immutable numbering for each record, including its
  overall `record_number` and optional per-Mission `mission_record_number`.
- `work_projection`: the current Work view and revision.
- `outbox`: pending external effects written in the same transaction as their
  causative record.

Every append supplies an expected Work revision and command ID. A repeated
command ID returns its earlier record and projection. A revision mismatch rolls
back the transaction and returns a revision conflict. Opening an Archive
normalizes legacy `failed` and `cancelled` Work projections to `stopped` with a
`stopReason`. The Archive never interprets runtime reachability or provider text
as lifecycle authority.

## Durable primitives

### Work

A Work contains User intent and a terminal state: `succeeded` or `stopped`.
A stopped Work carries a `stopReason` of `failed` or `cancelled`. The MVP view
also exposes `submitted`, `needs-input`, `queued`,
`active`, and `awaiting-review`. A User can rename the Work label through a
`work-amended` record. The admitted Mission keeps its immutable copied terms.
Its budget stores the Work cap, reserved token
allowance, and consumed allowance. USD cost is not part of the budget model
because provider pricing and actual usage are not persisted.

### Mission

Admission creates one immutable Mission with copied terms and Mandate revision
one. Mission terms do not change in place. A later term change must be recorded
as a successor Mission and `mission-change` evidence.

### Execution

An Execution binds one Mission to model, thinking level, token allowance,
prompt identity, Git sandbox, and Pi session. Its states are `queued`, `running`,
`awaiting-review`, `completed`, `blocked`, `failed`, and `stopped`. Runtime
failures retain bounded learning evidence describing what failed and whether
Mission specificity should be revisited. A Mission has
at most one active `queued`, `running`, or `awaiting-review` Execution. Khala
also records the latest runtime state and cumulative input, output, cache-hit,
and cache-miss token usage reported by Pi.

### Record

Record kinds include `submission`, `assessment`, `learning`, `mission`,
`mission-change`, `execution`, `signal`, `review-request`, `observation`,
`delivery`, `verdict`, `oracle-review`, `outcome`, `error`, and `work-amended`.
Record views are bounded. Each view exposes the internal sequence for cursor
ordering, the overall record number, and a per-Mission record number when the
record belongs to a Mission. Queries compose Work, Mission, Execution, kind,
state, and time filters with AND; repeated values within a field use OR. Results
are ordered by internal Archive sequence. A cursor binds filters and an as-of
sequence.

## Provider evidence

GitHub and GitLab review requests are reconciled by deterministic Work markers.
Khala stores provider-native IDs, URLs, branch/head information, validation,
review status, and bounded observations. GitHub conversation details retain at
most 8 comments and 8 checks with bounded fields; individual review-feedback
observations do not duplicate the full conversation. Review comments retain
stable observation IDs and bounded feedback lists so replay cannot redeliver them.
Provider text is untrusted evidence.
A merged provider observation is required before the Conclave can record the
Work Outcome.

## Runtime bindings

Pi child sessions use JSON-RPC over stdin/stdout. Conclave and Oracle turns are
ephemeral; Observer sessions may persist a session path. Persistent sessions use
an exclusive process-owned launch lease and transcript files are restricted to
the Khala process owner. Khala never copies child transcripts into the Archive.
`working`, `pending`, `idle`, `unreachable`, and `unknown` are runtime
observations, not lifecycle states.
