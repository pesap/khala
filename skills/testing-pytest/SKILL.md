---
name: testing-pytest
description: Python pytest adapter for TDD workflows. Use this skill when users need pytest test design, red-green-refactor execution, fixture/parametrize strategy, or CI test quality improvements in Python projects.
license: MIT
---

## Use when
- Project uses Python + pytest.
- User asks to write/refactor/debug tests with pytest.
- User asks for TDD in Python.
- User asks for fixture design, flaky test fixes, coverage, or performance checks in pytest.

## Avoid when
- Scope is not Python/pytest.
- User asks for language-agnostic TDD only (use `tdd-core` first).

## Relationship to tdd-core
- Apply `tdd-core` as the base doctrine.
- This skill adds pytest-specific execution patterns.

## Pytest-specific workflow
1. Pick one behavior from the TDD plan.
2. **RED**: add one failing pytest test.
3. **GREEN**: minimal implementation to pass.
4. **REFACTOR**: clean code/fixtures while tests stay green.
5. Repeat in small vertical slices.

## Pytest guardrails
- Prefer public-interface tests over internals.
- Use `@pytest.mark.parametrize` for behavior matrices.
- Use Hypothesis for invariants/properties.
- Keep fixtures explicit by scope; avoid hidden coupling in `conftest.py`.
- Use boundary mocks only; avoid mocking your own domain modules.

See [TDD_REFERENCE.md](TDD_REFERENCE.md) for commands and troubleshooting.

## Output
- Behavior coverage for this cycle
- Test files/fixtures changed
- Commands run + results
- Remaining gaps/risks + next cycle
