# Plan 003: Write each execution record once

> **Executor instructions**: Establish one persistence owner for initial Executor and Observer records. Do not change the Archive format.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-executor-registry.ts src/khala-work.ts src/khala-observer.ts test/khala.test.js` — expected: no output.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug | tech-debt
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

`writeExecutorRecord` already appends an `execution` record to the Archive. Both launch flows call it and then append the same payload a second time. The projection hides the duplicate by execution ID, but the authoritative append-only history contains redundant records and makes audit/replay output misleading.

## Current state

- `src/khala-executor-registry.ts:8-15` implements `writeExecutorRecord` by calling `appendArchiveRecord`.
- `src/khala-work.ts:220-236` calls `writeExecutorRecord(execution)` and immediately appends the same execution again.
- `src/khala-observer.ts:122-140` repeats the same pattern.
- `docs/data-model.md` defines the Archive as the complete historical record, so duplicates are not harmless projection details.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Search | `rg -n 'writeExecutorRecord|type: "execution"' src` | only intentional persistence sites remain |

## Scope

**In scope**:
- `src/khala-executor-registry.ts`
- `src/khala-work.ts`
- `src/khala-observer.ts`
- `test/khala.test.js`

**Out of scope**:
- Archive record schema or IDs
- Execution status transitions
- Sandbox cleanup

## Steps

### Step 1: Add regression coverage

Create a focused test that exercises the initial execution-record callback for both an Executor and an Observer, then counts Archive `execution` records for the execution ID. The expected count is exactly one after initial registration. Reuse existing archive/temp-directory helpers in `test/khala.test.js`; if direct launch injection is cumbersome, test the registry write boundary and one caller callback separately.

**Verify**: the new test fails or exposes a count of two before the implementation change, then passes after it.

### Step 2: Remove the second append

Keep `writeExecutorRecord` as the single initial/update persistence function. Remove the explicit duplicate append from both launch flows and remove imports that become unused. Preserve the Observer `kind: "observer"` field and the Executor payload exactly.

**Verify**: `rg -n 'appendArchiveRecord' src/khala-work.ts src/khala-observer.ts` returns no initial execution append sites, while learning/archive uses remain intentional; `npm run check` exits 0.

### Step 3: Run the complete existing test

Confirm submission, retry, session monitor, and role-authorization behavior remain unchanged.

**Verify**: `npm test` exits 0.

## Test plan

Cover one initial Executor record, one initial Observer record, and later status updates. Confirm later `updateExecutorRecord` calls still append historical state records rather than mutating in place.

## Done criteria

- [ ] Initial Executor launch creates one execution record.
- [ ] Initial Observer launch creates one execution record.
- [ ] Status updates remain append-only.
- [ ] No duplicate initial append remains.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if `writeExecutorRecord` has gained another persistence contract since the drift check.
- Stop if a test reveals a caller intentionally depends on duplicate records; report the dependency instead of preserving accidental duplication.

## Maintenance notes

Keep the function name and its append semantics documented. If persistence ownership changes later, change the registry API and callers together rather than adding a second direct Archive write.
