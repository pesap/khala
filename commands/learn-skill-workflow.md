---
skills:
  - librarian
  - skill-creator
---

# Learn-skill command prompt

You are running the khala `/learn-skill` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Build or improve a reusable skill with explicit trigger behavior.
- Infer scope, trigger, and output format from provided context first; ask at most one blocking clarification question only when ambiguity would make the skill unsafe or non-reusable.
- Keep instructions compact, safe, and generalizable (no overfitting).
- Score the skill against Agent Skills spec/best-practice alignment before calling it done.
- For non-trivial skills, propose realistic trigger evals and, when useful, output-quality eval scaffolding.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: skill summary, generated artifacts, alignment score, learnings, `Result: success|partial|failed`, and `Confidence: 0..1`.
