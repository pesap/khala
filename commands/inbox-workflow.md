---
skills:
  - github
  - gitlab
  - worktrunk
---

# Inbox command prompt

You are running the khala `/inbox` workflow.

This is a read-only maintainer visibility workflow. It should help the maintainer
pick the next highest-leverage action without mutating files, branches, issues,
PRs, MRs, labels, or comments.

Requirements:
- Be concise.
- Default to a compact, action-first dashboard for human terminal use. Full
  deterministic evidence is available only when the user passes `--details` or
  `--evidence`.
- Do not mutate local files, git branches, forge state, labels, issues, PRs, MRs,
  comments, CI runs, or sessions.
- Prefer deterministic evidence first: use the pre-collected GitHub evidence
  attached by the command handler, then bounded `git`/`gh`/`glab` checks only
  when a material gap remains. Avoid model-led re-bootstrap, repeated evidence
  collection, shell-quoting repair loops, and full session artifact reads when
  capsule/session summaries or bounded excerpts suffice.
- Detect GitHub vs GitLab from remotes when possible; use explicit command flags
  when provided.
- Gracefully degrade when `gh`, `glab`, auth, remotes, or session metadata are
  unavailable. Report missing evidence as a limitation, not a failure.
- For the side-terminal/root workspace use case, `/inbox` defaults to global
  maintainer semantics whenever the command is run outside a git repository.
  Inside a git repository, inspect the current repo by default unless `--global`
  or `--scope global` is provided. Respect explicit `--scope current`, repo,
  user, forge, focus, and limit hints from command input.
- If a user hint is present, use the command handler's read-only repository
  discovery evidence before collecting or requesting per-repo signals. Treat
  `@me` as the authenticated user. Do not clone, fetch, pull, or otherwise
  mutate repos.
- If both repo and user hints are present, prioritize the explicit repo and
  report that user repository discovery was ignored.
- Bucket findings into:
  1. Needs you now
  2. My work is broken
  3. Agent/session needs attention
  4. New work needs shaping
  5. Ready for agents
  6. Low-risk background
- Rank items by blocker status, explicit review request or mention, CI failure,
  age, stale local work, and whether another person is waiting.
- Keep each item to one line with source, age/status when known, and suggested
  next command.
- End with: summary counts, top 3 next commands, evidence gaps, risks,
  `Result: success|partial|failed`, and `Confidence: 0..1`.
