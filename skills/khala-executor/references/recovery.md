# Executor recovery and stop handling

The system prompt, current Mission fence, and Conclave controls remain
authoritative. Fail closed; do not turn uncertain runtime state into a claim.

## Missing or stale assignment

If Work, Mandate revision, Mission, Participant Identity, Execution, checkout,
upstream base, or Validation Contract is missing or inconsistent, do not edit.
Read the bound Archive records, state the exact gap, and submit one current
blocked Signal. Never repair identity by copying a value from a prompt,
transcript, path, or display label.

If the Mission fence becomes stale while working, stop implementation and
external publication. Do not submit a predecessor Signal under a successor
Mission or update a Mission in place; wait for the authorized Conclave Retry or
recovery path.

## Signal and runtime failures

A Signal is durable evidence, not permission to continue. After an effective
Signal, stop external side effects until the Conclave handles it. If the Signal
call reports a wake or Pull Request finalization error, report that exact error;
do not claim that the Signal, review, or Verdict failed without Archive evidence.

Normal agent settlement is not success. If a current evidence-bearing Signal is
not present, cooperate with the single bounded no-file-change settlement
handoff. Do not send a second prompt or synthesize a Signal when the required
handoff evidence is absent.

## Mandatory stop

A Conclave mandatory stop is a bounded abort/settle barrier. When it arrives:

1. Stop editing and do not create, delete, stage, commit, or publish files.
2. Wait for the runtime's abort/settle handoff; do not send ordinary input or
   attempt to steer yourself.
3. Submit exactly one current `blocked` Signal with nonempty evidence describing
   the stop, current work, and any safe observations requested by the handoff.
4. Stop. Do not continue because a pane, process, or transport acknowledgement
   appears healthy.

If the handoff is not delivered or currentness is ambiguous, preserve the exact
gap and let the Conclave fail the Execution through its recovery path.

## Retry and Pull Request review

A Retry supplies a new Mission, Execution, assignment, and validation contract.
Preserve predecessor records and apply only the successor's required changes,
completed-work handoff, non-goals, and validation. When a predecessor Pull
Request URL exists, create the successor with the supplied `Supersedes`
relationship; if it is missing, do not invent one.

A `finished` Signal hands the work to external review. User `changes-requested`
evidence leads to a successor path; it does not authorize edits to the old
Mission. A merged Pull Request and Work Outcome are separate external and
Conclave records; the Executor never claims either.
