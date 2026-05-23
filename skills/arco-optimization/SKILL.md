---
name: arco-optimization
description: Debug and optimize Arco `.kdl` models with spec-first validation, minimal edits, and solver-safe checks. Use when users ask to fix Arco parse/validation/solve failures, improve model feasibility or objective behavior, or tune Arco scenario performance.
---

## Use when
- User asks to fix or optimize an Arco model/scenario (`.kdl`).
- `arco run ...` fails (parse, validation, infeasible/unbounded, wrong objective value).
- Constraint/indexing logic, temporal offsets, bounds, or objective structure need correction.

## Avoid when
- Task is not Arco DSL (generic OR/LP/MIP theory only, or other frameworks).
- User wants broad architecture work unrelated to model correctness/solve behavior.
- No runnable model/data context is available and user does not want to provide it.

## Workflow
1. Scope quickly
   - Confirm goal: correctness, feasibility, or performance.
   - Capture failing command, exact error, and expected behavior.
2. Reproduce first
   - Run the failing `arco run ...` command before edits.
   - Classify failure: parse vs validation vs solve-time.
3. Spec-first triage (arco-spec.md)
   - Check high-impact rules first: 14, 23, 34, 36, 37, 42, 44, 45, 54, 58, 60, 63, 68, 72, 74.
   - Verify objective count, index declarations, predicate form, operator context, bounds consistency, and param resolution.
4. Apply minimal fix
   - Prefer explicit generated constraints (`index` + `if` + `expression`) when inference is ambiguous.
   - Keep feasible region unchanged unless user explicitly asks for reformulation.
   - Do not invent syntax outside Arco spec.
5. Validate
   - Re-run the same `arco run ...` command.
   - Confirm diagnostics removed and summarize behavior delta.
   - If performance-focused, report metric before/after on same scenario.

## Output
- Root cause (spec rule + file location).
- Exact edits (minimal diff summary).
- Validation command(s) and result(s).
- Risks/follow-ups (if any).
