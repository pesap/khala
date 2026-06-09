---
name: public-api-guard
description: Prevent accidental breaking changes to public APIs during cleanup/refactor work. Use this skill when users request behavior-preserving cleanup, large refactors, or any change that may alter exported interfaces, CLI contracts, schemas, or integration surfaces.
license: MIT
---

## Use when
- Refactor/cleanup touches exported modules or shared packages.
- User requests non-breaking changes.
- There is risk of signature/contract drift.

## Avoid when
- User explicitly requests a breaking-change release and migration work.
- Scope is internal-only code with no external surface.
- Baseline API surface cannot be identified and user declines guard setup.

## Instructions
1. Define API surface for scope.
   - Include exported symbols, CLI flags/output contracts, config/schema interfaces, and externally consumed types.
2. Capture baseline.
   - Snapshot current surface (tooling or explicit manifest).
3. Compare after changes.
   - Detect removals, signature changes, behavioral contract drift.
4. Enforce policy.
   - Block unapproved breaks.
   - If approved, require migration note and explicit callout.
5. Validate consumers where feasible.
   - Run impacted integration or compatibility tests.

## Output
- API surface definition
- Compatibility diff (before/after)
- Break classification (none/approved/unapproved)
- Validation commands + results
- Required follow-ups (if any)
