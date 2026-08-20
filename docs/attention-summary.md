# Attention summary

`/khala` and `Alt+K` show a compact, read-only, project-level attention
summary. It is not a session changer: it does not list agent sessions, raw
Executor rows, or runtime internals, and it never switches the User's session
or exposes a writable Conclave session path.

The summary is derived from the authoritative Archive and reports only what the
User can act on:

- Review requested — Work whose current, non-superseded Mission has finished
  (a Finish Verdict) and published a reviewable Pull Request (Archive status
  `reviewable`). Selecting the item shows the Pull Request URL. Only Pull
  Request records of the Work's current Mission are considered; a review action
  is suppressed when the Mission has not finished, when the Work already has an
  accepted Work Outcome, or when the Pull Request belongs to a superseded or
  rejected Mission. The latest such record per Work decides the state, so a
  later draft, closed, merged, or changes-requested record suppresses an older
  reviewable record for the same current Mission.
- Stopped Work — a Work Submission the Conclave rejected, a Mission rejected by
  a terminal Verdict, or a Work whose automatic Conclave submission recovery
  was exhausted (a durable `conclave-recovery` exhaustion record). Stopped Work
  is reported only from these durable terminal or exhausted records, never from
  an Execution failure alone, and never for a Work that already has an accepted
  Work Outcome.
- Executor model recovery needed — the latest current-Mission Executor failed
  because its model was unavailable. Selecting the item lets the User choose a
  different authenticated model. The selection is scoped to that one Mission
  recovery; run `/khala-recreate` afterward. It does not change global
  configuration.
- Khala recovery needed — a failed Conclave submission wake. Selecting the item
  shows the recovery command: `/khala-recreate`, or the setup command when
  configuration is missing.

Otherwise the summary states the number of active Work submissions and says
explicitly that no user action is required.

The surface keeps one two-level public condition: working (no user action
required) or action required. Category details explain the review or stopped
Work behind each action. Retryable and raw Execution failures, headless and
supervision state, recovery labels, Participant identities, and raw Executor
rows stay out of the normal surface. A model-unavailable Executor failure is
surfaced only when it has a current Mission and requires User selection.
Conclave submission-wake recovery and its exhaustion are distinct from
Executor run recovery; only durable evidence for an actionable recovery is
surfaced here.

Running Observers with a focusable pane appear only as a clearly secondary
read-only selection ("Inspect Observer pane"). The Archive has no durable
user-input-required signal; interactive input needs were previously inferred
from session transcripts, which this surface no longer reads, so they are not
reported.

In non-interactive modes the summary is reported as a notification instead of
an interactive selection.
