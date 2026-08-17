# Executor Signals

Use this reference immediately before sending `khala_signal`. Signals are
current-Execution evidence, not a Verdict, merge, or Work Outcome.

Choose `progress`, `blocked`, or `finished`. Supply a nonempty summary and at
least one nonempty evidence item. The runtime verifies the session, sandbox,
participant, governing Mandate, and current Mission fence; never work around a
rejection by reusing predecessor identifiers.

Before `finished`, complete every Validation Contract check and confirm the
implementation and reviewable Pull Request publication evidence. Include exact
validation results and unresolved gaps. If publication or a required fact is
missing, use `blocked` instead.

After an effective Signal, stop implementation and external side effects until
the Conclave handles it. A `finished` Signal can report a wake or Pull Request
finalization error after its evidence is durable. Preserve that exact error and
do not infer that the Signal, review, Verdict, merge, or Outcome failed.
