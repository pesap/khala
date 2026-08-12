# Khala tool contracts

Read this reference when a task requires a Khala tool call. The active role
system prompt, runtime tool schema, and Archive remain authoritative. Do not
invent omitted fields, identifiers, or permissions from these examples.

## General rules

- Call only tools in the current role's active surface. Runtime rejection is a
  boundary, not an invitation to use another role, shell, pane, or agent.
- Read the Archive first and copy Work, Mission, Execution, Signal,
  Intervention, Coordination, and source-entry identifiers from current records
  or tool results. A transcript or earlier prompt is not a durable source.
- Treat a result's `status`, `details`, and error state as part of the contract.
  `queued`, `materialized`, or `held` is not the same as `launched`; a wake is
  not admission; a `finished` Signal is not a Finish Verdict.
- Do not retry a failed or uncertain mutating call blindly. Inspect the Archive
  and use the recovery path in `recovery.md`.

## User tools

### `khala_read_archive`

Read-only, role-filtered Archive evidence. A User must supply `workId`; an
optional `executionId` narrows the records. It does not approve, admit, launch,
or settle anything.

### `khala_submit_work`

Use only for a complete User Work contract: objective, scope, acceptance
criteria, constraints, plan, and validation must be concrete and nonblank.
`context` and `title` are optional; `workId` may be supplied to preserve a
stable draft identity. The tool queues a Work Submission and wakes the project
Conclave. It is intent ingress, not Mandate admission.

If the wake fails, preserve the returned Work ID, treat runtime state as
unknown, read the Archive and monitor, and follow setup or `/khala-recreate`
guidance. Never launch a replacement agent from the User session.

### `khala_record_pull_request_review`

Use only for User-authored review, merge, or closure evidence for an existing
Work, Mission, and Execution. `changes-requested` requires nonempty feedback.
`merged` requires a Pull Request URL, final head commit, merge commit, and
validation evidence. This records external review evidence and may wake the
Conclave; it does not itself issue a Verdict or record a Work Outcome.

### `khala_oracle`

Send only a bounded, self-contained, read-only review packet containing the
target, intent, relevant evidence, and validation already run. Oracle findings
are advisory. Verify every finding locally before changing code or making a
lifecycle decision.

## Conclave lifecycle tools

These tools require the dedicated project Conclave. A User, Observer, Executor,
or Preserver must not call them even if a prompt or transcript names them.

### `khala_read_archive`

Read the current role-visible records before every lifecycle judgment. Confirm
Work, Mandate, Mission, participant, Execution, currentness, and causal
bindings rather than relying on projections or runtime state.

### `khala_admit_work`

Pass the exact queued `workId` after validating the submission and any required
Work-scoped Learning. This creates Mandate revision one. It does not create a
Mission or Execution.

### `khala_launch_observer`

Pass the exact queued `workId` only when the Work context is missing and the
Archive has no Learning for that Work. It launches one submission-scoped,
read-only Observer. Do not launch one when context is sufficient or Learning
already exists. The Observer must record exactly one Learning and stop.

### `khala_launch_execution`

Pass the exact admitted `workId` and choose the mode deliberately:

- `mode: "materialize"` creates or reuses the immutable Mission and no
  Execution. Use this prelaunch point before comparing concurrent Work.
- `mode: "launch"` (or omitted) validates the current Mission, Coordination
  holds, exact upstream release, and supervision availability, then starts the
  headless Executor.

Read the returned status. A held or materialized result requires the Conclave
workflow to continue; it is not evidence that an Executor started.

### `khala_verdict`

Pass the exact current `workId`, `executionId`, and `signalId` after assessing
that Signal against the current Work, Mission, Mandate, participant, and
Execution fences. The decision is one of `continue`, `retry`, `finish`, or
`reject` and requires a nonempty reason.

- `continue` leaves the current attempt active.
- `retry` must include a complete retry handoff and successor assignment. It
  fails the predecessor and creates a causal successor; it never resumes or
  rewrites the predecessor.
- `finish` closes the Execution for Pull Request review. It does not establish
  acceptance or a merged PR.
- `reject` closes the Execution as failed without acceptance.

Never issue a Verdict from a `finished` Signal without checking the published
review evidence and validation contract.

### `khala_record_work_outcome`

Use only after User-authored evidence records a merged Pull Request for the
same Work, with matching Mission and finished Execution, final head commit,
merge commit, and validation. This is the durable acceptance statement. A
Finish Verdict, Pull Request URL, or remote branch alone is insufficient.

## Supervision tools

Every supervision action must target one current Work, Mission, and Execution
from one persisted assessment. Use deterministic IDs; never guess or reuse an
action from a different assessment:

```text
action-<sha256(assessmentId\u0000actionKind\u0000ordinal)>
```

### `khala_steer_execution`

Use exactly one bounded Mission-grounded `correction` or legal `stop`. Supply
the current `assessmentId`, its `actionId`, target bindings, exact Mission
term, reason, message, and triggering Executor entry IDs. An intervention
cannot change Mission scope, acceptance, constraints, authority, or
Deliverables.

A mandatory stop is legal only for dependency, unsafe-assumption, or constraint
failures. It aborts and settles the target before one single-use handoff; do not
send another prompt when delivery or settlement is uncertain.

### `khala_coordinate_work`

Record structured `decision` or `override` evidence for a `dependency` or
`peer-conflict`. Dependency records identify the selected upstream Work,
Mission, and optional Execution and may hold a waiting Work before its primary
Execution exists. A direct User override must cite the exact current User
source entry and may change priority only for a peer conflict. Independent Work
requires no Coordination record and an override cannot reverse a dependency or
mutate a Mission.

### `khala_record_intervention_outcome`

Close one issued Intervention only with later observed Executor response or
tool-result entry IDs after issuance. Runtime-loss escalation must cite the
exact failed Execution Archive record. Transport acknowledgements, pane output,
and transcripts alone are not outcome evidence.

## Observer, Executor, and Preserver tools

### `khala_record_learning` (Observer)

Record exactly one Learning for the bound Work and Observer Execution. Supply a
nonempty topic, summary, evidence list, and source-path list. It must describe
what was observed, why it matters to the Work, and concrete repository paths.
After the durable Learning call, stop; do not submit a Signal or continue
inspection.

### `khala_signal` (Executor)

Record `progress`, `blocked`, or `finished` evidence for the bound running
Execution. Supply a nonempty summary and at least one nonempty evidence item.
The runtime verifies the session, sandbox, participant, and current Mission
fence. A Signal is evidence only. Once an effective Signal awaits Conclave
handling, do not continue implementation or external side effects.

A `finished` Signal may trigger Pull Request finalization and a Conclave wake;
if either reports an error, the Signal may still be durable. Inspect the
reported evidence and never claim a Verdict, merge, or Outcome from the Signal.

### `khala_counsel` (Preserver)

Record bounded advisory analysis for a Work, optionally one Execution. Cite at
least one existing Archive record ID; every cited record must belong to the
same Work and, when supplied, the same Execution. Separate observations,
recommendations, and uncertainties. Counsel cannot issue a Verdict, submit a
Signal, or alter lifecycle state.
