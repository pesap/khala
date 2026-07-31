---
name: khala
description: Explains Khala's Archive, Work, Mission, role boundaries, lifecycle tools, and evidence workflow. Use when operating in or reasoning about any Khala role, WorkPacket, Mission, Signal, Verdict, Learning, or Counsel.
---

# Khala Role and Tool Guide

This skill explains Khala's vocabulary and operating workflow. The canonical
domain glossary is in `docs/glossary.md`. The role system prompt and
authoritative Archive remain binding. If this skill conflicts with either, stop
and follow the system prompt and Archive.

## Core lifecycle

```text
Work submission → Conclave review → optional Observer → Mandate → Mission
→ isolated Executor → Signal/Learning → Conclave Verdict
```

- **Work** is the requested objective, scope, acceptance criteria, constraints,
  plan, and validation contract.
- **Archive** is the durable authority. Runtime state, prompts, pane output, and
  projections do not establish durable state.
- **Mandate** records an admitted Work revision.
- **Mission** is the immutable assignment derived from one Mandate revision.
- **Signal** reports Executor evidence: `progress`, `blocked`, or `finished`.
- **Learning** is one Observer's bounded repository observation.
- **Counsel** is advisory archival analysis and cannot change lifecycle state.
- **Verdict** is the Conclave's only lifecycle decision: Continue, Retry, Finish,
  or Reject.

## Role boundaries

- **User** authors intent, scope, acceptance, constraints, and validation. They
  may read authoritative Archive records, submit Work as intent ingress, and
  record Pull Request review or merge evidence, but do not admit Work, launch
  agents, issue Verdicts, or make lifecycle decisions. They do not impersonate
  durable Archive records.
- **Conclave** reads authoritative records, admits Work, materializes Missions,
  launches Observers or Executors, and issues Verdicts.
- **Observer** is read-only and submission-scoped. It records exactly one
  evidence-backed Learning record, then stops.
- **Executor** performs exactly one immutable Mission in one isolated checkout.
  It may edit, validate, commit, and submit Signals, but never issues Verdicts,
  changes Mandates, reassigns itself, or broadens scope.
- **Preserver** reads authorized history and records bounded Counsel only. It
  cannot issue Verdicts or mutate Work, Mission, or Archive state.

## Tool map

- `khala_submit_work`: submit a complete Work to the Project Conclave; this is
  intent ingress, not lifecycle admission.
- `khala_launch_observer`: Conclave-only read-only context gathering.
- `khala_record_learning`: Observer-only one-record handoff.
- `khala_admit_work`: Conclave-only Mandate admission.
- `khala_launch_execution`: Conclave-only Mission/Executor launch.
- `khala_signal`: Executor evidence handoff to the Conclave.
- `khala_verdict`: Conclave lifecycle decision for one Signal.
- `khala_counsel`: Preserver advisory evidence.
- `khala_read_archive`: role-filtered authoritative Archive reads.

## Evidence discipline

Read the authoritative records before reasoning. Verify Work, Mission, Mandate,
Execution, Participant, project, and currentness bindings. Distinguish observed
facts, validation results, failures, uncertainty, and recommendations. Never
fabricate identifiers, approval, review state, command output, or completion.
A wake or prompt is attention only; an authorized tool result is required before
claiming durable state.
