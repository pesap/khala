# Plan 006: Fail closed on Archive read corruption

> **Executor instructions**: Preserve the empty result for a missing Archive, but stop converting read failures and malformed records into authoritative empty state.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-archive.ts src/khala-conclave-storage-file.ts src/khala-sessions.ts test/khala.test.js` — expected: no output.

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug | operability
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The Archive is the source of durable truth. `listArchiveRecords` currently returns `[]` when the file cannot be read and silently drops malformed JSON or invalid envelopes. A permission error, partial write, or corruption can therefore look identical to a brand-new project, causing duplicate submissions or missed lifecycle state.

## Current state

- `src/khala-archive.ts:30-54` catches both file reads and per-line JSON parsing, returning empty or partial data.
- `docs/data-model.md:100-106` says invalid lines are dropped but does not define behavior for unreadable files or malformed JSON.
- `src/khala-conclave-storage-file.ts`, `src/khala-signal.ts`, `src/khala-learning.ts`, and `src/khala-verdict.ts` use Archive reads as lifecycle inputs.
- The project uses synchronous local JSONL I/O; `appendFileSync` writes complete records in one call.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Search | `rg -n 'listArchiveRecords' src` | all callers are reviewed for the new error contract |

## Scope

**In scope**:
- `src/khala-archive.ts`
- Archive callers requiring boundary error presentation
- `docs/data-model.md`
- `test/khala.test.js`

**Out of scope**:
- Archive format migration
- Automatic repair or truncation of corrupted files
- Silently skipping arbitrary invalid history

## Steps

### Step 1: Define read error semantics

Decide and document these cases: missing file returns `[]`; permission/read failure throws a typed or clearly identifiable error; malformed non-empty line reports the archive path and line number; valid records continue to be validated by `isArchiveRecord`. If compatibility with a crash-truncated final line is required, define a narrowly tested final-line rule rather than catching all parse errors.

**Verify**: add tests for missing, unreadable (or simulated read failure), malformed middle line, invalid envelope, and valid trailing newline behavior.

### Step 2: Implement explicit parsing

Replace broad catches with explicit file existence/read handling and line-aware parsing. Do not include record contents in errors because Archive payloads may contain sensitive repository data; report path and line number only.

**Verify**: the malformed and read-error tests fail closed, while a missing Archive still returns an empty list; `npm run check` exits 0.

### Step 3: Handle user-facing boundaries

Review callers that run from Pi tools, popup refresh, and Conclave wake paths. Translate the typed read error only at a true UI/runtime boundary with a truthful error message. Do not turn it back into an empty projection.

**Verify**: `npm test` passes and `rg -n 'catch.*\[\]|return \[\]' src` does not reveal new silent Archive fallbacks.

### Step 4: Update data-model documentation

Document the missing-file, read-error, malformed-line, and invalid-envelope behavior in `docs/data-model.md`.

**Verify**: `git diff --check` and `npm run check` exit 0.

## Test plan

Use temporary files/directories and the existing `test/khala.test.js` style. Assert thrown error type/message metadata without asserting payload contents. Test that an invalid envelope is handled according to the documented policy and cannot create false empty state.

## Done criteria

- [ ] Missing Archive remains an empty result.
- [ ] Read and parse failures are visible and fail closed.
- [ ] Errors do not expose Archive payload values.
- [ ] All lifecycle callers handle the new contract honestly.
- [ ] Documentation matches implementation.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if an existing deployment depends on silently ignoring malformed history; report the compatibility requirement and proposed migration.
- Stop if simulating read errors requires changing Node's filesystem APIs globally.

## Maintenance notes

Future Archive format changes need explicit versioning or migration behavior. Never reintroduce a catch-all that maps corruption to an empty authoritative state.
