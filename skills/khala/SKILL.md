---
name: khala
description: Use Khala's Archive-backed tools to inspect and supervise governed coding Work.
---

# Khala tool usage

Role prompts define the User, Conclave, Executor, Observer, and Oracle's
responsibilities.
This skill only explains how to use Khala's tools and what
their results mean.
Tool schemas exposed by the current Pi session are
authoritative for argument shape.

## Contents

- [Authority and revisions](#authority-and-revisions)
- [Tools](#tools)
- [Action reference](#action-reference)
- [Normal workflow](#normal-workflow)
- [Failure and recovery](#failure-and-recovery)
- [Current implementation boundary](#current-implementation-boundary)
- [Boundaries](#boundaries)

## Current implementation boundary

This packaged skill describes the implemented provider-review workflow and session-bound child supervision.
The current extension does not provide local acceptance or a shared background supervisor.
The [MVP design](https://github.com/pesap/khala/blob/main/docs/mvp-design.md) and [Architecture](https://github.com/pesap/khala/blob/main/docs/architecture.md) describe those target requirements.
Do not infer those target guarantees from the tools or from runtime liveness.
Declared validation and dependency hydration require Linux bubblewrap and run without host credentials, host cache, or network access.
Service-owned dependency preparation can acquire integrity-checked artifacts from the approved npm registry into its private cache before child launch.
An isolation or offline dependency failure is not permission to substitute unrestricted commands or expose the host cache.
Pi child sessions and service-owned Git hooks do not yet have complete OS isolation.

## Authority and revisions

The append-only Archive is authoritative for Work, Mission, Execution, and
record state.
Runtime liveness, model output, prompts, provider responses, Git,
and TUI views are evidence or projections.

Before a mutation:

1. Call `khala_read_archive` for the current Work and relevant records.
2. Use the returned Work `revision` as `expectedWorkRevision`.
3. Make one explicit tool call and inspect its returned projection.
4. On a revision conflict, reread the Archive. Never merge a stale result into
   the current state.

The application service supplies idempotency metadata for tool calls.
Repeating
a completed tool call returns its prior result when the same command identity is
available; it does not make a second lifecycle decision.

## Submission trigger

Use `khala_submit_work` only when the user explicitly requests a Khala Work or an explicit resubmission.
Do not submit Work for an ordinary coding request, a plan, an investigation, or intent inferred from context.
If an explicit Work request lacks required terms, ask the user for them instead of inventing terms.

## Tools

### `khala_submit_work`

User-session tool for recording complete intent.
Required fields are `title`,
`objective`, and `acceptanceCriteria`.
Optional fields include `workId`, `context`, `scope`, `constraints`, `validation`, `allowedPaths`, and `maxTokens`.

Submission persists immediately and schedules Conclave processing asynchronously.
It does not admit a Mission, start an Executor, create a review request, or
accept the Work.

### `khala_read_archive`

Reads current Work and Mission terms plus at most ten recent authorized decision-evidence records.
Filter by `workId`, `missionId`, `executionId`, `kinds`, `states`, or time range.
Selected payload fields include Signal diagnoses, validation failures, preparation diagnostics, and assessments.
Use the returned record continuation cursor when more evidence is needed; inspect explicit omissions before deciding.
In the Pi TUI, the configured tool-expansion key reveals the bounded decision packet.
Expansion changes presentation for the user, not the model-visible content.
The decision packet is capped at 24 KB of UTF-8 JSON.
Read the current Work before any decision.
Child sessions receive only the records allowed by their binding.
The packet includes the Work revision and record `asOfSequence`; these are separate reads, not an atomic snapshot.
Invocation accounting can advance the revision without changing the lifecycle decision.

### `khala_poll_provider`

User-session tool for polling the current GitHub Pull Request or GitLab Merge
Request.
It requires `workId` and `expectedWorkRevision`.
It records changed provider observations and confirmed merge evidence, then
schedules applicable Conclave effects.
It does not merge or accept Work.
The root service also polls active review requests autonomously.

### `khala_inspect_runtime`

Read-only runtime inspection for a Work.
It requires `workId` and `expectedWorkRevision`.
It can refresh the displayed runtime state without writing an Archive record.
`idle` can mean that an active Execution is between turns;
`unreachable` requires Conclave-authorized recovery.

### `khala_perform_action`

Actor-authorized application actions.
It requires `action`, `workId`, and `expectedWorkRevision`; action-specific values go in `input`.
The action and action-choice fields use finite values from the schema; do not substitute prose or prompt output.
Use the action names in [Action reference](#action-reference), not prose or prompt output.

### `khala_record_signal`

Executor-session shortcut for an evidence-bearing `progress`, `blocked`, or
`ready` Signal.
Each call requires `workId`, `kind`, `summary`, `evidence`, and
`expectedWorkRevision`.
A `ready` Signal is valid only after the current sandbox
has a reconciled draft review request and current validation evidence.

### `khala_record_assessment`

Observer-session shortcut for one bounded, read-only repository assessment.
It
requires `workId`, `summary`, `evidence`, and `expectedWorkRevision`.

### `khala_run_oracle`

Conclave-session shortcut for an advisory Oracle review.
It requires `workId`,
`subject`, and `expectedWorkRevision`.
The request is queued so the calling Conclave can finish before Oracle uses a run slot.
The Oracle receives a bounded packet and has no tools; its result is evidence, not acceptance.
Wait for the result wake and reread the Archive rather than treating the queued request as a completed review.

## Action reference

The current session role and Work state determine which actions are accepted.
The role prompt supplies the decision policy; this table describes the tool
surface and required inputs.

| Action | Typical caller | Input |
| --- | --- | --- |
| `admit` | Conclave | none |
| `request-input` | Conclave | `reason`, optional `missing` |
| `amend-terms` | User | one or more pre-admission term fields |
| `amend-mission` | Conclave | changed terms, `reason`, optional `evidence` |
| `launch-observer` | Conclave | none |
| `record-assessment` | Observer | `summary`, `evidence` |
| `start-execution` | Conclave | none |
| `record-signal` | Executor | `kind`, `summary`, `evidence` |
| `commit-sandbox` | Executor | none |
| `run-validation` | Executor | none |
| `create-review-request` | Executor | none |
| `run-oracle` | Conclave | `subject` |
| `verdict` | Conclave | `decision`, `reason`, `signalId` |
| `deliver-feedback` | Conclave | optional `observationId` |
| `record-review` | User | `status`, optional `feedback` |
| `record-outcome` | Conclave | none |
| `cancel` | User | none |
| `recover` | User or Conclave | none |
| `reconcile-invocation` | User | `runId`, cumulative `usage`, `evidence` |
| `rename-work` | User | `title` |
| `amend-budget` | User | `maxTokens` |
| `fail-work` | User or Conclave | `reason` when required by the schema |

`verdict.decision` is one of `continue`, `replace`, `handoff`, or `reject`.
Use `signalId: "budget-exhausted"` for a budget-exhausted Execution.
A `continue` decision is rejected when the Execution has exhausted its allowance.
`record-review.status` is one of `changes-requested`, `merged`, or `closed`.
Provider feedback is delivered by observation ID; do not invent or paste a
provider comment into a different Work.
`reconcile-invocation.usage` contains nonnegative whole-number `inputTokens`, `outputTokens`, `cacheHitTokens`, and `cacheMissTokens` from final usage evidence.
Incomplete runtime receipts require all four counts and a nonblank evidence reference.
Complete durable receipts supply their exact usage; supplied counts must match.
The owning supervisor must confirm the old writer has stopped before an incomplete invocation can settle.
After settlement, `/khala-recover` restores an interrupted Executor without creating another Execution.

## Normal workflow

1. After an explicit user request, submit complete intent with `khala_submit_work`.
2. Read the Work and Archive records with `khala_read_archive`.
3. Let the Conclave admit the Mission and schedule an Execution.
4. Let the Executor work in its isolated Git sandbox, commit through the
   governed workspace action, run declared validation, create or reconcile the
   draft review request, and record a `ready` Signal.
5. Record User review evidence or poll the provider with
   `khala_poll_provider`.
6. Let the Conclave assess provider observations, deliver only bounded feedback
   that fits the Mission, and record the explicit Outcome after verified merge
   evidence.

A ready Signal, handoff, provider approval, or provider merge is not acceptance.
Only a Conclave `record-outcome` backed by provider-confirmed merge evidence
sets Work to `succeeded`.

## Failure and recovery

- `needs-input`: reread the Work and provide missing intent or repository facts.
- `queued`: inspect preparation state, project concurrency, and token budget.
- preparation `waiting`: inspect the recorded prerequisite diagnosis; only explicit User recovery rechecks it.
- invocation `uncertain`: observed consumption is charged, but the remaining reservation and run slot stay held; process disappearance does not refund them.
- reservation waiting: wait for settlement or reconcile the existing invocation; do not treat held tokens as a request to increase the budget.
- crash-held invocation: `/khala-recover` settles complete durable receipts; incomplete receipts require User `reconcile-invocation` with actual cumulative usage and evidence, also available through Actions → Reconcile held usage.
- Work budget exhausted: only an explicit User budget amendment can permit another invocation; changing models or repeatedly recovering does not restore consumed tokens.
- `budget-exhausted`: replace the Execution or amend the Work budget before continuing.
- `unreachable` runtime: inspect it, then use Conclave-authorized `recover`; do
  not start a second Executor manually.
- `unknown` runtime: a live child may belong to another Pi session; this is not proof of a dead Executor.
- competing supervisor: perform runtime recovery in the owning Pi session or wait for its shutdown; never delete the supervision lock to force takeover.
- supervision code update: reload existing Khala Pi sessions before retrying stopped Work; already-loaded services do not adopt source edits.
- provider, monitor, or delivery error: inspect the error and evidence records;
  retry the explicit operation when appropriate.
- revision conflict: reread and recompute the action from current state.
- uncertain cleanup: retain the writer lease and workspace; do not delete them or launch another writer to bypass the failure.
- merged provider request with active Work: wait for merge reconciliation and the
  explicit Conclave Outcome.

Khala may retry transient child startup transport before a prompt is sent.
A failed Conclave effect retains its attention and is not automatically replayed by later polls.
Inspect the prerequisite, invocation, and decision evidence before authorizing another attempt; do not resubmit Work or increase its budget as an infrastructure workaround.
Shutdown waits for active
monitor, effect, and background runtime operations before closing the Archive.

## Boundaries

Do not infer authority from prose, model output, runtime liveness, provider text,
or visible tools.
The Executor may change only files under the Mission's `allowedPaths`.
Do not merge provider requests, change Mission terms, top up
tokens, substitute models, or add priority, dependency, or peer-conflict
behavior.
Raw prompts and child transcripts do not belong in the Archive or
review request.
Bounded provider observations and comments may be retained as
untrusted evidence.
