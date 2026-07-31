# Python delivery rules

Load this reference when applying `python-developer` to implementation, review,
refactoring, or hardening work. `SKILL.md` is the router; this file keeps the
detailed delivery contract.

## Guidance levels

- Default project workflow: follow these unless local code reality or the user
  explicitly wants a different pattern.
- Style guidance: prefer these patterns, but do not fight strong local
  conventions without reason.

## 1) Tooling and environment

- Use `uv` + `pyproject.toml` by default.
- Prefer `uv sync` for environment setup when needed.
- Run Python tools via `uv run` when the project manages them as dependencies.
- Prefer repo-managed commands (`uv run`, `just`, configured scripts, project
  task runners) over bare `python` / `python3`.
- Put reusable build, release, probe, or workflow logic in scripts instead of
  inline YAML/shell/Python snippets.
- Do not edit generated files directly; update the source config, generator, or
  script that produces them.
- Standard library first; add dependencies only when clearly justified. See
  `STRICT_RULES.md` for dependency, CLI, logging, and generated-file policy.
- Do not introduce Poetry, pip-only venv flows, or `requirements.txt` unless
  asked.

## 2) API and type design

- Require explicit type hints on new or materially changed Python code.
- Use the strongest local domain type for semantic fields: units, IDs, component
  references, solver names, datasets, and model entities.
- Identify the data owner before adding dataclasses/Pydantic models. Reuse
  canonical package models or infrasys `System` components when they own the
  contract.
- Prefer one structured return object over loose multi-value tuples when
  semantics matter.
- Do not use raw positional tuples, `object` type hints, casual `typing.cast`,
  or semantic `dict[str, Any]` payloads. See `STRICT_RULES.md` for hard type
  boundaries.
- Public helpers return useful values. Avoid success-by-`None`; use explicit
  values or `rust_ok.Result[None, E]` where no-payload success is necessary.
- Use `has_*` / `is_*` names for boolean predicates. Use `validate_*` only when
  the function's contract is to raise detailed validation errors; when
  practical, return the validated value/component so callers can use it
  directly.
- Keep signatures compact; prefer keyword-only args once a function grows beyond
  1-2 obvious positional parameters.
- Name functions so action + primary object are clear.

## 3) Error handling

- Prefer `rust_ok.Result[T, E]` for recoverable boundary failures where callers
  branch on success/failure.
- Never bare-unwrap `rust_ok` results in live code.
- Avoid broad `try/except`; keep guarded blocks tiny and catch specific
  exceptions or documented library error/status codes.
- Fail fast at boundaries with clear, actionable errors.
- See `STRICT_RULES.md` for the full error-handling contract.

## 4) Async and performance

- Use async patterns for I/O-bound paths that are already async-aware.
- Do not block the event loop in async code.
- Keep hot paths straightforward before attempting clever optimization.
- Check memory overhead in loops and model-building paths: materialization,
  copies, sorting, and repeated conversions. Measure Python command memory with
  Torc, not Python-level memory probes; see `STRICT_RULES.md` and
  `scripts/measure_memory_with_torc.sh`.
- Prefer project iterators/generators such as infrasys `get_components(...)`
  directly when building constraints, mappings, or model inputs.
- Avoid clever NumPy such as `np.einsum` unless it is clearly simplest and the
  shape/axis semantics are documented.

## 5) Testing

- Use `pytest` with function-based tests and fixtures by default.
- Each new or materially changed function should have direct or behavior-level
  test coverage.
- Reusable fixtures belong in pytest fixture plugins (`conftest.py` or project
  plugin modules), not copied private helpers in test files.
- Test public behavior first; do not test through private APIs.
- Add regression tests for bug fixes.
- When the user provides an exact failing command, validate with that command or
  the smallest faithful equivalent before reporting success.
- Run targeted tests for touched paths unless the user requests broader
  validation.
- Do not add pytest tests to benchmark/experiment folders when the project or
  user says benchmark tests are not desired.
- For benchmark scripts, prefer validation such as `ruff`, `py_compile`, doctest
  when docstrings are changed, small script smoke runs with bounded inputs,
  workflow dry-runs, and full benchmark runs only when needed.
- Escalate to `testing-pytest` when fixture architecture, plugin behavior,
  property tests, snapshots, or CI test strategy become the main problem.

## 6) Logging and CLI output

- Use `loguru` for project logging and disable the package logger by default so
  users opt in to logs.
- Prefer structured or consistent operational messages over ad-hoc `print(...)`
  debugging.
- Use `print(...)` only when a script/CLI contract requires stdout output.
- For probes, benchmarks, and smoke scripts, default to concise operational
  output such as Ok/Fail tables. Reserve full JSON for `--json`, `--verbose`, or
  diagnostics.
- Match existing project logging conventions when they are already coherent.

## 7) Naming, visibility, and entrypoints

- Prefer explicit public helpers over unnecessary hidden magic.
- Never call private APIs from dependencies or sibling packages. Use the clean
  public pathway the package provides instead of hacks or alternate paths.
- Name operations with clear action-first verbs (`list_...`, `get_...`,
  `build_...`, `run_...`) so behavior is obvious from the call site.
- Avoid private helper abuse. Use leading underscores only for truly private
  implementation details with no expected reuse, or when required by local
  conventions/framework protocols.
- For CLI scripts, put `argparse` / `sys.argv` parsing and process-exit behavior
  directly in `if __name__ == "__main__"`; keep reusable business logic in typed
  helper functions.
- Put measurable or reusable logic in named functions that return typed results.
- For benchmark/experiment scripts, separate input parsing, domain input
  construction, core computation, result validation, and boundary
  serialization/printing.

## 8) Documentation and docstrings

- Follow local docstring conventions first.
- If the repo has no clear convention, prefer NumPy-style docstrings for public
  functions and methods.
- Python examples should use the project doctest-comment style from
  `NUMPY_DOCSTRING_STYLE.md`.
- Add concise inline comments for non-obvious rationale, invariants, units,
  generated-file boundaries, compatibility constraints, operational gotchas, or
  algorithm choices. Prefer comments that answer "why this path?".
- Do not add breadcrumb comments such as "moved to X" after deleting or moving
  code.
- Add runnable examples when a function contract is non-obvious, user-facing, or
  easy to misuse.

## 9) Quality gates

- Assume pedantic `ruff` and `ty` expectations even when local config is looser.
  Write new code so it would survive strict lint and type review.
- Prefer repo-configured `ruff`, `pytest`, and `ty` settings for normal work.
- Use the pedantic scripts when the user wants a strict sweep, when hardening
  recently touched code, or when checking whether local config is too
  permissive.
- Treat pedantic checks as signal generators, not mandatory universal policy;
  they may surface issues that a repo intentionally ignores.

## 10) Scripts

| Script                                | Purpose                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check_pedantic_ruff.sh`      | Run a very strict Ruff lint pass with preview rules and `ALL` enabled                                                               |
| `scripts/check_pedantic_ty.sh`        | Run a very strict ty pass with all rules elevated to errors                                                                         |
| `scripts/measure_memory_with_torc.sh` | Measure one Python command's memory through Torc resource monitoring; installs latest Torc through the torc-hpc helper when missing |
