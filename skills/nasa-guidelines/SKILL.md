---
name: nasa-guidelines
description: Apply NASA/JPL Power of Ten style constraints to audit and harden code for predictability, simplicity, and explicit error handling. Use this skill when users ask for strict code quality, safety-oriented cleanup, anti-slop refactors, or NASA-style standards, even if they only ask to "clean up" or "make code more robust".
license: MIT
---

## Use when
- User asks for NASA guidelines, JPL Power of Ten, or safety-critical coding discipline.
- User wants stricter quality gates for complexity, error handling, and determinism.
- User asks for large cleanup/refactor and needs objective guardrails.
- User wants compliance-style reporting (violations, fixes, waivers).

## Avoid when
- Task is pure feature delivery where behavior changes are primary goal.
- User wants stylistic churn only (formatting, naming preference, comment tone).
- Rules would be applied mechanically without language/context adaptation.

## Instructions
1. Define scope and risk first.
   - Preserve runtime behavior unless user explicitly approves behavior changes.
   - Keep edits minimal, reversible, and auditable.
2. Map NASA/JPL rules to project language.
   - Evaluate applicability for each principle; do not force C-specific wording onto unrelated languages.
   - Mark each rule as `applicable` or `waived` with a short reason.
3. Audit before editing.
   - Gather concrete violations with file paths and examples.
   - Prioritize by risk: correctness/safety first, then maintainability.
4. Apply high-confidence fixes only.
   - Prefer root-cause simplification over broad rewrites.
   - Remove hidden fallbacks and silent error swallowing.
   - Keep control flow simple and functions focused.
5. Validate changes.
   - Run relevant lint/typecheck/tests for touched paths.
   - If checks cannot run, state why and provide manual verification steps.
6. Report compliance clearly.
   - Provide a rule-by-rule status: fixed, remaining, waived.
   - List residual risks and follow-up actions.

## NASA/JPL principles to enforce (language-adapted)
1. Simple, readable control flow
2. Bounded/guarded loops and recursion
3. Predictable behavior (no hidden dynamic fallbacks)
4. Small, single-purpose functions
5. Assertions/invariants for critical assumptions
6. Narrow variable scope and limited mutable shared state
7. No ignored errors/return values; no silent catch-and-continue
8. Minimize macro/metaprogramming complexity (or equivalent)
9. Avoid unsafe aliasing/pointer-like hazards (language equivalent)
10. Zero critical static-analysis warnings

## Output
- Scope and assumptions
- Compliance matrix (rule, status, evidence, action)
- File-level changes and rationale
- Validation commands + results
- Waivers and residual risks
