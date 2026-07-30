# Khala Glossary

This is Khala's canonical domain vocabulary. The glossary describes meaning and
authority, not implementation details.

## Lifecycle terms

### Work

A proposed objective and operating contract. Work defines the title, objective,
context, scope, acceptance criteria, constraints, plan, and validation.

### Work Submission

A Work proposal registered by the project Conclave and awaiting review. The
User or Maintainer authors the Work; the Conclave registers the submission in
the Archive and queues it for review. A submission is not authoritative Work
until the Conclave admits it.

### Mandate

The Conclave's authoritative admission of a Work Submission. A Mandate records
which terms the project accepted and which revision governs execution.

### Mission

One immutable assignment derived from a Mandate. A Mission binds the Work,
scope, acceptance criteria, constraints, plan, and validation for one execution
path. A Retry creates a successor Mission; it never rewrites its predecessor.

### Execution

One runtime attempt to perform a Mission. An Execution has its own Participant
Identity and isolated working environment.

### Signal

Evidence reported by an Executor about its current Execution. A Signal can
report progress, a block, or a claimed completion. A Signal is evidence, not a
lifecycle decision.

### Verdict

The Conclave's evidence-grounded lifecycle decision for one Signal. A Verdict
may Continue, Retry, Finish, or Reject an Execution.

### Learning

First-hand, Work-scoped repository evidence gathered by an Observer when the
Work Submission lacks sufficient context. The Observer authors Learning; the
Conclave reads it when deciding whether the Work is sufficiently specified.

### Counsel

Source-backed archival analysis prepared by a Preserver. Counsel interprets
existing Archive records and provides observations, recommendations, and
uncertainties. It is advisory and cannot change lifecycle state.

### Work Outcome

The target Conclave-authored record linking a Work Submission and its Missions
to an externally accepted result. Acceptance requires Maintainer-authorized PR
merge evidence; a `Finish` Verdict alone is only an execution handoff. Work
Outcome persistence is not yet implemented in the current Archive schema.

### Archive

Khala's durable authority. The Archive persists submissions, Mandates,
Missions, Executions, Signals, Verdicts, Learning, and Counsel. It records
history; it does not replace the role that authored each record or make
lifecycle decisions by itself.

## Roles

### User / Maintainer

Defines intent, bounds, acceptance, constraints, and validation. Submits Work
for Conclave review.

### Conclave

The project's governing authority. It reviews Work, admits Mandates, launches
Observers and Executors, reads evidence, and issues Verdicts.

### Observer

A read-only repository investigator for one Work Submission. It gathers missing
context and authors one bounded Learning handoff.

### Executor

Performs one exact Mission in one isolated environment. It may change files,
validate the work, and author Signals, but cannot issue Verdicts or change the
Mission's authority.

### Preserver

An archival adviser. It reads authorized history and authors source-backed
Counsel, but cannot admit Work, launch executions, or issue Verdicts.

## Record authorship

```text
User      → Work terms
Conclave  → Work Submission, Mandate, Verdict, and Work Outcome (target)
Observer  → Learning
Executor  → Signal
Preserver → Counsel
Archive   → persists every record
```

The role that authors a record is not necessarily the role that evaluates it.
The Conclave evaluates Learning, Signals, and Counsel; the Archive preserves
all of them.

## Canonical lifecycle (target)

```text
Work Submission
  → Observer Learning when context is missing
  → Conclave admission
  → Mandate
  → immutable Mission
  → Execution
  → Signal
  → Conclave Verdict
  → Continue, Retry, Finish, or Reject
  → Maintainer review and merge
  → Work Outcome
```
