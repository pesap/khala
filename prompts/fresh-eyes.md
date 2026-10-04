---
description: Review recent changes with fresh eyes
argument-hint: "[scope or focus]"
---

Review ${@:-the current uncommitted changes} with fresh eyes, as if seeing the code for the first time.
Set aside earlier assumptions and conclusions, not requirements or constraints.
Inspect `git status`, the relevant diff, and affected files before editing.

Compare with repo guidance and similar nearby code.
Style changes need a rule or clear precedent.
Search the repo by behavior for existing functionality.
Inspect matches and callers, and reuse what fits.
Check for bugs, missing requirements, unnecessary complexity, redundancy, needless jargon, and misleading comments.

Before editing, identify each problem, its consequence, and evidence.
Try to disprove the finding by checking whether it is intentional or already handled.
Make the smallest complete fix, considering what it could break.
Preserve intended behavior, useful explanations, tests, and safeguards.
Skip speculative changes and unrelated cleanup.

Run focused checks before editing and after each fix.
Briefly report each change, its evidence, and check results.
Leave uncertain findings unchanged and flag them separately.
If no justified changes remain, say so and stop.
