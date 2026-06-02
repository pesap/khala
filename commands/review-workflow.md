---
skills:
  - librarian
  - code-review
  - github
---

# Review command prompt

You are running the khala `/review` workflow.

Source attribution: adapted from Earendil's pi-review command (`https://github.com/earendil-works/pi-review`).

Keep this prompt thin. Use `workflows/review-workflow.yaml` as the workflow state machine and load listed skills only when their concrete track is needed.

Supported targets:
- `/review` or `/review uncommitted`: review staged, unstaged, and untracked changes.
- `/review branch <base>`: review the diff from the merge base with the base branch.
- `/review commit <sha>`: review only the selected commit.
- `/review pr <number|url>` or `/review <github-pr-url>`: review a GitHub PR after resolving metadata and checking it out locally.
- `/review folder <paths...>`, `/review file <paths...>`, or direct paths: snapshot-review those files/folders, not a diff.
- `--extra "..."`: append a one-off focus instruction to any mode.

Hard requirements:
- Be concise and evidence-based.
- Review only the requested scope: uncommitted changes, branch diff, commit, PR, or file/folder snapshot.
- Start repo-state reviews by inspecting Git state with a bounded, scope-appropriate command.
- For PR review, require `gh`; if it is unavailable or unauthenticated, stop with setup guidance. Before checkout, ensure there are no tracked-file pending changes; untracked files alone do not block PR review.
- For branch and PR review, compute the merge base first and review the diff from that SHA.
- For snapshot review, read the requested paths directly and do not invent diff context.
- Do not mutate files unless the user explicitly asks for fixes.
- Prioritize findings by severity (`[P0]` to `[P3]`) with precise file references.
- If there are no blocking issues, explicitly say the change looks good.
- Include `Human Reviewer Callouts (Non-Blocking)`.
- If you mutate files, include exactly one line: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- Final response must include: review summary, key findings, verdict (`correct` or `needs attention`), callouts, `Result: success|partial|failed`, and `Confidence: 0..1`.

Review rubric:
- Flag issues that meaningfully affect correctness, performance, security, or maintainability.
- Flag only discrete, actionable issues introduced in the reviewed scope.
- Do not rely on unstated assumptions; identify the concrete affected path, caller, invariant, or runtime scenario.
- Prefer simple fixes over wrappers or abstractions without clear value.
- Treat silent local error recovery, swallowed parse failures, unchecked errors, and fallback-to-success behavior as high-signal findings unless the boundary and compatibility requirement are explicit and tested.
- Review untrusted input carefully: redirects must be constrained to trusted destinations, SQL must be parameterized, URL fetches must not allow local-resource access, and escaping is preferred over sanitization when outputting text.
- Keep each finding short and actionable. Use suggestion blocks only for exact replacement code.
- Do not report trivial style issues unless they obscure correctness or maintainability.
