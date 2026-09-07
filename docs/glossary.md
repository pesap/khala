# Khala glossary

These terms support the [foundations](foundations.md) and [MVP design](mvp-design.md).
Detailed structure belongs in [Data model](data-model.md), and transitions belong in [Lifecycle](lifecycle.md).

- Archive: the durable account of goals, agreements, attempts, evidence, and decisions.
- Work: the User's stable goal, independent of any particular attempt or label.
- Mission: one immutable agreement defining what an attempt may do and how its result is checked and reviewed.
- Execution: one bounded attempt to carry out a Mission.
- Record: one immutable fact in the Archive.
- User: the person who assigns Work and controls its boundaries, feedback, allowances, and acceptance policy.
- Conclave: the coordinating role responsible for admission, bounded correction, judgment, and Outcome settlement.
- Executor: the role carrying out one bounded implementation attempt.
- Observer: an optional read-only gatherer of missing repository facts.
- Oracle: an optional independent reviewer whose findings are advisory.
- Actor: the authenticated role-bound identity responsible for an action or recorded fact.
- Application service: the boundary that enforces authorized actions and exposes saved facts.
- Child run: one invocation of a role, distinct from the Mission or Execution it serves.
- Signal: Executor evidence of meaningful progress, blockage, or readiness for review.
- Verdict: a Conclave decision to continue, replace, hand off, or reject an attempt and its current Mission as applicable.
- Review snapshot: the immutable identity and evidence of one result presented for review.
- Provider observation: evidence obtained from a code-host review request, not permission to act.
- Delivery: a bounded, authorized transfer of feedback to an attempt.
- Acceptance: the User's approval of a reviewed result, directly for local work or delegated to the repository's merge process for provider delivery.
- Outcome: the Conclave's recorded settlement of Work against the required evidence.
- Guidance: User-confirmed, scoped advice explicitly retained for applicable assignments.
- Attention: an unresolved request or operation, or an unacknowledged terminal failure, requiring a visible next action.
