# Plan 004: Enforce Signal and Verdict lifecycle fences

> **Executor instructions**: Strengthen the durable lifecycle state machine without changing valid progress, retry, finish, or reject behavior.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-signal.ts src/khala-verdict.ts src/khala-executor-registry.ts src/khala-model.ts test/khala.test.js` — expected: no output.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: plans/003-single-execution-record-write.md
- **Category**: bug | tests
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The system prompts describe an awaiting-judgment barrier, current execution, ownership, and idempotency fences. The implementation verifies identity but does not require the execution to be running before accepting a Signal, and it allows multiple Verdicts for one Signal. Late or repeated events can therefore append new lifecycle decisions after terminal state.

## Current state

- `src/khala-signal.ts:44-53` validates project, Work, executor name, and session path, but not `registry.status`.
- `src/khala-signal.ts:65-72` appends a Signal and wakes the Conclave.
- `src/khala-verdict.ts:58-68` verifies only that a matching Signal exists, then appends a new Verdict.
- `src/khala-verdict.ts:69-79` updates execution status for finish, retry, and reject.
- `src/khala-executor-registry.ts:31-48` reads the latest execution projection from the Archive.
- `system-prompts/conclave.md` requires explicit currentness, awaiting-judgment, and idempotency barriers; use that vocabulary in errors and tests.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Search | `rg -n 'status|signalId|verdict' src/khala-signal.ts src/khala-verdict.ts` | confirms all fence sites are reviewed |

## Scope

**In scope**:
- `src/khala-signal.ts`
- `src/khala-verdict.ts`
- `src/khala-executor-registry.ts` only if a small query helper is required
- `test/khala.test.js`

**Out of scope**:
- New lifecycle statuses
- Cross-process locking or database migration
- Changes to role authorization
- Changes to prompt wording except error text needed to explain the fence

## Steps

### Step 1: Characterize current valid transitions

Add tests for a running execution accepting progress and finished Signals; finish Verdict marking the execution finished; retry marking it failed and requeueing; reject marking it failed. Preserve the existing role-specific test setup.

**Verify**: `npm test` passes the characterization cases.

### Step 2: Reject late Signals

Require the registered execution to have `status === "running"` before appending a Signal. A finished or failed execution must produce a clear error and must not append a Signal or wake the Conclave.

**Verify**: tests confirm no new Signal record is present after a late submission; `npm run check` exits 0.

### Step 3: Enforce one effective Verdict per Signal

Before appending, query the Archive for an existing Verdict with the same `signalId`. For an exact duplicate request, return the existing durable Verdict without appending another record; for a conflicting decision or reason, reject it. Require the referenced execution to still be running, except for the idempotent replay case.

Do not use timestamps as a substitute for identity. Keep the Verdict's existing Signal, Work, and execution matching checks.

**Verify**: tests cover exact replay, conflicting replay, and Verdict against a finished/failed execution; each leaves the expected number of Verdict records.

### Step 4: Verify retry sequencing

Confirm the retry path still marks the current execution failed before requeueing the launched submission, and that a second retry for the same Signal cannot requeue again.

**Verify**: `npm test` and `npm run check` exit 0.

## Test plan

Add cases for late progress/finished Signals, duplicate identical Verdicts, conflicting duplicate Verdicts, Verdicts after terminal status, valid finish/retry/reject transitions, and retry idempotency. Assert Archive counts and latest execution/submission statuses, not only returned text.

## Done criteria

- [ ] Only running executions accept Signals.
- [ ] Each Signal has at most one effective Verdict.
- [ ] Duplicate Verdict calls are idempotent without duplicate records.
- [ ] Conflicting replay is rejected.
- [ ] Existing valid lifecycle tests still pass.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if the product requires multiple independent Verdicts per Signal; document that policy instead of imposing this fence.
- Stop if atomic duplicate prevention cannot be guaranteed with the current single-process Archive; report the cross-process locking requirement.

## Maintenance notes

Any new Archive mutation must state which execution status and idempotency fence it enforces. Review changes to `ExecutorStatus`, Signal kinds, and Verdict decisions together.
