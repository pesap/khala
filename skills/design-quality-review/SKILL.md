---
name: design-quality-review
description: >
  Formal, structured code review for correctness, security, structural health,
  type safety, and maintainability. Detects bugs, design degradation, spaghetti
  growth, thin abstractions, dead code, dependency smells, type weaknesses, and
  layer leaks. Use when the user explicitly asks for a review, audit, or quality
  assessment before merging (PR review, diff review, "review this PR", "audit
  this diff", "is this ready to merge?"). Do NOT use for casual code questions,
  explanations of how code works, implementation requests, or one-off "what do
  you think?" opinions.
license: MIT
compatibility: pi >= 1.0
---

# Design Quality Review

A single-pass review covering five dimensions: **correctness**, **security**,
**structural health**, **type safety**, and **maintainability**. Uses
progressive disclosure — load only the reference files relevant to what the diff
contains.

## Positioning

This skill replaces the previous separate skills `code-review`, `simplify`,
`type-hardening`, `dependency-untangler`, and `dead-code-proof`. It covers their
domains in one coherent framework.

Skills that remain standalone and complement this one:

- `security-audit` — full-app threat assessment (broader scope)
- `nasa-guidelines` — safety-critical coding discipline (different philosophy)
- `public-api-guard` — contract stability across versions (different concern)
- `comment-quality-gate` — comment-only hygiene (narrower scope)
- `surgical-dev` — coding guidelines, not reviewing

## Avoid when

- User asks a casual or open-ended question about code ("what do you think of
  this approach?", "how does this work?") — answer conversationally instead.
- User asks to implement a feature, fix a bug, or write code — this is a review
  skill, not an implementation skill.
- User asks for a full-app threat assessment or penetration test plan — use
  `security-audit`.
- User asks for NASA/JPL Power of Ten safety-critical discipline — use
  `nasa-guidelines`.
- User asks to check API contract stability across versions — use
  `public-api-guard`.
- User asks to clean up comments only — use `comment-quality-gate`.
- User asks to remove dead code from the entire codebase — run static analysis
  tools directly (`vulture`, `knip`, `ts-prune`, etc.) rather than a full
  review.
- The task is a one-line or trivial change with no structural or correctness
  surface — a full review is disproportionate.

## Severity System

Every finding gets a **dimension letter** and a **severity number** (0 = most
severe, 3 = least). Severity is independent across dimensions — a C1 is not
comparable to a T1. They gate on different criteria.

| Code | Dimension       | 0 (Blocker)                                                                                | 1 (Serious)                                                                          | 2 (Moderate)                                                   | 3 (Minor)                              |
| ---- | --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------- |
| C    | Correctness     | Crash, data loss, data corruption                                                          | Likely bug in normal operation                                                       | Edge-case bug, race condition                                  | Theoretical issue                      |
| S    | Security        | Exploitable vulnerability                                                                  | Security weakness with plausible attack path                                         | Defense-in-depth gap                                           | Best-practice hardening                |
| T    | Structure       | Architecture emergency (circular deps, 2k+ line file, tangled spaghetti across many flows) | Structural regression (file crosses 1k, new spaghetti in shared path, layer leak)    | Missed simplification, thin abstraction, wrong layer placement | Minor structure nit                    |
| D    | Types           | Unsound — type system lied to, unsafe cast that will crash                                 | Brittle — `any`/`unknown` at public boundary, nullable without guard                 | Weak — broad union where narrower exists, missing validation   | Cosmetic — type alias could be tighter |
| M    | Maintainability | Dead feature with live wiring, dependency cycle, duplicated subsystem                      | Dead code in active paths, unnecessary dependency, copy-pasted logic with drift risk | Stale comment, orphaned import, debug leftover                 | Naming could be clearer                |

## Finding Bar

Report a finding only when it is all of these:

1. Introduced or exposed by the reviewed scope.
2. Supported by concrete code evidence (file, line, before/after).
3. Actionable by the author.
4. Material enough that a maintainer would likely address it before merge.

Do not report: style preferences, naming preferences, speculative future issues,
issues outside scope, praise, or restatements of the diff.

## Review Method

### Step 1: Scope the review

Infer intent from the codebase. Identify: changed files, surrounding code,
callers, tests, public contracts, and established project patterns.

### Step 2: Decide which dimensions to load

**Do this immediately after scanning the diff and before applying any rules.**
Scan the changed files for signals. Load only the reference files whose loading
triggers match. **Do not load all references by default.**

| Reference                         | Load when the diff contains...                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `references/correctness.md`       | State mutations, async/concurrent code, complex conditionals, error handling paths, data transformations, algorithms with edge cases                                   |
| `references/security.md`          | Auth checks, user input reaching storage/network/filesystem, URL construction, secrets, tokens, permissions, deserialization of untrusted data                         |
| `references/structural-health.md` | New files >500 lines, diff adding >200 lines to existing file, new abstractions/wrappers, conditionals in shared/general-purpose paths, orchestration code             |
| `references/type-safety.md`       | `any`/`unknown`/casts, broad unions, nullable without guards, untyped boundaries, new type definitions                                                                 |
| `references/maintainability.md`   | Commented-out code, duplicated logic across files, new dependencies, imports that look accidental, stale references, debug artifacts                                   |
| `references/language-map.md`      | **Always load first** — determines thresholds, anti-pattern catalogs, and tool references for the repo's languages. Every other reference depends on these thresholds. |

If zero triggers match after scanning, the diff is likely trivial — skip to a
lightweight pass (check for obvious correctness/security issues without loading
references) and produce a short verdict.

### Step 3: Apply rules from loaded references

For each dimension, work through the rules in priority order (0 first, then
descending). Record findings with dimension+severity, concrete evidence, and a
proposed fix where applicable.

### Step 4: Calibrate restructuring suggestions

For each T-finding or D-finding that proposes a restructuring, estimate:

- Risk of the change (low / medium / high)
- Confidence that the restructuring is correct (0..1)
- Estimated blast radius (lines/files touched)
- Validation required (which tests/checks to run)

Only auto-suggest restructurings with confidence ≥ 0.80 and low risk. Flag
high-risk or low-confidence restructurings as "for consideration."

### Step 5: Run validation

Run the relevant linter, type-checker, and test suite for touched paths. Report
which commands were run and their results. If checks cannot run, state why and
provide manual verification steps.

## Approval Bar

The review produces one of three verdicts:

- **Approved** — no findings at severity 0 or 1 in any dimension.
- **Needs attention** — one or more C1, S1, T1, D1, or M1 findings, or any
  severity-0 finding. These are **presumptive blockers**; the author must fix or
  explicitly justify each.
- **Rejected** — multiple severity-0 findings, or a severity-0 that cannot be
  resolved without fundamental redesign.

### Presumptive blockers (require fix or explicit justification)

- **C0/C1**: Crash, data loss, likely bug.
- **S0/S1**: Exploitable or plausible vulnerability.
- **T0/T1**: Architecture emergency, file explosion past 1k lines, spaghetti
  growth in shared paths, layer leak, or missed code-judo opportunity where a
  clearly simpler design exists.
- **D0/D1**: Unsound types, `any`/`unknown` at public boundaries.
- **M0/M1**: Dead feature with live wiring, dependency cycle, dead code in
  active paths, unnecessary dependency.

### Non-blockers (fix at author's discretion)

- Severity 2 or 3 in any dimension.
- Suggestions without concrete evidence.
- Restructurings flagged as "for consideration" (high risk or low confidence).

## Output Format

Produce a structured report with these sections:

```text
## Verdict: [Approved / Needs attention / Rejected]

### Blocking Findings
[dimension][severity] file:line — finding
  Evidence: ...
  Fix: ...
  Validation: ...

### Non-Blocking Findings
[dimension][severity] file:line — finding
  Evidence: ...
  Suggestion: ...

### Restructuring Proposals (T-findings only)
[severity] file:line — proposal
  Risk: low|medium|high  Confidence: 0..1  Blast radius: N lines/files
  Validation required: ...

### Structural Health Summary
- Files crossing size thresholds: ...
- New abstractions introduced: ...
- Spaghetti signals: ...
- Dead code signals: ...
- Dependency signals: ...

### Validation
- Commands run: ...
- Results: pass/fail

### Dimensions Covered
- Correctness: [loaded / skipped — reason]
- Security: [loaded / skipped — reason]
- Structure: [loaded / skipped — reason]
- Types: [loaded / skipped — reason]
- Maintainability: [loaded / skipped — reason]
```

## Non-Findings

Do not report:

- Style-only preferences (formatting, naming, comment tone)
- Broad refactor suggestions without concrete evidence
- Speculative future issues
- Issues not introduced or exposed by the reviewed scope
- Missing tests that do not protect changed behavior or a concrete risk
- Performance concerns without a plausible scale or runtime impact
- Security concerns without an actual trust boundary or data exposure path
- "Maybe rename this" when the real issue is structural

## Review Tone

Be direct, evidence-based, and demanding about quality. Do not be rude, but do
not soften major findings into mild suggestions. If the code makes the codebase
messier, say so. If the implementation missed a dramatic simplification, say
that. If behavior can stay the same while structure becomes meaningfully
cleaner, push for the cleaner version.

Prefer a smaller number of high-conviction findings over a long list of cosmetic
notes.
