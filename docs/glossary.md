# Khala Glossary

This is Khala's canonical domain vocabulary. The glossary describes meaning and
authority, not implementation details.

## Lifecycle terms

### Work

A proposed objective and operating contract. Work defines the title, objective,
context, scope, acceptance criteria, constraints, plan, and validation.

### Work Submission

A Work proposal registered by the project Conclave and awaiting review. The
User authors the Work and submits it as intent ingress; the Conclave registers a
queued submission record in the Archive for review. This submission does not
admit the Work or authorize lifecycle actions. A submission is not authoritative
Work until the Conclave admits it.

### Mandate

The Conclave's authoritative admission of a Work Submission. A Mandate records
which terms the project accepted and which revision governs execution.

### Mission

One immutable assignment derived from a Mandate. A Mission binds the Work,
scope, acceptance criteria, constraints, plan, and validation for one execution
path. A Retry creates a successor Mission; it never rewrites its predecessor.

### Execution

One runtime attempt to perform a Mission. An Execution has its own Participant
Identity, isolated working environment, persisted Pi session and prompt
binding, and headless RPC supervision state.

### Supervision state

The projected relationship between a current Execution and its Conclave
supervisor: `connected`, `recovering`, `unavailable`, or `settled`. It is a
monitor projection, not an authority record or lifecycle decision.

### Upstream base

The immutable published remote, branch, and exact commit used to create a
dependent Execution sandbox. It is causal evidence for Coordination release and
revision invalidation; it is not the dependent Pull Request target branch.

### Signal

Evidence reported by an Executor about its current Execution. A Signal can
report progress, a block, or a claimed completion. A Signal is evidence, not a
lifecycle decision.

### Intervention

A Conclave-issued, bounded correction or mandatory stop for one current
Execution. It records its exact Mission term, deterministic action ID, delivery
evidence, and one later observed outcome. An Intervention cannot change Mission
authority and is not a Signal or Verdict.

### Coordination

Structured Conclave scheduling evidence relating current Work and Missions. A
Coordination may record a dependency, a peer conflict, or a direct User
priority override. Dependency holds preserve the selected upstream Execution
and exact published base; User overrides are legal only for peer conflicts.

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
to an externally accepted result. Acceptance requires User-authorized PR merge
evidence; a `Finish` Verdict alone is only an execution handoff. The Conclave
records a Work Outcome only after verified merge evidence.

### Archive

Khala's durable authority. The Archive persists submissions, Mandates,
Missions, Executions, Signals, Verdicts, Verdict Deliveries, Pull Requests,
Work Outcomes, Learning, and Counsel. It records history; it does not replace
the role that authored each record or make lifecycle decisions by itself.

## Roles

### User

Defines intent, bounds, acceptance, constraints, and validation; submits Work,
reviews Pull Requests, and communicates feedback or merge evidence to the
Conclave. The User does not admit Work or issue Verdicts.

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
User      → Work terms, Pull Request review, and merge evidence
Conclave  → Work Submission, Mandate, Verdict, and Work Outcome
Khala runtime → Verdict Delivery and Pull Request handoff evidence
Executor  → Signal
Observer  → Learning
Preserver → Counsel
Archive   → persists every record
```

The role that authors a record is not necessarily the role that evaluates it.
The Conclave evaluates Learning, Signals, and Counsel; the Archive preserves
all of them.

## Canonical lifecycle

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
  → User review and merge
  → Work Outcome
```
