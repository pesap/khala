---
name: workon-worker
description:
  Bootstrap and execute a spawned Khala /workon implementation worker from a
  session capsule and handoff ledger. Use when a prompt says this pane is the
  spawned /workon worker, worker continuation context, capsule acknowledgement,
  Worktrunk worktree verification, draft PR bootstrap, Reviewer Two, or final
  workon handoff.
license: MIT
---

# Workon Worker

Use this skill only inside the spawned `/workon` implementation worker pane. Do
not use it from the operator/bootstrap pane.

## Source order

1. Launch prompt: exact capsule path, ledger path, and first-turn ordering.
2. Session capsule: task-specific facts such as issue(s), branch, worktree,
   model routing, Reviewer Two settings, validation expectations, STOP
   conditions, and final-gate repo.
3. This skill and its references: stable `/workon` worker lifecycle policy.
4. Deterministic scripts: authoritative pass/fail gate results.

If prompt and capsule task facts disagree, stop and report the drift instead of
choosing silently. Never override an absolute path from the prompt with a
guessed path.

## First turn

1. Read the session capsule with the `read` tool.
2. Run the handoff acknowledgement command exactly after reading the capsule.
3. Read local repo/agent instructions.
4. Confirm the current directory is the Worktrunk worktree recorded in the
   capsule; edit only inside that worktree.
5. Read `references/workon-worker-contract.md` before draft PR bootstrap or
   implementation edits.
6. Run the readiness, drift, and STOP checks described by the capsule and
   contract.
7. If blocked, report the exact blocker and stop before implementation.
8. If clear, create or reuse the draft PR with an empty bootstrap commit, then
   start the smallest in-scope implementation slice automatically.

## Core invariants

- The parent/operator stop contract does not apply in this worker pane.
- The worker must not wait for another operator instruction after readiness
  passes.
- Keep all changes scoped to the source issue set and branch in the capsule.
- Do not merge, mark ready, close issues/PRs, label, or post broad public
  comments unless explicitly told.
- Do not run `/simplify` during bootstrap; run it only on the dirty
  implementation tree before the implementation commit.
- A Stage 2 final response is forbidden unless `scripts/workon-final-handoff.ts`
  returns a passing result for the current pushed PR head.

## Reporting back (khala_probe protocol)

All communication with the operator goes through `khala_probe`. Never assume the
operator sees your terminal output.

- Start of every turn: `khala_probe.receive`; acknowledge with
  `khala_probe.ack`.
- Progress at milestones: `khala_probe.report` `state=running kind=progress`.
- Stuck: `state=blocked` (external blocker) or `state=needs_operator_input`
  (decision needed) with a summary saying exactly what you need. Then END YOUR
  TURN — do not busy-poll; the operator's reply arrives as a durable message
  next turn.
- Risky command needed: `state=running kind=risk_approval_request` with
  `proposedCommand`.
- Finished implementation (Stage 1): after local validation is green and the
  head is pushed, use `state=done kind=completion` with the `completion` object
  (required by the schema). Put the bias check in `completion.biasCheck` — do
  NOT write the prose Bias Check section in probe reports. Include `ci: pending`
  or the current check counts; never report done when a check has failed. Then
  end your turn and await instructions.
- Heartbeat (`khala_probe.heartbeat`) at natural pauses so the runtime knows you
  are alive; it does not launch model work.

## Output minimum

First worker response or blocker report must include:

- `capsule-acknowledged`
- readiness status
- draft PR status or exact blocker
- first implementation action or escalation

Final handoff must include the passing final-gate evidence required by
`workon-final-handoff`.
