# Khala data model

`src/khala-model.ts` is the source of truth for current durable record shapes,
discriminants, statuses, and guards. The Archive is an append-only project JSONL
log at `<archiveRoot>/<projectKey>/archive.jsonl`.

## Archive envelope

Every Archive record contains `recordId`, `type`, resolved `projectPath`,
`workId`, `recordedAt`, and a guarded `payload`. Versioned records also contain
`schemaVersion`; unchanged record types use schema 2, while newly written
mission Execution records use schema 3. Schema 2 Execution records retain the
bindings required when they were written. `executionId` is present when the
record is execution-bound. Current record types are:

```text
submission, conclave-wake, mandate, mission, execution, signal,
verdict, verdict-delivery, learning, counsel, pull-request,
work-outcome, coordination, intervention
```

Append order is the historical authority. Timestamps do not repair ordering.
A local process-aware lock protects read-modify-append transitions and
serializes Conclave model-session mapping rotation across local processes; the
log is not a distributed transaction. Corrupt JSON, blank records, invalid envelopes,
and invalid typed payloads fail closed rather than projecting as empty state.

## Work and lifecycle records

- **Submission**: `KhalaWork` terms (`title`, `objective`, `context`, `scope`,
  `acceptanceCriteria`, `constraints`, `plan`, `validation`, optional typed
  positive `costBudget`), project, Archive path, and current submission status
  (`queued`, `reviewing`, `admitted`, or `rejected`).
- **Conclave Wake**: durable attention-transport evidence for one submitted
  Work. Each persisted attempt records `woken` or `failed`; failures retain the
  exact diagnostic and whether recovery requires setup or Conclave recreation.
  The payload and envelope must bind the same submitted Work, and wake IDs may
  not repeat. A failed wake does not imply admission or an Executor launch. If
  evidence cannot be persisted, the submission returns a distinct hard error
  without reinterpreting whether the wake completed.
- **Mandate**: `mandateId`, `workId`, positive `revision`, source submission
  `recordId`, immutable copied `terms`, admitting Conclave participant, and
  `admittedAt`. Current admission creates revision one.
- **Mission**: `missionId`, `workId`, `mandateId`, immutable complete `assignment`,
  `assignedParticipantId`, `createdAt`, and optional causal
  `predecessorMissionId`, `causedByVerdictId`, or `causedByCoordinationId`.
  Mission has no mutable status; projections derive current, superseded,
  finished, or retry-pending state.
- **Execution**: `executionId`, Work and Mission identity, Executor name and
  kind, participant and purpose, resolved project, sandbox, `launcher`, status
  (`starting`, `running`, `finished`, or `failed`), and `startedAt`.
  Executor records also bind `piSessionId`, `sessionPath`,
  `promptIdentity { packageVersion, promptSha256 }`, and optional immutable
  `upstreamBase { kind, workId, missionId, executionId, remote, branch,
  headCommit }`. Schema 3 requires those Pi identity bindings for a running
  mission Executor; recovery treats a historical schema 2 record without them
  as unavailable rather than assuming its runtime is recoverable. An Executor
  uses `launcher: "headless-rpc"`; Observer records retain their configured
  zellij, tmux, or Herdr pane target.
- **Signal**: `signalId`, exact Work/Execution identity, optional Mission and
  participant, kind (`progress`, `blocked`, or `finished`), summary, nonempty
  evidence where required, and `observedAt`.
- **Verdict**: `verdictId`, source Signal, Work/Execution and optional Mission,
  governing Mandate and issuing participant, decision (`continue`, `retry`,
  `finish`, or `reject`), reason, time, and complete successor assignment for
  Retry.
- **Verdict Delivery**: durable pending, delivered, or failed transport
  evidence for the headless Executor. Delivery is not a Verdict.
- **Pull Request**: review identity, Work/Mission/Execution, status, URL/number,
  source and target branches, planning/head commits, changed files, diff,
  validation, feedback, unresolved gaps, and merge/publication evidence.
- **Work Outcome**: verified merged Pull Request evidence, Work/Mandate/
  Mission/Execution bindings, validation and review evidence, accepting actor,
  and timestamp. It is the acceptance record; Finish is not acceptance.

## Coordination and Intervention records

**Coordination** records append-only phases for dependency or peer conflict,
including the two current Missions, selected priority, optional Execution
identities, exact remote/branch/upstream head, classification, reason, User
source entry when it is a direct override, release/invalidation evidence, and
causal resolution. A dependency hold may omit the waiting primary Execution but
must identify the selected upstream Execution. Direct invalidation carries an
exact remote observation; transitive invalidation instead cites the preceding
upstream invalidation and omits unobserved replacement/ref evidence. A null
replacement means the exact ref was observed missing. The upstream base is the
causal immutable remote, branch, and full commit used for a dependent sandbox;
it is not the Pull Request target branch.

**Intervention** records have an issuance and one outcome. Issuance binds the
assessment and deterministic action ID, Work/Mandate/Mission/Execution,
Conclave and Executor participants, Pi session and prompt identity, exact
Mission term, category, bounded message, mode, persisted Pi entry IDs, and
transport confirmation. Outcome binds observed entry IDs or the exact failed
Execution record for runtime-loss escalation, plus resulting Signal, Verdict,
Coordination, or successor references. Intervention records never replace
Signals, Verdicts, or Coordination decisions.

## Pi and supervision bindings

A persisted Conclave session contains hidden mission context, assessment start
and completion entries, source entry IDs, deterministic assessment/action ID
namespace, action reservations/completions, outage checkpoints, budget facts,
settlement handoffs, and direct User source entries. It is a control audit
surface, not a transcript mirror.

The Conclave model session is a disposable projection over Archive authority.
Before opening it with Pi, Khala rotates the mapped session when its file is at
least 16 MiB or has not been modified for 30 days. Rotation writes a fresh
Conclave marker and session name, atomically maps the project to that bounded
session, and preserves the mapped User session. It does not copy the prior
model transcript or modify the Archive. The prior model-session file remains
unreferenced in the Conclave sessions directory, and the next wake reconstructs
current context by reading the authoritative Archive.

Executor Pi sessions remain in their own JSONL files. Supervision stores stable
entry IDs, bounded message hashes, usage/cost facts, source ranges, prompt
identity, and causal references needed for assessment and recovery. It does not
copy raw prompts, assistant transcripts, tool output, or pane output into the
Archive. Runtime events and monitor rows are projections over these bindings.

Supervision state (`connected`, `recovering`, `unavailable`, `settled`) is a
projection, not a lifecycle record. Recovery validates the exact persisted Pi
session ID/path, catches up from the stable cursor, and fails only the affected
Execution when the binding is missing, corrupt, or unrestartable.

## Oracle review presentation

Khala Oracle takes a short required `subject` and a bounded, self-contained review
packet; the packet remains the only review evidence. Live partial results advance
through four public phases — Prepare context, Read packet, Review evidence, Deliver
verdict — rendered as a two-line status: a left-to-right path with done, active, and
pending symbols on wide terminals, and the active phase with its ordinal, elapsed time,
last completed checkpoint, and the configured cancel key on both wide and narrow lines,
without horizontal overflow. Phase transitions are monotonic and idempotent: each
coarse JSON lifecycle event can only complete phases, duplicate or late events are
no-ops, and Deliver verdict completes only when the final output parses a pass, revise,
or blocked verdict; usable output without a parsed verdict stays incomplete and never
marks that phase done. Models that emit no thinking events still advance safely. A
Pi-configured key hints cancellation; no percentage, ETA, confidence, or hidden
reasoning is shown, and durations are human-readable (ms, s, m:ss).

Compact results start with a `Verdict:` label (Pass, Needs revision, Blocked,
Incomplete), then blocker/major/minor counts or `No findings`, distinct
validation-gap counts, real duration, and the expand hint, with distinct failed,
cancelled, blocked, and incomplete states. An expanded Oracle result surfaces the
`Verdict:` label, then the review output and findings, then model and duration, then
the sanitized coarse lifecycle trace, then the submitted bounded review packet last.
Khala renders the bounded packet as literal content: packet Markdown cannot create
headings or links, and terminal control characters are displayed as escaped text rather
than sent to the terminal.

## Configuration and precedence

`KhalaConfig` contains the explicit current fields:

```text
worktreeRoot, worktreeBranchPrefix, launcher,
piCommand,
conclaveModel, conclaveMaxCostUsdPerTurn,
executorModel, executorMaxCostUsdPerTurn,
oracleModel, observerModel,
conclaveThinking, executorThinking, oracleThinking, observerThinking,
pullRequestTargetBranch, commitConvention, archiveRoot
```

Global `~/.pi/agent/khala.json` values are the base. A trusted project stores
only typed values that differ from the global configuration in
`.pi/khala.json`; untrusted projects never read the project override. The four
supervision model/cost fields
(`conclaveModel`, `conclaveMaxCostUsdPerTurn`, `executorModel`,
`executorMaxCostUsdPerTurn`) are required and have no Pi or role fallback.
`oracleModel` is explicitly required by Oracle setup. `observerModel` is
optional only when the shared `piCommand` supplies its own model. Non-interactive
setup validates each explicit thinking level for a configured model with an
offline Pi capability query and fails before writing configuration when the
query or that model's metadata is unavailable. The configured Pi command is
used for Executor, Observer, and Oracle child processes. Oracle retains only
safe shared process flags before applying its isolated role arguments.

For Work budgets, typed `Work.costBudget` values override the merged trusted
configuration independently per actor; unset values use the corresponding
explicit global/project configuration field. No model, Archive root, project
trust, or Work term is inferred from a fallback source.
