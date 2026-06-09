---
name: type-hardening
description: Strengthen type guarantees and contracts to reduce runtime surprises while preserving behavior. Use this skill when users ask to tighten typing, remove weak/implicit types, improve static analysis signal, or harden interfaces during cleanup/refactor work.
license: MIT
---

## Use when
- User asks to improve type safety without changing product behavior.
- Code has weak/implicit typing (`any`, broad unions, nullable ambiguity, untyped boundaries).
- Static analysis or review points to type drift, unsafe casts, or contract ambiguity.

## Avoid when
- Task requires rapid prototyping where strict typing would block delivery.
- Scope is pure runtime bugfix with no meaningful type contract surface.
- Type changes would force unapproved public API breaks.

## Instructions
1. Start from real boundaries.
   - Prioritize inputs/outputs, public interfaces, persistence/network payloads, and cross-module contracts.
2. Tighten types incrementally.
   - Replace weak types with precise named models.
   - Narrow unions/optionals based on proven invariants.
   - Remove unsafe casts and add explicit validation/guards where needed.
3. Preserve compatibility.
   - Keep external contracts stable unless approved.
   - If a break is necessary, document migration and call it out explicitly.
4. Align with language/tooling.
   - Use ecosystem-native strictness controls and lint/typecheck rules.
   - Prefer explicitness over clever generic complexity.
5. Validate confidence.
   - Run relevant typecheck/lint/tests for touched paths.
   - Report unresolved weak spots with reasons.

## Output
- Type hardening summary (boundaries strengthened, weak types removed)
- Contract compatibility notes (unchanged/changed)
- Validation commands + results
- Remaining weak-type hotspots and follow-up plan
- Risks/open questions