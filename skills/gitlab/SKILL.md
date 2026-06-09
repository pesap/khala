---
name: gitlab
description: Use this skill when the user needs GitLab terminal workflows (MRs, issues, pipelines, releases, .gitlab-ci.yml debugging, variables/rules/artifacts), even if they do not explicitly mention GitLab or glab CLI.
license: MIT
---

## Use when
- User asks to manage GitLab MRs/issues/pipelines/releases via terminal.
- User asks to create/debug `.gitlab-ci.yml`.
- User asks about CI variables, stages/jobs/rules, cache, artifacts, or pipeline failures.

## Avoid when
- GitHub operations (use `github` skill).
- Raw GitLab API workflows beyond practical `glab api` usage.
- Deep Kubernetes agent configuration outside repo CI scope.

## Workflow
1. Confirm target project/group and desired outcome.
2. Gather evidence with `glab` status/list/view commands.
3. Diagnose issue or optimization opportunity.
4. Apply/propose minimal corrective change.
5. Validate with follow-up `glab` checks and summarize risk.

See [REFERENCE.md](./REFERENCE.md) for command reference and CI patterns.

## Output
- Command evidence (key `glab` output snippets)
- Findings and recommended actions
- Proposed/implemented pipeline or workflow changes
- Validation status and next steps
