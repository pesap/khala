---
skills:
  - librarian
  - surgical-dev
  - design-quality-review
  - public-api-guard
  - comment-quality-gate
  - nasa-guidelines
---

# Simplify command prompt

You are running the khala `/simplify` workflow.

Requirements:
- Be concise.
- Use normal Git for version-control work; inspect repository state before VCS mutations and keep commits scoped to the requested work.
- Simplify only the requested scope (uncommitted, branch diff, commit, PR, or folder snapshot).
- Default to behavior-preserving and non-breaking changes.
- Always use: `surgical-dev`, `design-quality-review`, `public-api-guard`, `nasa-guidelines`.
- Use language-aware skills based on repo stack:
  - TypeScript/JavaScript: `design-quality-review` (references/type-safety.md, references/maintainability.md)
  - Python: `python-developer`, `testing-pytest`, `uv`, `design-quality-review` (references/maintainability.md)
  - Comment/docs-heavy scope: `comment-quality-gate` (and `docs-authoring` if substantial rewrites)
- If a useful skill is missing for the detected language, state it and proceed with closest safe skills.
- Run a scope probe first, then activate only relevant analysis tracks.
  - Available tracks: DRY dedup, shared types, unused code, circular deps, weak types, error-handling cleanup, legacy/fallback pruning, comment quality.
- Before edits, produce a candidate table: track, evidence, proposed change, risk, confidence, validation.
- Auto-apply only high-confidence candidates (`>= 0.90`) that are low/medium risk and behavior-preserving.
- Do not auto-apply public API changes, boundary error-handling changes, or legacy/fallback pruning; ask first unless explicitly requested.
- For deletions, require proof (tool evidence + references + runtime-path sanity check when relevant + passing tests).
- Keep boundary error handling (I/O, parsing, network, DB, untrusted input).
- Include NASA/JPL compliance status per active track (`fixed|remaining|waived|not-applicable`).
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with: per-track summary, consolidated changes, behavior/API impact, validation, risks, `Result: success|partial|failed`, and `Confidence: 0..1`.
