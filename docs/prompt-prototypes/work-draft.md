---
description: Draft a Khala Work from a goal and repository evidence
argument-hint: "<goal>"
---

Draft a Khala Work for this goal, grounded in the stated intent and relevant repository evidence:

$ARGUMENTS

Use the current submission fields: `title`, `objective`, `acceptanceCriteria`, and optional `workId`, `context`, `scope`, `constraints`, `validation`, `allowedPaths`, and `maxTokens`.
Include the objective, scope, observable acceptance criteria, allowed paths, validation commands, and unresolved questions when supported by the goal and evidence.
Verify paths and commands from the repository rather than assuming Khala's own template or conventions are present.

Do not invent missing User intent, authority, token allowances, paths, or validation commands.
Mark absent or unresolved information explicitly and ask for User input where needed.
Do not call `khala_submit_work`, invoke any other mutation, or treat this draft as permission to launch work.
Return a JSON object containing only grounded submission fields, followed by unresolved questions that need User answers.
The JSON draft is for User approval only and is not permission to submit it.
