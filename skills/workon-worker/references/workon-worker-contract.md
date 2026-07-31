# Workon worker contract

This is the stable lifecycle contract for spawned Khala `/workon` workers.
Task-specific facts come from the session capsule.

## Readiness gate

Before implementation edits:

- Treat `workon-ready` or `ready-for-agent` labels and parent route evidence as
  the readiness source; do not require readiness prose to be duplicated in the
  issue body.
- Inspect relevant code, docs, tests, recent commits, and linked issue state
  only as needed to verify readiness, drift, and blockers.
- Decide whether the task is still real, already solved, stale, over-scoped, or
  better handled differently.
- If the issue has an `improve` plan body, run its `Drift check` command before
  editing. If in-scope files changed, compare the issue's Current state excerpts
  against live code. If they do not match, stop before implementation, report
  the drift, and recommend `/plan` refresh the issue.
- Honor `STOP conditions` in the issue body. If one is true before or during
  work, stop and report instead of improvising.
- Call out stale assumptions, hidden risks, and anything that should stop the
  work.

If no blocker is found, create or reuse the draft PR immediately with an empty
bootstrap commit before implementation edits.

## Scope and implementation

- Keep future changes scoped to the capsule's source issue set and branch.
- For multiple source issues, work through them in the capsule's deterministic
  order unless issue-body evidence supports a different order.
- Do not widen scope without creating or recommending a follow-up.
- Stop and report instead of editing if readiness finds drift, stale
  assumptions, unresolved readiness gaps, or a true STOP condition.
- Implement the smallest scoped slice first.

## Pre-commit simplify pass

- After implementation edits, run focused validation for the touched behavior
  before simplifying.

<!-- prettier-ignore-start -->

- Run `/simplify` only on the dirty tree before creating the implementation commit; `/workon` bootstrap must not invoke `/simplify` because no implementation dirty tree exists yet.
- Keep simplification behavior-preserving, source-issue-scoped, and free of drive-by refactors.
- Rerun focused validation after simplification and before committing.
- Commit only the final implementation plus simplify result; do not require a separate simplify commit.

<!-- prettier-ignore-end -->

## Validation

- Run focused tests for the touched code.
- Validate every source issue expectation in the capsule.
- Run the relevant repo quality gate when the change affects public workflow
  behavior.
- Include exact commands and results in the worker summary.

## Reviewer Two loop

Use the capsule's Reviewer Two settings.

- If Reviewer Two is enabled, run an independent fresh-context Reviewer Two pass
  after implementation edits, focused validation, `/simplify`, and post-simplify
  validation, but before final commit and draft PR readiness.
- Use the recorded peer-review model and thinking level when available.
- Do not rely on builtin reviewer model inheritance; the launch contract must
  carry the peer-review model and thinking level explicitly.
- If Reviewer Two is required but cannot run independently, stop and report the
  blocker instead of self-reviewing.
- Expected Reviewer Two output: decision, blockers, importantRevisions,
  optionalSuggestions, missingAcceptanceCriteria, validationGaps, scopeConcerns,
  recommendation.
- Classify findings as must-fix, optional/deferred, or rejected with rationale.
- For must-fix findings, make the changes and rerun focused validation before
  continuing.
- Stop on pass, blocked, exhausted loop budget, or an unapproved product/scope
  decision.

## Draft PR and feedback heartbeat

- Before implementation edits, create or reuse the draft PR for the branch with
  an empty bootstrap commit; do not create duplicate PRs for the same head
  branch.
- If the empty commit, push, or draft PR create/update fails, stop and report
  the exact blocker to the operator.
- Link the draft PR back to every source issue and make clear it is not ready to
  merge until validation and review are complete.

<!-- prettier-ignore-start -->

Compose the PR body from a template, never free-form: use the repo-local template
(`.github/PULL_REQUEST_TEMPLATE.md` or `.github/pull_request_template.md`) when
present; otherwise use the `github` skill's `pr-template.md`. Fill every section;
add the source-closing marker (`Closes #<n>`) and a command-only Testing Strategy
section. Pass it via `gh pr create --body-file <file>` (or
`gh pr edit --body-file` for the bootstrap PR).

- For each source issue criterion, use checkbox state, not textual status prefixes: checked means met; unchecked means unmet.
- Preserve useful concise evidence as nested `Evidence:` lines under checklist items.
- For unmet criteria, keep the checkbox unchecked and include a concise reason or follow-up under the item or in Deviations.

<!-- prettier-ignore-end -->

- Before handoff, update the implementation commit message and PR body so they
  match the final validated scope.
- Prefer in-thread replies for review comments. Do not merge, mark ready, close
  issues, label, or post broad public comments unless explicitly told.

## Two-stage handoff

### Stage 1 — implementation handoff (report, then wait)

When the implementation is complete, local validation passes, and the head is
pushed to the draft PR:

1. Run the required local typecheck, tests, and lint. Then run the final gate
   script with `--allow-pending` for push and PR-head evidence. PR checks may
   still be pending — do not wait for them.
2. Report via `khala_probe.report state=done kind=completion` with the
   completion object. Include the PR URL, head SHA, local validation commands
   run, and `ci: pending` (or the current check counts).
3. End your turn. Do not poll CI. The operator decides whether to wait for
   checks, review immediately, or send revisions as durable messages.

Run the Stage 1 gate from the worktree root, filling values from the capsule and
draft PR:

```bash
scripts/workon-final-handoff.ts --branch <branch> --repo <owner/repo> --pr <draft-pr-number> --push --allow-pending
```

Never report `state=done` when a check has already failed. Fix an in-scope
failure or report `state=blocked` with the failed-check evidence.

### Stage 2 — final response (only when instructed or checks already green)

A FINAL free-text response in the `workon-final-handoff` format is still
forbidden unless the deterministic final gate passes, including
`checks.state: "pass"`. If the operator asks for final handoff while checks are
pending, report `state=running kind=progress` with the check status instead.

Run the Stage 2 gate without `--allow-pending`:

```bash
scripts/workon-final-handoff.ts --branch <branch> --repo <owner/repo> --pr <draft-pr-number> --push
```

If the Stage 2 gate exits nonzero, do not send a final response; paste the JSON
failure or its `reasons` and stop.

The final handoff response is forbidden unless the gate returns:

- `status: "pass"`
- `unpushedCommits: 0`
- `localHead` equal to `upstream.head`
- `pr.headMatchesLocal: true`
- `checks.state: "pass"`

Do not rely on earlier `gh pr checks` output; the final gate verifies PR checks
after the pushed head is current.

## Output

All operator communication uses `khala_probe`:

- At every turn start, call `khala_probe.receive` and acknowledge messages with
  `khala_probe.ack`.
- Report milestones with `khala_probe.report state=running kind=progress`.
- Report external blockers with `state=blocked` and decisions needed with
  `state=needs_operator_input`, say exactly what is needed, then end the turn
  without busy-polling.
- Request risky-command approval with `state=running kind=risk_approval_request`
  and `proposedCommand`.
- Report completion with `state=done kind=completion` and the required
  `completion` object, then end the turn.
- Use `khala_probe.heartbeat` at natural pauses; it does not launch model work.

- Start with review findings, readiness status, and recommendation.
- If readiness finds a blocker, report the blocker and stop before
  implementation.
- If implementation edits code, report exact proof run.
- Include draft PR URL/status after bootstrap PR create/update, plus latest
  heartbeat and CI result.
- Include final publication gate evidence: localHead, upstream.head,
  unpushedCommits, PR head match, and checks.state.
- Do not merge, close issues/PRs, label, or post broad public comments unless
  explicitly told.
