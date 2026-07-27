# Plan 014: Establish the durable Mandate and Mission lifecycle

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. This
> plan deliberately stops before Correspondence, Communion, remote transports,
> cancellation, or generic event sequencing. If anything in the STOP conditions
> occurs, stop and report; do not improvise. When done, update the status row for
> this plan in `plans/README.md` unless the dispatching reviewer maintains it.
>
> **Drift check (run first)**: review `git status --short` and the current
> implementation files listed in Scope. This plan was reconciled after Plans
> 003, 004, 006, 007, and 008 were verified; existing intentional worktree
> changes are part of the implementation baseline and must not be reset.

## Status

- **Implementation status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 003, 004, 006, 007, and 008; this plan extends their verified persistence, fence, projection, and cleanup contracts
- **Category**: migration
- **Planned at**: reconciled implementation baseline, 2026-07-27

## Why this matters

Khala's role prompts already require a pinned Mandate, immutable Mission, currentness fences, and assignment identity, but the durable model only contains submissions, executions, Signals, Counsel, Verdicts, and Learning. The current launch path derives an execution prompt directly from submitted Work, and Retry requeues the same submission instead of creating a successor Mission. This makes the Archive unable to prove which authority governed an execution or whether a retry changed the assignment. After this plan, every admitted Work has a versioned Mandate; every Executor run is attached to one immutable Mission; and Retry creates a new Mission without rewriting the old one.

## Current state

The executor must read these files before changing code. The excerpts below describe
why the lifecycle migration exists; the live files are authoritative after the
foundation plans and current worktree changes have been reconciled.

- `CONTEXT.md` — canonical domain glossary. It currently defines Project, User Session, Work Submission, Conclave, Executor, Observer, Learning, and Conclave Monitor, but not Mandate or Mission.
- `docs/data-model.md` — durable model contract. It says the Archive is append-only JSONL and that current state is the last record matching an identifier (`docs/data-model.md:10-29`). It currently lists only six record types (`docs/data-model.md:30-34`).
- `src/khala-model.ts` — single source of truth for record shapes, discriminants, constants, and guards. `ArchiveRecordType` currently has six values (`src/khala-model.ts:12-18`). `KhalaWorkSubmission` currently carries `queued`, `launching`, or `launched` (`src/khala-model.ts:56-91`). `ExecutorRecord` currently combines runtime binding and lifecycle status, with optional `kind: "executor" | "observer"` (`src/khala-model.ts:94-118`). `SignalRecord` is tied only to `workId` and `executionId` (`src/khala-model.ts:120-133`), and `VerdictRecord` is tied only to the Signal and execution (`src/khala-model.ts:135-145`).
- `src/khala-archive.ts` — append-only writer and fail-closed JSONL reader. `appendArchiveRecord` writes one JSON line at a time (`src/khala-archive.ts:23-44`). `isArchiveRecord` currently validates the envelope but does not validate the payload for its discriminant before `listArchiveRecords` returns it (`src/khala-archive.ts:46-75`).
- `src/khala-archive-projections.ts` — typed projections. Invalid payloads are currently silently skipped by `projectRecords` (`src/khala-archive-projections.ts:47-63`); lifecycle authority must not silently disappear.
- `src/khala-conclave-storage-file.ts` — submission state persistence. `claimSubmission`, `markSubmissionQueued`, `markSubmissionLaunched`, and `requeueSubmission` append submission snapshots (`src/khala-conclave-storage-file.ts:43-112`). These methods currently use launch state on the submission as the concurrency claim.
- `src/khala-work.ts` — Work submission and launch tools. `launchFromConclave` currently checks learning, claims the submission, creates an execution ID, formats a prompt, starts the sandbox, and writes the Executor record (`src/khala-work.ts:197-280`). There is no Conclave admission/Mandate tool.
- `src/khala-work-format.ts` — derives the Executor prompt directly from `KhalaWork`; it includes an attempt number but no Mandate or Mission identifier (`src/khala-work-format.ts:1-19`).
- `src/khala-observer.ts` — launches an Observer against a queued submission before any Mandate exists (`src/khala-observer.ts:42-114`). This must remain a submission-scoped observation path.
- `src/khala-executor-registry.ts` — appends an initial execution record and appends merged snapshots for updates (`src/khala-executor-registry.ts:5-32`). Runtime updates may remain append-only; Mission authority must not be updated through this generic function.
- `src/khala-signal.ts` — authorizes a bound, running Executor by project, sandbox, execution, Work, name, and session, then appends a Signal (`src/khala-signal.ts:33-80`). It must additionally fence the Mission and participant identity.
- `src/khala-verdict.ts` — validates a Signal and running Execution, appends a Verdict, changes execution status, and requeues the same submission on Retry (`src/khala-verdict.ts:46-99`). Retry must instead require and materialize a complete successor Mission.
- `src/khala-conclave.ts` — serializes Conclave wakes per project with `wakeChain` (`src/khala-conclave.ts:212-215`). Preserve serialized Conclave authority, but recovery must inspect admitted Works with incomplete Mission/Execution materialization, not only queued submissions (`src/khala-conclave.ts:67-80`).
- `src/executor.ts` — creates the sandbox before calling `onSandboxCreated`, then launches Pi and removes the sandbox on pre-launch failure (`src/executor.ts:33-78`). Do not claim an Execution is running before the launcher succeeds.
- `src/index.ts` — registers the existing Work, Observer, Signal, Verdict, Archive, and Counsel tools (`src/index.ts:124-145`). The new admission tool and Conclave recovery behavior must be registered here.
- `system-prompts/conclave.md` — already requires Mandate/Mission language and says Retry must contain a complete successor plan (`system-prompts/conclave.md:5-28`), but it currently directs the Conclave to launch directly from a queued submission (`system-prompts/conclave.md:43-64`).
- `system-prompts/executor.md` — already requires a current Mission, pinned Mandate, and assignment fence (`system-prompts/executor.md:1-24`), but the launched Pi process currently receives only Work text and IDs.
- `system-prompts/observer.md` — correctly restricts Observers to read-only inspection and one Learning record (`system-prompts/observer.md:1-13`).
- `system-prompts/maintainer.md` — defines the Maintainer as the authority that authors versioned Mandates and controls Finish authority (`system-prompts/maintainer.md:1-8`). The durable model must not pretend a Maintainer identity exists in the current tools unless it is actually bound.
- `test/khala.test.js` — Node built-in tests use local stubs and temporary Archives. Follow its existing fixture style; do not call real providers or launch real Pi sessions.

The repository convention is exact TypeScript dependencies, erasable TypeScript syntax, one authoritative model file, append-only Archive writes, role-owned mutation tools, and `npm run check` after code changes. `npm test` builds before running tests and is required when tests are changed, but the operator must authorize it before execution.

## Target domain model

Implement this model without introducing Correspondence or a general Communion yet:

```text
Project
└── Work Submission
    ├── queued / reviewing / rejected
    ├── submission-scoped Observer Execution ──► Learning
    └── admitted Work (identified by workId)
         └── Mandate revision 1..n
              └── Mission 1..n
                   ├── immutable assignment
                   ├── pins exactly one Mandate revision
                   └── Execution 1..n (runtime attempts/restarts)
                        └── Signal ──► Verdict

Continue: same Mission and Execution remain governed.
Finish/Reject: current Mission becomes terminal by projection.
Retry: current Mission is superseded and a successor Mission is created with a complete assignment.
```

Use these terms precisely:

- **Work Submission** is proposed work awaiting Conclave review.
- **Work** is the admitted lifecycle identified by `workId`; do not add a separate Work record in this plan.
- **Mandate** is the Conclave-admitted, versioned snapshot of the terms governing Work.
- **Mission** is an immutable assignment under one Mandate revision.
- **Execution** is runtime state for an Executor or submission-scoped Observer.
- **Participant** is a stable attributable identity. Include `maintainer` in the role vocabulary, but do not invent a Maintainer tool or session binding in this plan.
- **Signal** remains Executor-only. Observer output remains Learning.
- **Verdict** remains Conclave-only and is the only lifecycle judgment.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck/lint | `npm run check` | exit 0; no Biome or TypeScript diagnostics |
| Tests | `npm test` | exit 0; all Node tests pass; only use after test changes and when authorized |
| Targeted test inspection | `node --test test/khala.test.js` | all tests pass after `dist` has been built; prefer `npm test` for the final gate |
| Scope check | `git status --short` | only files listed in Scope are modified, plus the executor's status-row update |

## Scope

**In scope — the only implementation files to modify:**

- `CONTEXT.md`
- `docs/data-model.md`
- `src/khala-model.ts`
- `src/khala-archive.ts`
- `src/khala-archive-projections.ts`
- `src/khala-conclave-storage.ts`
- `src/khala-conclave-storage-file.ts`
- `src/khala-work.ts`
- `src/khala-work-format.ts`
- `src/khala-observer.ts`
- `src/khala-executor-registry.ts`
- `src/khala-signal.ts`
- `src/khala-verdict.ts`
- `src/khala-conclave.ts`
- `src/executor.ts`
- `src/index.ts`
- `system-prompts/conclave.md`
- `system-prompts/executor.md`
- `system-prompts/observer.md`
- `system-prompts/maintainer.md`
- `test/khala.test.js`

**Out of scope:**

- Correspondence, Communion UI, arbitrary channels, DMs, remote transport, ACP, Buzz integration, and search.
- Cancellation as a new lifecycle decision. Do not add `cancelled` to Verdicts or execution statuses.
- Generic global `sequence`, `causationId`, or cursor infrastructure. Use explicit source, predecessor, and successor identifiers in this plan; sequence allocation requires a separate Archive writer design.
- Cryptographic participant identities or multi-user authorization. Participant IDs must be stable and bound locally; do not claim they are authenticated identities.
- Rewriting historical Archives or fabricating Mandates/Missions for records created before this plan.
- Changes to the bundled `pi-review` extension.
- Changes to launcher implementations or VCS providers except the callback shape in `src/executor.ts` if required to keep runtime state accurate.
- Removing the existing process-aware local Archive lock. It remains a local interleaving guard, not a distributed transaction.
- Any file outside the list above. If a necessary change appears outside scope, STOP.

## Steps

### Step 1: Define the versioned lifecycle model and legacy read contract

In `src/khala-model.ts`, add the following model concepts beside existing shapes and guards:

- `ParticipantRole`: `user-session | maintainer | conclave | executor | observer | preserver`.
- `ParticipantIdentity`: stable `participantId`, `role`, and display label; do not use display names as authorization keys.
- `MandateRecord`: `mandateId`, `workId`, `revision`, `sourceSubmissionRecordId`, immutable `terms` copied from the submitted Work, `admittedByParticipantId`, and `admittedAt`.
- `MissionRecord`: `missionId`, `workId`, `mandateId`, optional `predecessorMissionId`, optional `causedByVerdictId`, immutable `assignment`, `assignedParticipantId`, and `createdAt`. Do not include mutable status.
- `ExecutionPurpose`: either `{ kind: "mission"; missionId }` or `{ kind: "observation"; submissionRecordId }`.
- Extend `ExecutorRecord` with `participantId`, `purpose`, and `missionId` only for Mission executions. Preserve runtime locator fields. Add `starting` only if needed to represent a created-but-not-yet-launched runtime; do not use execution status to represent Mission judgment.
- Extend `SignalRecord` with `missionId` and `participantId`.
- Extend `VerdictRecord` with `missionId`, `governingMandateId`, `issuedByParticipantId`, and an optional `successorAssignment` that is required for `retry`.
- Change submission lifecycle to distinguish review from runtime launch. The minimum states are `queued`, `reviewing`, `admitted`, and `rejected`; store `mandateId` on an admitted submission and a safe rejection reason on a rejected one. Do not use `launched` as a Work Submission state.

Extend `ArchiveRecordType` with `mandate` and `mission`. Do not add a participant record in this plan; participant identity is a bound value on lifecycle records. Use a deterministic project Conclave ID and execution-derived Executor/Observer IDs, and document that these are local attribution IDs rather than authenticated identities.

Add a `schemaVersion` to newly appended envelopes. Existing envelopes without the field are legacy version 1 and must remain readable. New Mandate/Mission records are version 2. Do not silently reinterpret old records as if they had Mandates or Missions. Add guards for every new payload and update the envelope dispatcher so an invalid payload for a known type is a read error rather than being silently omitted by projections.

**Verify**: `npm run check` → exit 0. Do not proceed if the model requires non-erasable TypeScript syntax.

### Step 2: Add typed projections and Archive append primitives

In `src/khala-archive-projections.ts`, add projections for Mandates and Missions plus helpers that return latest records by ID and current Mission relationships. The current Mission projection must be computed from immutable records: a Mission with a later successor whose `predecessorMissionId` points to it is superseded; a Mission with a terminal Verdict is terminal; no newer Mandate may mutate it.

In `src/khala-archive.ts`, add an append primitive for a small ordered batch of records so admission and Retry can materialize related records without interleaving their lines within one Khala process. Preserve the existing safe error behavior: never include malformed payload text in errors. Keep legacy version-1 reads working and write version 2 for all new records.

Do not pretend this is a cross-process transaction. The code must include recovery-oriented checks for a Verdict with a missing successor Mission and a Mission with no materialized Execution. The existing local Archive lock may serialize the ordered batch within this process boundary, but crash recovery must still detect incomplete materialization. Do not describe the batch as distributed or crash-atomic.

Update the projection tests and corruption tests so invalid typed payloads fail closed. Existing tests that intentionally append incomplete fixture payloads must use explicit non-authoritative test helpers or valid records; do not weaken production validation to preserve malformed fixtures.

**Verify**: `npm run check` → exit 0; `npm test` → all tests pass if the operator has authorized the test command.

### Step 3: Implement Conclave admission and Mandate creation

Add a Conclave-only `khala_admit_work` tool, preferably in `src/khala-work.ts` unless a new in-scope module is required. It must:

1. Verify the caller is the dedicated project Conclave.
2. Read the authoritative pending Work Submission, never trust tool parameters for its terms.
3. Refuse admission when required objective, scope, acceptance criteria, plan, or validation is missing or invalid. Required semantic values and list entries must be trimmed and nonblank; optional fields are not made mandatory.
4. Refuse admission when missing context has not been resolved by sufficient Work-scoped Learning.
5. Create Mandate revision 1 from the authoritative submitted terms, recording the submission Archive record ID and the Conclave participant ID.
6. Append the admission state and Mandate together in the defined order.
7. Be idempotent: repeating admission for the same admitted submission returns the existing Mandate; conflicting admission must fail closed.

Refactor `ConclaveStorage` and `khala-conclave-storage-file.ts` so submission claims describe review/admission rather than launch. A Work Submission that has an admitted Mandate must be resumable even when no Mission exists yet. Rejection must be durable and distinct from Retry or runtime failure.

Update `src/index.ts` and the Conclave tool allowlist in `src/khala-conclave.ts`. Update `system-prompts/conclave.md` so the Conclave admits a Work before launching a Mission, and explicitly says that a wake prompt never constitutes admission.

**Verify**: Add table-driven tests for non-Conclave rejection, invalid Work rejection, missing-context rejection, successful revision-1 admission, idempotent replay, conflicting replay, and recovery of an admitted submission with no Mission. `npm test` → all tests pass when authorized.

### Step 4: Materialize immutable Missions and bind Executions

Refactor `khala_launch_execution` in `src/khala-work.ts` so it requires an admitted Work and current Mandate. On the first launch it must create exactly one immutable Mission with a complete assignment derived from the Mandate, then launch an Executor bound to that Mission.

The Mission assignment must be persisted before the Executor receives its prompt. The Executor prompt generated by `src/khala-work-format.ts` must include the Work ID, Mandate ID/revision, Mission ID, exact assignment, and immutable validation contract. Do not allow a later Mandate to change an already-created Mission prompt.

Update `src/executor.ts` callback handling and `src/khala-executor-registry.ts` so:

- an Observer Execution is explicitly submission-scoped and has no Mission;
- an Executor Execution references exactly one Mission and participant ID;
- runtime status reflects starting/running/finished/failed only as needed;
- sandbox/launcher/session bindings remain runtime details;
- generic execution updates cannot alter `missionId`, `purpose`, participant identity, or Work binding;
- failed pre-launch attempts remain recoverable and do not leave the submission permanently claimed.

A Mission may have multiple runtime Executions only for restart/recovery under the same immutable assignment. Retry must never reuse the old Mission.

Update the Conclave recovery path in `src/khala-conclave.ts` to inspect admitted Work with a current Mission but no running Execution, and admitted Work with no Mission. Preserve the serialized `wakeChain`; do not introduce parallel Conclave authority.

**Verify**: Add tests proving that launch creates one Mission pinned to one Mandate, duplicate launch is idempotent, a newer Mandate does not alter the existing Mission, Observer launch creates no Mission, and pre-launch failures remain retryable. `npm run check` → exit 0; `npm test` → all tests pass when authorized.

### Step 5: Enforce Mission, participant, and Mandate fences on Signals and Verdicts

In `src/khala-signal.ts`, require the bound Executor to match:

- project path and sandbox;
- Work ID;
- Execution ID;
- Executor participant ID;
- Mission ID;
- the current Execution record;
- the current Mission projection.

Signals must be rejected after the Execution is terminal, after the Mission is superseded, or when the Signal's Mission does not match the Execution's pinned Mandate.

In `src/khala-verdict.ts`, require the Conclave to validate Work, Mission, Execution, Signal, and governing Mandate together. A Verdict must record `issuedByParticipantId` and `governingMandateId`. Preserve idempotent replay and reject conflicting Verdicts.

Decision rules:

- `continue`: leaves the current Mission and Execution active.
- `finish`: terminally finishes the current Execution/Mission projection.
- `reject`: terminally rejects the current Execution/Mission projection.
- `retry`: requires a non-empty complete `successorAssignment`, terminally fails the current Execution, creates exactly one successor Mission pointing to the predecessor and Verdict, and makes that successor eligible for launch. It must not create a placeholder Executor or rewrite the old Mission.

Use the batch append primitive or an explicit recovery-safe ordering for the Retry Verdict and successor Mission. If the implementation cannot guarantee that a crash leaves a detectable and recoverable state, STOP and report.

Remove the old `requeueSubmission`-as-retry behavior from this path. Preserve the old public result text only where it remains truthful; do not claim Work was requeued if the successor Mission was not materialized.

**Verify**: Add tests for all four decisions, missing or mismatched Mission/Mandate, late Signal rejection, retry without successor assignment, retry successor creation, retry idempotency, conflicting retry, and stale successor recovery. `npm test` → all tests pass when authorized.

### Step 6: Align role prompts, glossary, and data-model documentation

Update `CONTEXT.md` with implementation-independent definitions for Mandate, Mission, Participant, Signal, Verdict, Counsel, and the submission-scoped Observer path. Preserve the existing definitions of Project, User Session, Work Submission, Conclave, Executor, Observer, Learning, and Conclave Monitor.

Update `docs/data-model.md` with:

- version-1 legacy versus version-2 writes;
- the Work Submission → Mandate → Mission → Execution relationship;
- explicit Mission immutability and successor semantics;
- Observer Learning before Mandate admission;
- participant attribution as local identity, not cryptographic authentication;
- strict payload validation and recovery rules.

Update `system-prompts/conclave.md`, `executor.md`, `observer.md`, and `maintainer.md` so every instruction matches the implemented model. Remove or define any prompt term that the durable model still cannot support. In particular, the Executor must receive real Mandate/Mission identifiers, and the Observer must not be told it has a Mission.

**Verify**: `npm run check` → exit 0; `rg 'job|channel|bot|chat' CONTEXT.md docs/data-model.md system-prompts` → no Buzz vocabulary is introduced as canonical Khala terminology.

### Step 7: Final regression and scope review

Run the complete authorized test gate and inspect all lifecycle fixtures. Add a compact integration scenario to `test/khala.test.js`:

```text
queued Work Submission
→ submission-scoped Observer
→ Learning
→ Conclave admission
→ Mandate r1
→ Mission m1
→ Execution e1
→ blocked Signal
→ Retry Verdict with successor assignment
→ Mission m2
→ Execution e2
→ finished Signal
→ Finish Verdict
```

Assert that the Archive retains every historical record, m1 remains unchanged, m2 pins the same Mandate revision unless an explicit new admission occurred, and no Observer or stale Executor can mutate the new lifecycle.

**Verify**: `npm run check` → exit 0; `npm test` → exit 0; `git status --short` → only Scope files and the plan status row are modified.

## Test plan

Use `test/khala.test.js` temporary directories and the existing Pi stubs as the structural pattern. Add coverage for:

- schema version 1 reads and version 2 writes;
- invalid typed payloads failing closed;
- Mandate admission authorization, validation, idempotency, and conflict;
- Observer execution without Mission;
- Mission immutability and Mandate pinning;
- Execution-to-Mission and participant binding;
- duplicate launch and pre-launch recovery;
- Signal rejection for stale, mismatched, or terminal bindings;
- Continue, Finish, Reject, and Retry Verdict fences;
- retry successor assignment and materialization;
- crash/restart recovery for admitted Work, incomplete Missions, and incomplete retry materialization;
- the complete Observer → admission → execution → retry → finish lifecycle.

Do not use real provider APIs, real model calls, tmux, Zellij, or filesystem paths outside temporary test directories.

## Done criteria

- [x] `src/khala-model.ts` contains guarded Mandate and Mission records and explicit submission-scoped Observation versus Mission execution purpose.
- [x] New Archive writes are schema version 2; legacy version-1 Archives remain readable without fabricated Mandates or Missions.
- [x] Invalid payloads fail closed instead of disappearing from typed projections.
- [x] A Conclave-only admission operation creates exactly one immutable Mandate revision.
- [x] Every Executor Execution references exactly one immutable Mission and its pinned Mandate; Observers reference only a Work Submission.
- [x] Retry creates a successor Mission with a complete assignment and never reuses or rewrites the predecessor Mission.
- [x] Signals and Verdicts enforce Work, Mission, Mandate, Execution, participant, ownership, and currentness fences.
- [x] The role prompts, `CONTEXT.md`, and `docs/data-model.md` describe the implemented lifecycle without unsupported terminology.
- [x] `npm run check` exits 0 with no diagnostics.
- [x] Authorized `npm test` exits 0.
- [x] No Correspondence, Communion UI, remote transport, cancellation, or generic sequence machinery was added.
- [x] No lifecycle implementation files outside Scope were modified; related plan and design documents were updated separately.

## STOP conditions

Stop and report instead of improvising if:

- The verified foundation contracts from Plans 003 or 004 are changed incompatibly; reconcile the overlap before editing.
- Existing intentional worktree changes cannot be preserved safely.
- A historical Archive cannot be read without fabricating a Mandate, Mission, participant, or assignment.
- A Mission cannot be created before an Executor receives its assignment.
- Retry requires adding mutable status to Mission or silently mutating an existing Mission.
- A retry Verdict can be appended without a detectable/recoverable successor-Mission state.
- A required authority rule depends only on a display name, prompt text, transcript, model identity, or filesystem path that is not bound by an existing Khala session/execution contract.
- Strict payload validation would require exposing malformed payload contents in an error message.
- A change requires a new dependency, database, launcher implementation, or out-of-scope file. The retained local Archive lock is not a distributed transaction.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Future Correspondence should target a Submission, Work, Mission, or Execution using explicit unions; it must never be used as a lifecycle mutation path.
- Future Communion projections must use the same role visibility rules as Archive reads and must not expose Observer, Preserver, Maintainer, or Executor data by default.
- A future cancellation feature needs a separate authority decision and terminal-state design; do not overload Reject or blocked Signals.
- Generic Archive sequence/cursor support needs a serialized writer or lock design. The explicit Mission predecessor and Verdict references added here are not a substitute for global ordering.
- Reviewers should verify that a newer Mandate never changes an active Mission and that retry cannot leave a durable Verdict with an unmaterialized successor.
