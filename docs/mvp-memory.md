# Expandable evidence memory MVP

## Purpose and ownership

This MVP defines expandable evidence memory for Khala's governed workflow.
It adapts Victor Taelin's source log, summary tree, and persisted view to preserve useful discoveries across authorized attempts.
Pi durable supplies execution persistence while the Archive retains lifecycle authority.

The [main MVP](mvp-design.md), [data model](data-model.md), [lifecycle](lifecycle.md), and [security contract](security.md) remain authoritative.
Work, Mission, Execution, and Record remain the domain primitives.
A Pi Conversation, Task, or Entry is runtime machinery, not another Work or a source of lifecycle authority.

| Document | Owns |
| --- | --- |
| This MVP | User outcome, scope, exclusions, and policy boundaries |
| [Memory storage](mvp-memory-storage.md) | Source retention, derived indexes, retrieval, context views, and Pi durable integration |
| [Memory validation](mvp-memory-validation.md) | Delivery slices, deterministic acceptance, recall evaluation, and release evidence |

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

The correction enters through the [post-admission clarification flow](lifecycle.md#submission-and-clarification), not an Executor Signal, Observer assessment, or review action.
Authorized clarification request and User-answer actions are prerequisites for restart-safe evidence recall.
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
Use transactional SQLite storage and Pi durable's persisted tasks, entries, and documents.
A second transcript logger, task journal, or budget ledger would duplicate those responsibilities.

A temporal tree supplies orientation but cannot guarantee discovery of every minor fact.
Deterministic text, path, symbol, and error searches complement expansion and use the same source identities.
Neither the reference's zoom-only rule nor its claim that the latest mention is truth applies to Khala.

## MVP scope

The core scope is complete authorized source retrieval, persistent investigation evidence, deterministic discovery, and context preparation on recovery.
Hierarchical summaries form a separately evaluated context policy over that foundation.

Included responsibilities are:

- Preserve exact admitted intent, corrections, and required evidence instead of treating display excerpts as complete sources.
- Keep useful investigation outcomes in Signals and assessments, with references to retained supporting evidence.
- Keep private runtime sources outside the Archive and outside temporary storage when long-term retention is required.
- Provide bounded overview, search, and exact expansion through the authorized application boundary.
- Prepare relevant current-Work evidence before admission or resumption requests instead of relying only on optional model tool use.
- Use Pi durable for restartable execution and index construction without replacing Khala's authorization or accounting.
- Measure hierarchical summaries against complete deterministic retrieval before release or default enablement.

The initial scope is one repository and one Work, with per-role and per-Execution visibility restrictions.
Conclave requests remain bounded and Work-scoped rather than sharing an installation-wide conversation.
The Oracle remains a no-tools reviewer of its supplied packet.

## Evidence checkpoints

An investigation checkpoint describes the question, the attempted approach, the observation, and the remaining uncertainty.
It distinguishes measured outcomes from hypotheses and retains relevant paths, errors, commands, source identities, and head or environment identity.
It records why an approach failed under those conditions rather than turning the failure into an unconditional instruction.

These checkpoints use role-authorized Signals and assessments.
A model-generated checkpoint is still evidence, not proof that its claims are correct.
Summaries preserve attribution and point to that evidence instead of upgrading a hypothesis, attempted command, or partial result into completion.
Private reasoning is not promoted into reusable memory.

## Policy boundaries

Automatic recall is confined to the bound Work and the caller's permitted Execution scope.
A broader sharing policy must identify the source audience, destination audience, and approval required for promotion.
Shared repository identity alone grants no access.

| Concern | Required policy | Enforcement point |
| --- | --- | --- |
| Cross-Work recall | Explicit approval for evidence selection across Work scopes | Before selecting evidence for another Work |
| Reusable instructions | User-confirmed, scoped, version-pinned [guidance](data-model.md#guidance-and-context) | Before promotion and at Mission admission |
| Private source retention | Declared quotas, lifetime, backup handling, and erasure obligations | Before retaining a category of private source |
| Summary spending | Work-attributed reservation and invocation accounting for every request | Before provider dispatch |
| Provider and prompt policy | Pinned runtime, model, prompt, and retrieval configuration | Before evaluation or governed execution |

Cross-Work expansion may retrieve relevant, explicitly shareable repository evidence at admission, but reusable instructions still require User confirmation.
Cross-repository sharing always requires explicit authorization.

## Exclusions

This MVP does not introduce an endless global chat, another coordinating role, a vector database, a knowledge graph, or an automatic lesson writer.
It does not copy raw role transcripts into the Archive or User conversation.
It does not promise indefinite retention, perfect recall, erasure through compaction, or cross-model cache reuse.
It does not authorize replacing old state through automatic migration, changing Mission terms, increasing allowances, or weakening isolation.
It does not adopt another extension's agent orchestration or duplicate Pi durable's persistence machinery.

## Reference basis

[UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) supplies the source/tree/view design and batched merge ordering.
Evaluate its cache strategy against Khala's task-specific baseline rather than treating external simulations as release evidence.
Adapt the mechanisms without copying prompt text unless redistribution rights are established.

Pin the integration to [Pi durable 1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md) and its public contracts.
Persistent provider-session identity, positional system messages, and historical context access support stable rendering and restartable evidence retrieval.
