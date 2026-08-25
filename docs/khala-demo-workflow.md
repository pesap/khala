# A complete Khala Work workflow

This page shows how to follow one Work from submission through review. The
examples use placeholders; they are shapes, not Archive records or evidence.

## 1. Submission and Mission admission

A User submits complete Work terms. The application service records a
`submission` and schedules Conclave processing. A successful submission does
not yet mean that a Mission or Execution exists.

The Conclave reads the submission and, when its terms are complete, admits a
Mission. The Archive then contains a `mission` record with a stable Mission ID
and the copied assignment. Mission admission still does not prove that an
Executor is running.

## 2. Queued and running Execution

The Conclave starts an Execution when budget, concurrency, and the current
Mission permit it. The Archive records the Execution as `queued`; after the
Executor runtime is established, a later Execution record shows `running`.

Keep these facts separate:

- **Work state** describes the governed Work, such as `submitted`, `active`, or
  `awaiting-review`.
- **Mission state** describes the current immutable assignment, such as
  `admitted` or `active`.
- **Execution state** describes the attempt, such as `queued`, `running`, or
  `awaiting-review`.
- **Runtime state** describes an observation of the Executor process. It is
  evidence about reachability or activity, not authorization for a lifecycle
  transition.

## 3. Read the authoritative Archive

`khala_read_archive` returns bounded, append-ordered record projections. Use a
continuation cursor when the response says more records are available. Supply
only identifiers and filters that are known from the current Work; do not make
up IDs.

```json
{
  "workId": "<work-id>",
  "missionId": "<mission-id>",
  "executionId": "<execution-id>",
  "kinds": ["submission", "mission", "execution", "signal", "review-request"],
  "states": ["submitted", "admitted", "queued", "running", "awaiting-review"],
  "cursor": "<next-cursor-from-the-previous-page>"
}
```

A first read normally omits `cursor`. The returned projections identify the
record kind, Work/Mission/Execution bindings, state, summary, and evidence
references. A cursor is an exact Archive record identifier; timestamps do not
replace it.

## 4. Executor Signals

The Executor reports observable progress rather than acceptance. A progress
Signal should identify a concrete repository fact, such as a file read or a
validation command. A blocked Signal explains the blocking evidence. A ready
Signal is reserved for a complete review handoff.

For example, the evidence for two progress Signals might be:

- `docs/khala-demo-workflow.md` was created and contains the lifecycle sections
  required by the Mission.
- `git diff --check` completed successfully for the documentation change.

Signals are append-only evidence. The Conclave may assess a current Signal and
continue, retry, finish, or reject the Mission; a Signal itself is not a
Verdict.

## 5. Draft review request

Before a ready Signal, the Executor commits the change, publishes its branch,
and creates a draft review request through the application service. The
request must match the current sandbox branch, target branch, head commit,
diff, and validation evidence. A review request is a review artifact, not an
acceptance decision.

An Executor-authorized action has this shape:

```json
{
  "action": "create-review-request",
  "workId": "<work-id>",
  "expectedWorkRevision": 7
}
```

The revision is an example only. Use the current revision returned by the
Archive or the preceding application-service result. A revision conflict
requires a fresh Archive read; it is not an invitation to retry with a guessed
revision.

After the draft request is reconciled with the published branch, the Executor
can send a ready Signal containing the current head, diff, and validation
facts. The application service rejects a ready handoff when those bindings are
missing or stale.

## 6. User review

The User inspects the draft request and records an external review outcome
through `khala_perform_action`. This example records an open review without
claiming that a provider has actually returned one:

```json
{
  "action": "record-review",
  "workId": "<work-id>",
  "input": {
    "status": "open",
    "feedback": []
  },
  "expectedWorkRevision": 8
}
```

`expectedWorkRevision` must be the current Work revision and `feedback` should
contain only observed reviewer comments. A changes-requested review starts a
successor Mission; a merged review requires externally observed merge
evidence. Neither review action should be inferred from a local branch or a
runtime status.

A Work Outcome is recorded only after the Conclave verifies a merged review
request. A ready Signal, a Finish decision, or a draft review request alone is
not acceptance.

## Evidence checklist

When documenting or operating a workflow, verify the following in order:

1. The submission and Mission are present in the Archive.
2. The Execution is queued or running according to an Archive record.
3. Progress Signals cite concrete repository evidence.
4. The committed and published head matches the draft review request.
5. Validation results are recorded before the ready Signal.
6. User review evidence is kept separate from Executor evidence.
7. No merge or Work Outcome is claimed without provider-confirmed evidence.
