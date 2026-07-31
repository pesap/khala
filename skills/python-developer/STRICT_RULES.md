# Strict Python rules

Load this reference when writing or reviewing Python code, hardening a module,
adding public helpers, creating CLI scripts, changing error handling, or
touching Pydantic/data-model boundaries.

## 1) Standard library first

- Always try the Python standard library before adding a dependency.
- Add a dependency only when the standard-library path is impossible, unsafe, or
  clearly worse for the project contract.
- If adding a dependency, name why the standard library is insufficient.

## 2) Return contracts and `rust_ok`

- Do not create functions whose only successful result is `None`.
- Return a useful value: validated input, mutated object, summary/result object,
  written path, count, boolean predicate, or domain model.
- If the only performant success payload is no payload, return
  `rust_ok.Result[None, E]` instead of success-by-`None`.
- Use `rust_ok.Result[T, E]` for recoverable boundaries where callers should
  branch on success/failure.
- Never use bare `unwrap()` in live code. Use `is_ok(result)`, `is_err(result)`,
  explicit branching, or propagate the error with context.

## 3) Error handling

- Avoid broad `try/except` and catch-all handlers.
- Keep each `try` block to at most two statements.
- Catch specific exceptions or use documented library error/status codes from
  the function being called.
- Do not translate unknown failures into generic errors.
- Preserve context in raised errors or `Err(...)` payloads.

## 4) Type boundaries

- Do not use `object` type hints. They mean the contract is unknown.
- Prefer `Protocol`, generics, a union of concrete types, semantic aliases, or a
  named model.
- Avoid `typing.cast` whenever possible. A cast is a smell that the model or
  boundary is weak.
- If a cast is unavoidable, place a nearby runtime guard that proves the type.

## 5) Logging

- Use `loguru` for project logging when adding or changing logging behavior.
- Disable the package logger by default so users opt in explicitly, for example
  with `logger.disable("package_name")` in package initialization.
- Use `print(...)` only for CLI stdout contracts, examples, tests, or small
  script output.

## 6) Performance and memory

- Check memory overhead when calling helpers in loops or model-building paths.
- Measure Python command memory with Torc resource monitoring, not Python-level
  probes. Do not use `tracemalloc`, `resource`, `memory_profiler`, `psutil`, or
  ad hoc in-process Python measurement for benchmark memory numbers.
- Use `scripts/measure_memory_with_torc.sh -- <python-command> ...` as the
  minimal local pattern. If Torc is missing, that helper installs the latest
  release from <https://github.com/NatLabRockies/torc/releases> before running
  the measurement.
- For full benchmark suites, copy the PTDF pattern: Torc workflow with
  `resource_monitor`, raw JSON stdout from implementations, Torc SQLite DB for
  runtime/peak memory, and a summarizer that reads `result.peak_memory_bytes`.
- Look for accidental materialization, dataframe/array copies, repeated
  conversions, and sorting where deterministic order is not required.
- Prefer project iterators/generators, such as infrasys `get_components(...)`,
  when building constraints, mappings, or model inputs.

## 7) Public APIs and package pathways

- Never call private APIs from dependencies or sibling packages.
- Do not implement hacks or alternate pathways when the package already provides
  one clean public path.
- Avoid private helper abuse. Use leading underscores only for truly private
  implementation details with no expected reuse.

## 8) Tests and fixtures

- Each new or materially changed function needs direct or behavior-level test
  coverage.
- Test public behavior first; do not test through private APIs.
- Reusable fixtures belong in pytest fixture plugins (`conftest.py` or project
  plugin modules), not copied private helpers in test files.

## 9) CLI scripts

- For CLI scripts, keep argument parsing and process-exit behavior directly in
  `if __name__ == "__main__":` using `argparse` or `sys.argv`.
- Keep reusable business logic in typed helper functions called from that block.
- Do not make `run_*` functions print as their primary behavior; return a typed
  summary and print/serialize at the boundary.

## 10) Documentation and comments

- Python examples use doctest-comment style: execute a statement, then put the
  expected value on the next line as `# expected`.
- Inline comments are welcome when they explain non-obvious rationale,
  invariants, units, generated-file boundaries, compatibility constraints,
  operational gotchas, or algorithm choices.
- Prefer comments that answer "why this path?" for the next developer.
- Do not add breadcrumb comments such as "moved to X" after deleting or moving
  code.

## 11) Data-model handoff

When model shape, Pydantic fields, optional fields, units, component references,
or schema evolution are involved, load `data-model` too. In particular:

- `Field(description=...)` does not make weak types strong.
- New `bool` fields and optional fields are design-review triggers.
- Reuse canonical package/System models before creating local copies.
