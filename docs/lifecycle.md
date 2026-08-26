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
Mission. The User can rename the Work label later without changing the Mission
terms.

Admission is not launch. The scheduler orders admitted Work by Archive sequence.
It starts a Work only when the project concurrency limit and its reserved token
allowance permit it. Work that cannot start remains queued with `waiting for
budget` or the relevant concurrency message. When an Execution releases a
project slot, the parent supervisor durably wakes the oldest admitted queued
Mission; it does not start Work without a Conclave decision.

## Execution

The Executor receives one Mission in an isolated Git worktree and a separate Pi
JSON-RPC session. Model, thinking level, token allowance, sandbox, and prompt
identity are persisted before the child starts. A transient child startup exit
is retried once before runtime failure records an error and leaves the Mission
available for an explicit replacement Execution.

Only the current Executor can send `progress`, `blocked`, or `ready` Signals.
A ready Signal requires a reconciled draft GitHub Pull Request or GitLab Merge
Request. Signals are handoff evidence, not acceptance. An Execution can remain
`running` while its Pi runtime is `idle` between turns; the Archive records that
runtime observation separately and the TUI shows it explicitly. If the runtime
is `unreachable`, the TUI keeps the lifecycle state visible but labels the
Execution as having no active runtime or turn.

## Verdict and review

Only the Conclave can issue a Verdict:

- `continue` keeps the current Execution running.
- `replace` stops it and starts a replacement under the same Mission terms.
- `handoff` moves the current Execution and Work to User review.
- `reject` ends the current Mission without silently failing or cancelling Work.

The User can record `changes-requested`, `merged`, or `closed` provider review
evidence. Changes requested returns the current Execution to running. A merged
review request still needs a changed provider-outcome observation. Provider
observation records retain the review URL and observation ID as evidence
references. The Evidence view presents normalized pull request status, CI
checks, review comments, and review-request metadata without exposing the raw
provider response. Review comments are available in a selectable subpanel;
selecting one shows its author, timestamp, body, location, and URL. The view
also shows the Conclave handoff, including the feedback delivered to the target
Execution.

## Acceptance and failure

Only a Conclave `outcome` record linked to provider-confirmed merge evidence
sets Work to `succeeded`. A closed request, failed CI, missing provider result,
blocked Execution, and monitor failure remain evidence that requires a decision.
A successful provider observation clears a stale monitor error from the current
Work projection; the original failure remains in the append-only Archive. An
explicit failure or cancellation stops Work. The Work stores that decision
as `stopReason` rather than exposing separate failed and cancelled states. The
User can explicitly recover Work stopped by cancellation, which clears the old
Mission and returns the Work to pending admission.

## Runtime recovery evidence

Recovery is a Conclave authorization recorded as a durable effect; the parent
supervisor owns Executor rebinding and private runtime authority. Liveness
probes do not interrupt an active Executor turn, and terminal cleanup waits for
that turn to finish. Recovery probes the replacement Pi binding before recording
it as usable. If the replacement remains unreachable, Khala records a failed
Execution with runtime state `unreachable`; it never leaves that Execution
`running`.

This is observable from another Pi terminal by reading the same Work's bounded
Archive records:

```text
khala_read_archive({ workId: "<work-id>", kinds: ["execution", "error"] })

# failed recovery
error: Execution <execution-id> runtime could not be reconciled.

# successful recovery
execution: Execution <execution-id> runtime was reconciled.
```

The projection should show `execution.state: "failed"` and
`execution.runtimeState: "unreachable"` when the replacement probe fails. A
separate Archive reader can verify those values while the original TUI remains
open.

The MVP intentionally excludes automatic merge, semantic retry, token top-up,
priority, dependency, and peer-conflict decisions.
