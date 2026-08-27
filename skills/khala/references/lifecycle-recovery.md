# Shared lifecycle recovery

Use this reference for User, Conclave, Observer, or Preserver recovery events.
Do not use it for an active Executor Mission: that role follows the
`khala-executor` skill's Mission-specific recovery reference.

Fail closed and preserve exact causal evidence. A runtime, wake, transport
acknowledgement, pane, or monitor projection never authorizes a replacement
action.

## Submission or review wake fails

A successful Work submission acknowledgement means the queued submission is
durable even when its independently scheduled wake later fails. Signal or review
evidence may likewise already be durable when a wake reports an error. Keep the
same Work ID, read the Archive, and inspect the monitor. Follow the returned
setup or `/khala-recover` guidance; never start a replacement agent from a
shell or another delegation tool.

## Observer or Executor launch fails

Use the tool's returned identity and error evidence. A created pane or process
does not prove a launch started. Confirm the Executor record and Archive before
retrying. If cleanup or state is uncertain, let the Conclave recovery path
settle it rather than manually creating a second Observer or Execution.

## Currentness or delivery is uncertain

Stop a lifecycle action when Work, Mandate revision, Mission, participant,
Execution, Signal, or source-entry currentness does not match. Re-read the
Archive and use the authorized Retry or recovery path; never update an old
Mission in place.

Do not resend a correction, stop, or Intervention outcome from a transcript or
transport acknowledgement. Khala may verify its persisted marker and resend the
same bounded action only when the marker is absent. Conflicting evidence fails
closed.

## Retry, review, and runtime recovery

Retry creates a successor Mission and Execution. Preserve predecessor Signal,
Verdict, validation, and Pull Request records. Use the complete retry handoff
and, when a predecessor URL exists, its `Supersedes` relationship; do not close
the predecessor manually or invent a URL.

A reviewable Pull Request requires matching, remotely confirmed publication in
the Archive. If URL, branch, or head cannot be verified, record the gap rather
than inferring status. Only the Conclave can record a Work Outcome after
rechecking verified merge evidence and all bindings.

A missing or unrestartable headless session fails only its bound Execution and
preserves its exact failure record. Poll or Conclave-model outages use the
bounded runtime recovery path; dependent launch remains held while required
supervision or upstream evidence is unavailable. A changed or missing upstream
ref records invalidation and downstream handling; it never silently rebases an
active attempt.
