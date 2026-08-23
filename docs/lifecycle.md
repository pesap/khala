# MVP lifecycle

Khala separates User intent, Conclave decisions, Executor evidence, provider
evidence, and Archive persistence.

```text
Submission -> admission -> Mission -> queued Execution -> running Execution
  -> review request -> ready Signal -> Verdict handoff -> User review
  -> provider-confirmed merge -> Work Outcome
```

## Submission and admission

`khala_submit_work` validates title, objective, and acceptance criteria, applies
only documented defaults, and appends a `submission` record. It returns without
waiting for the Conclave child. A missing repository fact may launch one
read-only Observer, which records exactly one bounded `assessment` and stops.
The Conclave rereads the Archive and admits complete terms into an immutable
Mission.

Admission is not launch. The scheduler orders admitted Work by Archive sequence.
It starts a Work only when the project concurrency limit and its reserved token
allowance permit it. Work that cannot start remains queued with `waiting for
budget` or the relevant concurrency message.

## Execution

The Executor receives one Mission in an isolated Git worktree and a separate Pi
JSON-RPC session. Model, thinking level, token allowance, sandbox, and prompt
identity are persisted before the child starts. Runtime failure records an
error and leaves the Mission available for an explicit replacement Execution.

Only the current Executor can send `progress`, `blocked`, or `ready` Signals.
A ready Signal requires a reconciled draft GitHub Pull Request or GitLab Merge
Request. Signals are handoff evidence, not acceptance.

## Verdict and review

Only the Conclave can issue a Verdict:

- `continue` keeps the current Execution running.
- `replace` stops it and starts a replacement under the same Mission terms.
- `handoff` moves the current Execution and Work to User review.
- `reject` ends the current Mission without silently failing or cancelling Work.

The User can record `changes-requested`, `merged`, or `closed` provider review
evidence. Changes requested returns the current Execution to running. A merged
review request still needs a changed provider-outcome observation.

## Acceptance and failure

Only a Conclave `outcome` record linked to provider-confirmed merge evidence
sets Work to `succeeded`. A closed request, failed CI, missing provider result,
blocked Execution, and monitor failure remain evidence that requires a decision.
The User alone can record `cancelled`; failed Work requires an explicit
Conclave or User decision.

The MVP intentionally excludes automatic merge, semantic retry, token top-up,
priority, dependency, and peer-conflict decisions.
