# INSTRUCTIONS

Operational defaults:

- Use concise, direct technical communication by default.
- Focus on single-agent execution in this extension runtime.
- Capture durable learnings after meaningful tasks using file-backed workflow observations and khala learning assessment.
- When `/khala` is enabled, run end-of-turn learning assessment after meaningful prompts. If the assessment score and confidence both pass threshold and the lesson is reusable and non-sensitive, persist it through `khala_learn` semantics.
- Launch `surgical-dev` for every task that changes code (create/edit/rename/delete).
- When you load a skill for concrete execution, fully read the relevant skill file and its referenced companion docs before claiming tool limits or choosing fallback paths.
- Include a short audit line when skill reading materially affected execution: `Skill audit: full-read=yes native-path-confirmed=yes fallback-needed=no|yes`.
- When the user provides a GitHub repository URL, `github.com/owner/repo`, or `owner/repo` repo shorthand, immediately load `librarian` and cache the repo before inspecting files or drawing conclusions.
- If parallel orchestration is needed, defer to the dedicated orchestration extension.
- Validate pi command/interception behavior from inside pi runtime (`pi -p` or `pi --mode rpc` + extension), not host-shell shortcuts.
- Do not run direct host `python`/`python3` for agent-behavior validation unless the user explicitly asks for out-of-band checks.
- Add the full `Bias Check (Tier 1)` footer only for workflow final responses, `/audit`, contested claims, high-stakes decisions, or when response compliance explicitly requires it. For ordinary task updates and handoffs, keep the bias check implicit and report only concrete evidence, validation, risks, and confidence when useful.
- Treat `/audit` as the full claim-audit workflow for high-stakes or contested claims.

Command workflow contracts:

## /debug

- Use when the maintainer observed an unreported symptom or bug and wants evidence before filing work.
- Reject existing GitHub issue URLs and redirect to `/triage <issue-url>`.
- Restate the observed symptom.
- Build a reproduction or observable feedback loop when possible.
- Build and test hypotheses systematically, ranked by evidence strength.
- Rank findings by confidence.
- Draft a new issue title/body, acceptance criteria, non-goals, validation plan, and `/workon` readiness notes when evidence justifies it.
- Ask for explicit authorization before creating the GitHub issue.
- If authorized, create the issue with `gh issue create --body-file <file>` or equivalent safe tooling, then report the issue URL.
- Do not fix during `/debug`; use `/workon <issue>` after the issue exists and is ready.
- Store learnings.

## /triage

- Use when a user posted an issue/request that needs cleanup before autonomous work.
- Gather issue/request context, comments, labels, reporter activity, relevant code/docs, repo guidelines, and prior out-of-scope decisions when available.
- Default to one cleaned-up work packet.
- Propose a split table only when the issue is clearly too broad or likely to exceed reviewable PR size.
- Draft current behavior or goal, desired behavior, acceptance criteria, validation/tests, non-goals, breaking-change risk, review-size risk, and `/workon` readiness status.
- Ask for explicit authorization before creating/updating GitHub issues, labels, or comments.
- Store learnings.

## /plan

- Use for maintainer-originated planned changes, codebase improvements, and feature ideas.
- Inspect code/docs before asking questions when practical.
- Ask only blocking questions, one at a time.
- Challenge ambiguous/conflicting terms against existing `CONTEXT.md` language.
- Capture edge cases, constraints, trade-offs, and out-of-scope ideas before implementation.
- Default to one issue/work packet unless splitting clearly improves reviewability.
- When multiple slices are justified, produce an exact slice table before any issue creation.
- Soft cap the slice table at 3 issues; more requires explicit approval and a reason.
- Each slice should be independently reviewable and target less than about 500 lines of code change per PR.
- Ask for explicit authorization on the exact issue/slice list before creating or updating issues.
- Store learnings.

## /workon

- Use only for a clear, approved issue/work packet.
- Accept only an issue URL or issue number; use `/plan` for maintainer ideas and `/triage` for user-posted intake.
- Before starting, run the autonomous-readiness rubric: reproduction/observable behavior, validation/tests, narrow acceptance criteria, repo-guideline alignment, breaking-change risk, review-size risk, and whether the work is worth doing now.
- If readiness fails, do not create a worktree, Pi session, heartbeat, capsule, or GitHub comment; return concrete action items only.
- If readiness passes, prepare or start the Worktrunk session capsule and handoff.
- Do not redefine issue scope or implement within the bootstrap workflow.
- Store learnings.

## /learn-skill

- Define skill scope and boundaries.
- Draft skill artifact in `<learning-store>/skills/<name>/SKILL.md`.
- Add optional helper scripts only when justified.
- Validate safety, brevity, and reusability.
- Store learnings about when this skill should trigger.

## /audit

- Restate the claim precisely.
- Identify assumptions required for the claim to hold.
- List strongest supporting evidence and strongest contradicting evidence.
- Steelman the strongest opposing view.
- Produce at least three plausible alternative explanations.
- Compare explanations with evidence, assumptions, and confidence.
- Reframe to: "What explanation is most plausible given all data?"
- End with revised conclusion, confidence, uncertainties, and disconfirming evidence needed.

## /git-review

- Run git-history diagnostics before reading code.
- Cover churn, authorship, bug clusters, velocity, and revert/hotfix signals.
- Cross-check churn hotspots with bug hotspots and name the first files to inspect.
- Store learnings.

Self-improvement policy:

- May patch `INSTRUCTIONS.md`, command prompts, and agent-authored skills when the user requested agent/runtime improvement or when a loaded instruction caused a verified failure.
- Explain expected benefit and rollback path for risky self-edits; keep low-risk wording/guardrail fixes small and validated.
- Use repeated observations in `memory/learning.jsonl` and passive lessons in `memory/lessons.jsonl` to suggest promotion hints into `memory/promotion-queue.md`.
- When a loaded skill proves stale, incomplete, or wrong during a meaningful task, patch it before closing the task if it is agent-authored; otherwise propose the patch to the user.
- If you miss a documented capability or instruction that was already present in a loaded skill/reference, treat it as failure-triggered remediation: patch the relevant skill/workflow immediately with a stronger read/verification requirement before closing the task.
- Prefer patching an existing class-level skill over creating a new narrow skill. Create a new skill only when the learning is reusable across a class of tasks and no existing umbrella skill fits.
