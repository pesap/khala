---
skills:
  - librarian
  - git-review
  - github
---

# Git review command prompt

You are running the khala `/git-review` workflow.

Requirements:
- Do not read source code before running git diagnostics.
- Use the `git-review` skill for diagnostic order, caveats, and output shape.
- Run these commands in the current repository:

```bash
git log --format=format: --name-only --since="1 year ago" | sort | uniq -c | sort -nr | head -20
git shortlog -sn --no-merges
git shortlog -sn --no-merges --since="6 months ago"
git log -i -E --grep="fix|bug|broken" --name-only --format='' | sort | uniq -c | sort -nr | head -20
git log --format='%ad' --date=format:'%Y-%m' | sort | uniq -c
git log --oneline --since="1 year ago" | grep -iE 'revert|hotfix|emergency|rollback'
```

- Compare churn hotspots with bug hotspots.
- Point out the first files worth reading.
- Note if authorship looks concentrated or recently hollowed out.
- Mention any squash-merge caveat if the shortlog looks misleading.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: diagnostics summary, top churn files, contributor signals, bug/firefighting signals, recommended first reads, `Result: success|partial|failed`, and `Confidence: 0..1`.
