# Workflows and recovery

Use this reference after the user has explicitly requested Khala and the relevant Work is known.
Read the current Archive before every consequential decision.

## Contents

- [Before submission](#before-submission)
- [Normal workflow](#normal-workflow)
- [Diagnose before recovering](#diagnose-before-recovering)
- [Failure and recovery](#failure-and-recovery)

## Before submission

Inspect the repository's actual validation commands and permitted paths before declaring them.
Supply literal executable shell commands in `validation`, not prose or instructions to check unspecified touched files.
For example, use `"validation": ["npm run check"]` only when that command exists in the target repository.
Confirm that the configured execution environment supports governed validation before launching implementation.
The current adapter uses the Anthropic sandbox runtime on Linux and macOS.
Linux requires `bwrap`, `socat`, `rg`, and permitted user namespaces.
macOS uses `/usr/bin/sandbox-exec`, with the descendant-cleanup limitation described in [boundaries](boundaries.md#current-implementation-boundary).
Preparation checks an actual isolated launch before the Executor starts.
On an unsupported host, explain the blocker and ask the User how to proceed rather than submitting a Work that cannot validate.
Never bypass isolation with unrestricted host validation or increase a budget without explicit User authorization.

## Normal workflow

1. Submit complete User intent with `khala_submit_work` for a new Work.
2. Read the Work and Archive records with `khala_read_archive`.
3. Let the Conclave admit the Mission and schedule an Execution.
4. Let the Executor work in its dedicated Git sandbox and under the Mission's `allowedPaths`.
5. Let the Executor commit through the governed workspace action, run declared validation, create or reconcile the draft review request, and record a `ready` Signal.
6. Record User review evidence or poll the provider with `khala_poll_provider`.
7. Let the Conclave assess provider observations and deliver only bounded feedback that fits the Mission.
8. Record the explicit Outcome only after the current review request and provider outcome both confirm that the reviewed head was merged.

A ready Signal, handoff, provider approval, or provider merge is not acceptance.
Current provider delivery reaches `succeeded` only through a Conclave `record-outcome` backed by provider-confirmed merge evidence.

## Diagnose before recovering

In a User or Conclave session, start with a Work-scoped read before narrowing to one Mission or Execution.
Stay within the current role's authorized record visibility.
For example, replace `example-work` with the known Work ID:

```json
{
  "workId": "example-work",
  "kinds": ["execution", "invocation", "verdict", "error", "work-amended"]
}
```

Starting with an Execution filter can hide Conclave reservations, budget amendments, and earlier replacement history.
Compare record sequences and timestamps with the current projection before treating a Verdict's prose as a verified diagnosis.
Distinguish an exhausted Execution allowance, consumed Work budget, held invocation reservations, and the correction allowance.
A reservation wait is not consumed-budget exhaustion, and the deciding Conclave can itself hold a reservation.
Do not reject a Mission or recommend a budget increase solely because tokens are temporarily reserved.
An already-running token-exhaustion wake requires `replace` or `reject` before returning, but has no supported durable replacement-deferral outcome for reservation-only blocking.
If replacement is unavailable and rejection has no independent justification, report this lifecycle conflict rather than inventing an action or diagnosis.
Waiting does not satisfy that wake's decision contract.
If the necessary invocation or amendment records are unavailable, state that limitation rather than inventing a cause.

`replacementEligibility` reports only some gates.
Inspect Mission state, the current Signal, and the other stated lifecycle and capacity requirements before deciding that replacement can start.
A rejected Mission is not permission to restart its Execution, even when token and correction gates show eligibility.
Mission reconciliation belongs to the Conclave, and Work closure still requires an explicit actor-authorized decision.
Report missing validation as missing recorded evidence, not as proof that no implementation edits exist.

## Failure and recovery

- `needs-input`: reread the Work and provide missing intent or repository facts.
- `queued`: inspect preparation state, project concurrency, and token budget.
- Preparation `waiting`: inspect the recorded prerequisite diagnosis; only explicit User recovery rechecks it.
- Invocation `uncertain`: observed consumption is charged, but the remaining reservation and run slot stay held.
  Process disappearance does not refund them.
- Reservation waiting: wait for settlement or reconcile the existing invocation.
  Do not treat held tokens as a request to increase the budget.
- Crash-held invocation: `/khala-recover` settles complete durable receipts.
  Incomplete receipts require User `reconcile-invocation` with actual cumulative usage and evidence.
- Work budget exhausted: only an explicit User budget amendment can permit another invocation.
  Changing models or repeatedly recovering does not restore consumed tokens.
- Execution `budget-exhausted`: the same Execution cannot continue under its exhausted allowance.
  The Conclave must inspect replacement gates, including held reservations, before selecting a permitted, evidence-backed decision.
  Replace only when the current gates permit it, or reject for independently supported reasons.
  Do not equate this condition with exhaustion of the overall Work budget.
- `unreachable` runtime: inspect it, then use `recover` as the owning User or bound Conclave.
  User-initiated recovery must run in the owning User session.
  Use `/khala-recover` there to reread the project Archive and reconcile runtime bindings.
  That session must hold the Archive's exclusive supervision lock.
  Do not start a second Executor manually.
- `unknown` runtime: a live child may belong to another Pi session.
  This is not proof of a dead Executor.
- Competing supervisor: perform runtime recovery in the owning User Pi session or wait for its shutdown.
  Never delete the supervision lock to force takeover.
- Supervision code update: reload existing Khala Pi sessions before retrying stopped Work.
  Already-loaded services do not adopt source edits.
- Provider, monitor, or delivery error: inspect the error and evidence records, then retry the explicit operation when appropriate.
- Do not substitute models, add priority, or invent dependency or peer-conflict behavior when an operation fails.
- Revision conflict: reread the Archive and recompute the action from current state.
- Uncertain cleanup: retain the writer lease and workspace.
  Do not delete them or launch another writer to bypass the failure.
- Merged provider request with active Work: wait for merge reconciliation and the explicit Conclave Outcome.

Khala may retry transient child startup transport before a prompt is sent.
A failed Conclave effect retains its attention and is not automatically replayed by later polls.
Inspect prerequisite, invocation, and decision evidence before authorizing another attempt.
Do not resubmit Work or increase its budget as an infrastructure workaround.

Shutdown waits for active monitor, effect, and background runtime operations before closing the Archive.
The `recover` action can be authorized by the owning User or the bound Conclave.
User recovery cannot run from a competing session.
