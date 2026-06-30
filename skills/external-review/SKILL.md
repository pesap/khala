---
name: external-review
description: Run an independent read-only review by launching a fresh Pi process with `pi -p`, an explicit high-thinking model, and a bounded review packet. Use when the user asks for an external review, independent review, second opinion, fresh eyes, high-thinking review, or a separate reviewer pass before committing, opening, updating, or merging a change.
---

# External Review

Use a separate Pi process as a fresh reviewer. The external reviewer is advisory:
verify its claims locally before changing code or reporting them as facts.

## Workflow

1. Scope the review target: current diff, staged diff, branch, PR, issue, file,
   or user-provided artifact. If the target is ambiguous, choose the smallest
   obvious current change and state that assumption.
2. Build a bounded review packet for the external reviewer. Prefer:
   - User request and intended behavior.
   - Changed-file list and diffstat.
   - Focused diff or relevant excerpts, not the whole repository.
   - Validation already run and known failures.
   - Specific concerns the user asked about.
3. Launch Pi with a high thinking level using this command shape:

```bash
pi --no-session --no-tools --model "${EXTERNAL_REVIEW_MODEL:-github-copilot/gpt-5.5}" --thinking high -p "$REVIEW_PROMPT"
```

Use the user's requested model when provided. Otherwise use
`EXTERNAL_REVIEW_MODEL` when set, falling back to `github-copilot/gpt-5.5`.
Keep `--no-tools` unless the user explicitly wants the external reviewer to use
tools; read-only packet review is the default.

4. Ask the external reviewer for structured output:
   - Material findings only, ordered by severity.
   - File/line or excerpt-backed evidence.
   - Why the issue matters.
   - Suggested fix direction.
   - Validation gaps and open questions.
   - Final verdict: pass, revise, or blocked.
5. Synthesize the result. Inspect the local code before accepting any finding.
   Classify each external finding as must-fix, optional/deferred, false
   positive, or needs human decision. Explain rejected findings briefly.
6. If implementing fixes, keep them scoped to confirmed must-fix findings and
   rerun focused validation afterward.

## Prompt Template

Use this shape for `$REVIEW_PROMPT`:

```text
You are an external reviewer running in a fresh context.

Review target:
<scope and intent>

Review posture:
- Read-only. Do not ask to mutate files or run tools.
- Report only material correctness, security, maintainability, API, test, or
  scope risks that should change the work before it is considered done.
- Do not praise. Do not report style preferences.

Context:
<user request, constraints, validation already run>

Changed files and diffstat:
<bounded file list and stats>

Diff or excerpts:
<focused patch/excerpts>

Output format:
Findings:
- Severity: blocker|major|minor
  Evidence: <file/line or quoted excerpt>
  Issue: <problem>
  Why it matters: <impact>
  Suggested fix: <direction>

Validation gaps:
- <gap or "none">

Open questions:
- <question or "none">

Verdict: pass|revise|blocked
```

## Guardrails

- Do not use external review as a substitute for local understanding.
- Do not paste the external review verbatim as the final answer unless the user
  explicitly asks for raw output.
- Do not send secrets, private tokens, credentials, or unrelated proprietary
  context in the review packet.
- If the packet is too large for one prompt, split by subsystem or risk area and
  run multiple focused external reviews.
