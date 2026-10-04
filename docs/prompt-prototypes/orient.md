---
description: Prepare a bounded, read-only plan for a task
argument-hint: "<task>"
---

Prepare for this task without implementing it:

$ARGUMENTS

Do a bounded, task-specific, read-only investigation.
Search by behavior and inspect likely implementations, relevant callers, tests, repository guidance, and documented validation commands.
Identify existing functionality to reuse, the likely files involved, applicable conventions, and validation entry points that are verified from repository evidence.
Do not run validation or arbitrary project scripts.

Return a concise preparation note with:

- Existing behavior or functionality to reuse, with paths and evidence.
- Relevant files and callers, with why each is relevant.
- Repository conventions and verified validation entry points.
- Important unresolved questions that block safe implementation.

Stay within the stated task.
Do not edit or create files, implement changes, execute scripts, submit Khala Work, or produce a repository-wide audit.
If evidence is insufficient, state what remains unknown instead of guessing.
