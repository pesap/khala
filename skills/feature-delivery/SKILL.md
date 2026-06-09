---
name: feature-delivery
description: Deliver features from acceptance criteria to validated implementation. Use when users ask for new functionality, scoped enhancements, or end-to-end delivery with tests.
license: MIT
---

## Use when
- The user asks for a new feature or enhancement.

## Avoid when
- Task is pure debugging/review with no feature scope.
- Requirements are intentionally open-ended and user does not want scoping.

## Workflow
1. Extract acceptance criteria from the request and repo context; ask at most one blocking clarification only when the criteria cannot be inferred safely.
2. Plan minimal implementation.
3. Implement incrementally.
4. Add or update tests.
5. Validate behavior.
6. Summarize what shipped and what remains.

## Output
- Acceptance criteria mapping
- Implementation summary
- Test/validation summary
- Known risks or TODOs
