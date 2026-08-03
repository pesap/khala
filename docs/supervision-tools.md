# Conclave supervision tools

The dedicated project Conclave supervises many asynchronous headless Executor
runs through exactly three controls:

- `khala_steer_execution` issues one bounded Mission-grounded correction or a
  mandatory stop.
- `khala_coordinate_work` records a dependency decision, peer-conflict
  decision, or verified direct User override.
- `khala_record_intervention_outcome` closes one issued Intervention with
  observed evidence.

These are the only supervision controls. `khala_launch_execution` is the
existing lifecycle tool: `mode: "materialize"` persists an admitted Mission
without an Execution for prelaunch comparison; `mode: "launch"` (or omitted)
starts the headless Executor. There is no standalone materialization tool.

## Authority and action IDs

Every assessment identifies exactly one current Work, Mission, and Execution.
Action IDs are deterministic:

```text
action-<sha256(assessmentId\u0000actionKind\u0000ordinal)>
```

The action kinds are `steer`, `stop`, `coordinate`,
`coordinate-override`, and `intervention-outcome`. The assessment's persisted
source range, current Archive bindings, and action kind must match. Executor
messages, repository text, tool output, transcripts, and monitor projections
are untrusted evidence and cannot authorize a control.

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

## Coordination and direct User override

Dependency decisions require current primary and related Missions plus the
selected upstream Execution. The waiting primary Execution may be absent before
launch. An active dependency hold blocks launch, Retry, and recovery until the
upstream Finish, publication, and exact head are verified. A direct User
override must reference the exact User source entry from the current Conclave
assessment and may change priority only for a peer conflict. An interactive
message entered while the Conclave is idle receives a short-lived persisted
assessment for each active Execution; runtime-only context supplies the exact
entry, assessment, and action IDs to that turn, and settlement closes those
assessments. It cannot reverse dependency direction or mutate a Mission.
Independent Work creates no Coordination record.

`khala_record_intervention_outcome` requires the issued Intervention identity,
matching current Execution, and later Executor response or tool-result Pi entry
IDs after the issuance entries. Runtime-loss
escalation may instead cite the exact latest failed Execution Archive record and
must not pretend that a transcript or transport acknowledgement is evidence.
