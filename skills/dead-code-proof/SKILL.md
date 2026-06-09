---
name: dead-code-proof
description: Remove unused code only when non-usage is proven with layered evidence. Use this skill when users ask to delete dead code, run knip/vulture/ruff-unused checks, prune exports, or clean legacy paths, even if they only say "remove unused stuff".
license: MIT
---

## Use when
- User asks to remove dead/unused code, exports, files, or dependencies.
- Static analysis flags potential unused symbols.
- Cleanup/refactor includes deletions that might affect runtime wiring.

## Avoid when
- Task is feature delivery where deletion is incidental and unverified.
- Runtime/plugin discovery paths are unknown and cannot be validated.
- Behavior changes are intended (this skill is behavior-preserving by default).

## Instructions
1. Build evidence before deleting.
   - Run ecosystem-appropriate detectors (e.g., knip, lint/type unused checks).
   - Cross-check with text/AST references and known dynamic entrypoints.
2. Score each candidate.
   - `high`: proven unused across static + reference + runtime-path checks.
   - `medium`: likely unused but dynamic usage uncertainty remains.
   - `low`: conflicting evidence or unclear ownership.
3. Implement only high-confidence removals by default.
   - Do minimal, reversible edits.
   - Do not delete medium/low items without explicit approval.
4. Validate after each deletion batch.
   - Run lint/typecheck/tests for touched scope.
   - Confirm no import/export breakage.
5. Report proof trail.
   - For every deletion, include evidence and validation outcome.

## Output
- Deletion summary (files/symbols removed)
- Evidence matrix per deletion
- Validation commands + results
- Deferred candidates (medium/low) with blockers
- Risks and rollback notes
