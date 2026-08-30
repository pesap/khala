# Data model reference

Khala stores an append-only Archive in embedded SQLite.
`src/model.ts` is the source of truth for public discriminants.
`src/archive.ts` is the durability implementation.

## Archive

The database uses WAL mode and contains:

- `archive_records` stores immutable records with sequence, opaque ID, actor, Work/Mission/Execution bindings, payload version, bounded summary, evidence references, payload, and timestamp.
- `archive_record_numbers` stores immutable global and per-Mission record numbers.
- `work_projection` stores the current Work view and revision.
- `outbox` stores pending external effects written in the same transaction as their causative record.

Every append supplies an expected Work revision and command ID.
A repeated command ID returns its earlier record and projection.
A revision mismatch rolls back the transaction and returns a revision conflict.
The first Archive creation writes an initialization marker beside the SQLite file so a missing database cannot be silently replaced.
Opening an older Archive may add missing command/projection columns, migrate legacy Work states and missing path scopes, and allocate missing record numbers before reading projections.
These startup migrations are the supported mutations of historical storage.
The Archive never interprets runtime reachability or provider text as lifecycle authority.

## Durable primitives

### Work

A Work contains User intent and a terminal state of `succeeded` or `stopped`.
A stopped Work carries a `stopReason` of `failed` or `cancelled`.
The view also exposes `submitted`, `needs-input`, `queued`, `active`, and `awaiting-review`.
A User can rename the Work label or amend pre-admission terms through a `work-amended` Record.
The admitted Mission keeps its immutable copied terms.
Its budget stores the Work cap, current reservation, and observed input and output consumption.

### Mission

Admission creates one immutable Mission with copied terms and Mandate revision one.
Mission terms include permitted repository-relative paths.
Mission terms do not change in place.
A later term change creates a successor Mission with `predecessorMissionId` and `mission-change` evidence.
The predecessor remains available in Archive records.

### Execution

An Execution binds one Mission to model, thinking level, token allowance, prompt identity, Git sandbox, and Pi session.
Its states are `queued`, `running`, `awaiting-review`, `completed`, `blocked`, `failed`, and `stopped`.
A blocked Execution has a `blockReason` of `signal` or `budget-exhausted`.
A Mission has at most one active `queued`, `running`, or `awaiting-review` Execution.
An `awaiting-review` Execution continues to count toward the project Execution limit until it ends.
Historical Executions remain available through Archive records.
Khala records the latest runtime state and cumulative input, output, cache-hit, and cache-miss token usage reported by Pi.
Executor validation records bind passed or failed command results to an Execution and exact sandbox head.
Only input and output tokens count toward the Work budget.

### Record

Record kinds include `submission`, `assessment`, `learning`, `mission`, `mission-change`, `execution`, `validation`, `signal`, `review-request`, `observation`, `delivery`, `verdict`, `oracle-review`, `outcome`, `error`, and `work-amended`.
Record views are bounded.
Each view exposes internal sequence, global record number, optional per-Mission record number, opaque ID, kind, actor, bindings, payload version, summary, evidence references, timestamp, and bounded payload.
Queries compose Work, Mission, Execution, kind, state, and time filters with AND.
Repeated kind and state values use OR.
Results are ordered by internal Archive sequence.
An Archive cursor binds normalized filters, an as-of sequence, and the last returned sequence.
The service revalidates authorization on every page.

## Provider evidence

GitHub and GitLab review requests are reconciled by deterministic Work markers.
Khala stores provider-native IDs, URLs, branch and head information, validation, review status, and bounded observations.
GitHub conversation details retain at most eight comments and eight checks with bounded fields.
GitLab polling stores normalized CI/review status and merge observations but does not normalize comments or checks.
Review comments retain stable observation IDs and bounded feedback lists so replay cannot redeliver them.
Provider text is untrusted evidence.
`ProviderObservation` is a discriminated union keyed by its `kind`.
CI observations use the finite review and check-status vocabulary.
Review-comment observations use comment-specific statuses.
Feedback-delivery and monitor-failure observations use their own status vocabularies.
Provider-outcome observations always represent a merged review and require repository, branch, head, and merge-commit identity.
A merged provider observation is required before the Conclave can record the Work Outcome.
`ProviderCheck.status` remains provider-native text because individual providers expose different check-state vocabularies.

## Runtime bindings

Pi child sessions use JSON-RPC over stdin and stdout.
Conclave and Oracle turns are ephemeral.
Observer sessions may persist a session path.
Persistent sessions use an exclusive process-owned launch lease.
Ephemeral sessions use runtime-owned paths and reject child-reported paths outside those paths.
Transcript files are restricted to the Khala process owner.
Prompt identity is persisted for Executor bindings, Observer bindings, and Oracle records.
Khala never copies child transcripts into the Archive.
