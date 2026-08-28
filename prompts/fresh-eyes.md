---
description: Review recent changes with fresh eyes and fix obvious issues
argument-hint: "[scope or focus]"
---

Carefully reread the current dirty diff, and the files you touched, for
obvious bugs, regressions, brittle behavior, misleading comments, missing
validation, or unnecessary complexity.

If a scope is provided, use it.
Before editing, inspect git status and the
relevant diff, then re-read touched files directly.
Fix only concrete issues
and rerun the focused validation after each fix.
