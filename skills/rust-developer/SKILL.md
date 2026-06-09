---
name: rust-developer
description: Rust implementation workflow for safe, idiomatic, strongly-typed code with fast feedback and disciplined testing. Use when users request Rust feature work/bugfix/refactor/perf, stricter code quality, clippy hardening, panic/unsafe reduction, stronger typing/contracts, or behavior-first test discipline.
license: MIT
---

## Use when
- Task involves Rust feature work, refactors, bug fixes, or performance-sensitive paths.

## Non-negotiable rules
- Prefer `crate::` paths over `super::` for clarity.
- No `unwrap`, `expect`, or panic-prone paths in production code.
- Use strong typing instead of stringly-typed validation.
- Prefer enums over strings for domain states.
- No E2E tests unless explicitly requested.
- Avoid global mutable state; pass context explicitly.
- Keep `unsafe` isolated, minimal, and documented with invariants.
- Justify every `unsafe` block: why safe Rust is insufficient, what invariants make it sound, and how tests/review cover the risk.
- Treat warnings as errors and fix immediately.
- Optimize hot paths and benchmark performance-sensitive changes.
- If tests live in the same module, keep `mod tests {}` at the bottom.
- Use rust-analyzer/LSP when available.
- All code should be tested.
- If complexity grows, prefer crate/module boundaries to contain it.
- Be idiomatic.
- Always question assumptions.

## Workflow
1. Clarify behavior and contracts before coding.
2. Model domain types first (enums/newtypes/structs), then implement logic.
3. Add focused tests (prefer integration tests for user-visible behavior; no E2E unless asked).
4. Prefer specific tests over the full suite unless broad validation is needed.
5. Run `cargo fmt --all`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`, and targeted `cargo test` (or `cargo nextest run` when available).
6. For snapshot-heavy flows, prefer `insta` patterns used by nearby tests.
7. For hot paths, run a benchmark/profiling check and summarize trade-offs.

## Safety and error handling
- Use `Result`/`thiserror`-style typed errors where appropriate.
- Prefer explicit error propagation (`?`) with context.
- Prefer `if let`/let chains for fallibility over panic-prone shortcuts.
- Avoid hidden fallbacks that mask failures.
- If adding or touching `unsafe`, include a concise `SAFETY` justification in code or review notes.

## Rust style and maintenance
- Read and match nearby test/style patterns before adding cases.
- Prefer integration tests when behavior crosses module/CLI boundaries.
- Prefer snapshots or structured assertions over brittle substring assertions.
- Prefer top-level imports over local imports or fully qualified names.
- Avoid shortened variable names; use descriptive domain names.
- Prefer let-chains (`if let ... && ...`) over nested fallibility branches when clearer.
- Prefer [`TypeName`] references in Rust doc comments.
- Prefer `#[expect(...)]` over `#[allow(...)]` when suppressing Clippy.
- Never assume Clippy warnings are pre-existing.
- Do not update all lockfile dependencies; use precise updates (for example `cargo update --precise`).
- Do not use release-profile builds unless requested or reproducing performance issues.
- For Unix-hosted Windows-target changes, run `cargo xwin clippy --workspace --all-targets --all-features --locked -- -D warnings` when possible.

## Output
- Summary of code/test changes
- Validation commands and results
- Performance notes for hot-path changes
- Risks/assumptions and follow-ups
