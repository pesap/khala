# Plan 007: Centralize Archive projections

> **Executor instructions**: Reduce duplicated full-Archive scans without changing the append-only format or durable record shapes.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-archive.ts src/khala-conclave-storage-file.ts src/khala-executor-registry.ts src/khala-signal.ts src/khala-learning.ts src/khala-verdict.ts src/khala-counsel.ts` — expected: no output.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/006-strict-archive-reads.md
- **Category**: perf | tech-debt
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

Multiple modules independently load the complete JSONL Archive and implement typed filtering/latest-record logic. This makes each lifecycle operation O(n) in file size, often repeated several times per operation, and allows subtle differences in latest-record semantics to drift. A single projection seam will simplify callers and make the Archive contract easier to test.

## Current state

- `src/khala-conclave-storage-file.ts:61-71` indexes latest submissions by `record.workId`; `:130-138` scans again for one submission.
- `src/khala-executor-registry.ts:31-48` independently projects execution records.
- `src/khala-signal.ts:109-125`, `src/khala-learning.ts:116-123`, and `src/khala-verdict.ts:97-109` repeat typed scans.
- `src/khala-archive.ts` is the low-level JSONL reader and currently has no projection API.
- `docs/data-model.md` defines current state as the latest record matching an identifier.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Duplication search | `rg -n 'listArchiveRecords' src` | only the projection layer and intentional raw Archive inspection remain |

## Scope

**In scope**:
- `src/khala-archive.ts` or a new `src/khala-archive-projection.ts`
- Submission, execution, Signal, Learning, and Verdict readers
- `src/khala-counsel.ts` if source lookup benefits from the same snapshot
- Relevant tests and `docs/data-model.md`

**Out of scope**:
- Changing JSONL records or append behavior
- Database/index files or background compaction
- A generic untyped `any`-based query engine

## Steps

### Step 1: Define projection invariants

Write tests first for latest submission by Work, latest execution by execution ID, all Signals, Learning by Work, latest Verdict by Signal/execution, and source-record lookup. Preserve append order as the authoritative tie-breaker unless a domain record explicitly uses its own timestamp; document any exception.

**Verify**: tests express the current expected results before callers are migrated.

### Step 2: Add one typed Archive snapshot/projection seam

Implement a typed projection helper that reads the Archive once per operation and validates payloads with the existing guards from `src/khala-model.ts`. Prefer small typed query functions or a clearly typed snapshot over a broad abstraction with untyped callbacks. Preserve `readonly` results where callers do not mutate them.

**Verify**: `npm run check` exits 0 and projection tests pass.

### Step 3: Migrate domain callers

Replace direct repeated scans in submission storage, executor registry, Signal, Learning, Verdict, and Counsel code with the projection API. Keep `khala_read_archive` as the raw role-filtered inspection path; it should not be forced through a lossy current-state projection.

**Verify**: `rg -n 'listArchiveRecords' src` shows only the low-level Archive implementation, projection layer, and intentional raw archive tool usage.

### Step 4: Compare behavior and performance shape

Use existing tests plus a temporary Archive containing multiple state records per entity. Assert outputs are identical to the pre-migration behavior, except where Plan 006 explicitly changes corruption handling. Confirm each public operation reads the file once per snapshot.

**Verify**: `npm test` exits 0 and `npm run check` exits 0.

## Test plan

Cover empty Archive, interleaved Work lifecycles, duplicate execution IDs in history, invalid payloads, timestamp ordering for Verdicts, Counsel source lookups, and multiple Signals. Model assertions after existing Archive filtering in `test/khala.test.js`.

## Done criteria

- [ ] Domain modules no longer duplicate typed Archive scans.
- [ ] Projection semantics are documented and tested.
- [ ] Archive format and append-only behavior are unchanged.
- [ ] No `any`-based query API is introduced.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if a single projection cannot preserve a domain's explicit ordering semantics.
- Stop if the abstraction becomes larger or less clear than the duplicated code; retain small domain queries and report the trade-off.

## Maintenance notes

Every new durable record type needs a guard and a projection query only when current-state consumers require it. Keep raw history inspection separate from projected state.
