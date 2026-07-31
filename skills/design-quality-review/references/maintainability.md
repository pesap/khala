# Maintainability Reference (M0–M3)

Load this reference when the diff contains commented-out code, duplicated logic
across files, new dependencies, imports that look accidental, stale references,
or debug artifacts.

## Review Priority Order

### M0: Dead Feature with Live Wiring / Dependency Cycle

Presumptive blocker.

- **Dead feature with live wiring**: feature flag, config toggle, or code path
  that is never activated in production but is wired through core
  infrastructure. This is dead code that still costs: it runs in CI, needs
  maintenance, confuses readers, and can rot silently.
- **Dependency cycle**: module A imports from B, B imports from A (direct or
  transitive). This makes the modules impossible to test, deploy, or reason
  about independently.
- **Duplicated subsystem**: two implementations of the same significant
  feature/algorithm maintained in parallel. The diff adds to one without
  removing the other.

### M1: Active Rot

Presumptive blocker.

- **Dead code in active paths**: unreachable branches, functions called from
  nowhere, imports used by nothing, variables assigned but never read — and this
  dead code sits in files that are actively maintained. It wastes reviewer time
  and risks being accidentally "fixed" or "updated" during future changes.
- **Unnecessary dependency**: the diff adds a new library dependency for
  something the standard library, an existing dependency, or <100 lines of
  well-tested code could handle. Each new dependency is a maintenance vector
  (CVEs, breaking changes, build complexity).
- **Copy-pasted logic with drift risk**: a significant block of logic (>20
  lines) duplicated from another file instead of extracting a shared helper. The
  two copies will inevitably diverge.
- **Commented-out code block >10 lines**: large blocks of dead code left as
  comments. These rot silently and confuse readers about whether the code is
  needed.

### M2: Maintenance Drift

- **Stale or misleading comment**: a comment that describes behavior that no
  longer matches the code. Worse than no comment.
- **Orphaned import/variable**: something the diff removed usage of but left the
  import or declaration.
- **Debug artifact**: `console.log`, `print()`, `dbg!()`, `TODO` comments, or
  temporary test code left in production paths.
- **Magic number without explanation**: a literal value used in logic with no
  named constant or comment explaining its origin.
- **New dependency without version pinning**: adding a dependency with `*` or
  `latest` instead of a pinned version.
- **Inconsistent pattern**: the diff solves a problem one way when the codebase
  already has an established pattern for the same problem.

### M3: Polish

- Variable/function name could be clearer (but is not misleading).
- Comment could be more concise or more precise.
- Minor formatting inconsistency (trailing whitespace, mixed indentation).
- Missing docstring on a non-obvious function (but the name is clear).

## Dead Code Detection

For the reviewed scope, check for these signals. Treat them as **evidence for a
finding**, not as automatic deletions (the full dead-code-proof workflow with
static analysis tools is separate).

### High-confidence signals (flag as M1)

1. **Function defined but never called** anywhere in the codebase (check with
   grep or static analysis).
2. **Import used by zero statements** in the importing file.
3. **Variable assigned but never read** in its scope.
4. **Branch that can never be reached**: condition is always true/false given
   the types and values flowing into it.
5. **File imported by nothing** and containing only symbols that are not
   exported to external consumers.

### Medium-confidence signals (flag as M2)

1. **Feature flag always set to one value** in all configuration environments.
2. **Code path gated by a condition that is always true** in the current
   deployment context.
3. **Export never imported** by any file in the repo (but could be used by
   external consumers — verify before flagging as M1).
4. **Commented-out code** — flag if >10 lines.

### What NOT to flag as dead code

- Plugin/hook systems where discovery is dynamic (reflection, filesystem scan,
  DI container). These require runtime analysis, not static review.
- Config-driven behavior where the config lives outside the repo.
- Public API exports — even if nothing in-repo imports them, they are not dead.
- Dead code that was present _before_ the diff. Only flag what the diff
  introduces or exposes.

## Dependency Hygiene

For every new dependency introduced by the diff:

1. **Is it justified?** What does it provide that the standard library or an
   existing dependency doesn't? Could <100 lines of well-tested code replace it?
2. **Is it pinned?** Check for exact version pinning (not `*`, `latest`,
   `^x.y.z` without lockfile).
3. **Is it transitive?** If the dependency is already a transitive dependency of
   something else, pinning it directly creates a version conflict risk.
4. **Is it lightweight?** A dependency that pulls in 50 transitive dependencies
   for one utility function is a smell.
5. **Does it belong in the right dependency group?** devDependency vs
   dependency, optional vs required, test vs production.

For dependency _structure_ (not new deps), flag:

- **Wrong-direction import**: low-level utility importing from high-level
  feature. This couples layers that should be independent.
- **Deep transitive import**: importing a deeply nested internal module of
  another package (`package.internal._private._helper`) — this breaks when the
  package reorganizes.
- **Star/re-export without control**: `from module import *` or
  `export * from './module'` — this leaks implementation details into the public
  surface.

## Duplication Detection

When the diff adds logic, scan for duplication:

1. **Is this logic already implemented elsewhere in the codebase?** Grep for key
   function names, algorithm patterns, or constant values.
2. **Is the duplicated version significantly different?** If the diff's version
   has different edge-case handling, error behavior, or defaults, this is worse
   than duplication — it's _divergent duplication_. Flag as M1.
3. **Could the existing implementation be extended instead?** If a small
   parameterization would let the existing code serve both callers, prefer that
   over copy-paste.

## What Not to Flag as Maintainability

- "This should be refactored" without concrete evidence of a problem.
- "This could be more modular" when the code is <200 lines and has one caller.
- Naming preferences that are not misleading.
- Missing comments on self-documenting code.
- Dead code outside the reviewed scope (unless the diff exposes it as an orphan
  — e.g., the diff removes the last caller of a function).
