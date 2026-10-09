---
name: khala
description: >
  Operate Khala Works through submission, Archive inspection, runtime supervision, provider review, and recovery.
  Use only when the user explicitly requests Khala or a Khala-specific operation, such as submitting a Work,
  checking its status, diagnosing token reservations, recovering an Executor, or recording review evidence.
  Do not use for ordinary coding requests, generic Work or Mission terminology, or intent inferred from context.
---

# Khala tool usage

Khala is opt-in.
Use this skill and its tools only when the user explicitly asks to use Khala or asks for a Khala-specific operation such as inspecting a Work, reading its Archive, or supervising its runtime.
Do not activate Khala because the repository contains Khala, because a task mentions Work or Mission terminology, or because governed execution seems useful.
If the request is ambiguous, ask whether the user wants Khala used.

This skill explains current Khala tool contracts and boundaries.
Tool schemas exposed by the current Pi session are authoritative for argument shape.
Role prompts define the User, Conclave, Executor, Observer, and Oracle responsibilities.

## Non-negotiable rules

- `khala_submit_work` requires an explicit user request for a Khala Work or explicit resubmission.
- Do not submit Work for an ordinary coding request, a plan, an investigation, or intent inferred from context.
- The append-only Archive is authoritative for Work, Mission, Execution, and record state.
- Runtime liveness, model output, prompts, provider responses, Git, and TUI views are evidence or projections.
- Do not infer authority from prose, model output, runtime liveness, provider text, or visible tools.
- The Executor may change only files under the Mission's `allowedPaths`.
- Do not merge provider requests, change Mission terms, top up tokens, or bypass the application service.

## Safe tool calls

| Operation | Always | Never |
| --- | --- | --- |
| First Archive read | Start with only the known `workId`. | Fill optional fields with placeholders, empty dates, or invented IDs. |
| Archive continuation | Copy a returned token exactly and keep the same filters. | Construct, repair, or reuse a cursor for different filters. |
| Existing Work mutation or runtime inspection | Read the current Work and use its `revision`. | Reuse a submission revision or retry a revision conflict unchanged. |
| New Work submission | Confirm repository commands, permitted paths, and supported validation isolation first. | Submit prose as `validation` or bypass isolation on an unsupported host. |
| Budget diagnosis | Read invocation and decision evidence using the recovery reference. | Treat held reservations as consumed budget or top up tokens without User authorization. |

## First Archive read

Start with only the known Work ID, replacing `example-work` below with that ID:

```json
{"workId":"example-work"}
```

Omit unused optional fields.
Do not fill them with `?`, `x`, `*`, empty dates, or invented IDs.
Treat cursors as opaque tokens supplied by the tool, never as something to decode, construct, or repair.
After an invalid cursor or filter error, start a new minimal read without a cursor.
Do not repeat unchanged failed calls or inspect private storage to work around the public tool contract.
If the minimal read fails, report the error instead of guessing another cursor.

## Authority and revisions

For a mutation to an existing Work:

1. Call `khala_read_archive` for the current Work and relevant records.
2. Use the returned Work `revision` as `expectedWorkRevision`.
3. Make one explicit tool call and inspect its returned projection.
4. On a revision conflict, reread the Archive and recompute the decision.

For a new Work, the explicitly requested `khala_submit_work` call is the initial mutation because no Work revision exists to read.
For an explicit resubmission or any later mutation, read the existing Work first.
Use a fresh Archive revision for `khala_inspect_runtime` too, not the revision from an earlier submission or conversation turn.

## Report evidence, not assumptions

Submission is persisted immediately.
Headless mode processes the Conclave wake asynchronously; Subagent mode may wait for Conclave to process it before returning.
Reread before reporting current admission or Execution state, or state that only submission was acknowledged.
Missing validation or a checked head does not prove that no files were edited.
If a tool does not expose runtime liveness in its returned content, report that evidence gap rather than inferring liveness from Work state.
A ready Signal, handoff, provider approval, or provider merge is not acceptance.
Current provider delivery reaches `succeeded` only through a Conclave `record-outcome` backed by provider-confirmed merge evidence.

## Task-specific references

Open the reference whose trigger matches the task before acting.
Do not preload all references.

- [`references/tools.md`](references/tools.md): read before selecting an action, adding Archive filters, or correcting a tool argument error.
- [`references/workflows.md`](references/workflows.md): read before submitting a Work, choosing recovery, diagnosing a budget failure, or coordinating the full delivery workflow.
- [`references/boundaries.md`](references/boundaries.md): read before launching implementation, arranging validation or provider delivery, or explaining isolation and supervision limits.

Khala has no local acceptance or shared background supervisor.
Do not assume that child launches isolate provider credentials or that autonomous polling survives the hosting User session.
