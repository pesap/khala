# Workflows and recovery

Use this reference after the user has explicitly requested Khala and the relevant Work is known.
Read the current Archive before every consequential decision.

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
- `budget-exhausted`: replace the Execution or amend the Work budget before continuing.
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
