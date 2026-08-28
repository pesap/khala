# Khala glossary

- Archive — authoritative append-only SQLite event store. Runtime and views
  do not mutate it directly.
- Actor — a role-bound identity such as User, Conclave, Observer, Executor,
  Oracle, or monitor.
- Application service — the single versioned interface used by Pi tools and
  layouts to validate actor, state, revision, and external effects.
- Execution — one bounded attempt at a Mission, including model, thinking,
  allowance, sandbox, prompt identity, and Pi binding.
- Mission — one immutable contract copied from admitted Work terms.
- Observer — a submission-scoped, read-only context gatherer that records
  exactly one assessment.
- Oracle — a separately configured no-tools reviewer whose findings are
  advisory and never issue a Verdict.
- Record — one immutable Archive fact with actor, bindings, payload version,
  summary, and evidence references.
- Signal — Executor evidence describing progress, blockage, or review
  readiness. It is not acceptance.
- Verdict — a Conclave decision to continue, replace, hand off, or reject a
  current Execution.
- Work — the stable User goal with a budget and terminal `succeeded` or
  `stopped` state; `stopReason` records a failure or cancellation.
- Work Outcome — explicit acceptance evidence created only after provider
  merge confirmation.
