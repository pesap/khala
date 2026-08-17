# User actions

Use this reference only from a User session for Archive inspection, Work
submission, Pull Request evidence, or a bounded Oracle review. The active tool
surface and current Archive remain authoritative.

## Inspect an existing Work

Use `khala_read_archive` before discussing an existing Work or reusing its
identifiers. A User must supply `workId`; `executionId` narrows the visible
records. Reads are append-ordered, bounded projections. Continue with
`nextCursor` when `hasMore` is true. A read is evidence only: it does not admit,
launch, approve, or settle anything.

## Define and submit Work

1. State objective, context, scope, acceptance criteria, constraints, plan, and
   validation separately. Do not hide missing context in a recommendation.
2. Before `khala_submit_work`, ensure objective, scope, and every required list
   entry are concrete and nonblank. `context` and `title` are optional; a stable
   `workId` preserves a draft identity when one exists.
3. Submit once and preserve the returned Work ID. Its `queued` acknowledgement
   durably records intent and independently schedules Conclave processing; it
   is not Mandate admission, Mission materialization, Executor launch, or a
   lifecycle decision.
4. If later Archive evidence reports a failed wake, keep the same Work ID and
   follow shared lifecycle recovery. Never launch a replacement agent directly.

## Record Pull Request evidence

Use `khala_record_pull_request_review` only for review, closure, requested
changes, or merge facts the User has actually observed for the matching Work,
Mission, and Execution. The User owns the `open`, `changes-requested`, `closed`,
and `merged` statuses and the review feedback and evidence fields; the runtime
owns publication bindings (URL, number, branches, commits, changed files, diff
summary, validation evidence) and the `draft`/`reviewable` statuses.

- `changes-requested` requires nonempty feedback.
- `merged` requires a Pull Request URL, final head commit, merge commit, and
  validation evidence (the runtime's recorded validation evidence is preserved
  when no new evidence is supplied).
- The record may wake the Conclave, but it is external review evidence. It does
  not issue a Verdict or establish a Work Outcome.

Do not replace runtime-confirmed Pull Request facts or infer a merge from a URL,
branch, or Finish Verdict.

## Request an Oracle review

Use `khala_oracle` only with a bounded, self-contained, read-only packet that
states the review target, intent, relevant evidence, and validation already run.
Oracle findings are advisory. Verify every finding locally before changing code
or making a lifecycle judgment.
