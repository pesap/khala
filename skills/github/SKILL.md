---
name: github
description: Use this skill when the user needs GitHub terminal workflows (PRs, issues, CI failures, workflow optimization, caching/artifacts, matrix builds, runner sizing), even if they do not explicitly mention GitHub Actions or `gh` and instead ask to check a PR, inspect CI, reply to review comments, optimize workflows, or work an issue from the terminal.
---

## Use when
- User asks to inspect or act on GitHub PRs, issues, review comments, or workflow runs from the terminal.
- User asks to debug or optimize GitHub Actions workflows.
- User asks about cache, artifacts, matrix strategy, concurrency, runner sizing, or CI cost/speed tradeoffs.
- User implicitly needs GitHub CLI workflows: "check this PR", "why did CI fail", "reply to review", "open an issue", or "create the PR".

## Avoid when
- GitLab operations (use `gitlab` skill).
- Deep GitHub App/OAuth app implementation.
- Pure product/code work with no GitHub workflow component.
- Raw API workflows beyond practical `gh api` usage.

## Workflow
1. Confirm repo scope and desired outcome.
2. Gather evidence with `gh` commands before proposing changes.
3. Diagnose from concrete signals: PR state, review thread, run status, logs, artifacts, labels, issue context, or workflow YAML.
4. Prefer the smallest high-impact action: rerun, reply in-thread, update metadata, patch workflow config, or open/fill the right PR.
5. Validate via checks, reruns, or follow-up `gh` inspection where possible.
6. Load [references/REFERENCE.md](./references/REFERENCE.md) as the index, then read only the relevant file for the task.
7. Summarize evidence, decisions, and residual risks.

## High-value policies
- Prefer replying in-thread to reviewer comments, not as loose PR comments.
- Check for an existing open PR for the same head branch before creating a new one.
- Prefer explicit PR body injection over implicit defaults.
- Use repo-local templates when present; otherwise use `skills/github/pr-template.md`.
- Before creating/updating a PR body, resolve the durable source issue from explicit instruction, issue-numbered branch name, session capsule, or forge context. Write `Closes #N`/`Closes owner/repo#N` only when resolved; otherwise omit close text.
- Before claiming PR success, inspect the real remote PR and verify base branch, commit list, signature state, body format, close marker, and checks status.

## Reference loading guide
- Read `references/prs.md` when replying to review comments, checking PR state, or creating PRs.
- Read `references/issues.md` when creating, triaging, or relating issues/sub-issues.
- Read `references/runs.md` when investigating failed CI.
- Read `references/actions.md` when changing workflow YAML, caching, matrices, artifacts, or concurrency.
- Read `references/api-patterns.md` when standard `gh` commands do not expose enough data.
- Use `evals/train-trigger-prompts.json` and `evals/validation-trigger-prompts.json` when refining this skill's trigger surface.
- Use `evals/evals.json` when grading output quality.

## Output
- Command evidence (key `gh` output snippets)
- Findings and optimization recommendations
- Proposed/implemented workflow changes
- Validation status and follow-up actions
