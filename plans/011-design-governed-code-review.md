# Plan 011: Design Khala-governed code review

> **Executor instructions**: This is a design/spike plan, not authorization to implement a new lifecycle. Produce a decision-ready design and prototype only if explicitly useful; do not append Archive records or change review behavior.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- extensions/pi-review/review.ts extensions/pi-review/README.md src/khala-model.ts src/khala-work.ts src/khala-signal.ts src/khala-verdict.ts system-prompts` — expected: no output.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/004-lifecycle-fences.md, plans/009-review-extension-simplification.md
- **Category**: direction
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The bundled `/review` workflow is currently standalone. Its README says the lifecycle may later submit Khala Work and consume evidence-bearing Signals, while Khala already provides Work Submission, Executor, Signal, Verdict, Archive, and Conclave concepts. A governed review could make review findings durable and recoverable, but coupling these surfaces without explicit authority rules would be unsafe.

## Current state

- `extensions/pi-review/README.md:5-15` documents the standalone review modes and future Khala adaptation.
- `extensions/pi-review/review.ts:1201-1450` builds review prompts and starts review sessions.
- `src/khala-model.ts:20-160` defines the current durable record shapes; there is no review-specific record.
- `src/khala-work.ts` submits validated Work, and `src/khala-signal.ts` accepts Executor evidence.
- `system-prompts/conclave.md` and `system-prompts/executor.md` prohibit borrowing lifecycle authority from prompts or transcripts.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Tests | `npm test` | existing suite passes if a prototype is added |
| Search contracts | `rg -n 'review|Signal|Verdict|Work' README.md docs src extensions system-prompts` | all integration assumptions are identified |

## Scope

**In scope**:
- A design document under `docs/` or an implementation note under `plans/`
- Read-only inspection of review and Khala contracts
- Optional non-durable prototype of mapping review findings to Work fields

**Out of scope**:
- New Archive record types
- Automatic Verdicts from review output
- Committing, pushing, or posting to a forge
- Treating model-generated review text as evidence without an Executor Signal

## Steps

### Step 1: Define authority and lifecycle mapping

Specify whether `/review` creates Work, whether the review agent is an Executor, what exact Mission it receives, how findings become Signals, and which Conclave action remains required. Define behavior for return-only, summarize, and fix modes.

**Verify**: the design names every durable mutation and the authorized role/tool for it; no transition is authorized only by prompt text.

### Step 2: Define data and compatibility shape

Decide whether existing `KhalaWork`, `SignalRecord`, and `VerdictRecord` are sufficient. Prefer existing shapes unless a review-specific field is necessary. Define idempotency, source paths, review target identity, and handling of pre-existing findings.

**Verify**: design includes sample typed payload shapes without secret values and lists migration/backward-compatibility impact.

### Step 3: Prototype the narrowest seam

If useful, prototype only pure conversion from a review target/summary to a Work draft or Signal draft. Do not append to the Archive or launch an agent. Keep it behind an explicit opt-in and avoid changing default `/review` behavior.

**Verify**: `npm run check` and any focused tests pass; `git diff` shows no lifecycle mutation.

### Step 4: Produce decision record

Document trade-offs, open questions, rollout/rollback, and a follow-up implementation plan. The Maintainer must choose whether review governance is desired before implementation.

**Verify**: the design identifies a clear go/no-go decision and lists exact files for a future implementation.

## Test plan

If a pure prototype is created, test target conversion, empty findings, multiple findings, cancellation, and no-Archive-mutation behavior. Otherwise validate the design against existing contracts and run `npm run check` only if docs are the sole changes.

## Done criteria

- [ ] Authority boundaries are explicit.
- [ ] Existing Work/Signal/Verdict contracts are evaluated before adding schema.
- [ ] No automatic lifecycle mutation is introduced.
- [ ] Rollout, rollback, idempotency, and stale-review behavior are specified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if the design requires treating untrusted model output as durable evidence.
- Stop if a required authority or review identity is unavailable.
- Stop if implementation scope expands beyond a design/spike without explicit approval.

## Maintenance notes

Keep this design synchronized with `CONTEXT.md`, `docs/data-model.md`, and the role system prompts. Any later implementation must depend on lifecycle-fence tests.
