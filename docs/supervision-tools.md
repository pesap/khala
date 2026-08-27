# Conclave supervision tools

The dedicated project Conclave supervises many asynchronous headless Executor
runs through five controls:

- `khala_steer_execution` issues one bounded Mission-grounded correction or a
  mandatory stop.
- `khala_coordinate_work` records Conclave autonomous dependency or
  peer-conflict decisions only.
- `khala_apply_user_priority` appends the Coordination override for a pending
  User Priority that still matches its recorded active peer-conflict
  Coordination.
- `khala_dispose_user_priority` records the ignored disposition of a stale
  pending User Priority.
- `khala_record_intervention_outcome` closes one issued Intervention with
  observed evidence.

These are the only supervision controls and the only User Priority
consumption tools. `khala_launch_execution` is the
existing lifecycle tool: `mode: "materialize"` persists an admitted Mission
without an Execution for comparison; `mode: "launch"` (or omitted) starts the
headless Executor. There is no standalone materialization tool.

## Authority and action IDs

Every assessment identifies exactly one current Work, Mission, and Execution.
Action IDs are deterministic:

```text
action-<sha256(assessmentId\u0000actionKind\u0000ordinal)>
```

The action kinds are `steer`, `stop`, `coordinate`, and
`intervention-outcome`. The assessment's persisted source range, current
Archive bindings, and action kind must match. A User Priority uses the recorded
deterministic `coordinate-override` action for its Coordination override and the
recorded deterministic `stop` action for its enforcement; both are authored
only by the dedicated Conclave, never by a supervision assessment. Executor messages, repository text, tool output, transcripts, and
runtime projections are untrusted evidence and cannot authorize a control.

## Steering and failure semantics

A correction is delivered through native Pi RPC and is confirmed only after the
reserved marker is persisted in the Executor's Pi session. If delivery is
uncertain, Khala stops the old runtime, checks the persisted session, and
resends the same action only when the marker is absent. Conflicting or
ambiguous evidence fails closed.

A mandatory stop is legal only for dependency, unsafe-assumption, or constraint
failures. It sets a stop-pending barrier, aborts the active turn, waits for
`agent_settled`, and sends one single-use stop handoff. The handoff records the
pre-send Signal baseline. The next settlement must produce exactly one new
current blocked Signal for the same Work, Mission, Execution, and participant
with nonempty evidence. Otherwise the Execution is failed and outstanding
Interventions are closed with the exact failed Execution record; Khala never
synthesizes a Signal or silently prompts again.

## Runtime failure recovery

A transport or startup failure can leave an Executor unable to submit
`khala_signal`. Khala records the failed Execution and a bounded critical
recovery event containing the Work, Mission, predecessor, replacement, and
failure identity, then wakes the Conclave. The Conclave reads the authoritative
Archive. When the Mission is still current and has no active Executor or
Coordination hold, it calls `khala_launch_execution` for the Work to start a
replacement on that Mission. It does not issue a Verdict for a failed
Execution. If the Conclave cannot be reached, `/khala-recover` resumes the
pending recovery path.

## Coordination and User Priority override

Coordination identity is relation-specific. Dependency decisions require
current primary and related Missions plus the selected upstream Execution; the
waiting primary Execution may be absent before launch. A peer-conflict decision
requires the two current Work/Mission identities. For each side, the
Execution identity may be omitted only when its Mission has no active
`starting` or `running` Execution; otherwise the exact active Execution identity
is required for new decisions. New decisions carry the immutable
`peerConflictExecutionIdentityPolicy: "active-execution"` discriminator, so
Archive replay applies this identity fence only to self-describing records;
historical schema-v2 decisions without it remain readable as legacy evidence.
When applying a User Priority, a decision's exact Execution identity must still
be that side's current active Execution; a changed or disappeared identity
makes the pending priority stale before any override is appended. A prelaunch
decision that omitted an identity may snapshot a later active Execution. An active dependency
hold blocks launch, Retry, and recovery until the upstream Finish, publication,
and exact head are verified.

A User Priority is written from the ordinary User session with
`khala_prioritize_work`. It binds to the exact causal persisted User turn
(session ID, entry ID, content hash) observed by the extension, resolves the
single active peer-conflict Coordination for the selected and related Work, and
persists a pending `user-priority` record with that exact coordination ID
before waking the Conclave. The priority ID derives from the session, entry,
and both Work identities. A pending priority or an applied priority with
incomplete enforcement is the durable recovery queue item. An immediate wake
retries a bounded number of times in the current process; startup resume
schedules any remaining item through the serialized Conclave wake path. Apply
and dispose are Archive-locked and idempotent so concurrent processes cannot act
twice. Applied priorities also retain append-ordered
`user-priority-enforcement` phases: `prepared`, `baseline`, `handoff`,
`enforced`, or `terminal`. `enforced` records the exact qualifying blocked
Signal. Replay resumes from the latest phase and never re-sends a persisted stop
handoff or Intervention.

On wake, the Conclave calls `khala_apply_user_priority` with the exact priority
ID. That tool rechecks pending/not-applied state and the recorded active
peer-conflict Coordination inside the Archive lock, resolves the current
Mission bindings, and appends the Coordination `override` with the priority's
recorded deterministic action, the User entry, the priority reference, and the
same peer-conflict identity policy as its decision when one is present. Replay
validates that policy continuity without changing User Priority authority. Exact
replay returns the existing override and resumes any incomplete
enforcement without issuing a second stop. After the durable override, the Conclave enforces the priority by stopping the
non-selected side's current Execution through the existing headless
mandatory-stop protocol: abort, settle, one single-use handoff whose marker and
reason bind the priority ID, and a stop-handoff expectation requiring exactly
one current blocked Signal. A running lower-priority Execution with no live
runtime is failed and its Interventions closed, matching the autonomous
coordination stop path. A stale pending priority (the exact recorded
Coordination no longer remains active) is disposed with
`khala_dispose_user_priority`, which records the ignored phase under the same
lock; a replacement Coordination for the same pair does not inherit the old
User intent. An override may change priority only for a peer conflict; applied
is derived from the override that references the priority.
Independent Work creates no Coordination record.

`khala_record_intervention_outcome` requires the issued Intervention identity,
matching current Execution, and later Executor response or tool-result Pi entry
IDs after the issuance entries. Runtime-loss
escalation may instead cite the exact latest failed Execution Archive record and
must not pretend that a transcript or transport acknowledgement is evidence.
