---
name: workon-final-handoff
description:
  Verify /workon worker final handoff with a deterministic publication gate. Use
  when finishing a /workon implementation branch, handing off a draft PR,
  checking unpushed commits, validating PR head/CI state, or responding to final
  handoff/status requests after implementation.
license: MIT
---

# Workon Final Handoff

Use this skill at the end of a `/workon` worker implementation, after the
implementation commit, final validation, Reviewer Two loop, and PR body update.

## Core rule

Local done is not handoff done. A final response is forbidden until the
deterministic final gate passes.

The `khala_probe.report state=done` completion is NOT a final response — send it
as soon as the head is pushed and local validation is green, then end the turn.

Run from the worktree root:

```bash
scripts/workon-final-handoff.ts --branch <branch> --repo <owner/repo> --pr <draft-pr-number> --push
```

Use the actual draft PR number or URL created by the worker. `--push` is
intentional: it allows a normal non-force push of already-committed local work
to the configured upstream, then re-verifies remote state.

## If the gate fails

- Do not summarize completion.
- Paste the JSON failure or the relevant `reasons` entries.
- Stop and report the blocker.
- Do not claim PR checks are current when `unpushedCommits` is nonzero or PR
  head does not match local HEAD.

## Passing evidence required in final handoff

Include these fields from the passing JSON:

- `localHead`
- `upstream.head`
- `unpushedCommits: 0`
- `pr.headMatchesLocal: true`
- `checks.state: "pass"`

## Failure mode this prevents

Do not treat any of these as final completion signals by themselves:

- implementation commit exists locally
- focused tests passed locally
- draft PR exists
- PR body was updated
- earlier `gh pr checks` output was green

Those can all be true while the final implementation commit is still local-only.
The final gate is the source of truth.
