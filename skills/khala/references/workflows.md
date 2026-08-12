# Khala workflows

Use this reference for lifecycle ordering. Read current Archive records before
each decision; the sequences below are guardrails, not permission to skip a
runtime check.

## User: define and submit Work

1. Read the Work-scoped Archive when discussing an existing Work.
2. State objective, context, scope, acceptance criteria, constraints, plan, and
   validation separately. Do not hide missing context in a recommendation.
3. Call `khala_submit_work` once the contract is complete. Preserve the returned
   Work ID and distinguish `queued` from any later Conclave action.
4. If the wake fails, do not launch a replacement. Inspect the authoritative
   records and follow the setup or `/khala-recreate` path.
5. Record review or merge evidence with `khala_record_pull_request_review` only
   when the User has actually observed it. A review record is not acceptance.

## Conclave: review and launch

When a queued submission wakes the dedicated Conclave:

1. Read and validate the authoritative submission. Required terms and list
   entries must be nonblank.
2. If context is absent, inspect Work-scoped Learning. If it is insufficient,
   call `khala_launch_observer` and wait for its one Learning record; do not
   admit or launch an Executor first.
3. Once context is sufficient, call `khala_admit_work`. Re-read the resulting
   Mandate before using its IDs.
4. Call `khala_launch_execution` with `mode: "materialize"` before comparing
   concurrent Work when semantic comparison is required. This persists an
   immutable Mission without starting an Executor and preserves prelaunch
   Coordination.
5. Compare current Work and Mission records using objective, context, scope,
   acceptance, constraints, plan, validation, named modules, APIs, contracts,
   and generated artifacts. Path overlap alone is not a dependency decision.
6. Record a dependency or peer-conflict decision with
   `khala_coordinate_work`. Independent Work needs no Coordination record.
7. Only after holds, upstream release, and supervision availability permit it,
   call `khala_launch_execution` with `mode: "launch"`.

A dependency hold may exist before the waiting primary Execution exists. Release
requires verified upstream Finish, Pull Request publication, and the exact
remote head. Resolution then verifies that the dependent sandbox used that
exact base; never rebase an active dependent attempt in place.

## Conclave: assess and decide

For each current Signal, verify Work, Mandate, Mission, participant, Execution,
Signal currentness, and causal bindings. Assess asynchronous Executions
independently and fairly.

- Use `khala_steer_execution` only for one bounded Mission-grounded correction
  or legal mandatory stop.
- Use `khala_record_intervention_outcome` only after the issued action has a
  later observed response or exact runtime-loss evidence.
- Use `khala_verdict` for the one lifecycle decision. Continue, Retry, Finish,
  and Reject have distinct consequences; do not turn a recommendation or
  monitor state into a Verdict.

A mandatory stop must abort and settle before one single-use handoff. The next
settlement must produce exactly one current blocked Signal with nonempty
evidence, or the Execution fails without synthetic evidence.

## Review and acceptance

A Finish Verdict closes the Execution for external review. It does not mean the
Pull Request was created, reviewed, merged, or accepted.

1. Confirm the reviewable Pull Request evidence is published and tied to the
   Work, Mission, and Execution.
2. Let the User record review, requested changes, merge, or closure evidence.
3. `changes-requested` preserves the predecessor and leads to a successor
   Mission/Execution; it never rewrites the predecessor.
4. For a verified merge, re-read the Pull Request, finished Execution, Mission,
   Mandate, final head, merge commit, and validation evidence.
5. Record one `khala_record_work_outcome` for the accepted Work. A remote ref,
   Pull Request URL, or Finish Verdict alone cannot establish the Outcome.
