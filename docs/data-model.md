# Khala Data Model

`src/khala-model.ts` is the single source of truth for durable record shapes,
discriminants, statuses, and guards. The Archive is an append-only, project-scoped
JSONL log at `<archiveRoot>/<projectKey>/archive.jsonl`.

## Archive envelope

Each line contains:

| Field | Purpose |
| --- | --- |
| `recordId` | Unique identifier for the historical line. |
| `schemaVersion` | `2` on current writes; absent or `1` means legacy history. |
| `type` | `submission`, `mandate`, `mission`, `execution`, `signal`, `verdict`, `counsel`, or `learning`. |
| `projectPath` | Resolved project identity. |
| `workId` | Work lifecycle identifier. |
| `executionId` | Optional execution binding. |
| `recordedAt` | Append timestamp. |
| `payload` | Type-specific guarded record. |

Version-1 envelopes remain readable without fabricating Mandates, Missions,
participants, or assignments. Current code writes version 2 records. A valid
legacy queued submission may be admitted prospectively by creating a new Mandate
that cites its real historical submission record; old launched or executed
records are not backfilled.

The Archive is history, not a mutable table. Current state is projected from the
latest append-order record for an identifier. Physical append order is the
authoritative tie-breaker; timestamps are not used to repair ordering.

A short-lived process-aware local lock protects read-modify-append lifecycle
operations. It prevents local interleaving but is not a distributed lock and
is not crash-atomic. Batch appends are ordered and recovery-visible, not
transactional across processes.

## Lifecycle

```text
Work Submission
  └─ queued / reviewing / admitted / rejected
       ├─ submission-scoped Observer Execution ──► Learning
       └─ admitted Work
            └─ Mandate revision 1
                 └─ immutable Mission
                      └─ runtime Execution(s)
                           └─ Signal ──► Verdict
```

A Work Submission is not authoritative Work until the dedicated project
Conclave admits it. Admission copies the submitted terms into Mandate revision
1 and records the source submission line and Conclave participant ID.

A Mission pins exactly one Mandate revision and contains an immutable complete
assignment. It has no mutable status field. Projections derive its state:

- a successor referencing `predecessorMissionId` supersedes it;
- Finish or Reject Verdicts make it terminal;
- a Retry Verdict without its successor is `retry-pending` and requires recovery;
- otherwise it is current and eligible for an Executor runtime.

Retry appends the Verdict, failed predecessor Execution snapshot, and complete
successor Mission in one ordered local batch. The successor uses the same
assignment shape, may change its terms, and never rewrites the predecessor.
Recovery detects missing successors, missing causal Verdicts, duplicate
successors, and Missions with no materialized Execution.

## Records

### Work Submission

`KhalaWork` contains title, objective, context, scope, acceptance criteria,
constraints, plan, and validation. Required semantic fields and list entries
must be nonblank. Context may be empty only when sufficient Work-scoped
Observer Learning resolves it before admission.

Legacy `launching` and `launched` submission states remain readable for v1
archives. New code uses `queued`, `reviewing`, `admitted`, and `rejected`.
Observer launch changes `queued` to `reviewing`; current completion or failure
returns it to `queued`. Admission is distinct from runtime launch and Retry.

### Mandate

A `MandateRecord` contains `mandateId`, `workId`, positive `revision`, the
source submission `recordId`, immutable submitted `terms`, local Conclave
participant attribution, and admission time. Only revision 1 admission is
currently exposed; no tool creates revision 2.

### Mission

A `MissionRecord` contains `missionId`, `workId`, `mandateId`, optional
predecessor and causal Verdict IDs, immutable `assignment`, assigned local
participant ID, and creation time. Runtime details and mutable status never
belong in this record.

### Execution

An `ExecutorRecord` contains runtime bindings and an explicit purpose:

- `{ kind: "mission", missionId }` for an Executor;
- `{ kind: "observation", submissionRecordId }` for a submission-scoped Observer.

New executions use `starting`, then `running`, `finished`, or `failed`. A
sandbox callback binds runtime location; launcher success is required before
`running`. Generic runtime updates cannot alter Work, purpose, Mission, Mandate,
or participant identity. Participant IDs are stable local attribution labels,
not authenticated identities.

### Signal and Verdict

A Signal is Executor-only evidence for its current Mission and participant.
Signals cannot authorize a transition and are rejected after terminal or
superseded state.

A Verdict is Conclave-only judgment for one Signal. It records the Mission,
governing Mandate, issuing Conclave participant, and decision. Exact replays
return the existing durable Verdict without appending; conflicting replays are
rejected. Continue leaves the current runtime active. Finish and Reject close
it. Retry requires a complete successor assignment and materializes a successor
Mission; it does not requeue the old submission.

Counsel remains Preserver-only advisory input. Learning remains Observer-only,
Work-scoped evidence. Neither can authorize a lifecycle transition.

## Validation and read errors

Every payload has a matching guard in `khala-model.ts`, and the envelope guard
validates the declared payload type. Invalid typed payloads are corruption, not
an empty projection. Typed projections in
`src/khala-archive-projections.ts` centralize current-state queries; raw Archive
inspection remains separate.

A missing or zero-length Archive returns an empty list. An unreadable Archive,
malformed JSON, blank/whitespace line, invalid envelope, unsupported schema, or
invalid typed payload throws `KhalaArchiveReadError` with the Archive path and,
when applicable, line number. Errors never include malformed payload contents.
Only the empty final segment created by a normal trailing newline is ignored.
Callers must fail closed rather than converting corruption or lock contention to
empty state.

Archive-root selection is explicit: Pi's trusted-project signal may enable a
project `.pi/khala.json` override. Standalone and untrusted callers use the
global root by default, and no automatic migration or fallback occurs.
