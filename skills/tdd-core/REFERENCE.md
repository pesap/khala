# TDD Core Reference

General TDD doctrine adapted for C, Rust, Python, and mixed-language repos.

## Core principle

Tests should verify **observable behavior via public interfaces**, not
internals.

If behavior stays the same, refactors should rarely break tests.

## Anti-pattern: horizontal slicing

Avoid writing all tests first, then all implementation.

Prefer vertical slices:

- RED: one failing behavior test
- GREEN: minimum code for that test
- REFACTOR: design cleanup while all tests stay green

## Good tests

- Describe capability (WHAT), not mechanism (HOW)
- Use public interfaces/endpoints/APIs
- Fail for behavior regressions, not internal reshuffling

## Bad tests

- Assert private call order/count in core domain code
- Mock internal collaborators you control
- Break on rename/refactor without behavior change

## Mocking policy

Mock/stub/fake mostly at boundaries:

- network/external services
- filesystem/process boundaries (when expensive or unsafe)
- time/randomness

Prefer real domain components internally.

## Interface design for testability

- Inject dependencies; avoid hard-coded constructors in logic paths
- Return assertable outputs/state transitions
- Keep interfaces small and explicit
- Validate unknown/untrusted input at boundaries

## Refactor cues after GREEN

- duplication
- long mixed-concern functions
- shallow modules leaking complexity
- brittle setup/fixtures
- primitive obsession (missing domain types)

## Language notes

### C

- Keep seams explicit (function pointers/adapter layers) for boundary
  substitution
- Run sanitizers/static analysis where available (ASan/UBSan/clang-tidy)

### Rust

- Keep tests on public API and module boundaries
- Prefer property/invariant tests for tricky logic
- Validate with: `cargo fmt`, `cargo clippy -D warnings`, `cargo test`

### Python

- Keep tests function-based with clear arrange/act/assert
- Use parametrization for input matrices and Hypothesis for invariants
- Prefer focused runs during cycles, then broader suite

## Per-cycle checklist

- [ ] one behavior targeted
- [ ] failing test first
- [ ] minimal pass implementation
- [ ] refactor only when green
- [ ] focused validation executed
