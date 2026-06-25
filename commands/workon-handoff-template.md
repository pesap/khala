{{route_instruction_block}}

I want to discuss and possibly work on: {{issue_title}}

Context:
- Repository: {{repo}}
- Source issue: {{issue_url}}
- Branch: {{branch_name}}
- Handoff ledger: {{handoff_ledger}}
- Exact model: {{resolved_model}}
- Exact thinking level: {{resolved_thinking_level}}
- Model routing: {{model_routing_mode}} ({{model_routing_reason}})
- This handoff comes from `/workon`; a session capsule path is provided separately by the launcher.
- Treat this prompt as starting context, not a final technical decision.

Initial handoff and readiness gate:
- Read the session capsule path provided by the launcher.
- Acknowledge that the capsule was read by running: `{{ack_command}}`.
- Read the local agent/repo instructions.
- Confirm you are in the Worktrunk worktree recorded in the capsule; only edit files inside that worktree.
- Inspect the relevant code, docs, tests, recent commits, and linked issue state only as needed to verify readiness, drift, and blockers.
- Decide whether this task is still real, already solved, stale, over-scoped, or better handled differently.
- If the issue has an `improve` plan body, run its `Drift check` command before editing. If in-scope files changed, compare the issue's Current state excerpts against live code. If they do not match, stop before implementation, report the drift, and recommend `/plan` refresh the issue.
- If the issue has a `Workon readiness` section, verify it says `Ready for /workon: yes` and contains no unresolved `no`, `unknown`, `TBD`, or `to be confirmed` fields. If it fails, stop before implementation and report the exact readiness gaps.
- Honor any `STOP conditions` in the issue body. If one is true before or during work, stop and report instead of improvising.
- Call out stale assumptions, hidden risks, and anything that should stop the work.
- If no blocker is found, create/reuse the draft PR immediately with an empty bootstrap commit, then start the smallest scoped implementation slice in this worktree without waiting for another operator instruction.

Next-step action:
- Keep future changes scoped to the issue and branch.
- Do not widen scope beyond the issue without creating or recommending a follow-up.
- Stop and report instead of editing if the readiness gate finds drift, stale assumptions, unresolved readiness gaps, or a true STOP condition.

Implementation instructions:

Pre-commit simplify pass:
- After implementation edits, run focused validation for the touched behavior before simplifying.
- Run `/simplify` only on the dirty tree before creating the implementation commit; `/workon` bootstrap must not invoke `/simplify` because no implementation dirty tree exists yet.
- Keep the simplify pass behavior-preserving, source-issue-scoped, and free of drive-by refactors.
- Rerun the focused validation after simplification and before committing.
- Commit only the final implementation plus simplify result; do not require a separate simplify commit.

Validation:
- Run focused tests for the touched code.
- Run the relevant repo quality gate when the change affects public workflow behavior.
- Include exact commands and results in your summary.

{{reviewer_two_review_loop}}

Draft PR and feedback heartbeat:
- Before implementation edits, create or reuse the draft PR for this branch with an empty bootstrap commit; do not create duplicate PRs for the same head branch.
- If the empty commit, push, or draft PR create/update fails, stop and report the exact blocker to the operator.
- Link the draft PR back to {{issue_url}} and make clear it is not ready to merge until validation and review are complete.
- In the draft PR body, use the repo PR template shape: resolved source-closing marker when applicable, Summary, checklist-style Acceptance criteria copied from every source issue criterion, Deviations from the original plan, command-only Testing Strategy, and References.
- For each source issue criterion, use checkbox state, not textual status prefixes: checked means met; unchecked means unmet.
- Preserve useful concise evidence as nested `Evidence:` lines under checklist items.
- For unmet criteria, keep the checkbox unchecked and include a concise reason/follow-up under the item or in Deviations.
- After opening the draft PR, check the PR/issue forge for human feedback and failing CI every {{heartbeat_interval}} while you are still working.
- After opening the draft PR and after pushing implementation updates, check PR CI before claiming status; report failing checks exactly and keep working only when the fix is in scope.
- Before handoff, update the implementation commit message and PR body so they match the final validated scope.
- Prefer in-thread replies for review comments. Do not merge, mark ready, close issues, label, or post broad public comments unless explicitly told.

Output:
- Start with review findings, readiness status, and recommendation.
- If the readiness gate finds a blocker, report the blocker and stop before implementation.
- If implementation edits code, report exact proof run.
- Include draft PR URL/status after the bootstrap PR create/update, plus latest heartbeat and CI check result.
- Do not merge, close issues/PRs, label, or post broad public comments unless explicitly told.
