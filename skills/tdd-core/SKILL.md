---
name: tdd-core
description: Test-driven development with a red-green-refactor loop. Use when the user wants test-first development, mentions "red-green-refactor" or TDD, asks for behavior-first tests, or wants a feature/bugfix built through small vertical slices instead of writing all code first.
license: MIT
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Use when
- The user explicitly asks for TDD, test-first, or red-green-refactor.
- The task benefits from behavior-first delivery through public interfaces.
- A bugfix needs a failing test before the fix.

## Avoid when
- The task is pure investigation with no agreed implementation path yet.
- The change is trivial and the user explicitly does not want test work.
- The environment cannot run meaningful tests and the user only wants a sketch.

## Workflow

### 1. Planning

When exploring the codebase, use the project's domain glossary so that test names and interface vocabulary match the project's language, and respect ADRs in the area you're touching.

Before writing code, infer the target interface and behavior priorities from the user's request, existing tests, nearby implementation, docs, and issue context. Ask at most one blocking clarification only when the next test would otherwise encode a risky or irreversible assumption.

- [ ] Identify the smallest public interface change that proves the requested behavior
- [ ] Choose the first behavior to test from the request and repo context
- [ ] Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test (not implementation steps)

**You can't test everything.** Focus testing effort on critical paths and complex logic. If priorities are underspecified but a reasonable first slice is available, proceed with that slice and call out the assumption in the final summary.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

- Prefer the narrowest public interface that proves behavior end-to-end.
- Name the test after the behavior/capability, not the helper or implementation detail.

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior
- Prefer broad-but-shallow behavioral coverage over deep implementation coupling

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

## Common TDD failure modes

- Writing the whole test suite up front instead of learning one slice at a time.
- Testing helpers, mocks, or internal wiring rather than behavior through public interfaces.
- Letting GREEN expand into speculative implementation for future tests.
- Refactoring while still RED.
- Keeping brittle tests that fail on refactor without behavior change.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```
