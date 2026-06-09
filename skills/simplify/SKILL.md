---
name: simplify
description: Safely simplify recently touched code for readability and maintainability while preserving exact behavior. Use when users ask to simplify, refactor, clean up, reduce complexity, remove low-payoff indirection, or make a finished change easier to review without changing behavior.
license: MIT
---

## Trigger conditions
- User asks to simplify/refactor/clean up code without behavior changes.
- User asks for a readability/maintainability pass after an edit.

## Use when
- Scope is clear (specific files, diff, commit, PR, or folder).
- Goal is lower complexity with identical API/output behavior.
- You can validate touched paths with targeted checks.

## Avoid when
- User asks for feature, product, or architecture changes.
- Behavior expectations are ambiguous.
- Risky code paths lack tests or validation options.

## Instructions
1. Work only within requested scope.
2. Preserve exact behavior, API shape, side effects, and output.
3. Apply project standards first, then simplify structure.
4. Prefer explicit control flow over clever compact code.
5. Produce evidence-backed candidates before editing.
6. Auto-apply only low/medium-risk candidates with confidence `>= 0.90`.
7. Do not auto-apply public API changes, boundary error-handling changes, legacy/fallback pruning, or deletions without proof.
8. Remove dead/redundant code and low-payoff indirection only when usage evidence supports removal.
9. Keep abstractions that earn their keep; remove wrappers with no semantic value.
10. Run targeted validation for touched code and report it.

## Simplification checklist
- Unnecessary wrappers/pass-through helpers
- Dead code, debug leftovers, obsolete branches
- Local indirection that can be inlined safely
- Over-modularization for hypothetical future use

## Candidate table
Before edits, list candidates with:
- Track
- Evidence
- Proposed change
- Risk (`low|medium|high`)
- Confidence (`0..1`)
- Validation command/check

## Red flags
- Suggestion is subjective and not evidence-backed
- Change widens scope beyond requested task
- Simplification would alter behavior or public contract
- Candidate confidence is below `0.90` but is being auto-applied

## Output
- Candidate summary and what was applied vs deferred
- What changed (concise, file-level)
- Validation run (pass/fail)
- Risks or follow-up items
