# Design: Reusable Observer Learning

## Decision
Keep Observer Learning Work-scoped by default. Cross-Work reuse is a separate,
future opt-in policy requiring explicit Conclave authorization, visibility,
freshness, semantic equivalence, and conflict handling. Current Learning
behavior remains unchanged and no new cross-Work reader is authorized by this
design.

## Authority and selection rules

- An Observer may record Learning only for its bound execution, as today.
- The Archive is authoritative; Learning is never copied or edited in place.
- The Conclave may read Learning for the same Work while validating it and may
  cite selected records in its reasoning. A User Session cannot promote
  Learning directly to an Executor Mission.
- Any future cross-Work candidate reader must be Conclave-only and must not
  satisfy a missing Work context without explicit authorization.
- A candidate is visible only when its project path, source paths, and Work
  authority permit access. Cross-project reuse is forbidden by default.
- Freshness is evaluated against the candidate's source commit, source path
  existence, and an explicit age or invalidation policy. Missing provenance is
  stale, not reusable.
- Equivalence requires normalized topic, affected paths, source revision, and
  claims to match the new Work's scope. Similar prose alone is insufficient.
- Authorization requires the Conclave to approve the candidate for this Work;
  an Observer, Executor, or external prompt cannot grant reuse permission.

A reuse decision should remain a Conclave reasoning event and should cite the
Learning record IDs in evidence. Do not introduce a new lifecycle record type
until the authority and replay semantics are approved.

## Security

Learning may contain repository details and must be treated as untrusted data
when inserted into prompts. Preserve role prompts and Work bounds, cap selected
content, and avoid exposing secrets found in source files. Source paths must be
validated against the trusted project root before display or reuse. A stale or
ambiguous candidate is rejected closed.

## Compatibility

Existing `LearningRecord` payloads, Observer permissions, and the current
"learning for this Work" behavior remain valid. No current Work execution may
change because a new Learning record appears. A future cross-Work proposal must
add provenance and authorization without weakening the Mission fence.

## Rollout

1. Define canonical source revision and path normalization without changing the
   persisted record format.
2. Add a read-only candidate evaluator with table-driven tests for visibility,
   freshness, equivalence, and authorization.
3. Add Conclave prompt guidance that requires explicit selection and citations.
4. Measure rejected, stale, and selected candidates before enabling reuse for
   all Work submissions.

## Rollback

Disable candidate selection and return to the current per-Work Learning path.
The evaluator is read-only, so rollback requires no Archive mutation. Any
already-running Executor continues under its immutable mission; do not replace
its context retroactively.

## Open questions

- What source revision should be recorded for non-Git repositories?
- What age and commit-distance thresholds define stale Learning?
- Should equivalent Learning be selected by exact normalized fingerprints or by a
  bounded semantic review performed by the Conclave?
- Which project configuration, if any, may authorize cross-Work visibility?
- How should conflicting Learning be surfaced without leaking its payload?
