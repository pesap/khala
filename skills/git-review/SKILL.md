---
name: git-review
description:
  Run repository health diagnostics from git history before reading source code.
  Use when users ask for a git review, repo hotspot analysis, churn review,
  contributor/ownership signals, bug cluster discovery, rollback/firefighting
  history, or which files to inspect first.
license: MIT
---

## Use when

- User asks for `/git-review`, repository health review, codebase hotspot
  analysis, or first-read recommendations.
- The task is to rank risky files or areas from git history before source
  inspection.
- User wants churn, authorship, bug-fix, revert, or maintenance signals.

## Avoid when

- User asks for a normal code review of a specific diff or PR; use
  `design-quality-review`.
- User asks to mutate branches, commits, or pull requests; use the VCS/GitHub
  skills.
- The repository has no accessible git history; state the missing evidence and
  fall back only if the user asks.

## Workflow

1. Confirm the repository root and requested time window; default to one year
   for churn and six months for recent authorship.
2. Run diagnostics before reading source files:
   - `git log --format=format: --name-only --since="1 year ago" | sort | uniq -c | sort -nr | head -20`
   - `git shortlog -sn --no-merges`
   - `git shortlog -sn --no-merges --since="6 months ago"`
   - `git log -i -E --grep="fix|bug|broken" --name-only --format='' | sort | uniq -c | sort -nr | head -20`
   - `git log --format='%ad' --date=short | sort | uniq -c`
   - `git log --oneline --since="1 year ago" | grep -iE 'revert|hotfix|emergency|rollback'`
3. Compare churn hotspots with bug hotspots and recent authorship concentration.
4. Call out caveats: squash merges, generated files, vendored code, monorepo
   moves, and sparse history.
5. Recommend the smallest set of files or folders to inspect first, with
   evidence for each.

## Output

- Diagnostics summary
- Top churn files
- Contributor and ownership signals
- Bug/firefighting signals
- Recommended first reads
- Caveats and confidence
