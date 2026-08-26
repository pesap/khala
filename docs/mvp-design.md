# MVP design

## Purpose

This document specifies the Khala MVP. It uses [glossary](glossary.md) terms and narrows the [lifecycle](lifecycle.md).

Khala governs isolated, code-writing Pi sessions without consuming or interrupting the User conversation. Conclave, Observer, Executor, and Oracle run outside the User session through versioned, role-specific prompts. Prompt identity is Archive evidence. Role settings change Khala's persisted role configuration and never change the User's active Pi model or settings.

The Archive is authoritative. Runtime, Git, code-host APIs, models, and views provide evidence; they do not directly change lifecycle state. Every mutation has an actor, expected Work revision, and idempotency key. Tool visibility is not authority: the application service validates actor capability and current state.

## Primitives and roles

Khala has four durable primitives:

- **Work**: the stable User goal. Its terminal states are `succeeded` or `stopped`; `stopReason` records whether it was failed or cancelled.
- **Mission**: one immutable contract containing objective, scope, acceptance criteria, constraints, validation requirements, and authoritative context references.
- **Execution**: one bounded attempt at a Mission, containing model, thinking mode, prompt identity, token allowance, sandbox, and Pi RPC binding.
- **Record**: one immutable Archive fact. Assessments, Signals, observations, Verdicts, Outcomes, and errors are Record kinds.

User, Conclave, Observer, Executor, and Oracle are roles, not durable primitives. An implementation plan and newly discovered evidence belong to an Execution; they do not change Mission identity. A Mission has at most one active Execution, while historical Executions remain attached to it.

Changing Mission terms creates a successor Mission and a `mission-change` Record with predecessor, reason, evidence, and disposition. Changing model, thinking, prompt, allowance, sandbox, or runtime creates a replacement Execution under the same Mission. Changing the Work budget cap creates a `work-amended` Record.

## Submission, admission, and scheduling

A submission requires title, objective, and acceptance criteria. It may also provide context, scope, constraints, validation requirements, and a maximum token budget; project policy may supply documented defaults.

Missing User intent or authority produces `needs-input`. Missing repository facts may launch one low-cost, read-only Observer. The Observer records one bounded, evidence-backed `assessment` and stops. It may discover facts, but it cannot invent objective, acceptance criteria, scope boundaries, constraints, or authorization.

The Conclave admits only safe, bounded Work with complete Mission terms and a resolved Work budget cap. Before launch it verifies the sandbox base and branch, permitted paths, prompt binding, token allowance, and validation contract.

Each Execution reserves an allowance from the Work budget. Admitted Work is scheduled FIFO by Archive sequence when budget and project concurrency permit it. Parallel Work is assumed independent; the MVP has no priority, dependency, peer-conflict, or User-override model. `/khala` shows queue order, reservation, allowance, and `waiting for budget`.

## Lifecycle

```text
Submission -> needs-input | admission -> immutable Mission -> Execution
  -> draft review request -> monitor -> ready Signal -> optional Oracle
  -> handoff Verdict -> awaiting review -> authorized feedback loop
  -> provider-confirmed merge -> succeeded Outcome
```

```text
Work:      submitted <-> needs-input; submitted -> queued -> active <-> awaiting-review
           -> succeeded | stopped
Mission:   admitted -> active <-> awaiting-review -> succeeded | rejected | superseded
Execution: queued -> running <-> awaiting-review -> completed | blocked | failed | stopped
```

A `ready` Signal and `handoff` Verdict are review handoff evidence, not acceptance. Only provider-confirmed merge evidence creates `succeeded`. An explicit failure or cancellation stops Work; `stopReason` preserves that decision without creating separate Work states. Closure, rejection, or failed CI is evidence that requires a decision, not an automatic Work Outcome.

A blocked, failed, or stopped Execution does not end its Mission. The Conclave may start a replacement Execution under unchanged Mission terms. Authorized review feedback may return an awaiting-review Execution to `running`.

Only Conclave creates Verdicts. `continue` keeps the current Execution running; `replace` ends it and creates a replacement under the same Mission; `handoff` enters awaiting review; and `reject` ends the current Mission without by itself failing or cancelling Work.

## Signals, review, and monitoring

Only an Executor sends evidence-bearing Signals for its current Execution:

- `progress`: a meaningful implementation, publication, validation, or remediation phase change.
- `blocked`: the Execution cannot continue, with a bounded reason and evidence.
- `ready`: the Execution is ready for review handoff, with review-request, head, diff, and validation evidence.

A draft review request is created through a reconciled application action before `ready`. Khala commits and publishes the sandbox branch, then passes that branch and current head to the provider adapter. GitHub Pull Requests and GitLab Merge Requests are first-class review requests. `gh` and `glab` use their own authenticated sessions; Khala stores no provider credentials.

Monitoring emits observations, never Signals or Verdicts: `ci-status`, `review-comment`, `feedback-delivery`, `monitor-failure`, and provider outcome. The User-facing `khala_poll_provider` adapter records changed observations and merge evidence; unchanged polls update an in-memory heartbeat. Provider observations can wake the Conclave through the transactional outbox.

Provider text is untrusted evidence. At publication Khala records provider-native Principal IDs. The GitHub adapter currently makes feedback eligible only when the author matches the authenticated review principal, has a trusted author association, and the review is in a submitted actionable state. The User may explicitly reveal any provider text regardless of delivery eligibility.

Eligible feedback is not a direct instruction. Conclave checks Mission fit and creates one bounded, deterministic Delivery with a stable ID. Replay cannot redeliver it. Failed delivery or monitor exhaustion creates attention evidence and does not automatically end an Execution or Mission.

After `ready` and before `handoff`, Conclave may call `khala_oracle`. Its packet contains the Mission, diff, validation, and provider evidence, but excludes the Executor prompt, transcript, and conclusion. The separately configured, no-tools Oracle returns advisory findings only; Conclave records their disposition and alone decides the Verdict.

## Pi-native interaction

`/khala` is quiet and on demand. It opens no view unprompted, emits no child-session traffic into the User conversation, and provides Role settings without changing the User's active model or settings.

The first view lists active Work by title. Each row is a Work, not a Mission; admitted Work has a Mission and may have an Execution. Work is the User's stable goal, Mission is the admitted bounded plan, and `Next` is the immediate action Khala reports. Succeeded and cancelled Work is hidden; stopped Work with a failure reason remains visible and is marked in red. Typing uses the same minimalist fuzzy filtering pattern as Pi's model selector. Work names are bounded before rendering and presented in aligned Work, ID, state, and Execution columns. Text labels and semantic colors together communicate status. The user-session footer shows a branded status such as `khala: idle` or `khala: ◈ 2`. Selecting Work opens a compact status view with `Work active`, `Mission in progress`, and `Execution running` instead of repeating the same `active` label. It separates those lifecycle concepts from Executor runtime state and the next action. It does not repeat revision, budget, or token metadata. Evidence shows Executor turn status and explicitly reports missing Signal or provider evidence. An unreachable Executor exposes runtime recovery in `Actions`. It is followed by the core sections `Actions`, `Evidence`, and `Archive`; available provider comments add `Review comments`, and blocked Executions add `Inspect blocking signal`. Raw Executor output and provider text are hidden by default; bounded evidence is available on explicit inspection. Recovery opens an in-TUI progress view with a plain-language status, the current recovery stage, what Khala is doing, and the next step. A successful recovery says that no action is needed when Khala will continue automatically; a failed recovery tells the User to inspect Evidence and decide what to do next. The progress view remains open until recovery finishes.

The Work picker shows one compact keybinding line:

```text
r Role Settings  ↑↓ Navigation  home First  enter Enter  escape Escape  backspace Backspace
```

Selection is pinned by Work ID. Refresh preserves selection and filters. Navigation never writes. State is never conveyed by color alone. The Actions view lists only actions currently available to the active actor.
Users can rename a Work label without changing the admitted Mission terms.

Role settings are available from the Work picker and persist model and thinking choices for Conclave, Executor, Observer, and Oracle. Changes apply to future launches; an existing Execution retains its persisted settings. Recovery first rereads Archive state and reconciles runtime, workspace, model, and code-host bindings. An Execution is first durably reserved as `queued`; the persistent parent supervisor consumes its `executor-wake` effect and launches the Executor so a Conclave child cannot kill it during shutdown. Khala never silently substitutes a model or increases an allowance.

Runtime liveness (`working`, `pending`, `idle`, `unreachable`, or `unknown`) is an observation, not lifecycle state. It is derived from the persisted session ID and a bounded Pi RPC probe; a PID alone never proves work. A running Mission with an unreachable Executor is displayed as an active lifecycle with an unavailable runtime and can be reconciled from `Actions`.

## Application interface

Every layout and Pi tool calls one versioned application service. No client reads the Archive store, interprets lifecycle rules, or performs provider effects itself. IDs are opaque and stable; cursors are opaque, snapshot-bound, and versioned.

```text
submit_work(input, meta)                    -> WorkView
list_work(filter?, cursor?)                 -> Page<WorkSummary>
inspect_work(work_id)                       -> WorkView
inspect_runtime(work_id, meta?)             -> WorkView
available_actions(scope, revision?)         -> Action[]
perform(action_command)                     -> ActionResult
read_records(query, cursor?)                -> Page<RecordView>
```

```text
CommandMeta { command_id, actor, expected_work_revision?, role_token?, bound_work_id?, bound_execution_id?, schema_version }
Action      { id, scope, kind, label, enabled, disabled_reason?, input_schema?,
              confirmation?, expected_work_revision? }
RecordView  { sequence, id, kind, actor, work_id, mission_id?, execution_id?,
              payload_version, summary, evidence_refs[] }
Error       { code, summary, retryable, remediation, evidence_refs[] }
```

`perform` revalidates actor, action, input, and revision before writing. Child role sessions carry a parent-signed capability whose role and Work/Execution scope are verified before Archive access. Record queries support Work, Mission, Execution, kind, state, and time filters; fields compose with AND and repeated values with OR. Results order by monotonically increasing Archive sequence. A cursor binds normalized filters, authorization scope, `as_of_sequence`, and last returned sequence.

Pi tools are thin actor-scoped adapters to this service: User submits, reads, and performs User actions; Conclave reads and performs governance actions; Observer records assessments; Executor records Signals; Oracle has no tools.

## Ports and external effects

The application service depends on narrow ports:

```text
ArchivePort       append, query, project
AgentRuntimePort  ensure_session, send, get_state, request_stop
WorkspacePort     preflight, ensure_sandbox, inspect_head, publish_sandbox, remove_sandbox
CodeHostPort      capabilities, identity, ensure_review_request, poll, inspect_outcome
ModelCatalogPort  list_scoped, resolve, supported_thinking
```

Local Git belongs to `WorkspacePort`; remote review requests belong to `CodeHostPort`. Origin selects the GitHub or GitLab adapter without adding a Conclave branch.

Every external effect has a stable Khala ID and uses ensure/reconcile semantics. Adapters first find an existing effect by deterministic metadata or provider ID, create only when absent, and persist the provider-native ID. After an unknown result, recovery reconciles before retrying.

## Errors, persistence, and exclusions

Expected errors use the typed `Error` envelope. Khala may retry an idempotent transport call, but never performs an implicit semantic retry, model substitution, token top-up, merge, scope change, or feedback redelivery.

Token exhaustion records `blocked` and ends that Execution. A replacement Execution may receive another allowance within the Work cap; increasing the cap requires a Work amendment. Validation failure remains remediable while the Executor can continue. Review mismatch and delivery failure create attention evidence for reconciliation rather than automatically ending the attempt.

Archive deletion, replacement, or integrity failure is unrecoverable inside Khala and fails closed until external restoration.

The Archive is an embedded SQLite event store in WAL mode with expected-version appends and a transactional outbox. Each short `BEGIN IMMEDIATE` transaction checks the expected revision, appends Records, updates projections and budget reservations, and records pending external effects atomically. Idempotency returns the prior result; revision conflict requires a reread.

The MVP excludes automatic merge, automatic token top-up, generic semantic retry, priority controls, dependencies, peer-conflict detection, non-Git VCS, and more than one active Execution per Mission. It supports GitHub and GitLab review requests and parallel assumed-independent Work within token and concurrency limits.
