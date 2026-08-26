# Demo frictions

Resolutions below describe the current product behavior and the operational
lesson for future demos.

- 2026-08-26 — Resolved: The first live Work submission encountered a Conclave
  child exit before its first response. Runtime startup now retries one
  transient child lifecycle failure, and the outbox worker retries the
  idempotent Conclave wake once more before retaining durable failure evidence.
- 2026-08-26 — Resolved: GitHub polling used the unsupported `merged` JSON field
  with GitHub CLI 2.97. The adapter now requests `mergedAt` and has a focused
  regression test for that contract.
- 2026-08-26 — Clarified: The user-scoped adapter correctly rejected an attempt
  to record an Executor Signal. The role boundary remains intentional; User
  action guidance now explains that Executor evidence comes from the bound
  Executor and provider comments enter through `khala_poll_provider`.
- 2026-08-26 — Resolved: A provider-polling child retained a stale Pi UI context
  after session replacement. Background effect scheduling no longer captures a
  session UI context; all progress and failures remain in the Archive.
- 2026-08-26 — Mitigated: A transient Executor rebind failure previously caused
  an immediate replacement Execution. Runtime startup now retries the rebind
  once, preserving the same Execution when the child recovers. A genuinely
  unavailable runtime still follows the intentional durable replacement path.
- 2026-08-26 — Prevented operationally: The demo PR targeted `main` while that
  base already had two failing supervision-recovery tests. The demo Work scope
  correctly prohibited unrelated test changes. Future demos must verify the
  target branch is green before introducing the deliberate CI failure; the
  current branch’s focused Khala suite is green.
- 2026-08-26 — Resolved: A one-shot Pi process used to trigger pending effects
  shut down immediately after launching its child runtime. Demo supervision
  now uses a persistent parent Pi session for the entire Work lifecycle.
- 2026-08-26 — Resolved: Long-lived supervisors sharing one project could see
  the same project-local Archive and terminate each other’s child sessions.
  The retry demo used a separate project path, Archive root, and worktree root.
- 2026-08-26 — Resolved: Child Pi inherited an auto-loaded copy of the project
  extension, causing duplicate tool and flag registration. The isolated child
  command disables auto-loaded extensions before loading Khala explicitly.
- 2026-08-26 — Resolved locally: Parallel CI test files raced while
  `test/index.test.js` rewrote `dist/package.json`, producing invalid-package
  errors. The test now installs that fixture with an atomic rename; the
  historical demo PR predates this local fix and remains unmodified.
- 2026-08-26 — Resolved locally: Aborting a timed-out RPC child could emit an
  unhandled `EPIPE` from its stdin stream. Runtime cleanup now observes stdin
  errors and routes them through the normal child-failure path; the demo PR
  predates this local fix and remains scoped to its demo source file.
