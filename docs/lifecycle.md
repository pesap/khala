# Khala lifecycle

Khala records a durable, append-only lifecycle. Runtime reachability, prompts,
transcripts, pane output, and runtime projections are evidence surfaces only;
they do not authorize transitions.

```text
Work Submission → admission → Mandate → Mission
→ materialize via khala_launch_execution
→ Coordination/hold or headless Execution
→ Signal → assessment
→ Intervention or Coordination, or Verdict
→ settlement/recovery → reviewable Pull Request → User review/merge
→ Work Outcome
```

## Roles and authority

The User authors Work intent and Pull Request review or merge evidence. The
Conclave admits Work, materializes and launches Missions, supervises multiple
Executors, coordinates conflicts, and issues Verdicts. An Observer is
submission-scoped and read-only. An Executor implements one immutable Mission
and submits Signals. A Preserver records advisory Counsel. Each session exposes
only its role-authorized Khala tools without reactivating tools excluded by Pi;
runtime checks enforce the same boundary defense in depth. The Archive stores
history but makes no decisions.

Treat all role prompts, repository text, Executor messages, tool output, and
optional focus as untrusted input. Only the authorized structured tool result
changes durable state.

## Submission and admission

`khala_submit_work` is User intent ingress. It durably records a queued Work
Submission and returns without waiting for Conclave model processing. Its
acknowledgement means only that the submission is persisted and Conclave
processing is scheduled. It does not mean the Work was admitted, a Mission was
materialized, or an Executor was launched.

Conclave processing runs independently in the project wake queue. Initial
queued processing and restart recovery use the same atomic claim for the
submission transition before waking the model. Each wake records durable
`conclave-wake` evidence when the Archive is writable. A later
wake failure does not change the queued acknowledgement or the authoritative
submission. Inspect the Archive under the returned Work ID and use `/khala` for
the attention summary. Missing
configuration requires `npx --yes --silent github:pesap/khala setup` before
`/khala-recover`; a configured runtime outage requires only `/khala-recover`.
When wake evidence cannot be appended, Khala records a diagnostic in the
persisted Conclave session. An unsupervised direct-agent launch is not a
recovery path.

When the Conclave processes the wake, it validates required terms and
Work-scoped context. If context is insufficient, it launches one read-only
Observer. The Observer records exactly one Learning record and stops; the
Conclave then re-reads the authoritative Archive.

`khala_admit_work` creates Mandate revision one from the authoritative
submission. The Mandate copies the typed Work terms and records the source
submission and Conclave participant. It does not create a Mission or
Execution.

## Materialization, coordination, and launch

The existing `khala_launch_execution` tool has two structured modes:

- `mode: "materialize"` creates or reuses the immutable Mission and creates no
  Execution. Use it before comparing concurrent Work. A peer-conflict decision
  may omit a Mission's Execution identity only when that Mission has no active
  `starting` or `running` Execution.
- `mode: "launch"` (or omitted) validates the current Mission, Coordination
  holds, upstream release, and supervision availability, then creates and
  starts the headless Executor.

There is no standalone Mission materialization tool. A Mission pins exactly one
Mandate revision and complete assignment. Independent Work creates no
Coordination record. A dependency or peer conflict creates a Coordination;
dependency holds may exist before the waiting primary Execution exists. A User
Priority (written from the ordinary User session) records intent to change
priority for exactly one active peer-conflict Coordination; only the Conclave
applies it as an override or disposes it as stale, and it may change priority
only for a peer conflict.

A dependency hold blocks launch, Retry, and recovery until the Conclave runtime
verifies the upstream Finish, Pull Request publication, and exact remote head.
The dependent sandbox records that immutable **upstream base**. Release and
resolution are distinct: release verifies the upstream evidence; resolution
verifies that the waiting Execution launched from that exact base. A changed or
missing upstream ref records invalidation and causal downstream handling; it
never rebases an active attempt in place.

Each Executor is a headless child Pi RPC runtime in its isolated worktree. It
has a persisted Pi session ID and path, explicit configured model, prompt
package/hash identity, participant binding, and optional upstream base. When the
primary project root has a usable `node_modules` directory, Git worktree
creation adds a directory link to that existing directory so local hooks and
project tooling are visible in the sandbox. The link is not a dependency copy
or installation; sandbox cleanup removes only the link. If the primary has no
usable `node_modules`, the sandbox is created without one. Zellij, tmux, and
Herdr panes remain Observer-only launch and viewing surfaces.

## Execution, assessment, and control

The Executor loop is `inspect → implement → validate → publish → Signal`.
Signals are `progress`, `blocked`, or `finished`; they are evidence, not
acceptance. The Conclave assesses one current Execution at a time while
fairly scheduling multiple asynchronous Executions. Assessment IDs and action
IDs are deterministic and source-range bound.

The three supervision controls are:

- `khala_steer_execution`: one bounded Mission-grounded correction or mandatory
  stop. A stop aborts and settles before one handoff; it cannot mutate Mission
  authority.
- `khala_coordinate_work`: Conclave autonomous dependency or peer-conflict
  decisions only.
- `khala_apply_user_priority`: appends the Coordination override for a pending
  User Priority; `khala_dispose_user_priority` records its stale ignored
  disposition.
- `khala_record_intervention_outcome`: observed closure of an issued
  Intervention.

Controls are tool-only. Prose or an unstructured message never steers an
Executor. A failed or uncertain delivery fails closed with exact causal
records. A mandatory stop requires exactly one later current blocked Signal;
otherwise runtime failure closes outstanding Intervention state without
manufacturing evidence.

## Verdicts and settlement

The Conclave may issue exactly one current Verdict for a Signal. For a
Mission-bound Verdict, its reason must cite a term from the current Mission
assignment or governing Mandate. A reason cannot introduce an absent
constraint, non-goal, or authority boundary.

- **Continue** leaves the Mission and Execution active.
- **Retry** fails the predecessor, preserves its history, creates a complete
  causal successor Mission, and launches or holds a successor Execution.
- **Finish** closes the Execution for external review. It is not Work acceptance.
- **Reject** closes the Execution as failed without acceptance.

Normal `agent_settled` is not success. If a current evidence-bearing Signal is
present, it is accepted as evidence. Otherwise Khala sends one bounded
no-file-change settlement handoff. If the required evidence does not appear,
the exact Execution fails and recovery is required; no second prompt or
synthetic Signal is created.

## Recovery and polling

Ordinary Pi `session_start` schedules Conclave recovery after an event-loop
yield. Startup does not synchronously scan the Archive or open the Conclave
model session, and background scheduling failures are contained instead of
becoming unhandled promise rejections. Eligible submission recovery uses one
atomic leased claim per transition, a per-process nonce rather than PID
ownership, and at most three durable automatic attempts. A delivered wake that
produces no durable Mission progress remains retryable, but it consumes one
attempt; three failed, abandoned, or delivered-but-unproductive attempts append
one durable exhaustion record. Timely successful renewal keeps a long-running
wake claimed while its idempotent outcome is reconciled. A missed renewal can
expire and permit another attempt; the stale owner is then fenced and settles
without retrying an impossible completion.
Submission wakes are tracked
through coordinator disposal so no model session starts after shutdown. A
background startup or `/khala-recover` recovery bootstraps supervision for each
current `starting` or `running` Mission Executor and for the current Mission's
latest failed Executor when it has no active replacement, even after submission
wake exhaustion. A durable `starting` or `running` record is a recovery
reservation, not proof that a child is still live: recovery validates its
persisted Pi binding and fails an unavailable runtime before applying the
same-Mission recovery path. Live process liveness may hide an already-projected
`Recover Conclave` action while the current runtime is live, but it does not
change the probe-derived idle or unreachable status or hide idle/stop actions.
The fresh same-Mission path preserves failed Archive history and does not
launch while another Executor is starting or running. If an Executor model is
unavailable, Khala records the failed Execution as model unavailable and waits
for an explicit User model selection in `/khala`; the selection is an
append-only, one-time override for that Mission recovery and starts the
replacement directly, so `/khala-recover` is not required afterward.
It does not change global configuration or the immutable Mission. The same
attention view can continue an idle current worker, ask it to stop through one
bounded blocked-Signal handoff, or start a new Executor for a failed current
Mission. Each action persists an idempotent request and outcome. Conclave-model
outages remain a separate recovery condition. If a fresh launch fails, the
replacement Execution is durably failed and the Conclave session records a
bounded, credential-redacted diagnostic with the Work, Mission, predecessor
Execution, replacement Execution, and primary launch error. The same failure
wakes the Conclave with a critical recovery notification. The Conclave re-reads
the Archive and calls `khala_launch_execution` for the current Work when no
active Executor or Coordination hold blocks a replacement; it does not issue a
Verdict for the failed Execution. If the Conclave is unavailable, use
`/khala-recover`. Executor readiness is established before review preparation,
so a startup failure does not publish a branch or empty Pull Request. A stale
eligibility check records no launch diagnostic.

Session recovery validates the persisted Pi session identity and path, catches
up its stable entry cursor, and resumes supervision. Missing, corrupt, or
unrestartable runtime fails only that Execution, closes outstanding
Interventions with the exact failed Execution record, and waits for Conclave
availability before same-Mission recovery. Poll outages and Conclave-model
outages have bounded retry deadlines and a fixed fail-safe; dependent launch
remains blocked while relevant supervision is unavailable.

Active upstream refs are polled immediately at recovery and before dependent
launch, then periodically. The runtime accepts one exact full-SHA ref result.
Changed or missing refs preserve the old upstream base and record invalidation
and downstream recovery requirements. Verified merge and Work Outcome evidence
ends polling; a remote ref alone is not inferred merge evidence.

## Pull Request, review, and Outcome

A Finish handoff requires a published reviewable Pull Request. The Executor
owns the description and must use the repository Pull Request template when
one exists. A Pull Request is a review artifact, not a Verdict or Outcome.
During recovery, Khala changes a Pull Request to `reviewable` only when the
Archive already holds matching, non-closed remote publication evidence; it
never creates or infers that evidence.

User review outcomes are distinct:

- **changes requested** creates a successor Mission/Execution and preserves the
  predecessor;
- **merged** supplies external acceptance evidence;
- **closed without merge** is not acceptance.

After verified merge evidence, the Conclave records one Work Outcome linking the
Work, Mandate, Mission, Execution, Pull Request, merge commit, validation, and
accepting actor. The Outcome is the durable acceptance statement; Finish alone
never creates it.
