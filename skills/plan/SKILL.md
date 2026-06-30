---
name: plan
description: Run a rigorous planning session that challenges plans against existing terminology, code reality, and documented decisions. Use when users want to stress-test a design, sharpen domain language, and update CONTEXT.md/ADRs as decisions become clear.
license: MIT
---

## Source

- Adapted from: https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs
- Also incorporates domain-modeling discipline from: https://github.com/mattpocock/skills/tree/main/skills/engineering/domain-modeling

## Use when

- User wants to validate a plan against domain language and boundaries.
- User asks for domain modeling, terminology alignment, or context mapping.
- User wants architecture decisions captured as lightweight ADRs.

## Avoid when

- Task is pure implementation with no domain/terminology design.
- User explicitly wants quick coding without discovery questions.

## Session mode

- Ask one question at a time.
- Wait for user feedback before the next question.
- If a question can be answered from code/docs, inspect first.

## Domain awareness

- Look for `CONTEXT-MAP.md` first (multi-context repos).
- Else look for root `CONTEXT.md` (single context).
- Create files lazily:
  - create `CONTEXT.md` when first term is resolved
  - create `docs/adr/` when first ADR is needed
- Treat `CONTEXT.md` as a glossary only. Do not use it as a spec, scratch pad, implementation plan, or repository for implementation decisions; put implementation decisions in the plan or an ADR instead.

## During the session

1. Challenge conflicting terminology against `CONTEXT.md`.
2. Replace fuzzy/overloaded terms with precise canonical terms.
3. Use concrete scenarios to test boundaries and edge cases.
4. Cross-check user claims against the codebase and surface contradictions.
5. Use the decision/design guide to identify gray areas, scope creep, canonical refs, and remaining ambiguity.
6. Use domain probes only when the user's topic naturally touches that domain; never run them as a checklist.
7. Update `CONTEXT.md` inline as terms are resolved (do not batch).
8. Offer ADRs only when all are true:
   - hard to reverse
   - surprising without context
   - result of a real trade-off

Use references:

- [DECISION-DESIGN.md](./DECISION-DESIGN.md) for thinking-partner posture, clarity gates, gray areas, scope creep, canonical refs, and final plan shape.
- [DOMAIN-PROBES.md](./DOMAIN-PROBES.md) for contextual domain-specific probing questions.

Use formats:

- [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md)
- [ADR-FORMAT.md](./ADR-FORMAT.md)

## Output

- Ordered question log and recommended answers
- Updated language terms and ambiguity resolutions
- Canonical refs and existing code context used for the plan
- Decisions captured vs deferred ideas
- Verification/acceptance checks and unresolved ambiguity
- Code/documentation contradictions found
- Files created/updated (`CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/*`)
