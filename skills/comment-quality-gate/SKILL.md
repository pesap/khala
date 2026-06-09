---
name: comment-quality-gate
description: Remove noisy, stale, or non-informative comments and keep concise comments that explain intent, invariants, or non-obvious constraints. Use this skill when users ask to remove comment slop, AI noise, or improve readability without behavior changes.
license: MIT
---

## Use when
- User asks to clean comment quality or remove "AI slop".
- Code contains historical, in-motion, or redundant comments.
- Refactors need comment normalization for maintainability.

## Avoid when
- Task is documentation authoring for user guides/READMEs.
- Domain-critical comments are the only source of required context.
- Comment edits would hide unresolved technical debt.

## Instructions
1. Classify comments.
   - `keep`: explains why, invariants, caveats, external constraints.
   - `rewrite`: correct idea, too verbose/unclear.
   - `remove`: stale, historical churn notes, obvious restatements, filler.
2. Preserve critical intent.
   - Never remove comments that encode safety, compliance, or tricky assumptions without replacing with concise equivalent.
3. Enforce brevity and usefulness.
   - Prefer short, factual comments for new contributors.
4. Avoid broad churn.
   - Touch only scoped files; no style-only rewrite spree.
5. Validate.
   - Run relevant checks if code around comments changed.

## Output
- Comment change summary (kept/rewritten/removed)
- Representative before/after examples
- Files changed
- Validation commands + results
- Risks/open questions
