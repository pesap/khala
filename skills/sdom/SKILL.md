---
name: sdom
description: Build, run, debug, and extend the SDOM (Storage Deployment Optimization Model) Python package across data ingestion, Pyomo formulation wiring, solver configuration, outputs, and parametric studies. Use when users ask about SDOM runs, SDOM datasets, SDOM formulations, SDOM solver errors, SDOM result validation, or SDOM documentation updates, even if they only say "storage deployment model", "GenMix target", "parametric sweep", "Pyomo model", or "energy storage expansion model".
license: MIT
---

# sdom

## Use when
- Running SDOM scenarios, reproducing run failures, or interpreting solver outcomes.
- Changing SDOM model wiring in `src/sdom/` (sets/params/formulations/objective/constraints).
- Working with SDOM input datasets under `Data/` and validating expected schema.
- Implementing or validating parametric sweeps (`ParametricStudy`).
- Updating SDOM outputs, result post-processing, or SDOM docs/tests.

## Avoid when
- Task is generic Pyomo optimization not tied to SDOM.
- Task is mainly GitHub triage/PR/CI operations (use `github`).
- Task is purely generic Python hygiene with no SDOM-specific domain context.

## Quick reference routing
- Start with [references/REFERENCE.md](./references/REFERENCE.md).
- For run/setup/test commands, use **Runbook** section.
- For architecture entry points, use **Code map** section.
- For common failures, use **Troubleshooting** section.
- For validated source links, use **Canonical docs** section.

## Workflow
1. Confirm scope: run/debug/feature/docs and target dataset(s).
2. Reproduce with the smallest credible case first (reduced `n_hours` when possible).
3. Inspect touched SDOM surfaces before editing (io, model init, formulations, results, parametric).
4. Apply minimal, behavior-focused changes; preserve existing default run behavior unless explicitly requested.
5. Validate with targeted tests/runs, then broader checks when needed.
6. Summarize behavior changes, validation evidence, and residual risks.

## Output
- Scope classification (run/debug/feature/docs)
- Files/surfaces touched
- Validation commands + outcomes
- Data/solver assumptions
- Residual risks and follow-ups
