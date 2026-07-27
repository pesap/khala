# Plan 013: Design Archive recovery and inspection tooling

> **Executor instructions**: Design a safe operator surface for inspecting and recovering an append-only JSONL Archive. Do not mutate Archive files or add repair commands in this plan.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-archive.ts src/khala-archive-tool.ts src/khala-model.ts docs/data-model.md README.md` — expected: no output.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/006-strict-archive-reads.md, plans/007-archive-projections.md
- **Category**: direction | dx
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

Khala deliberately stores authoritative history as inspectable JSONL, but current tooling only exposes role-filtered reads and silently tolerates corruption. Once strict read semantics and typed projections exist, operators need a safe way to identify malformed lines, inspect projected state versus raw history, and decide whether recovery is possible without rewriting history.

## Current state

- `README.md:88-90` describes the Archive as inspectable JSONL.
- `docs/data-model.md:20-42` defines append-only history and latest-record projections.
- `src/khala-archive-tool.ts` exposes `khala_read_archive` with Work and execution filters.
- `src/khala-archive.ts:30-54` currently hides read and parse failures.
- `src/khala-model.ts` contains the authoritative envelope and payload guards.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Tests | `npm test` | existing suite passes if a read-only prototype is added |
| Contract search | `rg -n 'Archive|archive|read_archive|JSONL' README.md docs src system-prompts` | all operator-facing assumptions are identified |

## Scope

**In scope**:
- Design document under `docs/` or `plans/`
- Read-only inspection of Archive and role tooling
- Optional read-only diagnostic prototype

**Out of scope**:
- Rewriting, truncating, deleting, or compacting Archive files
- New authority to append records
- Exposing restricted records to broader roles
- Automatic repair based solely on model output

## Steps

### Step 1: Define diagnostic output

Specify raw line diagnostics, envelope validation, payload validation, projected current state, duplicate IDs, and incomplete final-line handling. Ensure diagnostics never print secret values or unrestricted payload content.

**Verify**: design lists exact fields, role visibility, and redaction behavior.

### Step 2: Define recovery policy

Separate safe read-only diagnosis from any future repair. Define whether recovery means copying a verified prefix, quarantining a malformed line, or requiring manual operator action. Preserve the append-only history and never silently rewrite it.

**Verify**: design includes failure cases, backup requirements, idempotency, and rollback.

### Step 3: Define the operator interface

Evaluate extending `khala_read_archive` versus adding a dedicated diagnostic command/tool. Specify role permissions, project selection, output size limits, and whether raw and projected views are separate operations.

**Verify**: design names the authorized role and exact input validation for every proposed operation.

### Step 4: Produce implementation slices

List a read-only diagnostic implementation first, followed by any explicitly approved recovery operation. Include tests with malformed middle lines, invalid payloads, duplicate records, restricted roles, and large output.

**Verify**: design contains machine-testable acceptance criteria and a clear no-go path for unsafe repair.

## Test plan

If a read-only prototype is created, test diagnostics without modifying the Archive, role filtering, redaction, line numbering, and projected/raw consistency. Do not add tests that mutate a user's real Archive.

## Done criteria

- [ ] Diagnostic and recovery authority are separate.
- [ ] Append-only history and role visibility are preserved.
- [ ] No automatic mutation is introduced.
- [ ] Failure, backup, rollback, and output-limit rules are explicit.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if safe redaction cannot be guaranteed.
- Stop if the proposal requires rewriting history to appear valid.
- Stop if a model-generated diagnosis would be treated as operator authorization.

## Maintenance notes

Keep tooling aligned with the strict read contract from Plan 006 and typed projections from Plan 007. Any future repair feature needs an explicit Maintainer decision and separate security review.
