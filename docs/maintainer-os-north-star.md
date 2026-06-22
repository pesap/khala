# Maintainer OS north star

## Purpose

Khala should become a local-first maintainer control plane for a developer who
owns many repositories across GitHub, GitLab, and enterprise forges while using
Pi, Worktrunk, zellij, and Khala memory for day-to-day engineering work.

The goal is not to create a fully autonomous swarm. The goal is to make every
agent run start from a durable work packet, every project state visible from one
place, and every repeated mistake promotable into docs, checks, or memory.

## Desired outcome

A maintainer can start a day with one command, see what needs attention across
repos, choose the next highest-impact item, and launch or resume a focused Pi
session with enough context to make progress without rediscovering the world.

```text
/inbox
  -> ranked maintainer queue
  -> /workon issue|pr|session
  -> Worktrunk worktree + zellij tab + Pi session capsule
  -> /review, /ship, /recheck-pr loops
  -> Khala learning promotion
```

## Source of truth hierarchy

1. **Forge artifacts**: issues, PRs/MRs, review threads, labels, CI, assignees,
   and project boards are the durable collaboration record.
2. **Git/Worktrunk state**: branches, worktrees, commits, local diffs, and merge
   state are the execution record.
3. **Session capsules**: small local summaries pass context between Pi sessions
   without relying on full transcripts.
4. **Khala memory**: private learning stores reusable lessons and points agents
   toward repo-specific constraints.
5. **Project docs and automation**: repeated lessons graduate into
   `REVIEW_GUIDELINES.md`, `AGENTS.md`, `CONTEXT.md`, tests, hooks, or CI gates.

## Operating principles

### Issue-first development

Non-trivial development starts by finding or creating an issue. Branches,
worktrees, PRs, and session capsules should carry the issue identifier whenever
possible.

If a change cannot be tied to an issue, the workflow should either create a small
issue or require an explicit bypass reason.

### One writer, many reviewers

Use parallel agents for scouting, review, and synthesis. Keep file mutation to a
single writer per worktree. Parallel implementation uses separate Worktrunk
worktrees and explicit merge/review boundaries.

### Read-only visibility before autonomy

The first control-plane layer should be read-only: collect state, rank it, and
recommend next commands. Mutation comes later, behind explicit workflow commands
such as `/workon`, `/ship`, and `/recheck-pr`.

### Work packets over chat history

Agents should receive compact work packets instead of vague prompts or large
transcripts. A good work packet includes:

- goal and source issue/PR/MR
- acceptance criteria and non-goals
- likely files or subsystems
- validation commands
- escalation rules
- current worktree/session state
- expected output format

### Promote repeated lessons

Khala memory is useful for private recall, but repeated lessons should move into
more durable layers:

- first occurrence: Khala lesson
- repeated occurrence: project guideline or session template
- recurring failure: test, lint, hook, workflow gate, or CI check

### Token-aware model routing

Use deterministic tools before models. Use cheap/local models for bounded
classification and scouting, stronger models for synthesis, design decisions,
review, and high-risk edits.

Cheap agents should generally be read-only or patch-limited unless their work is
automatically validated.

## Core workflow primitives

### `/inbox`

Read-only maintainer queue. It gathers forge, git, Worktrunk, and session state
into ranked buckets:

1. Needs you now
2. My work is broken
3. Agent/session needs attention
4. New work needs shaping
5. Ready for agents
6. Low-risk background

The command should end with a short recommended action list, not a giant report.

### `/workon`

Issue-first session bootstrap. It resolves an issue, PR, or topic into a durable
source of truth, derives an issue-numbered branch/worktree name, writes a global
Pi capsule under `~/.pi/khala/github.com/<owner>/<repo>/capsule.md`, and in
Zellij waits for the Worktrunk-created worktree tab before starting Pi there with
the handoff prompt. It does not implement the feature or bugfix itself.

### `/recheck-pr`

Post-PR feedback loop. It reads unresolved review/Copilot/CI feedback, classifies
comments, applies accepted fixes through one writer, re-runs validation, and
replies in-thread when safe.

### Existing `/review` and `/ship`

`/review` remains the scoped feedback command. `/ship` remains the safe publish
command. The new control-plane workflows should call into these rather than
reimplementing them.

## Session capsule shape

```markdown
# Session capsule

Repo:
Branch:
Issue:
PR/MR:
Worktree:
Zellij tab/session:
Capsule: ~/.pi/khala/github.com/<owner>/<repo>/capsule.md

## Problem

## Current state

## Decisions

## Changed files

## Validation

## Open questions

## Next prompt
```

Session capsules are intentionally small and portable. They are the handoff
object between Pi sessions, Worktrunk tabs, and future dashboard views.

## `/inbox` prototype acceptance criteria

The first prototype should be useful without a daemon or database:

- runs as a normal Khala workflow command
- is read-only
- inspects the current repo by default
- accepts optional repo/user/forge/focus/limit hints
- supports user-wide read-only repository discovery with `--user` or
  `--user <login>` before later repo-registry work
- gracefully degrades when `gh`, `glab`, or auth are unavailable
- reports local git state, PR/MR review needs, issue-shaping needs, CI failures,
  and stale local/session hints when evidence is available
- returns a ranked, compact queue plus the top three next commands

Non-goals for the first prototype:

- no automatic issue/PR/MR mutation
- no background daemon
- no cross-repo registry requirement
- no zellij/worktree launching
- no autonomous remediation

## Near-term roadmap

1. Prototype `/inbox` as a read-only workflow command.
2. Add `/workon` for issue-first Worktrunk session creation.
3. Add a repo registry once current-repo inbox is useful.
4. Add session capsule discovery and stale-session detection.
5. Add `/recheck-pr` for Copilot/reviewer/CI feedback loops.
6. Promote repeated inbox findings into Khala lessons, repo docs, or automation.
## Current harness layer

The first local-first harness layer now turns run metadata into an
operator-ready control surface. Workflow starts open global run ledgers under
`~/.pi/khala/runs/`; tool calls, mutations, checkpoints, interruption,
completion, resume attempts, skill activity, source context, local artifacts,
and workflow progress are recorded in the same durable record.

The primary operator commands answer:

- what work is active;
- why it exists, including the source issue or PR when available;
- where the local worktree, capsule, and run ledger live;
- what state the workflow reached; and
- what action is safe to take next.

Use `/run-list active`, `/run-list resumable`, and
`/run-list needs_operator_review` for the maintainer queue; `/run-show` for
full recovery context; `/run-resume` only for ledgers classified `resumable`;
and `/run-checkpoint` after operator verification that prior side effects must
not be repeated. Runs with uncertain mutation, shell, forge, external, or
unknown tool side effects stay gated behind operator review.
