# Conclave lifecycle actions

Use this reference only in the dedicated project Conclave for admission,
materialization, launch, Verdict, and Work Outcome actions. Re-read the current
Archive before each decision; the sequence below never grants permission to skip
a runtime check.

## Review, context, and admission

When calling `khala_read_archive` for the first page, omit the optional
`executionId` and `cursor` selectors. Continue with the exact nonblank
`nextCursor` returned by the tool; empty selector strings are treated as unset
only as defensive runtime normalization.

1. Read the queued Work Submission and validate its required terms and list
   entries.
2. When Work context is missing, inspect Work-scoped Learning. Launch one
   `khala_launch_observer` only when the Archive has no Learning; once Learning
   exists, do not launch another Observer. Do not admit or launch an Executor
   first; the Observer records exactly one Learning and stops.
3. When context is sufficient, call `khala_admit_work` with the exact queued
   Work ID. Admission creates Mandate revision one, not a Mission or Execution.
   Re-read the resulting Mandate before using its identifiers.

## Materialize, coordinate, and launch

Call `khala_launch_execution` deliberately:

- `mode: "materialize"` creates or reuses the immutable Mission without an
  Execution. Use it before a required semantic comparison with concurrent Work.
- `mode: "launch"` (or the default) validates the current Mission, holds, exact
  upstream release, and supervision availability before starting the headless
  Executor.

Compare objective, context, scope, acceptance, constraints, plan, validation,
named modules, APIs, contracts, and generated artifacts. Path overlap alone is
not a dependency decision. Record dependency or peer-conflict evidence only
when it exists; independent Work needs no Coordination record. A dependency
hold can exist before the waiting primary Execution. Release requires verified
upstream Finish, Pull Request publication, and exact remote head; the dependent
sandbox must use that exact base and is never rebased in place.

Read the returned status. `materialized` or `held` means no Executor has
started. Use the Conclave supervision reference for Coordination and controls.

## Assess a Signal and issue a Verdict

For each current Signal, verify the Work, Mandate, Mission, participant,
Execution, Signal currentness, and causal bindings. Then call
`khala_verdict` with the exact Work, Execution, and Signal IDs and a nonempty
reason.

- `continue` leaves the current attempt active.
- `retry` fails the predecessor and requires a complete retry handoff and
  successor assignment; it creates a successor rather than resuming or
  rewriting the predecessor.
- `finish` closes the Execution for Pull Request review. It is not acceptance or
  evidence of a merge.
- `reject` closes the Execution without acceptance.

Do not issue Finish from a `finished` Signal until published review evidence and
the Validation Contract have been checked.

## Record a Work Outcome

A Finish Verdict is only an external-review handoff. Let the User record actual
review, requested-change, merge, or closure evidence. For a verified merge,
re-read the Pull Request, finished matching Execution, Mission, Mandate, final
head, merge commit, and validation evidence. Only then call
`khala_record_work_outcome`. A remote ref, Pull Request URL, or Finish Verdict
alone cannot establish an Outcome.
