# Khala Lifecycle

This document describes Khala's target lifecycle in detail. The README shows the
short user-facing version; this document explains the durable records, role
boundaries, review loop, and Retry semantics.

## The high-level model

```text
Work
  → Conclave intake and context review
  → Mandate and immutable Mission
  → isolated Executor Execution
  → reviewable Pull Request
  → Maintainer review and merge
  → Conclave Work Outcome
```

The Archive persists every durable step. It is the system's memory and authority,
but it does not author evidence or make decisions by itself.

## Roles and authorship

| Role | Authors | Does not own |
| --- | --- | --- |
| User / Maintainer | Work terms, scope, acceptance, constraints, validation | Mandates or Verdicts in a User Session |
| Conclave | Work Submission registration, Mandates, Verdicts, Work Outcomes | Executor implementation evidence |
| Observer | Work-scoped Learning | Admission or lifecycle decisions |
| Executor | Signals and implementation evidence | Mandates, Verdicts, or acceptance |
| Preserver | Source-backed Counsel | New first-hand Learning or lifecycle decisions |
| Archive | Durable persistence and historical ordering | Authorship, judgment, or approval |

The role that authors a record is separate from the role that evaluates it. For
example, an Observer authors Learning, while the Conclave evaluates whether that
Learning is sufficient for admission.

## Detailed lifecycle

### 1. Author and submit Work

The User or Maintainer defines a complete Work contract:

- objective and context;
- scope and constraints;
- acceptance criteria;
- implementation plan;
- validation contract.

`khala_submit_work` sends the Work to the project Conclave. The Conclave intake
path registers a Work Submission in the project Archive with status `queued`.
The User authored the terms; the Conclave registered the submission.

A Work Submission is a proposal, not yet an authoritative Mandate.

### 2. Review context

The Conclave reads the authoritative Work Submission.

If repository context is missing or insufficient, the Conclave launches a
submission-scoped, read-only Observer with `khala_launch_observer`.

The Observer:

1. reads the repository and authorized Work-scoped Archive records;
2. records one evidence-backed Learning record with
   `khala_record_learning`;
3. stops and leaves the Conclave to decide whether the context is sufficient.

Learning is first-hand evidence. It is not Counsel and it is not a Verdict.

A Preserver may separately read existing Archive history and record source-backed
Counsel with `khala_counsel`. Counsel is optional historical analysis; it does
not replace Observer Learning and does not change lifecycle state.

### 3. Admit the Work

When the Work is sufficiently specified, the Conclave calls
`khala_admit_work`.

Admission:

1. validates the submitted Work terms;
2. records Mandate revision one;
3. copies the admitted terms into the Mandate;
4. records the source submission and Conclave participant attribution;
5. marks the submission admitted.

The Mandate is now the authoritative contract for execution. Later history must
not silently rewrite it.

### 4. Materialize and launch a Mission

The Conclave calls `khala_launch_execution`.

The launch path:

1. reads the admitted Mandate;
2. materializes one immutable Mission if none exists;
3. binds the Mission to its Mandate and assigned Participant Identity;
4. creates an Execution record;
5. creates an isolated Executor worktree and launcher target;
6. marks the Execution running only after launch succeeds.

A Mission is the assignment. An Execution is one runtime attempt to perform that
assignment. Keeping these separate makes Retry and recovery auditable.

### 5. Execute and report evidence

The Executor works only inside its isolated checkout and within its Mission.
Its local loop is:

```text
inspect → implement → validate → commit and publish → report evidence
```

The Executor submits `khala_signal` records. Signals have three meanings:

- **progress**: a non-blocking checkpoint or implementation update;
- **blocked**: the Executor cannot continue safely or within scope;
- **finished**: the Executor believes the implementation is ready for review.

A Signal is evidence, not approval. The Executor cannot issue a Verdict or
accept its own Work.

The intended control rule is:

```text
progress → Archive checkpoint; execution may continue
blocked  → execution awaits Conclave decision
finished → execution awaits Conclave handoff decision
```

Progress may wake the Conclave for drift monitoring, but should not require a
full lifecycle Verdict on every ordinary checkpoint.

### 6. Conclave review and Verdict

A Signal wakes the serialized project Conclave. The Conclave reads the complete
binding chain:

```text
Work → Mandate → Mission → Participant → Execution → Signal
```

It distinguishes observed evidence, validation results, uncertainty, and
unsupported claims before choosing a Verdict.

#### Continue

Continue leaves the current Mission and Execution active. The Conclave may
include bounded guidance for the Executor, but guidance cannot change the
Mission's scope, acceptance criteria, authority, or governing Mandate.

#### Retry

Retry is required when the current attempt cannot satisfy its assignment.
Retry must:

1. record the reason and source Signal;
2. preserve the predecessor Mission and Execution history;
3. fail the predecessor Execution;
4. create a complete successor Mission;
5. launch a successor Execution or leave an explicit recoverable launch state.

A successor may refine the implementation plan or validation details, but it
must remain governed by the appropriate Mandate. Retry never rewrites the
predecessor.

#### Finish handoff

Finish means the Executor's implementation is complete enough to hand off for
external review. It does **not** mean the Work has been accepted or merged.

The resulting PR remains available for Maintainer review. If review requests
changes, the Conclave creates a successor Mission/Execution rather than silently
changing the completed Mission.

#### Reject

Reject closes the Execution without acceptance when the evidence cannot satisfy
the Mission, the assignment is invalid, or the Work must not continue.

### 7. Maintainer review and merge

The Maintainer, optionally assisted by GitHub Copilot or another reviewer,
reviews the PR against the original Work and Mandate.

Review outcomes are distinct:

- **changes requested**: the Conclave receives review feedback and starts a
  successor Mission/Execution;
- **PR merged**: the external VCS records acceptance of the implementation;
- **PR closed without merge**: the Work is abandoned or rejected, not accepted.

A PR being `closed` is not sufficient evidence of acceptance. The authoritative
acceptance event must establish that it was merged, identify the merge commit,
and identify the relevant review and validation evidence.

### 8. Archive the Work Outcome

After a verified merge, the Conclave records a Work Outcome containing the
relationship between the original submission and the accepted result. The
Outcome should reference:

- Work, Mandate, Mission, and Execution identifiers;
- PR URL and number;
- source and target branches;
- final head and merge commits;
- changed files and diff summary;
- validation results;
- review feedback and unresolved gaps;
- accepting actor and timestamp.

The Outcome is the durable statement that the Work was accepted. The Archive
preserves the evidence; the Conclave authors the Outcome; the Maintainer owns
the external acceptance decision.

## Simplified state model

The user-facing states are intentionally fewer than the durable records:

```text
Queued
  → Context review
  → Executing
  → Reviewable
  → Accepted
```

Side paths:

```text
Context review → Observer Learning
Executing      → blocked → Continue or Retry
Reviewable     → changes requested → successor Execution
Reviewable     → PR closed without merge → Abandoned or Rejected
```

Internally, the Archive retains the finer-grained Submission, Mandate, Mission,
Execution, Signal, Verdict, Learning, Counsel, and Outcome records.

## Current implementation boundary

The current implementation already provides the Archive, Work Submission,
Observer Learning, Preserver Counsel, Mandate, Mission, Execution, Signal, and
Verdict records. The following are lifecycle improvements described by this
document rather than claims about existing runtime enforcement:

- durable delivery of a Verdict back to an active Executor;
- automatic or explicitly recoverable successor launch after Retry;
- runtime role enforcement for Work submission;
- a distinct reviewable-PR state after Executor completion;
- structured external PR review and merge evidence;
- a Work Outcome record linking the submission to the merged result.
