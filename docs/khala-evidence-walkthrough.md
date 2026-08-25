# Khala evidence walkthrough

This walkthrough shows the observable path from a submitted Work to a reviewable
Executor branch. Examples use placeholder IDs. They illustrate tool shapes; they
are not Archive evidence.

## Lifecycle at a glance

1. A User submits complete Work terms.
2. The Conclave admits the Work into one immutable Mission.
3. An Execution is queued and then started in its isolated sandbox.
4. The Executor records progress Signals with concrete evidence.
5. The Executor commits the change and creates a draft review request.
6. The Executor records a ready Signal for User review.
7. The User reviews the draft. Review and merge decisions remain outside the
   Executor's authority.

A queued or running Execution is not proof that the implementation is complete.
The Archive records durable lifecycle state; provider, process, and terminal UI
state are only supporting evidence.

## 1. Submission and Mission admission

Submission provides the objective, scope, acceptance criteria, constraints, and
validation requirements. It is queued for Conclave assessment. Admission creates
a Mandate and an immutable Mission for one attempt. A retry creates a successor
Mission rather than rewriting the original terms.

Read the bounded Archive projection for a Work with a placeholder ID:

```json
{
  "workId": "<work-id>",
  "executionId": "<execution-id>"
}
```

The returned records distinguish the Mission assignment from later Execution
records. Continue with the returned cursor when the page reports more records.

## 2. Queued and running Execution

The Conclave schedules an Execution against the admitted Mission. The queued
record identifies the sandbox, branch, base commit, model, and allowance. A
later running record identifies the active session. These records establish the
assignment and runtime state, not acceptance.

An Executor reads only its bound Work and Execution. It must stop if that
binding or the Work revision becomes stale.

## 3. Evidence-bearing Signals

Signals report progress without changing the Mission terms or making an
acceptance decision. Each Signal should state what changed and cite evidence
that another reviewer can inspect. For example, an Executor can record a
progress Signal after creating the page and another after validation:

```json
{
  "workId": "<work-id>",
  "kind": "progress",
  "summary": "Added the lifecycle walkthrough page.",
  "evidence": [
    "docs/khala-evidence-walkthrough.md exists on the Executor branch.",
    "git diff --check passes."
  ],
  "expectedWorkRevision": 4
}
```

The revision in this example is illustrative. Use the current Archive revision
when calling the tool; do not copy a revision from an example.

A ready Signal is appropriate only after the branch is committed, the draft
review request is reconciled, and validation evidence is available:

```json
{
  "workId": "<work-id>",
  "kind": "ready",
  "summary": "Implementation is ready for User review.",
  "evidence": [
    "Head commit: <head-commit>",
    "Changed file: docs/khala-evidence-walkthrough.md",
    "Draft review: <review-url>",
    "Validation: git diff --check"
  ],
  "expectedWorkRevision": 5
}
```

The ready Signal is a handoff, not a Verdict or acceptance record.

## 4. Draft review and User review

Before a ready Signal, the Executor creates or reconciles a draft Pull Request
(or Merge Request) through Khala's application service. The review request
should identify the branch, current head, changed files, and validation results.
Use the repository's review template when one exists. Do not merge the request
or claim approval from its draft status.

The User reviews the draft and may request changes, close it, or approve it.
Only provider-confirmed merge evidence plus an explicit Work Outcome records a
successful Work completion. A draft review URL is evidence of handoff, not
evidence of merge.

## Reading the record safely

Archive reads are append-ordered and bounded:

```json
{
  "workId": "<work-id>",
  "executionId": "<execution-id>",
  "cursor": "<previous-record-id>"
}
```

Use the returned `nextCursor` for the next page. Treat record payloads as the
authoritative lifecycle projection and keep unverified provider messages,
process liveness, and model output out of evidence claims.
