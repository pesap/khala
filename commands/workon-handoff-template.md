I want to discuss and possibly work on: {{issue_title}}

Context:
- Repository: {{repo}}
- Source issue: {{issue_url}}
- Branch: {{branch_name}}
- Exact model: {{resolved_model}}
- Model routing: {{model_routing_mode}} ({{model_routing_reason}})
- This handoff comes from `/workon`; a session capsule path is provided separately by the launcher.
- Treat this prompt as starting context, not a final technical decision.

Before doing any implementation:
- Read the session capsule path provided by the launcher.
- Read the local agent/repo instructions.
- Inspect the relevant code, docs, tests, recent commits, and linked issue state.
- Decide whether this task is still real, already solved, stale, over-scoped, or better handled differently.
- Call out stale assumptions, hidden risks, and anything that should stop the work.

Task:
- If your independent review supports it, implement the smallest vertical slice for {{repo}}#{{issue_number}}.
- Keep changes scoped to the issue and branch.
- Do not widen scope beyond the issue without creating or recommending a follow-up.

Pre-commit simplify pass:
- After implementation edits, run focused validation for the touched behavior before simplifying.
- Run `/simplify` only on the dirty tree before creating the implementation commit; `/workon` bootstrap must not invoke `/simplify` because no implementation dirty tree exists yet.
- Keep the simplify pass behavior-preserving, source-issue-scoped, and free of drive-by refactors.
- Rerun the focused validation after simplification and before committing.
- Commit only the final implementation plus simplify result; do not require a separate simplify commit.

Draft PR and feedback heartbeat:
- Once there is a coherent implementation commit, create or update a draft PR for this branch on the forge.
- Link the draft PR back to {{issue_url}} and make clear it is not ready to merge until validation and review are complete.
- In the draft PR body, include an acceptance-criteria response list for every source issue criterion: mark each item `Addressed` with evidence, or `Not addressed` with the reason and follow-up.
- After opening the draft PR, check the PR/issue forge for human feedback every {{heartbeat_interval}} while you are still working.
- Prefer in-thread replies for review comments. Do not merge, mark ready, close issues, label, or post broad public comments unless explicitly told.

Validation:
- Run focused tests for the touched code.
- Run the relevant repo quality gate when the change affects public workflow behavior.
- Include exact commands and results in your summary.

Output:
- Start with review findings and recommendation.
- Then provide the plan or patch summary.
- If you edit code, report exact proof run.
- Include draft PR URL/status when created, plus latest heartbeat check result.
- Do not merge, close issues/PRs, label, or post broad public comments unless explicitly told.
