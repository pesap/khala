# Conclave supervision actions

Use this reference only in the dedicated project Conclave for one current
assessment's correction, mandatory stop, Coordination, or Intervention outcome.
These controls are tool-only and cannot change Mission scope, acceptance,
constraints, authority, or Deliverables.

## Fence every action

Read current Archive records and bind every action to one Work, Mission,
Execution, participant, and persisted assessment. Use the action ID derived for
that assessment and action kind; never guess or reuse an action from another
assessment:

```text
action-<sha256(assessmentId\u0000actionKind\u0000ordinal)>
```

Tool transport, a pane, a transcript, and a monitor projection are not outcome
evidence. Do not resend an uncertain control without following recovery.

## Correct or stop an Executor

Use `khala_steer_execution` for exactly one bounded, Mission-grounded
`correction` or legal `stop`. Supply the assessment/action IDs, current target
bindings, exact Mission term, reason, message, and triggering Executor entry
IDs.

A mandatory stop is legal only for dependency, unsafe-assumption, or constraint
failures. It aborts and settles the target before one single-use handoff. Do not
send another prompt while delivery or settlement is uncertain. The handoff must
produce exactly one later current blocked Signal with nonempty evidence; missing
or ambiguous evidence fails the Execution without a synthetic Signal.

## Record Coordination

Use `khala_coordinate_work` for a `dependency` or `peer-conflict` decision, or
for a legal direct User priority `override` to a peer conflict. A dependency
identifies the selected upstream Work, Mission, and Execution and can hold a
waiting Work before its primary Execution exists. A direct User override must
cite the exact current User source entry. It can change priority only for a peer
conflict; it cannot reverse a dependency or mutate a Mission.

## Close an Intervention

Use `khala_record_intervention_outcome` only after issuance and only with later
observed Executor response or tool-result entry IDs. Runtime-loss escalation
instead cites the exact failed Execution Archive record. A transport
acknowledgement, pane output, or transcript alone cannot close an Intervention.
