---
name: python-developer
description: Deliver Python feature work, bug fixes, refactors, and production hardening with uv-based tooling, explicit typing, focused pytest validation, and strict quality gates. Use when users ask to implement, debug, clean up, type-harden, or test Python code, even if they do not mention uv, pytest, Ruff, or ty.
license: MIT
---

# python-developer

## Use when
- The task is primarily Python feature work, bug fixing, refactoring, or production hardening.
- The user wants clearer APIs, stronger typing, better tests, or safer error handling in Python code.
- The user asks to clean up, debug, or make a Python module/script/package more maintainable.
- You need a repeatable Python delivery workflow instead of ad-hoc prompting.

## Avoid when
- The task is not Python-centric.
- The request is planning-only, docs-only, or status-only.
- The user wants a tiny one-off snippet with no repo integration or validation expectations.

## Quick router
- Deep root-cause debugging or flaky behavior investigation -> load `debug-investigation`.
- Test-first red/green/refactor workflow -> load `tdd-core` and `testing-pytest`.
- Deep pytest fixture/plugin/parametrize strategy -> load `testing-pytest`.
- Typed data contracts, Pydantic, dataclasses, or schema boundaries -> load `data-model`.
- Broad typing cleanup or interface hardening -> load `type-hardening`.
- Standalone script packaging or shell glue -> consider `uv` or `bash-script`.

## Guidance levels
- **Default project workflow**: follow these unless local code reality or the user explicitly wants a different pattern.
- **Style guidance**: prefer these patterns, but do not fight strong local conventions without reason.

## Core workflow
1. Restate assumptions and acceptance criteria.
2. Read touched code paths end-to-end before editing.
3. Implement the smallest root-cause change.
4. Add or update targeted pytest coverage.
5. Run relevant validation with `uv run ...` where practical.
6. Summarize changed files, evidence, and residual risks.

## Delivery rules

### 1) Tooling and environment
- Use `uv` + `pyproject.toml` by default.
- Prefer `uv sync` for environment setup when needed.
- Run Python tools via `uv run` when the project manages them as dependencies.
- Prefer the Python standard library over introducing a new dependency when it solves the problem clearly and maintainably.
- Do not introduce Poetry, pip-only venv flows, or `requirements.txt` unless asked.

### 2) API and type design
- Require explicit type hints on new or materially changed Python code.
- Prefer one structured return object (`dataclass`, `TypedDict`, or Pydantic model) over loose multi-value tuples when semantics matter.
- Keep signatures compact; prefer keyword-only args once a function grows beyond 1-2 obvious positional parameters.
- Name functions so action + primary object are clear.

### 3) Error handling
- Avoid broad `try/except` and catch-all handlers.
- Handle expected failure modes with specific exceptions.
- Fail fast at boundaries with clear, actionable errors.

### 4) Async and performance
- Use async patterns for I/O-bound paths that are already async-aware.
- Do not block the event loop in async code.
- Keep hot paths straightforward before attempting clever optimization.

### 5) Testing
- Use `pytest` with function-based tests and fixtures by default.
- Add regression tests for bug fixes.
- Run targeted tests for touched paths unless the user requests broader validation.
- Escalate to `testing-pytest` when fixture architecture, plugin behavior, property tests, snapshots, or CI test strategy become the main problem.

### 6) Logging and CLI output
- Prefer `logging`-based structured or consistent operational messages over ad-hoc `print(...)` debugging.
- Use `print(...)` only when a script/CLI contract requires stdout output.
- Match existing project logging conventions when they are already coherent.

### 7) Naming, visibility, and entrypoints
- Prefer explicit public helpers over unnecessary hidden magic.
- Name operations with clear action-first verbs (`list_...`, `get_...`, `build_...`, `run_...`) so behavior is obvious from the call site.
- Use leading underscores only when they match clear local conventions or framework/protocol expectations.
- Prefer callable entry functions for reuse; use `if __name__ == "__main__":` when a real script entrypoint is appropriate.

### 8) Documentation and docstrings
- Follow local docstring conventions first.
- If the repo has no clear convention, prefer NumPy-style docstrings for public functions and methods.
- Add runnable examples when a function contract is non-obvious, user-facing, or easy to misuse.

## References to load on demand
- `SYNTAX_DO_DONT.md` for concrete Python do/don't patterns.
- `NUMPY_DOCSTRING_STYLE.md` when docstring style or examples are part of the task.
- `scripts/check_pedantic_ruff.sh` for an intentionally strict Ruff gate.
- `scripts/check_pedantic_ty.sh` for an intentionally strict ty gate.

Read `SKILL.md` first. Load the extra files only when their detail is relevant.

## Quality gates
- Prefer repo-configured `ruff`, `pytest`, and `ty` settings for normal work.
- Use the pedantic scripts when the user wants a strict sweep, when hardening recently touched code, or when checking whether local config is too permissive.
- Treat pedantic checks as signal generators, not mandatory universal policy; they may surface issues that a repo intentionally ignores.

## Scripts

| Script | Purpose |
|---|---|
| [scripts/check_pedantic_ruff.sh](./scripts/check_pedantic_ruff.sh) | Run a very strict Ruff lint pass with preview rules and `ALL` enabled |
| [scripts/check_pedantic_ty.sh](./scripts/check_pedantic_ty.sh) | Run a very strict ty pass with all rules elevated to errors |

## Output
- Assumptions and approach.
- File-level changes.
- Validation commands + results.
- Residual risks, follow-ups, or delegation notes.

## Trigger eval plan
### Positive prompts
1. "Use python-developer to fix this Python bug and add a regression test."
2. "Refactor this Python module for clearer types and better error handling."
3. "Make this async Python path safe and validate it with targeted pytest runs."
4. "Tighten this Python script so it is production-ready and easier to maintain."
5. "Clean up this Python package API and keep the diff small."

### Near-miss negative prompts
1. "Review this architecture doc; no code changes yet."
2. "Explain Python generators simply."
3. "Fix this TypeScript build error."
4. "Only write a migration plan; do not touch code."
5. "Give me a one-line Python snippet for reading JSON."
