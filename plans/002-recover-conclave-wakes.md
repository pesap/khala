# Plan 002: Recover the Conclave after wake failures

> **Executor instructions**: Make the Conclave recover after one failed prompt or initialization. Preserve serialized wake ordering and durable error entries.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-conclave.ts test/khala.test.js` — expected: no output.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug | tests
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The Project Conclave is woken by Work submissions, Observer Learning, and Executor Signals. `wakeConclave` appends a continuation to a cached promise chain, but a rejected continuation leaves the chain rejected forever. Runtime initialization failures are also cached permanently. One transient failure therefore prevents all later coordination until the Pi process restarts, defeating Khala's recoverable lifecycle promise.

## Current state

- `src/khala-conclave.ts:104-138` assigns `runtime.wakeChain = runtime.wakeChain.then(...)` and awaits it.
- `src/khala-conclave.ts:139-152` catches the failure and appends `khala-conclave-error`, but does not repair the chain.
- `src/khala-conclave.ts:155-167` stores the initialization promise in `runtimes` before it succeeds.
- `src/khala-conclave.ts:170-183` catches initialization failures but leaves the rejected promise in the map.
- `test/khala.test.js` already provides the repository's Node test style: temporary directories, Pi stubs, and `node:assert/strict`.

The Archive remains authoritative. A wake failure should be recorded as an error observation, not as a durable lifecycle transition.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all existing and new tests pass |
| Inspect changed files | `git diff --check` | no whitespace errors |

## Scope

**In scope**:
- `src/khala-conclave.ts`
- `test/khala.test.js`

**Out of scope**:
- Archive schema changes
- Prompt wording changes
- Concurrent multi-process locking
- Changes to Pi's session implementation

## Steps

### Step 1: Define the recovery invariant in tests

Add focused tests using an injected or stubbed Conclave runtime/session so that the first `prompt()` call rejects and the next wake succeeds. Add a second test where runtime initialization rejects once and succeeds on the next attempt. Assert that the failure is recorded and the later wake invokes the session.

If the current module does not expose enough seams, extract the smallest internal factory/helper needed for deterministic dependency injection; do not add a general mock framework.

**Verify**: `npm test` initially demonstrates the new regression tests fail against the current implementation or, if the failure is only reachable through a new seam, the tests compile and directly exercise the reproduced rejected-promise behavior.

### Step 2: Repair the wake chain

Change the serialized chain so each wake observes the previous result but the stored chain is always a fulfilled continuation after local error recording. Preserve FIFO ordering. Do not swallow errors before the error entry is appended.

**Verify**: `npm test` passes the prompt-failure recovery test and still passes all existing lifecycle tests.

### Step 3: Evict failed runtime initialization

When `initializeRuntime` rejects, remove that exact promise from `runtimes` before propagating or handling the error. Avoid deleting a newer replacement promise by comparing the map's current value with the failed promise.

**Verify**: the initialization-failure test shows a second wake retries initialization and succeeds; `npm run check` exits 0.

### Step 4: Preserve recovery diagnostics

Ensure the existing `khala-conclave-error` custom entry still contains the Work identifier when available and the formatted error. Do not turn an initialization failure into a false successful launch.

**Verify**: `npm test` and `git diff --check` pass.

## Test plan

Cover: prompt failure followed by successful Signal wake; initialization failure followed by successful Work wake; FIFO ordering for two successful wakes; and existing error-entry behavior. Follow the temporary-directory and Pi stub pattern in `test/khala.test.js`.

## Done criteria

- [ ] A rejected prompt does not poison future wakes.
- [ ] A rejected initialization does not poison future runtime creation.
- [ ] Wake ordering remains serialized.
- [ ] Error entries remain durable and truthful.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if reliable failure injection requires modifying Pi dependency code.
- Stop if preserving FIFO ordering requires cross-process synchronization; report that as a separate design need.
- Stop if the live code differs materially from the excerpts.

## Maintenance notes

Future wake sources must use the same recovery-safe chain. Review any new `.then` or `.catch` added around `wakeChain` for accidental permanent rejection.
