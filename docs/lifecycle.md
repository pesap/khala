# Lifecycle

Lifecycle sustains progress by giving each consequential transition an authorized owner and a visible result.
This document defines the target lifecycle from the [MVP design](mvp-design.md), not a claim that the current tools implement every transition.
[Data model](data-model.md) owns durable identities and evidence; [Architecture](architecture.md) owns effect execution; [Security](security.md) owns enforcement boundaries.

## Lifecycle loop

```text
Submission -> clarification if needed -> immutable Mission -> queued Execution
  -> validated commits -> ready Signal -> Conclave Verdict
  -> handoff -> review -> bounded correction or acceptance
  -> Conclave records succeeded Outcome
```

```text
Work:      submitted <-> needs-input; submitted -> queued -> active <-> awaiting-review
           -> succeeded | stopped
Mission:   admitted -> active <-> awaiting-review -> succeeded | rejected | superseded
Execution: queued -> running <-> awaiting-review -> completed | blocked | failed | stopped
```

These outlines describe the ordinary flow, not permission to take every transition from every state.
The application service validates actor, input, current bindings, expected Work revision, and required evidence for each action.
Runtime reachability and provider text are observations, not lifecycle decisions.

## Submission and clarification

A submission requires a title, objective, and at least one acceptance criterion.
It may include context, scope, constraints, validation requirements, permitted paths, and a maximum token budget.
The repository is captured from the invoking workspace or explicitly selected before admission; changing directories later cannot retarget Work.

The Conclave resolves bounded scope, permitted paths, and validation from User intent and trusted repository instructions.
It asks when requirements or authorization are unclear and never assumes every repository uses `npm run check`.
One structured clarification request serves both pre-admission and admitted Work, recording reason, optional missing fields, evidence reference, and permitted response.

Before admission, `request-input` places Work in `needs-input`.
The User answers through `amend-terms`, returning Work to `submitted` before admission.
After admission, clarification is an unresolved attention item on the existing Work, not a return to submission.
An answer within existing terms permits bounded continuation; changed terms require approval of the exact successor agreement.
An action depending on an unanswered request cannot proceed.

Missing repository facts may launch one read-only Observer.
It reads only resolved permitted context, records one bounded evidence-backed assessment, and stops.
It cannot invent objective, acceptance criteria, scope, constraints, or authorization.
Its allowance and timeout are specified in [Operations](operations.md#allowances-and-limits).

## Admission and amendment

The Conclave admits only safe, bounded Work with complete Mission terms and a resolved Work budget cap.
Before Execution reservation, the service verifies target branch, sandbox base, prompt binding, token allowance, validation contract, and required isolation.
The scheduler then follows the [architecture contract](architecture.md#scheduling-and-child-runs).

Corrections within unchanged Mission terms require Conclave authorization, not another User approval.
Changed Mission terms require User approval of the exact successor terms, bound to the current Mission and expected Work revision.
Different or stale proposed terms are rejected by the service.

Approval of successor terms authorizes ending the current attempt without cancelling the Work.
A running, blocked, queued, or awaiting-review Execution is stopped for amendment; its useful work and evidence remain available, and Work remains nonterminal.
No continuation under the predecessor terms is authorized once that stop is requested.
The Conclave may apply `amend-mission` only when the current Execution is absent, failed, or stopped.
The amendment creates a successor Mission, marks the predecessor superseded, and records reason, User approval, evidence, and disposition.
It clears current review and Execution bindings and returns Work to the FIFO queue.
No successor Execution starts until the predecessor's process tree is confirmed stopped.
Amendment does not reset consumed budget or correction allowance.

## Execution and Signals

Only the current Executor sends `progress`, `blocked`, or `ready` Signals.
Progress describes a meaningful implementation, publication, validation, or remediation phase change.
Blocked explains why the Execution cannot continue.
Ready identifies the head, diff, successful declared validation, and permitted-path evidence, plus a current review request for provider delivery.
An adapter unable to perform required validation blocks readiness rather than weakening the Mission.

The Executor produces one coherent commit or a small justified series addressing the acceptance criteria, not arbitrary line-count targets.
Handoff identifies base, reviewed head, commit sequence, change summary, check results, and remaining concerns through the [review snapshot](data-model.md#review-snapshots).
New commits invalidate readiness and require fresh validation and a new snapshot.
Executor runs exit before waiting for Conclave judgment, without discarding their recorded Execution or result.

A blocked Execution does not end its Mission by itself.
A budget-exhausted Execution cannot receive a `continue` Verdict.
Failed or stopped Executions can be replaced under unchanged terms only while the current Mission remains authorized for execution.
Replacement cannot bypass rejection, an approved amendment, cancellation, or recorded acceptance.
Authorized review feedback can return an awaiting-review Execution to `running`.
Runtime recovery rebinds the same Execution rather than silently creating a replacement.

## Verdicts and review

Only the Conclave creates Verdicts:

| Verdict | Meaning |
| --- | --- |
| `continue` | Preserve a non-exhausted Execution for bounded continuation |
| `replace` | End the current Execution and queue a replacement under the same Mission after confirmed termination |
| `handoff` | Enter User review after ready evidence and the delivery evidence required by the Mission |
| `reject` | End the current Mission and ask the User to approve successor terms or stop Work |

Rejection marks the Mission rejected and stops its current Execution while retaining its useful work and evidence.
Work remains nonterminal, awaiting approved successor terms or an explicit decision to stop Work.
Rejection does not itself fail or cancel Work.
A Conclave decision that produces no required durable result becomes attention evidence rather than indefinite silent progress.
Closure, failed checks, and monitoring failures require reconciliation or an explicit decision.

After ready and before handoff, the Conclave may request an Oracle review.
The bounded packet contains the Mission, review diff, declared validation commands, and latest bounded provider observation summary when available.
It excludes the Executor prompt, transcript, and conclusion.
The no-tools Oracle returns advisory findings; its prompt identity and parsed result are retained, and the final Verdict records the Conclave's disposition.

## Publication and base drift

Local delivery commits through the governed workspace action without fetching, pushing, or contacting a code host.
Provider delivery creates a draft review request through a reconciled service action before ready.
The authorized sandbox branch and current head are passed to the provider adapter only after publication permission is verified.

For provider delivery, Khala refreshes the stored target branch before Execution creation and publication.
The target must still point to the Execution's base commit when publication begins.
Base drift blocks publication and requires a User-approved successor Mission at the new base; there is no automatic rebase.
The successor preserves previous work as evidence, carries forward authorized changes through a bounded implementation pass, and requires fresh validation.
That pass consumes the Work's existing correction allowance.
Provider base or head drift also blocks ready handoff.

## Acceptance and settlement

Ready and handoff are evidence that a result can be reviewed, not acceptance.
For local delivery, explicit User acceptance of the exact reviewed snapshot plus a Conclave Outcome creates `succeeded` from awaiting review.
Acceptance does not merge, cherry-pick, or modify the User's checkout.
Previous acceptance cannot authorize a changed head.

For provider delivery, the Mission's recorded delegation makes verified provider merge evidence acceptance.
No second confirmation in Pi is required.
The Conclave may settle from active or awaiting-review Work after verifying the reviewed snapshot and merge evidence.
Evidence must connect the snapshot's source head to the merged result, including squash and rebase merges; commit IDs need not be equal.
A merge without a matching reviewed snapshot requires attention rather than inferred success.

Recorded acceptance closes correction intake for the accepted result, including while settlement is pending.
Pending corrections cannot resume an Executor or alter that result; any active writer must stop, with its additional work preserved separately from the accepted snapshot.
Later feedback remains evidence but does not reopen the accepted assignment; further changes require new Work.
Both modes require a Conclave Outcome before Work becomes `succeeded`.
If acceptance is recorded but settlement lacks budget, retain it and show “accepted, awaiting settlement”.
A User budget increase is required before another child launches; this waiting reason is not another Work state.
The design does not replace Conclave settlement with automatic application-code success.

## Feedback and correction

Explicit User feedback in Pi is supported for both delivery modes and binds to a review snapshot.
The Conclave checks Mission fit before authorizing another bounded implementation pass.
The initial pass is not a correction; subsequent passes after review or a blocker consume the finite allowance defined in [Operations](operations.md#allowances-and-limits).

Provider comments are eligible only under the [security trust rules](security.md#provider-feedback).
Eligible text is evidence, not a direct instruction.
The Conclave creates one bounded Delivery for an observation, bound to the current review snapshot.
Older-snapshot feedback requires reassessment; edited provider text is a new observation rather than rewritten delivery evidence.
Completed Delivery is not replayed.
Failed delivery remains pending or becomes attention evidence and requires explicit retry after reconciliation; it does not automatically end the Execution or Mission.

Feedback need not become reusable guidance.
The [data model](data-model.md#guidance-and-context) defines explicit promotion, applicability, pinning, and withdrawal.

## Cancellation, recovery, and retention

Explicit failure or cancellation stops Work and records `stopReason` as `failed` or `cancelled`.
The service rejects further writer commands, invalidates pending launches and publication effects, and requests termination of the current process tree.
A recorded stop is not proof that writes have ceased.
Replacement, workspace release, and cleanup wait for confirmed process-tree termination; uncertain termination retains ownership and requests attention.
Completed external effects are reconciled and preserved rather than undone by cancellation.
Terminal Work is not reopened by a later merge observation; the external result remains visible evidence.

Recovery rereads Archive state and reconciles runtime, workspace, model, and provider bindings.
An unreachable runtime alone neither ends Work nor permits replacement.
The [supervisor contract](architecture.md#supervision-and-recovery) defines exclusive ownership and restart reconciliation.

Ending an Execution releases live process resources, not its unreviewed result.
Local commits, branches, and worktrees remain until acceptance is recorded under the delivery mode or the User authorizes disposal, and retention policy permits cleanup.
Cleanup verifies that commits remain reachable from a retained reference; local acceptance alone does not make an unmerged branch disposable.
Failed, cancelled, and superseded attempts retain recoverable unreviewed work unless the User explicitly authorizes disposal.
Only Khala-owned resources may be removed, never assigned User-owned worktrees.
Remote branches and review requests remain for audit and are not automatically closed or deleted.

## Checks before relying on the lifecycle

Exercise pre- and post-admission clarification, exact-term amendment approval, rejected Missions, and exhausted correction allowance.
Approve successor terms while an attempt is blocked or awaiting review, then verify it stops without cancelling Work or losing its result before the successor starts.
Verify exact-head local acceptance and provider merge settlement, including stale snapshots and unavailable settlement budget.
Record feedback and pending corrections around acceptance and verify they cannot change the accepted result or restart its writer.
Interrupt validation and publication, cancel Work, and confirm that no replacement writer starts before termination is established.
Verify that failed delivery, duplicate observations, base drift, and external merge races preserve evidence without expanding authority.
