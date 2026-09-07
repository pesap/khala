# Application actions

This page maps current Pi tool entry points to their responsibilities.
It is not the full target action schema and does not imply that every [MVP requirement](mvp-design.md) is available through the current tools.
The application service enforces permissions; a tool name or visible action is not authority.

## Entry points

| Tool | Purpose |
| --- | --- |
| `khala_submit_work` | Record complete User intent without waiting for admission |
| `khala_read_archive` | Read bounded, role-authorized Work facts and record summaries |
| `khala_inspect_runtime` | Inspect runtime liveness without writing lifecycle state |
| `khala_poll_provider` | Record changed provider observations and merge evidence |
| `khala_perform_action` | Submit an actor-authorized lifecycle action |
| `khala_record_assessment` | Record one bounded Observer assessment |
| `khala_record_signal` | Record current Executor progress, blocked, or ready evidence |
| `khala_run_oracle` | Request bounded no-tools advisory review |

User actions include pre-admission amendments, renaming, budget changes, review evidence, recovery, cancellation, and explicit failure where authorized.
Conclave actions include admission, Mission decisions, optional Observer and Oracle use, Verdicts, bounded feedback, and Outcome settlement.
Observer and Executor tools remain bound to their assigned role and Work.
Oracle sessions have no tools and receive only the review packet.
The current action names and inputs are defined in [`src/model.ts`](../src/model.ts) and the handlers in [`src/index.ts`](../src/index.ts).
The packaged [Khala skill](../skills/khala/SKILL.md) describes current tool use.

## Read before acting

Read saved state and the current revision before submitting a consequential decision.
Use runtime inspection for liveness rather than inferring it from the Work state.
Use provider polling for fresh external evidence rather than interpreting a comment as permission.
An error or revision conflict is not successful execution of the requested action.

`khala_read_archive` returns current terms and at most the ten most recent bounded record summaries, not complete record payloads.
Use the authorized Archive view for record details.
Pi tool expansion changes presentation rather than granting the model additional record access.
Current summary output is bounded to 48 KB and 1,800 lines.

## Where the contracts live

- [Lifecycle](lifecycle.md) owns admission, amendments, correction, review, acceptance, and recovery decisions.
- [Architecture](architecture.md#commands-and-reads) owns command metadata, idempotency, conflicts, pending-command reconciliation, and bounded reads.
- [Architecture effects](architecture.md#external-effects-and-monitoring) owns outbox execution and monitoring.
- [Data model](data-model.md) owns record and snapshot identities.
- [Security](security.md) owns session identity, tools, context, and provider trust.
- [Operations](operations.md#startup-and-recovery) distinguishes current recovery commands from target background supervision.

Local acceptance, exact successor approval, shared-Archive supervision, command-status reads, and the target attention actions require their contracts to be implemented before callers assume they exist.
Do not invent a tool action from a target requirement or bypass the service with direct storage access.
