---
name: khala
description: >
  Use only when the user explicitly requests Khala, a Khala Work, Archive inspection, or Khala supervision.
  Do not use for ordinary coding requests or intent inferred from context.
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

## Authority and revisions

For a mutation to an existing Work:

1. Call `khala_read_archive` for the current Work and relevant records.
2. Use the returned Work `revision` as `expectedWorkRevision`.
3. Make one explicit tool call and inspect its returned projection.
4. On a revision conflict, reread the Archive and recompute the decision.

For a new Work, the explicitly requested `khala_submit_work` call is the initial mutation because no Work revision exists to read.
For an explicit resubmission or any later mutation, read the existing Work first.

The application service supplies idempotency metadata for tool calls.
Repeating a completed tool call returns its prior result when the same command identity is available; it does not make a second lifecycle decision.

## Minimal workflow

1. After an explicit Khala request, submit complete intent with `khala_submit_work` when a new Work is requested.
2. Read the Work and Archive records with `khala_read_archive`.
3. Let the Conclave admit the Mission and schedule an Execution.
4. Let the Executor work in its dedicated Git sandbox, commit through the governed workspace action, run declared validation, create or reconcile the draft review request, and record a `ready` Signal.
5. Record User review evidence or poll the provider with `khala_poll_provider`.
6. Let the Conclave assess bounded provider observations and record the explicit Outcome only after verified merge evidence.

A ready Signal, handoff, provider approval, or provider merge is not acceptance.
Current provider delivery reaches `succeeded` only through a Conclave `record-outcome` backed by provider-confirmed merge evidence.

## Current limits

The current extension does not provide local acceptance or a shared background supervisor.
Autonomous provider polling belongs to the hosting User session and stops when that session closes.
Declared validation and dependency hydration require Linux bubblewrap and run without host credentials, host cache, or network access.
Pi child launches and service-owned Git hooks do not yet have complete OS isolation.
Do not treat provider credential files as inaccessible to an Executor child.

## Load references only when needed

- [`references/tools.md`](references/tools.md) describes tool contracts, action inputs, and role-bound shortcuts.
- [`references/workflows.md`](references/workflows.md) describes normal operation, failure handling, and recovery.
- [`references/boundaries.md`](references/boundaries.md) describes current implementation limits, provider requirements, and security boundaries.

Do not preload every reference for an ordinary coding task.
