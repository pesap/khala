---
name: librarian
description: "Cache and refresh remote git repositories under ~/.cache/checkouts/<host>/<org>/<repo> so future references can reuse a local copy. Always use this skill when the user provides a GitHub repository URL, GitHub repo shorthand like owner/repo, or any remote git repository as reference, even if they only ask to inspect, compare, borrow from, or review it."
---

Source attribution: copied from Armin Ronacher's `agent-stuff` librarian skill (`https://github.com/mitsuhiko/agent-stuff/tree/main/skills/librarian`).

Use this skill whenever the user points you to a remote git repository (GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand). For GitHub references, `owner/repo`, `github.com/owner/repo`, and `https://github.com/owner/repo` all require this skill before inspecting files or drawing conclusions.

## Use when
- User provides a remote repository URL or `owner/repo` shorthand as source material.
- User asks to inspect, compare, borrow from, or review a remote repository.
- A workflow needs a stable local checkout of a referenced repo.

## Avoid when
- The repository is already the current working tree and no remote reference was provided.
- User asks for live GitHub issue/PR metadata rather than repository files; use the GitHub skill.
- The reference is a single webpage, package docs page, or artifact that is not a git repository.

The goal is to keep a reusable local checkout that is:

- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`~/.cache/checkouts/<host>/<org>/<repo>`

Example:

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

```bash
bash checkout.sh <repo> --path-only
```

Examples:

```bash
bash checkout.sh mitsuhiko/minijinja --path-only
bash checkout.sh github.com/mitsuhiko/minijinja --path-only
bash checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

The script will:

1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash checkout.sh <repo> --force-update --path-only
```

## Recommended workflow

1. Resolve repository path via `checkout.sh --path-only`.
2. Use that path for searching, reading, and analysis.
3. On later references to the same repo, call `checkout.sh` again; it will find and update the cached checkout.

## If edits are needed

Prefer not to edit directly in the shared cache. Copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
