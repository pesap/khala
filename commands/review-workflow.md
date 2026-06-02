---
skills:
  - librarian
  - code-review
  - github
---

# /review

Run a scoped code review as a skeptical maintainer.

Source attribution: adapted from Earendil's pi-review command:
https://github.com/earendil-works/pi-review

Use this file only for target resolution and response contract.
Use `code-review` for review judgment.
Load `github` only for PR targets.
Load `librarian` only when repository navigation/search is needed.

## Targets

- `/review` or `/review uncommitted`: staged, unstaged, and untracked changes.
- `/review branch <base>`: diff from merge-base with `<base>`.
- `/review commit <sha>`: selected commit only.
- `/review pr <number|url>` or `/review <github-pr-url>`: GitHub PR.
- `/review file <paths...>`, `/review folder <paths...>`, or direct paths: snapshot review.
- `--extra "..."`: append one review focus.

## Scope Rules

Review only the requested scope.

For repo-state reviews, start by inspecting bounded repo state with scope-appropriate Git commands.

For uncommitted review:
- Inspect tracked and untracked changes.
- Include staged, unstaged, and untracked files.
- Do not include unrelated committed history.

For branch review:
- Compute merge-base with `<base>`.
- Review only the diff from merge-base to current `HEAD`.

For commit review:
- Review only the selected commit.
- Do not review unrelated parent or descendant changes.

For PR review:
- Require `gh`.
- If `gh` is missing or unauthenticated, stop with setup guidance.
- Before checkout, ensure there are no tracked-file pending changes.
- Untracked files alone do not block checkout.
- Resolve PR metadata.
- Check out the PR locally.
- Compute merge-base.
- Review only the diff from merge-base to PR `HEAD`.

For snapshot review:
- Read requested files/folders directly.
- Do not invent diff context.
- Treat findings as risks in the current snapshot, not necessarily regressions.

Do not mutate files unless the user explicitly asks for fixes.

## Review Method

1. Resolve target.
2. Determine scope.
3. Read changed files or requested files.
4. Read callers, tests, contracts, config, and migrations when needed.
5. Apply `code-review`.
6. Produce final report.

## Human Reviewer Callouts (Non-Blocking)

- migrations
- dependency changes
- auth/permission behavior
- public API or contract changes
- destructive operations
- feature flags
- config/default changes
- observability changes
- rollout or rollback concerns

Write `- (none)` if none apply.

## Output contract

Return only:

```md
## Review Summary
<1-4 sentences>

## Key Findings

- [P<0-3>] <title> 
  - Evidence: 
    - <bullets of evidence with fpath if needed>,
  - Impact(s): 
    - <bullets of impact with fpath if needed>,
  - Suggested action(s): 
    - <bullet of fix direction per file if needed>.

## Human Reviewer Callouts (Non-Blocking)
<bullets, or "- (none)">

## Verdict
<correct|needs attention>

Result: <success|partial|failed>
Confidence: <0..1>
Confidence breakdown:
<topic>: <score>
```

Include exact file and line evidence whenever possible.

If exact line numbers are unavailable, cite the smallest precise symbol, function, or file region.

Use suggestion blocks only for exact, small, high-confidence replacements.
