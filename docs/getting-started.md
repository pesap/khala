# Getting started

This guide follows the current tools from submission to provider review.
It is not a walkthrough of the complete target design: local acceptance and independent background supervision remain requirements in [MVP design](mvp-design.md).
See [Foundations](foundations.md) for the intent and guarantees.

## Prerequisites

Install:

- Node.js 22.19 or newer.
- Pi.
- Linux.
- Git.
- An authenticated `gh` or `glab` session if the Work will publish a review
  request.

## Install and configure

Install the latest Khala release from its Git tag:

```sh
pi install git:github.com/pesap/khala@v1.1.1
```

Pi installs packages globally by default.
To install Khala only for the current project, add `-l`:

```sh
pi install git:github.com/pesap/khala@v1.1.1 -l
```

Start Pi in a trusted repository.
Open `/khala`, choose Role settings, and configure models and thinking levels for Conclave, Executor, Observer, and Oracle.
Keep the hosting Pi session open while relying on autonomous progress; the current extension closes its application service during session shutdown.
See [Operations](operations.md#startup-and-recovery) for recovery and the target background-supervision boundary.
Settings are stored in
`~/.pi/agent/khala.json` and apply to future launches.
An existing Execution
keeps its persisted model and thinking level.

## Submit Work

Call `khala_submit_work` with a title, objective, and acceptance criteria.
Add
scope, constraints, repository context, validation commands, and a token cap
when they are known.
Submission is persisted immediately; Conclave processing
runs asynchronously.

Reopen `/khala` to inspect the Work.
The picker hides succeeded and cancelled Work by default and keeps failed Work visible for attention.
Use the history key to inspect completed and cancelled Work.

## Follow the review cycle

1. Conclave validates the intent and admits one immutable Mission.
2. If repository facts are missing, the Conclave may launch one read-only
   Observer assessment.
3. The scheduler reserves an Execution within project concurrency and Work
   token limits.
4. The Executor works in an isolated Git worktree, commits through the governed
   workspace action, runs the declared validation commands, and creates or
   reconciles a draft Pull Request or Merge Request.
5. The Executor sends a `ready` Signal with validation evidence.
6. The Conclave hands the Work to User review, where handoff is not acceptance.
7. Record review evidence and use `khala_poll_provider` after the request is
   open.
   The root service also polls active requests autonomously.
8. New actionable GitHub comments may be delivered to the same Execution. A
   confirmed provider merge wakes the Conclave, which must record the explicit
   Outcome before Work becomes `succeeded`.

Provider polling records observations and merge evidence; it never merges code or settles Work by itself.
Provider delivery delegates acceptance to the repository's merge process, with a Conclave Outcome required for success.
See [Lifecycle](lifecycle.md) for the target transitions, [Architecture](architecture.md) for effects, and [Application actions](supervision-tools.md) for current tool entry points.

## Inspect evidence

Use `khala_read_archive` for current Work facts and the ten most recent bounded record summaries.
Use the `/khala` Archive view for complete record history, newest first in bounded pages.
Select Older records to continue through the snapshot or Newest records to refresh from the head.
Use
`khala_inspect_runtime` for a read-only runtime check.
An unreachable Executor
must be recovered by the bound Conclave through the `recover` action; runtime
liveness alone does not grant authority.

Use `/khala` to open:

- Actions for actor-authorized decisions.
- Evidence for Archive-derived records.
- Peer-Review for available provider comments.
- Archive for complete record metadata and structured fields.

See [TUI navigation](tui-navigation.md#current-interface-reference) for the current interface and its distinction from the target interaction.

## Common recovery cases

- Needs input: add the missing intent or repository context, then let the
  Conclave reread the Archive.
- Queued: the Work is waiting for a project slot or token allowance.
- Unreachable Executor: inspect runtime evidence and use Conclave recovery; do
  not start a second Executor manually.
- Provider or delivery failure: inspect the error and evidence records, then
  retry the explicit operation when appropriate.
- Merged provider request with active Work: wait for provider-outcome
  reconciliation and the explicit Conclave Outcome; a merge observation alone
  is insufficient.
- Interrupted project session: run the Pi command `/khala-recover` after
  reopening the project to drain pending effects and reconcile persisted runtime
  bindings.

Khala does not silently change Mission terms, increase token allowance, merge
provider requests, or retry semantic decisions.
