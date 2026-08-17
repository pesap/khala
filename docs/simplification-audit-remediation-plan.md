# Simplification audit remediation plan

This plan turns the validated simplification audit into small, reviewable
implementation slices. It covers the accepted findings from the audit completed
on 2026-08-17. It does not authorize unrelated cleanup or compatibility layers.

## Operating rules

- Preserve one authoritative owner for each finding; do not combine unrelated
  changes into a broad refactor.
- Default to a strict cutover rather than a compatibility layer. Obtain explicit
  product approval before removing behavior that appears intentional.
- Keep indexes and snapshots operation-scoped. Do not create a persistent cache
  or a general-purpose state framework merely to implement these findings.
- Land one independently reviewable slice at a time, with behavioral regression
  coverage and an independent review after every significant slice.

## Decisions required before implementation

| Decision | Affected finding | Required outcome |
| --- | --- | --- |
| Pull request `open` ownership | F-08 | Decide whether User or runtime owns entering `open`; all other runtime bindings remain runtime-owned. |
| Existing Observer session markers | F-21 | Confirm strict rejection/cutover or an explicit one-time handling policy for old persisted markers. |
| Existing pi-review custom state | F-20 | Confirm strict cutover or a bounded translation policy for persisted custom entries. |
| Legacy v1 retry behavior | F-07 | Confirm that the intentional legacy retry branch may be removed after v2 validation is hardened. |
| Oracle summary parser | F-18 | Confirm that no product-owned consumer is intended before removal. |

## Phase 1: P0 correctness and ownership

### 1. Repair Observer session integrity (F-21 and F-17)

Define a role-discriminated persisted session-marker contract. Root registration
must write the Observer identity expected by learning; all marker readers must
consume the role-specific shape. Reject, clean up, or requeue an Observer run
that lacks the target required to close its lifecycle.

Scope includes root registration, learning, signal/archive marker consumers,
Observer lifecycle, and behavioral tests for a root-launched Observer and a
targetless Observer state.

### 2. Make headless runtime cleanup identity-safe (F-13)

Change executor-RPC deregistration to remove an execution entry only when the
closing runtime is the instance currently registered for that execution ID.
Add a replacement-runtime/late-close regression test.

### 3. Fail closed on incomplete retry handoffs (F-01)

Strengthen v2 submission validation so retry handoff metadata and successor
assignment are complete and mutually valid. Reject malformed existing records
rather than projecting an ambiguous retry state. Cover valid retry, incomplete
handoff, incomplete assignment, and fields invalid for non-retry decisions.

### 4. Close the Mission creation race (F-06)

Within the work lock, reread Submission, Mandate, and current Mission before
choosing to create, reuse, or reject. Keep external side effects outside the
lock. Add concurrent/retry lifecycle coverage.

F-15 is folded into this slice: introduce a local runtime union only if the
implementation needs it to express mutually exclusive launch states. Do not
create it as a standalone abstraction.

### 5. Coalesce complete supervision polls (F-12)

Single-flight the full polling transaction for a given base, rather than only
its ref lookup. Verify concurrent global and scoped polls perform one base
transaction while preserving their observable results.

### 6. Restrict User PR mutations to User-owned fields (F-08)

Implement the ownership decision above. Permit User-owned outcome and evidence
fields only; protect runtime-owned bindings and statuses. Add tests proving an
invalid User update cannot overwrite runtime state.

## Phase 2: P1 local simplifications

### 7. Make build output authoritative (F-22)

Clean generated output before TypeScript emit so stale files cannot survive a
build. This is a soft prerequisite for the later hook and CI simplifications.

### 8. Bound setup-time model discovery (F-03)

Give the model-list subprocess an explicit timeout and output-size limit. Do
not parse partial stdout after either limit is reached. Use a fake child-process
test for timeout, oversized output, and normal output.

### 9. Align the Signal prompt with its tool contract (F-25)

Keep draft-only behavior tool-free, and request only the tool inputs that the
Signal tool accepts. Derive identities from runtime state rather than prompting
for unsupported fields.

### 10. Use one archive snapshot per composite projection (F-04)

Build one immutable, append-ordered snapshot for each composite projection
operation, with private local maps where they simplify lookups. Preserve
existing results while removing repeated archive reads and scans.

F-05 is folded into this work. Do not introduce a persistent global index.

## Phase 3: P2 targeted cleanup

### 11. Bypass recovery scans for named scheduled work (F-09)

Use the known work ID carried by a scheduled wake to claim directly. Retain the
global scan only for startup and resume cases where the work is not known.

### 12. Build a private coordination graph per snapshot (F-11)

Replace repeated scans and overlapping maps with a snapshot-local graph keyed
by complete upstream identity, including remote and branch. Keep its lifetime
limited to the coordination operation.

### 13. Remove the nested executor-registry reread (F-16)

Let the locked writer receive the current executor record already loaded by the
caller, rather than reading it again inside a nested helper.

### 14. Use explicit clarify outcomes (F-19)

Replace nullable clarify results with a local discriminated outcome for ready,
cancelled, invalid, unavailable, and failure. Map those outcomes to UI text in
one boundary and add behavior-level coverage for each path.

### 15. Simplify automation after build hygiene is proven (F-23 and F-24)

After F-22, remove redundant typecheck/package work from the pre-push hook and
redundant build work from CI while retaining the meaningful test gates.

### 16. Correct ownership terminology in documentation (F-26)

Align README and glossary language with the actual flow: User queues work,
Conclave admits it, and runtime executes it.

## Phase 4: explicitly gated P3 work

### 17. Retire the legacy v1 retry path (F-07)

Only after F-01 and explicit approval, remove the isolated v1 retry branch and
its legacy-only tests. Do not add a migration or compatibility fallback.

### 18. Normalize pi-review active state (F-20)

After the persisted-state decision, replace the dual globals and optional
active record with one explicit active/inactive state representation. Cover
the selected cutover behavior.

### 19. Remove the unused Oracle summary parser (F-18)

After consumer confirmation, remove the unregistered parser and its dedicated
test while retaining any still-used package prompt or public surface.

## Validation gates

For every implementation slice:

1. Run `prek run` before and after the change as required by project rules.
2. Add and run focused behavioral tests using the repository-approved runner;
   do not use prohibited full-suite commands.
3. Run `npm run check` after code changes.
4. Update public documentation in the same slice when a public or persisted
   contract changes.
5. Obtain a fresh independent review after each significant slice.

Before closing the program, rerun the relevant focused regressions across all
completed slices, run the repository quality gates, and verify that the final
state has no accidental compatibility adapters or broad persistent caches.

## Explicit non-work

- Do not implement rejected findings F-02, F-10, F-14, or R-01.
- Do not treat the separate legacy `launching`/`launched` storage path as part
  of this plan without a new owner-approved finding.
- Do not turn F-04 or F-11 into a general cache, registry, or state-machine
  framework.
