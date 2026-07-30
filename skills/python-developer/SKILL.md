---
name: python-developer
description: >
  Deliver Python feature work, bug fixes, refactors, tests, and production
  hardening with uv-based tooling, explicit typing, public-behavior pytest
  validation, and strict quality gates. Use when users ask to implement, debug,
  clean up, type-harden, package, benchmark, document, or test Python code, even
  if they only mention pytest, Ruff, ty, uv, async, logging, Pydantic,
  dataclasses, scripts, or maintainability.
license: MIT
---

# python-developer

## Use when

- Python feature work, bug fixes, refactors, tests, or production hardening.
- The user wants stronger typing, clearer APIs, safer errors, better tests, or
  maintainable Python scripts/packages.
- The task mentions pytest, uv, Ruff, ty, async Python, logging, Pydantic,
  dataclasses, CLI scripts, memory/performance, or benchmark Python code.

## Avoid when

- The task is not Python-centric.
- The request is planning-only, docs-only, review-only, or status-only.
- The user wants a tiny standalone snippet with no repo integration or
  validation.

## Quick router

| Situation                                            | Load                         |
| ---------------------------------------------------- | ---------------------------- |
| Root-cause debugging or flaky behavior               | `debug-investigation`        |
| Red/green/refactor or behavior-first tests           | `tdd-core`, `testing-pytest` |
| Deep pytest fixtures/plugins/parametrize/CI strategy | `testing-pytest`             |
| Pydantic/dataclass/config/schema/model boundary      | `data-model`                 |
| Public API compatibility risk                        | `public-api-guard`           |
| Strict code-quality review                           | `design-quality-review`      |
| Standalone uv script packaging                       | `uv`                         |
| Bash/shell wrapper work                              | `bash-script`                |
| Benchmark suite/runtime/memory comparison            | `benchmark`                  |

## Workflow

1. Restate assumptions, acceptance criteria, and the smallest validation target.
2. Inspect local toolchain, validation commands, and touched code paths before
   editing.
3. Reuse canonical package models, public APIs, and repo-managed commands.
4. Implement the smallest root-cause change.
5. Add or update focused validation: pytest for package behavior, or explicit
   non-pytest gates for scripts, benchmarks, and docs-only artifacts.
6. Run validation through `uv run ...`, `just`, or repo-configured commands when
   available.
7. Summarize changed files, validation evidence, residual risks, and any
   follow-up routing.

## Core rules

- Prefer `uv` + `pyproject.toml`; avoid Poetry, pip-only venv flows, or
  `requirements.txt` unless asked.
- Add explicit type hints to new or materially changed Python code.
- Prefer semantic/domain types over raw `str`, `float`, `dict[str, Any]`,
  `object`, or casual `typing.cast`.
- Reuse canonical package/infrasys models before creating local models.
- Public helpers return useful values; avoid success-by-`None`.
- Use `rust_ok.Result[T, E]` at recoverable boundaries where callers branch;
  never bare-unwrap `rust_ok` results in live code.
- Keep `try` blocks small and catch specific documented exceptions.
- Test public behavior, not private helpers.
- Use reusable pytest fixtures/plugins instead of copied private test helpers.
- Use `loguru` for project logging and disable package logging by default.
- Put CLI parsing and process-exit behavior in `if __name__ == "__main__"`; keep
  reusable business logic in typed helpers.
- Add comments only for non-obvious rationale, invariants, units, generated-file
  boundaries, compatibility constraints, or operational gotchas.

## References to load on demand

| Reference                             | Load when                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERY_RULES.md`                   | Applying this skill to implementation, review, or hardening work                                                                         |
| `STRICT_RULES.md`                     | Enforcing strict project rules or touching returns, errors, logging, memory, public APIs, tests, CLI, comments, or data-model boundaries |
| `SYNTAX_DO_DONT.md`                   | Concrete good/bad Python examples would prevent ambiguity                                                                                |
| `NUMPY_DOCSTRING_STYLE.md`            | Adding or changing public Python docstrings/examples                                                                                     |
| `scripts/check_pedantic_ruff.sh`      | User requests strict lint hardening                                                                                                      |
| `scripts/check_pedantic_ty.sh`        | User requests strict type hardening                                                                                                      |
| `scripts/measure_memory_with_torc.sh` | Measuring Python command memory                                                                                                          |

Read `SKILL.md` first. Load extra files only when their detail is relevant.

## Quality gates

- Prefer repo-configured `ruff`, `pytest`, and `ty` settings for normal work.
- Use targeted tests for touched paths unless broader validation is requested.
- For benchmark/experiment folders, avoid pytest unless the repo/user expects
  it; prefer `ruff`, `py_compile`, doctest, bounded smoke runs, workflow
  dry-runs, or full benchmark runs when needed.
- Treat pedantic Ruff/ty scripts as signal generators, not universal blockers.

## Output

- Assumptions and approach.
- File-level changes.
- Validation commands and results.
- Residual risks, follow-ups, or delegation notes.

## Evals

- Trigger evals: `evals/trigger-prompts.json`.
- Output-quality evals: `evals/evals.json`.
