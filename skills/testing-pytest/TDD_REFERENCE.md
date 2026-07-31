# Pytest TDD Reference

Pytest execution reference layered on top of `tdd-core`.

For core doctrine (behavior-first tests, vertical slices, mock boundaries), use:

- `../tdd-core/SKILL.md`
- `../tdd-core/REFERENCE.md`

## Fast command set

- Target behavior: `pytest -q -k <pattern>`
- Failed-first rerun: `pytest --lf -q`
- Debug one failure: `pytest -k <pattern> -vv --maxfail=1 --pdb`
- Coverage signal: `pytest --cov --cov-report=term-missing`
- Parallel (only deterministic tests): `pytest -n auto`

## Fixture discipline

- Prefer local fixtures near tests unless broadly shared.
- Use explicit fixture scopes (`function`, `module`, `session`).
- Avoid autouse fixtures unless clearly justified.
- Keep setup deterministic and side effects isolated.

## Parametrize and properties

- Use `@pytest.mark.parametrize` for behavior/input tables.
- Use Hypothesis for invariants and broad input exploration.
- Avoid duplicating examples that property tests already cover.

## Mocking in pytest

- Mock at boundaries (HTTP, external SDKs, time/random, OS/process edges).
- Avoid mocking internal domain collaborators you own.
- Prefer fakes/stubs with stable behavior over deep mock chains.

## Refactor cues after GREEN

- repeated setup/assertions -> fixture/helper extraction
- long mixed-concern tests -> split by behavior
- brittle fixture webs -> reduce indirection and scope

## Cycle checklist

- [ ] one behavior targeted
- [ ] failing test first
- [ ] minimum implementation only
- [ ] refactor while green
- [ ] focused pytest checks run
