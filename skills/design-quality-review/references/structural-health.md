# Structural Health Reference (T0–T3)

Load this reference when the diff contains new files >500 lines, adds >200 lines
to an existing file, introduces new abstractions or wrappers, adds conditionals
in shared/general-purpose paths, or contains orchestration code.

This is the "code judo" dimension. The core question: **can this change be
restructured to make the implementation dramatically simpler, smaller, more
direct, and more elegant while preserving behavior?**

## Core Philosophy

Do not merely identify local cleanup opportunities. Actively search for "code
judo" moves: restructurings that preserve behavior while making the
implementation dramatically simpler. Assume there is often a reorganization that
uses the existing architecture more effectively and makes the change feel
inevitable in hindsight.

## Review Priority Order

### T0: Architecture Emergency

Presumptive blocker.

- **Circular dependency** introduced between modules that previously had a clean
  directional relationship.
- **File >2000 lines** due to this change, or a file pushed from <1000 to
  > 2000 in a single PR.
- **Spaghetti tangle**: the change adds branching logic to 5+ unrelated code
  paths in different files with no unifying abstraction.
- **Dead feature with live wiring**: feature flag or config toggles that are
  always-off in production but wired through core paths.
- **Inverted layer dependency**: a low-level utility module importing from a
  high-level feature module (dependency inversion without an interface).

### T1: Structural Regression

Presumptive blocker.

- **File crosses 1000 lines** due to the PR. Treat this as a strong code-quality
  smell. Prefer extracting helpers, subcomponents, or modules instead of letting
  a file sprawl past 1000 lines. Only waive if there is a compelling structural
  reason and the file remains clearly organized.
- **New ad-hoc conditionals in shared paths**: feature-specific `if` blocks,
  mode flags, or special cases inserted into general-purpose modules. If a
  change adds "weird if statements in random places," that is a design problem.
- **Layer leak**: feature logic leaking into shared infrastructure, or
  implementation details leaking through a public API.
- **Bespoke helper where canonical exists**: the codebase already has a
  utility/helper/module for this concept, but the diff introduces a
  near-duplicate.
- **Missed code-judo opportunity**: a clearly plausible restructuring exists
  that would make the implementation dramatically simpler. The path to the
  better design is visible and well-defined.

### T2: Missed Simplification or Minor Structural Issue

- **Thin abstraction**: a wrapper, interface, or helper that adds indirection
  without buying clarity. Identity wrappers, pass-through helpers, single-use
  abstractions that merely rename concepts.
- **Logic in wrong layer**: code placed in a module that does not own the
  concept, even though a canonical home exists elsewhere in the codebase.
- **Unnecessary sequential orchestration**: independent work serialized for no
  good reason when parallel execution would be simpler and clearer.
- **Non-atomic updates**: related state mutations that can leave state
  half-applied when one fails. Push for an atomic structure.
- **Condition chain instead of model**: repeated `if/else` or `switch` on the
  same discriminant suggesting a missing enum, strategy, or state machine.
- **Magic behavior**: generic mechanisms that hide simple data-shape
  assumptions, making the code harder to reason about.
- **Refactor that moves complexity around but doesn't delete it**: the change
  reorganizes code but fails to reduce the number of concepts a reader must hold
  in their head.

### T3: Minor Structure Nit

- A function could be extracted but the file is well under threshold.
- A small helper could be inlined but isn't causing confusion.
- Minor inconsistency with existing abstractions (not a pattern violation).

## File-Size Gates (Language-Adapted)

Consult `references/language-map.md` for exact thresholds. Defaults:

| Language   | Warning at | Blocker at | Notes                                                             |
| ---------- | ---------- | ---------- | ----------------------------------------------------------------- |
| Python     | 800 lines  | 1200 lines | Python files tend to be shorter; 800 is already large             |
| TypeScript | 1000 lines | 1500 lines | Component files can be larger; pure logic files should be smaller |
| Rust       | 1200 lines | 2000 lines | impl blocks inflate line count; trait impls can be separate files |
| Go         | 800 lines  | 1200 lines | Idiomatic Go keeps files focused                                  |
| Default    | 1000 lines | 1500 lines | Err on the side of decomposition                                  |

## Anti-Spaghetti Detection

Apply the "spaghetti test" to every new conditional in the diff:

1. **Is this conditional in a general-purpose module?** If yes, does it pull
   feature-specific knowledge into a shared path? Flag as T1.
2. **Is this conditional gating behavior based on a mode/flag/config that
   spreads across multiple files?** If yes, push for a dedicated abstraction
   (strategy, state machine, policy object) instead of scattered `if` checks.
3. **Is this conditional a special case that could be a default flow?** Many
   special cases exist because the default design didn't account for the case.
   Can the default be changed so the special case disappears?

## Thin Abstraction Detection

An abstraction is "thin" (T2) when:

- It adds a new name without adding new behavior or constraints.
- It is a single-method class/interface used in exactly one place.
- It is a pass-through: every public method delegates to an identical method on
  a wrapped object with no transformation.
- It is a re-export: a module that exists only to re-export symbols from another
  module with no added value.
- Removing it would make the code shorter and clearer with no loss of
  information.

## Layer Discipline

For every new function, class, or module introduced by the diff, ask:

1. **What concept does this code belong to?**
2. **Which package/module owns that concept?**
3. **Is this code in that owner?** If not — T2 (wrong layer).

Signs of a layer leak:

- Feature name appearing in infrastructure code (e.g.,
  `if user.plan === 'enterprise'` in a database connector).
- Implementation detail leaking through API (e.g., database column names in REST
  responses, internal error codes in public error messages).
- Import direction reversal (low-level importing high-level).

## Orchestration Smells

- **Sequential where parallel**: `await a(); await b();` when `a` and `b` share
  no state and neither depends on the other's result — T2.
- **Non-atomic multi-step**: `update(x); update(y);` where `update(y)` can fail
  after `update(x)` succeeded, leaving partial state — T2. Suggest wrapping in a
  transaction or using a batch operation.
- **Orchestration mixed with business logic**: a function that both decides
  _what_ to do and _does_ it. Separate orchestration from business logic.

## Preferred Remedies

When you find a structural problem, prefer suggestions in this order:

1. Delete a whole layer of indirection rather than polishing it.
2. Reframe the state model so conditionals disappear instead of getting
   centralized.
3. Change the ownership boundary so the feature becomes a natural extension of
   an existing abstraction.
4. Turn special-case logic into a simpler default flow with fewer exceptions.
5. Extract a helper or pure function.
6. Split a large file into smaller focused modules.
7. Move feature-specific logic behind a dedicated abstraction.
8. Replace condition chains with a typed model or explicit dispatcher.
9. Reuse the existing canonical helper instead of introducing a near-duplicate.
10. Parallelize independent work when that also simplifies the orchestration.
11. Restructure related updates into a more atomic flow.

Do not be satisfied with "maybe rename this" when the real issue is structural.
Do not be satisfied with a merely cleaner version of the same messy idea if
there is a plausible path to a much simpler idea.
