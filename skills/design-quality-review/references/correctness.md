# Correctness Reference (C0–C3)

Load this reference when the diff contains state mutations, async/concurrent
code, complex conditionals, error handling paths, data transformations, or
algorithms with edge cases.

## Quick Severity Map

| Severity | Description                    | Example                                                         | Blocker? |
| -------- | ------------------------------ | --------------------------------------------------------------- | -------- |
| C0       | Crash, data loss, corruption   | Unchecked null dereference in payment path                      | Yes      |
| C1       | Likely bug in normal operation | Missing `await`, inverted condition, race on shared state       | Yes      |
| C2       | Edge-case bug                  | Behavior on empty input, timezone edge, first-run vs subsequent | No       |
| C3       | Theoretical / hard-to-trigger  | Requires unlikely input combo, specific async interleaving      | No       |

## Review Priority Order

### C0: Crash, Data Loss, Data Corruption

These are presumptive blockers. Flag immediately.

- Unhandled null/undefined/nil reaching a required path
- Silent data loss (truncation, overwrite without backup, missing save)
- Data corruption from partial writes or non-atomic multi-step updates
- Infinite loops or unbounded recursion without escape
- Stack overflow from deep recursion on untrusted input size
- Division by zero, index out of bounds with no guard
- Type confusion that will crash at runtime (not just compile-time weakness —
  that's D0)

### C1: Likely Bug in Normal Operation

- Inverted condition (flag set when it should be clear, or vice versa)
- Off-by-one in loop or slice boundary
- State machine transition to impossible state
- Race condition in shared mutable state without synchronization
- Missing `await` / unchecked async operation
- Wrong order of operations (check-then-use with mutation gap)
- Unvalidated assumption about collection ordering (map iteration, set ordering)
- Default value that silently produces wrong behavior

### C2: Edge-Case Bug

- Behavior on empty input, null, zero, negative, or boundary values
- Timezone, locale, or encoding edge cases
- Concurrent modification during iteration
- Resource exhaustion path (file handles, connections, memory)
- Timeout or retry interaction with state
- First-run vs subsequent-run behavior divergence

### C3: Theoretical / Hard-to-Trigger

- Requires extremely unlikely input combination
- Requires specific interleaving of async operations
- Requires environment condition unlikely in practice
- Documented as "should not happen" but not enforced

## Error Handling Checks

For every error path in the diff, check:

1. **Is the error swallowed?** Catch blocks that log and continue, return
   default, or convert failure to success are C1 or C0.
2. **Is the error propagated correctly?** Wrapped errors should preserve the
   original; callers should be able to distinguish error kinds.
3. **Is fallback safe?** If an operation fails and the code continues with a
   default, is the default guaranteed to produce correct behavior?
4. **Are partial results cleaned up?** If a multi-step operation fails mid-way,
   are earlier steps rolled back or is the partial state clearly invalid?
5. **Is retry idempotent?** If operations are retried, can a partial success
   from the first attempt cause duplicate effects?

## State and Invariants

- **Does the change introduce a new state variable?** Check that all transitions
  are handled and the variable is initialized before use.
- **Does the change weaken an existing invariant?** If previously "X is always
  non-null after init" and now there's a path where X could be null, flag it.
- **Does the change introduce ordering dependency between state mutations?** If
  A must happen before B, is this enforced or only assumed?
- **Are there check-then-act gaps?** Reading state, checking a condition, then
  acting — if state can change between check and act, flag as C1.

## Async and Concurrency

- **Missing `await` or equivalent** — C1.
- **Shared mutable state without synchronization** — C1.
- **Fire-and-forget without error handling** — "go do this" with no way to know
  if it failed — C2.
- **Ordering assumption between concurrent operations** — if the code assumes A
  completes before B but they run concurrently — C1.
- **Missing cancellation/timeout** — if an operation can hang indefinitely with
  no timeout — C2.

## Data Transformations

- **Lossy conversion** — float→int truncation, wide string→narrow encoding, rich
  object→flat map losing fields — check if loss is intentional.
- **Assumed format** — parsing without validation, assuming JSON structure,
  assuming date format — C1 or C2 depending on input source.
- **Silent coercion** — `"5" + 1` → `"51"` in JS, truthy/falsy checks, implicit
  type conversion — flag if the result could be surprising.

## What Not to Flag as Correctness

- Missing features ("it doesn't handle X yet") — unless X is an expected input
  in the changed path.
- Performance optimizations — unless they introduce a correctness risk.
- Style or readability — that's not correctness.
