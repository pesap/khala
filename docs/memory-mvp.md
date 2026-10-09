# Expandable evidence memory MVP

## Status and ownership

This is a proposed MVP, not an implemented feature or evidence of improved agent recall.
It adapts Victor Taelin's source log, summary tree, and persisted view to Khala's governed workflow and Pi durable execution.
It does not authorize dependency changes, state migrations, broader context sharing, or automatic cleanup.

The [main MVP](mvp-design.md), [data model](data-model.md), [lifecycle](lifecycle.md), and [security contract](security.md) remain authoritative.
Work, Mission, Execution, and Record remain the domain primitives.
A Pi Conversation, Task, or Entry is runtime machinery, not another Work or a source of lifecycle authority.

| Document | Owns |
| --- | --- |
| This proposal | User outcome, MVP scope, exclusions, and approval decisions |
| [Memory storage](memory-storage.md) | Source retention, derived indexes, retrieval, context views, and Pi durable integration |
| [Memory validation](memory-validation.md) | Delivery slices, deterministic acceptance, recall evaluation, and release evidence |

## User outcome

Khala should resume an authorized attempt with its useful discoveries intact, find the evidence behind them, and avoid repeating an investigation merely because the conversation ended.
Remembering an old result does not establish that it remains true for a new head or environment.
The desired improvement is better evidence retrieval and use, not model training or increased authority.

The first end-to-end scenario stays within one Work and one Execution:

1. The Executor investigates a failure and records an evidence-bearing checkpoint describing the attempted approach, observed outcome, and unresolved question.
2. The Conclave requests clarification of a factual assumption, and the User answers that request without changing the Mission terms.
3. The runtime is interrupted after those facts are saved.
4. An authorized recovery prepares the corrected context and the prior investigation outcome before another model request.
5. The Executor can expand both references to complete permitted evidence and validate its next change against the current head.

The correction enters through the target [post-admission clarification flow](lifecycle.md#submission-and-clarification), not an Executor Signal, Observer assessment, or review action.
Its authorized request and User-answer actions are a prerequisite for Slice 3, not existing memory capabilities.
This scenario tests useful continuity without granting access to another Execution's private history.
Changed Mission terms remain governed by the [lifecycle amendment contract](lifecycle.md#admission-and-amendment).

## Adopt the structure, not a second agent product

| Reference mechanism | Khala adaptation |
| --- | --- |
| Append-only original log | Retain admitted evidence and private execution sources once, under their owning storage |
| Immutable summary tree | Build derived, scope-bound nodes with links to children and exact sources |
| Persisted view | Save a bounded ordered selection rather than refitting it at every restart |
| Zoom | Expand through the authorized application interface, down to paged source content |
| Batched merges | Preserve stable historical prefixes between explicit view replacements |
| Background compactor | Run bounded, accounted durable tasks rather than ungoverned model requests |

The logical structure matters more than daily JSONL files.
Khala already has transactional SQLite storage, and Pi durable provides persisted tasks, entries, and documents.
A second transcript logger, task journal, or budget ledger would duplicate those responsibilities.

A temporal tree supplies orientation but cannot guarantee discovery of every minor fact.
Deterministic text, path, symbol, and error searches complement expansion and use the same source identities.
Neither the reference's zoom-only rule nor its claim that the latest mention is truth applies to Khala.

## MVP scope

The first usable slice provides complete authorized source retrieval, persistent investigation evidence, deterministic discovery, and context preparation on recovery.
The bounded hierarchy is a later experimental slice of this proposal, not a prerequisite for repairing retrieval.

Included responsibilities are:

- Preserve exact admitted intent, corrections, and required evidence instead of treating display excerpts as complete sources.
- Keep useful investigation outcomes in existing Signals and assessments, with references to retained supporting evidence.
- Keep private runtime sources outside the Archive and outside temporary storage when long-term retention is required.
- Provide bounded overview, search, and exact expansion through the existing application boundary.
- Prepare relevant current-Work evidence before admission or resumption requests instead of relying only on optional model tool use.
- Use Pi durable for restartable execution and index construction without replacing Khala's authorization or accounting.
- Measure hierarchical summaries against repaired deterministic retrieval before release or default enablement.

The initial scope is one repository and one Work, with existing per-role and per-Execution visibility restrictions.
Conclave requests remain bounded and Work-scoped rather than sharing an installation-wide conversation.
The Oracle remains a no-tools reviewer of its supplied packet.

## Evidence checkpoints

An investigation checkpoint describes the question, the attempted approach, the observation, and the remaining uncertainty.
It distinguishes measured outcomes from hypotheses and retains relevant paths, errors, commands, source identities, and head or environment identity.
It records why an approach failed under those conditions rather than turning the failure into an unconditional instruction.

These checkpoints use existing role-authorized Signals and assessments.
A model-generated checkpoint is still evidence, not proof that its claims are correct.
Summaries preserve attribution and point to that evidence instead of upgrading a hypothesis, attempted command, or partial result into completion.
Private reasoning is not promoted into reusable memory.

## Current implementation gaps

The assessment baseline is Khala revision `d3cec86`.
The following are deterministic storage or retrieval issues, not measurements of model recall.
The regression expectations belong to [Memory validation](memory-validation.md#deterministic-acceptance).

| Current behavior | Consequence | Owning implementation |
| --- | --- | --- |
| Storage pages hold 100 records, but packets keep at most ten and forward the storage cursor | Following every continuation can skip retained bodies | [Archive queries](../src/archive-query.ts) and [decision evidence](../src/decision-evidence.ts) |
| Many term fields are capped at 500 UTF-8 bytes and arrays at ten items | Current Mission requirements can disappear from the model-facing overview | [Decision evidence](../src/decision-evidence.ts) |
| Payload reads above 16,000 characters become a clipped wrapper | A stored payload is not necessarily completely retrievable | [SQLite Archive](../src/sqlite-archive.ts) |
| Records appear under both `records.items` and `items` | Repeated content consumes the packet budget | [Decision evidence](../src/decision-evidence.ts) |
| The reader has no exact record selector or source-field paging | A summary cannot reliably lead to a complete original | [Tool registration](../src/index.ts) |
| Runtime session paths use the system temporary directory | Stable filenames do not establish long-term retention | [Runtime storage](../src/runtime-storage.ts) |

Ordinary Pi RPC remains the current runtime.
The hosting User session still owns the application runtime, and current Pi child launches do not establish OS isolation.
The proposal does not claim to implement the [independent supervisor](architecture.md#supervision-and-recovery) or close the [process isolation gap](security.md#workspace-and-process-isolation).

## Approval decisions

The defaults in this table bound the prototype, not new production configuration settings.
Unresolved decisions block the affected slice rather than granting implicit permission.

| Decision | Bounded proposal | Approval required before |
| --- | --- | --- |
| Cross-Work recall | No automatic access to earlier Works, even in the same repository | Enabling repository-wide evidence selection |
| Reusable instructions | Follow User-confirmed, scoped, version-pinned [guidance](data-model.md#guidance-and-context) | Promoting observations into standing guidance |
| Private source retention | Use deterministic synthetic fixtures until quotas, lifetime, backup, and erasure requirements are selected | Retaining new categories of real transcripts or artifacts |
| Summary spending | Attribute every request to its Work through existing invocation accounting | Making summary model calls in governed Work |
| Provider and prompt policy | Pin the selected runtime, model, prompt, and retrieval configuration | Starting the held-out evaluation |

The recommended later cross-Work policy is automatic retrieval of relevant, explicitly shareable repository evidence at admission, while reusable instructions still require User confirmation.
That recommendation is not approved by this document and does not widen current capabilities.
Cross-repository sharing always requires explicit authorization.

## Exclusions

This MVP does not introduce an endless global chat, another coordinating role, a vector database, a knowledge graph, or an automatic lesson writer.
It does not copy raw role transcripts into the Archive or User conversation.
It does not promise indefinite retention, perfect recall, erasure through compaction, or cross-model cache reuse.
It does not authorize replacing old state through automatic migration, changing Mission terms, increasing allowances, or weakening isolation.
It does not adopt another extension's agent orchestration or duplicate Pi durable's persistence machinery.

## Reference basis

[UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), reviewed with its discussion on 2026-10-08, supplies the source/tree/view design and batched merge ordering.
Its reported cache reuse and cost reductions are simulations, not Khala release evidence.
The proposal adapts the mechanisms rather than copying its prompt text, whose redistribution license is not established here.

[Pi durable 1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md) is the integration baseline.
The feature first shipped in 1.0.0, but [later fixes](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/CHANGELOG.md) add persistent provider-session identity and correct leading system-message placement.
The API remains experimental, so the implementation must pin and validate its selected release.
