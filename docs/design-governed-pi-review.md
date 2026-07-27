# Design: Governed pi-review Work Flow

## Decision
Keep pi-review read-only and make a future review request an ordinary Khala Work
Submission. This design is downstream of the durable Mandate/Mission lifecycle
in Plan 014 and does not authorize integration until that lifecycle is stable. The review extension would submit a Work describing the target and
rubric; the Project Conclave would authorize one isolated Executor to run the
review; the Executor would report findings through Signals. This document does
not add records, automatic Verdicts, or implementation behavior.

## Authority and flow

- The User Session defines the review objective, target, scope, and acceptance
  criteria through `khala_submit_work`.
- The Conclave validates the target and decides whether context is sufficient,
  then launches an Executor using the existing Work/Executor boundary.
- The Executor may inspect only its sandbox and may append Signals, never
  Verdicts or Counsel.
- The Conclave remains the only issuer of Continue, Retry, Finish, or Reject.
- pi-review remains a presentation and target-construction surface; it must not
  become an alternate lifecycle authority.

Proposed Work metadata is plain existing Work text: target kind, immutable
resolved commit or merge base, requested review policy, and output contract.
No new lifecycle record type is needed.

## Security

The Conclave must resolve branch, commit, PR, and folder targets before launch,
reject paths outside the project, and preserve the existing GitHub URL allowlist.
The Executor receives immutable target values rather than arbitrary shell text;
all Git commands continue to use argv arrays. Review output is evidence, not
permission to edit, commit, push, or issue a Verdict. User-provided instructions
must remain lower authority than role prompts and the validated Work bounds.

## Compatibility and observability

Existing `/review` direct workflows remain unchanged during migration. A new
explicit `Review as Khala Work` action should be opt-in, with direct mode as the
fallback. Archive payloads remain unchanged until a separately approved schema
proposal exists. The Conclave Monitor can display the normal execution and
Signal records. The review result should be retained in Signal evidence or
source paths, not copied into diagnostic logs.

## Rollout

1. Add a pure target serializer and a review-to-Work adapter behind an explicit
   UI action.
2. Add a Conclave validation prompt and integration tests for each target kind.
3. Run both direct and governed reviews in development, comparing resolved
   targets and policy text.
4. Enable the governed action by default only after sandbox, authorization,
   retry, and cancellation tests pass.

## Rollback

Remove or disable only the opt-in adapter and return to direct `/review`.
Existing Work and Archive records remain valid because the design adds no record
kind and does not rewrite the append-only Archive. In-flight governed Work must
be resolved by the Conclave using its normal lifecycle rather than being
silently deleted.

## Open questions

- Should a PR target be resolved by the User Session or by the Conclave inside
  the trusted project before sandbox creation?
- Which review output size and evidence paths are acceptable for Signal payloads?
- Should cancellation produce a blocked Signal, or only requeue after explicit
  Conclave approval?
- Which existing review settings are allowed in Work text without weakening
  the system review rubric?
