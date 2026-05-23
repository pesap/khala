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

- Restate problem.
- Build hypotheses.
- Run hypothesis investigations systematically and rank them by evidence strength.
- Rank findings by confidence.
- Propose fix; apply when requested.
- Validate with targeted checks.
- Store learnings.

## /feature

- Extract acceptance criteria from the request and repo context; ask only one blocking clarification question if the criteria cannot be inferred safely.
- Plan minimal implementation.
- Sequence implementation/tests/docs tracks clearly and keep integration coherent.
- Integrate and verify.
- Summarize shipped behavior, risks, and follow-ups.
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
