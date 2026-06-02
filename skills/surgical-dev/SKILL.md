---
name: surgical-dev
description: Default guardrail for focused code edits. Use when a task creates, edits, renames, or deletes code and needs minimal diffs, explicit assumptions, targeted validation, rollback awareness, and low-risk implementation discipline.
---

## Trigger conditions
- Any task that creates, edits, renames, or deletes code.
- Any bugfix, feature, refactor, or review that changes runtime behavior.

## Use when
- You are about to mutate code and need low-risk execution.
- You need minimal, reviewable diffs with explicit verification.
- You can run targeted checks for touched paths.

## Avoid when
- Task is code-free (planning only, docs-only, status updates).
- User explicitly asks to skip this workflow for a one-off.
- Required constraints are missing and user does not want clarification.
## Instructions
1. Think before coding
   - State assumptions first. If ambiguous, ask before editing.
   - If multiple valid interpretations exist, surface tradeoffs.
2. Simplicity first
   - Implement the smallest correct change.
   - No speculative abstractions, configurability, or extra features.
3. Surgical changes only
   - Touch only lines required by the request.
   - No drive-by refactors/formatting/comment churn.
   - Remove only artifacts your change makes unused.
4. Goal-driven validation
   - Define concrete success checks before or during edits.
   - Run targeted tests/lints and report pass/fail.
   - If checks cannot run, state why and provide manual verification.
5. Safety gate
   - Stop and ask before risky or destructive actions.
   - Provide a short rollback path for high-risk edits.
## Output
- Assumptions and success criteria
- File-level changes
- Validation commands + results
- Risks/open questions (if any)
