# Governed Khala Work lifecycle

This page shows how a Khala Work moves from User intent to Pull Request review.
The Archive is authoritative: runtime status, prompts, transcripts, and pane
output are evidence only. A Signal supplies evidence; it does not make a
lifecycle decision.

## State boundaries

| Boundary | What it answers | What it does not prove |
| --- | --- | --- |
| Work | Has the submitted objective been admitted, rejected, or kept active? | That an Executor is running or that a change is accepted. |
| Mission | What immutable assignment and validation terms govern this attempt? | That the assignment has been completed. |
| Execution | What durable attempt is queued, running, finished, or failed? | That its child process is reachable; runtime liveness is separate evidence. |
| Signal | What evidence has the Executor reported? | That the Conclave accepted the evidence or issued a Verdict. |
| Pull Request | What branch, head, diff, and review state are available? | That the Work succeeded; only verified merge evidence can support a Work Outcome. |

The normal lifecycle is:

```text
Work Submission → Mission admission → queued Execution → running Execution
→ Executor Signals → Conclave assessment/Verdict → draft Pull Request
→ User review or merge → Work Outcome after verified merge
```

## 1. Submission and admission

The User submits complete terms: objective, scope, acceptance criteria,
constraints, and validation. The submission is queued for Conclave review. It is
not yet a Mandate, Mission, or Execution.

Admission creates a Mandate and one immutable Mission. The Mission copies the
terms that govern this attempt. A retry creates a successor Mission rather than
rewriting the predecessor.

## 2. Queued and running Execution

The Conclave creates an Execution for the Mission. `queued` means the attempt
has been recorded but has not started. `running` means the durable Execution
lifecycle has started and is supervised. It does not by itself prove that the
child runtime is reachable or idle; those are runtime observations.

The Executor works only in its isolated Git sandbox. It should inspect, make the
scoped change, validate it, publish its branch, and then report evidence.

## 3. Read authoritative records

`khala_read_archive` returns bounded, append-ordered projections. Use Work,
Mission, and Execution identifiers to narrow the view; use the returned cursor
to continue a long result. The identifiers below are placeholders, not real
Archive records.

```json
{
  "workId": "<work-id>",
  "missionId": "<mission-id>",
  "executionId": "<execution-id>",
  "kinds": ["submission", "mission", "execution", "signal", "pull-request"],
  "cursor": "<optional-cursor>"
}
```

Read the Archive before making a decision or reusing a revision. Do not infer
state from a prompt, transcript, process listing, or provider message.

## 4. Executor Signals and Conclave decisions

An Executor reports `progress`, `blocked`, or `ready` evidence through the
application service. Each Signal should identify observable repository facts,
such as a file path, commit, validation command, or published review URL. The
Conclave assesses the current Signal and may continue, retry, finish the
handoff, or reject it. A `ready` Signal is not acceptance.

A revision fence prevents an action from applying to stale Work state. If the
expected revision is rejected, reread the Archive and do not retry the same
mutation unchanged.

For example, the following shapes use placeholders and illustrative evidence:

```json
{
  "action": "record-signal",
  "workId": "<work-id>",
  "expectedWorkRevision": 7,
  "input": {
    "kind": "progress",
    "summary": "Documentation page added within the Mission scope.",
    "evidence": [
      "docs/khala-demo-workflow.md exists",
      "git diff --check passed"
    ]
  }
}
```

## 5. Draft review handoff

Before the final handoff, the Executor must commit the scoped change, push the
Mission branch, and create or reconcile a **draft** Pull Request against the
configured target branch. The review request should contain the change summary
and validation evidence, not raw prompts or transcripts.

A draft Pull Request is a review artifact. It is not a Verdict, merge, or Work
Outcome. A review handoff can be represented by an application-service action
such as:

```json
{
  "action": "create-review-request",
  "workId": "<work-id>",
  "expectedWorkRevision": 8,
  "input": {
    "subject": "Add the governed Khala lifecycle walkthrough",
    "summary": "Adds a documentation-only lifecycle reference.",
    "evidence": [
      "branch pushed at <head-commit>",
      "git diff --check passed",
      "draft review request published at <review-url>"
    ]
  }
}
```

The Executor then sends a final evidence-bearing Signal containing the current
head, changed-file summary, review URL, and validation results. It must not claim
approval, merge, or acceptance.

## 6. User review and acceptance

The User reviews the draft Pull Request. The possible outcomes remain distinct:

- **Open:** review is still pending.
- **Changes requested:** the Conclave may create a successor Mission while
  preserving the previous attempt and its feedback.
- **Merged:** the User supplies merge evidence, including the merge commit.
- **Closed without merge:** the Work is not accepted.

Only provider-confirmed merge evidence plus an explicit Conclave-authored Work
Outcome records acceptance. A finished Execution, a ready Signal, or a draft
Pull Request alone never does so.

## Evidence checklist

For a reviewable handoff, confirm all of the following in the current sandbox
and Archive projection:

- the change is limited to the Mission scope;
- validation was actually run and its result is recorded;
- the branch has a committed, published head;
- the Pull Request is draft and matches that branch head;
- the final Signal cites current, concrete evidence; and
- no merge or succeeded Work Outcome is claimed before User review.
