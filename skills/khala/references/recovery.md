# Khala recovery and failure handling

Fail closed and preserve exact causal evidence. Runtime reachability, a wake,
transport acknowledgement, a pane, or a monitor projection never authorizes a
replacement action.

## Work submission or review wake fails

The Work Submission, Signal, or review evidence may already be durable even
when its wake reports an error. Read the Archive and keep the same Work ID.
When a Work-submission wake fails, treat Executor state as unknown. Use the
reported setup path or `/khala-recreate`; never start a direct replacement
agent from a shell or another delegation tool.

## Observer or Execution launch fails

Use the tool's returned identity and error evidence. Do not assume a launch
started because a pane or process was created. Confirm the Executor record and
Archive before retrying. If launch cleanup or state is uncertain, let the
Conclave recovery path settle it rather than creating a second Observer or
Execution manually.

## Stale Mission, Signal, or currentness fence

Stop implementation or lifecycle action when Work, Mandate revision, Mission,
participant, Execution, or Signal currentness does not match. Re-read the
Archive and use the authorized Retry or recovery path. Never update an old
Mission in place and never submit a Signal for a successor using predecessor
identifiers.

## Supervision delivery is uncertain

Do not resend a correction, stop, or outcome based on a transcript or transport
acknowledgement. Khala may verify the persisted marker and resend the same
bounded action only when its marker is absent; conflicting evidence fails
closed.

A mandatory stop must abort and settle the Executor, then deliver one handoff.
The Executor must submit exactly one later current blocked Signal with nonempty
evidence. If that evidence is missing or ambiguous, the targeted Execution is
failed and the Intervention is closed with exact runtime-loss evidence; Khala
must not synthesize a Signal or silently prompt again.

## Retry and Pull Request recovery

Retry creates a successor Mission and Execution. Preserve the predecessor's
Signal, Verdict, validation, and Pull Request records. The successor uses the
complete retry handoff and, when a predecessor URL exists, a `Supersedes`
relationship; do not close the predecessor manually or invent a missing URL.

A reviewable Pull Request requires matching, remotely confirmed publication
already in the Archive. If recovery cannot verify the URL, branch, or head,
record the gap rather than changing the status by inference. A merged Pull
Request remains external acceptance evidence; only the Conclave can record the
Work Outcome after rechecking all bindings.

## Runtime, polling, and model outages

A missing or unrestartable headless session fails only its bound Execution and
preserves the exact failure record. Poll and Conclave-model outages use the
bounded runtime recovery path; dependent launch remains held while required
supervision or upstream evidence is unavailable. A changed or missing upstream
ref records invalidation and downstream handling; it never silently rebases an
active attempt.
