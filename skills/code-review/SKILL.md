---
name: code-review
description: Review code changes for bugs, performance issues, and best-practice violations. Use when users ask for a PR/diff review, risk assessment, or actionable quality findings.
---

# Code Review

## Use when
When reviewing a pull request, diff, or set of code changes.

## Avoid when
- User asks for implementation work instead of review.
- Scope has no concrete diff/target files to assess.

## Instructions

1. **Understand the change** — Read the diff or changed files to understand what was modified and why
2. **Check for bugs** — Look for logic errors, off-by-one errors, null/undefined access, race conditions, unhandled edge cases
3. **Check error handling** — Prefer fail-fast propagation unless the current boundary can fully recover. Flag swallowed parse/IO/network failures, unchecked error codes, fallback-to-success behavior, and local `try/catch` blocks that hide failure signals.
4. **Check untrusted input** — Flag unconstrained redirects, non-parameterized SQL, URL fetches that can reach local resources, missing authorization boundaries, and output that should be escaped rather than sanitized.
5. **Check performance** — Flag O(n^2) loops, unnecessary allocations, missing indexes, N+1 queries, unbounded growth, and missing backpressure where it can affect stability.
6. **Check maintainability risk** — Flag fragile control flow, unclear invariants, avoidable coupling, and abstractions that increase operational risk without clear value.
7. **Check tests** — Are there tests? Do they cover edge cases? Are they testing behavior or implementation?
8. **Report only actionable findings** — Findings must be discrete, introduced by the reviewed scope, provable from concrete evidence, and likely worth fixing if the author knew about them.

## Output
- Prioritized findings by `[P0]` to `[P3]`
- File/line evidence for each finding
- Concrete fix guidance
- Residual risks and follow-up checks
- Verdict: `correct` or `needs attention`
- `Human Reviewer Callouts (Non-Blocking)` with applicable migrations, dependency changes, auth/permission behavior, public contract changes, destructive operations, feature flags, or configuration default changes; write `- (none)` when none apply
