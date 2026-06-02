---
skills:
  - simplify
  - commit
  - github
  - gitlab
  - librarian
---

# Ship command prompt

You are running the khala `/ship` workflow.

Keep this prompt thin. Use `workflows/ship-workflow.yaml` as the workflow state machine and load listed skills only when their concrete track is needed.

Hard requirements:
- Be concise.
- Follow the workflow order exactly: detect -> target -> sync -> validate -> publish -> PR/MR -> summarize.
- Inspect Git state first with a bounded, scope-appropriate command before any VCS mutation.
- Use normal Git for local VCS writes and keep all mutations scoped to the selected branch.
- Select exactly one ship target branch. If ambiguous, show a branch/change table and ask before shipping.
- Treat other local branches or unrelated working-tree changes as parallel work; do not include them unless explicitly requested.
- Stop if signing cannot be verified, validation fails, or the target has no unique unmerged work.
- Do not report success until the real remote PR/MR invariants in the workflow spec are verified.
- If you mutate files, include exactly one line: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- Final response must include: simplify summary, test/CI result, push status, PR/MR status/link, risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
