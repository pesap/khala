---
name: docs-authoring
description: Draft or revise technical docs (README, setup, API, troubleshooting, release notes) so they are accurate, scannable, and GitHub-friendly. Use when users ask to improve docs clarity/structure/rendering, not marketing copy.
---

## Use when
- User asks to write, rewrite, clean up, or expand README/docs.
- User asks for setup, usage, API, troubleshooting, migration, or release-note docs.
- User asks to improve Markdown structure, navigation, links, tables, diagrams, or callouts.
- User asks for “make this clearer/easier to follow” and the artifact is documentation.

## Avoid when
- Task is implementation/debugging with no doc deliverable.
- User wants persuasion/marketing voice rather than technical accuracy.
- Requirements are unknown and no source of truth is available.

## Workflow
1. **Anchor on user outcome**
   - Identify target reader, primary job-to-be-done, and success path.
   - Prefer “quickstart-first” ordering for end-user docs.
2. **Ground claims in source truth**
   - Verify commands, flags, paths, APIs, versions, and behaviors from repo artifacts.
   - If unverifiable, mark as assumption and reduce certainty language.
3. **Restructure for scanability**
   - Use strict heading hierarchy.
   - Keep paragraphs short; prefer bullets/checklists for procedures.
   - Put prerequisites before steps; put validation checks after steps.
4. **Harden examples**
   - Use fenced code blocks with language tags.
   - Keep examples copy-paste safe (realistic placeholders, no hidden steps).
   - Show expected output when it materially reduces ambiguity.
5. **Optimize GitHub rendering**
   - Use relative links for repo-local references.
   - Use tables only for reference/comparison, not prose.
   - Use callouts and `<details>` sparingly to control noise.
6. **Close with operator clarity**
   - Summarize changed sections/files.
   - List assumptions, open questions, and follow-up docs gaps.

## README section defaults (good-api aligned)
- Structure README as a learning ladder:
  - **Convenient first**: 30-90 second Quickstart with exact install/run commands and expected output.
  - **Gradual second**: Installation options, core concepts, and command/API reference that extend the same mental model.
  - **Flexible third**: advanced composition, architecture, extension points, and escape hatches for experts.
- Use a concise top summary (what it is, who it helps, constraints/disclaimer if needed).
- Add a short nav row/table of contents for long READMEs.
- Prefer command tables for CLI discoverability (`command` + `what it does`).
- Show at least one realistic end-to-end example before deep reference sections.
- Use collapsible `<details>` for optional advanced depth so default path stays fast.
- Keep badges minimal and meaningful; avoid decorative clutter.

## Quality gate
- Accurate technical statements tied to evidence.
- Reader can complete the primary task in one pass.
- No skipped heading levels.
- Code blocks are typed and runnable in context.
- Internal links resolve and section labels are specific.
- README flow matches learning ladder (quick win → deeper usage → expert flexibility).

## GitHub formatting defaults
- Badges: keep minimal and meaningful (CI/version/license/coverage).
- Callouts: `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` only when signal is high.
- `<details><summary>`: use for optional depth, not required steps.
- Mermaid: use for simple flows/architecture only.
- `<kbd>`: use for keyboard shortcuts.

## Output
- Files/sections changed
- Documentation strategy used (ordering/structure decisions)
- Assumptions + unverifiable claims
- Remaining risks or follow-up improvements
