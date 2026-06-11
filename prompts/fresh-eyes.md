---
description: Review recent changes with fresh eyes and fix obvious issues
argument-hint: "[scope or focus]"
---

Carefully read over all of the new code you just wrote and other existing code you just modified with fresh eyes, looking super carefully for any obvious bugs, errors, problems, issues, confusion, regressions, brittle behavior, misleading comments, missing validation, or unnecessary complexity.

If an explicit scope or focus is provided, use it as the primary review target:

$@

If no explicit scope is provided, use the current dirty diff and the files modified in this session as the review target.

Before editing:
- Inspect the current git status and relevant diff.
- Re-read the touched files directly from disk.
- Check nearby existing code and tests when needed to verify assumptions.

Then fix only concrete issues you uncover. Keep fixes scoped to the reviewed changes, avoid unrelated refactors, and preserve user changes you did not make. After any fix, rerun the relevant focused validation and report the exact commands and results.
