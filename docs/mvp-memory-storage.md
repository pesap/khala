# Memory storage and runtime design

## Design boundaries

This MVP defines source retention, retrieval, and durable execution for [expandable evidence memory](mvp-memory.md).
The [data model](data-model.md) owns domain facts, [security](security.md) owns authorization, and [operations](operations.md#allowances-and-limits) owns resource policy.
The structures below are internal representations, not new domain primitives or model-callable tools.

## Storage ownership

```text
Authorized application reads
    |
    +-- Archive: intent, agreements, evidence, decisions, guidance, accounting
    |
    +-- Pi durable: private execution sources and task checkpoints
    |       +-- Derived summary nodes and bounded view manifests
    |
    +-- Rebuildable search projection: keys and references to permitted sources
```

The Archive retains its transactional Record, projection, and outbox responsibilities.
It does not become a raw transcript store.
An Archive source is referenced in place rather than copied into another authoritative log.

Pi durable owns private execution history through its public storage interfaces.
Retained sources belong in private user-owned application storage outside active checkouts, not the system temporary directory.
Runtime scratch files, credentials, leases, and disposable progress are not long-term memory sources.
A stable repository identity follows the [repository contract](data-model.md#repository-and-workspace-identity), not a mutable working-directory string or remote URL alone.

Use SQLite and Pi's persisted entries and documents rather than implementing Taelin's daily files, flush protocol, and recovery queues again.
JSONL remains useful as a reviewed export, not a second live writer or authority.
No implementation may query or mutate Pi-owned tables through private schema knowledge.

## Stored representations

### Source references

A source reference identifies immutable retained content and its permitted audience.
It includes the owning store identity, opaque source ID, source version or digest, content type, encoded size, and provenance.
Provenance identifies the repository, Work, Mission, Execution, role, and observed result or head when applicable.
A Pi entry ID alone is insufficient because its numeric identity is local to one stored Session.

Availability and applicability are separate facts.
A readable historical result may be superseded or inapplicable to the current head.
An authorized caller can distinguish retained, expired, redacted, and missing content without treating any unavailable source as an empty successful result.
Unauthorized callers receive no source text or existence-revealing detail.

Exact access means exact retained content, not reconstruction of output already clipped before capture.
Tool output needed as evidence must be retained before presentation truncation, with paged access and a digest.
Where a public Pi interface cannot preserve the required artifact, establish an application-owned artifact path and reference contract before claiming completeness.
Do not copy complete transcripts into artifacts merely to create another log.

### Summary nodes

A node is a derived description of a fixed, ordered set of authorized sources.
A leaf links to its source, and a parent links to its two completed children.
Short text can be represented verbatim without a model request.

Each published node records:

- Its node identity, generation, child or source references, and content digest.
- The visibility partition and source lineage used to construct it.
- Its covered ordinal range and immutable source cutoff.
- The actual UTF-8 size of the rendered contribution.
- The summarizer model, thinking level, prompt digest, and governed invocation identity when a model was used.

Store nodes as long-lived, scope-bound document-family members through public Pi interfaces, with application-enforced write-once generations.
Do not keep all nodes in one ever-growing JSON document.
Task memos and task-scoped documents are unsuitable because they disappear or retire when the task finishes.
A changed summary creates a new generation rather than rewriting a published node or its source.

The summary must preserve attribution, corrections, failed approaches, and unresolved questions without converting claims into verified outcomes.
Treat source content as untrusted data and give the summarizer no action tools.
Do not index private reasoning, credentials, role capabilities, or private process bindings as recallable evidence.

### View manifests

A manifest is a bounded ordered selection of node references for one visibility partition.
It records a generation, renderer version, source watermark, applicability revision, rendered size, and render digest.
The source watermark identifies committed progress in each contributing store, not a fictitious shared sequence or transaction.

Persist the selection and reuse it on restart.
Each governed request records the immutable manifest snapshot or equivalent retained snapshot identity that explains its rendered context.
While its sources remain retained and authorized, ordinary manifest replacement must not make an earlier request's rendering unrecoverable.
After expiry or redaction, preserve only policy-permitted provenance and report unavailable content to authorized readers instead of reconstructing or substituting it.

Within the manifest's declared covered prefix, nodes form a disjoint chronological cover with no gaps or repeated sources.
The manifest reports any newer unindexed sources separately instead of presenting a partial index as complete history.
The rendering order and version remain stable for equal source and manifest identities.
Forks and changed scopes do not inherit a manifest without explicit lineage and authorization checks.

### Search projection

Search indexes point to sources rather than retaining another transcript or inferring authority from summaries.
Start with deterministic lexical, path, symbol, and error indexing over approved evidence fields.
A query returns bounded source references and authorized snippets, followed by exact expansion when needed.

Use a Khala-owned SQLite search projection with source and visibility metadata.
Choose its index layout against bounded query, rebuild, and deletion requirements.
An additional database, embedding service, or semantic ranking model requires a demonstrated need.

Index updates consume committed source watermarks through bounded scans.
Rebuilding search is an explicit derived-data operation and does not regenerate the persisted context view or launch an LLM.
Pi watches may collapse intermediate updates and therefore cannot be the sole audit or indexing feed.

## Retrieval contract

The application service owns authorized overview, search, expansion, source reading, and Mission retrieval.
Convenience tools use the same contracts rather than introducing another access path.

| Capability | Required result |
| --- | --- |
| Overview | Exact current identity and applicability plus a bounded historical view with explicit coverage |
| Search | Bounded matching source references and snippets within the caller's permitted scope |
| Expand node | Its authorized children, source bindings, generation, and completeness information |
| Read source | Exact permitted content or field pages, digest, encoding, total size, and continuation |
| Read Mission | Complete immutable terms, directly or through explicit field and array paging |

Every read revalidates current role authority, including continuations and cached results.
A node is visible only when every source that contributed to its text was permitted for that audience.
This includes contextual sources supplied to the summarizer, not only the child nodes named in the output.
Summarizing private Execution evidence into a Work-level node is not an authorized promotion.
Search snippets, hit counts, node metadata, and cached renders follow the same restriction.

A cursor binds the query, immutable source or snapshot identity, and the last item or byte range actually delivered.
It must not advance past records dropped to meet an item or byte budget.
Page boundaries preserve UTF-8 characters, and reassembly reproduces the authorized source digest.
Large arrays have explicit continuation rather than silent removal of later requirements.
Private fields are excluded before paging, with the public source digest defined over the permitted representation.

Mandatory intent and current constraints are not lossy historical summaries.
Context preparation must obtain complete current Mission terms before an implementation request.
If required terms cannot fit the selected request budget, report the limitation rather than silently shortening them or sending an incomplete agreement.
Historical evidence remains paged and selected on demand.

## Corrections, retention, and scope changes

A correction appends evidence that identifies what it supersedes and why.
It changes applicability without rewriting an immutable Mission or pretending that historical observations never occurred.
Guidance promotion, version pinning, and withdrawal follow the [guidance contract](data-model.md#guidance-and-context).

A summary based on superseded evidence remains historical only when its status is explicit and its audience remains permitted.
An affected active view is invalidated or replaced before reuse.
An in-flight summary may publish only after rechecking its source identities, visibility partition, and applicability revision.
New unrelated evidence may extend a watermark, but a changed policy or source interpretation must not silently become part of the old build.

Retention policy must specify quotas, lifetimes, pinned evidence, backup handling, and disposition of references before real private sources are admitted.
A source needed for an unresolved decision is not disposable merely because its producing task ended.
Missing required evidence blocks the dependent action instead of allowing a summary to stand in as proof.

Redaction must remove access to the source and every derived node, snippet, and cached view that could disclose it.
Withholding content is not a claim that its bytes have been erased.
Context omission, document retirement, reset, and compaction are not substitutes for physical erasure.
Select the storage layout and retention policy together, including required erasure of backups and descendant summaries.
Reject source capture when those obligations cannot be met through public interfaces.
Do not bypass that requirement by editing Pi's private tables.

Cross-Work retrieval requires the explicit sharing approval defined by the [policy boundaries](mvp-memory.md#policy-boundaries).
Sharing a database, repository, conversation owner, or summary ancestor grants no additional access.

## Hierarchical view experiment

Build the tree over dense local ordinals within one authorized source stream.
Archive sequences and Pi IDs can have gaps and must not be used directly as the reference's contiguous message numbers.
A parent merges adjacent aligned siblings with equal spans and a completed parent representation.
For a stream with `T` items and a zero-based last ordinal, prioritize pairs by:

```text
due = (T - pairLastOrdinal) / childSpan
```

Choose the largest value, preferring the oldest pair on ties.
Measure age from the pair's last item, not its first.
Only select a merge that reduces the measured rendered size when fitting a byte budget.

Append completed leaves between batches.
Crossing the high-water mark triggers a batch that merges eligible pairs toward the low-water mark, then atomically publishes the replacement manifest.
Persist the queue of unfinished node builds and their inputs instead of rescanning the entire history after every append.
If incomplete nodes prevent a fit, expose the backlog and stop context dispatch when mandatory bounds cannot be met.
Never send half a source or a fabricated summary as a substitute.

Choose node sizes, view watermarks, summarizer context, and concurrency against the Work allowance, model context window, output reserve, and measured retrieval quality.
Do not copy another workload's byte budgets or worker count without evaluation.
Measure bytes for encoded storage and actual request tokens for model capacity and spending.
Account for any summarizer context as well as the summarized input in privacy and cost checks.

## Pi durable integration

Use [Pi durable 1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md) through its [public types](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/harness/types.ts) and [specification](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/docs/spec.md).
Keep durable execution behind the application's [runtime interface](architecture.md#boundaries), separate from role policy and evidence retrieval.
Do not depend on private SDK hooks or storage schemas.

| Public mechanism | Intended use |
| --- | --- |
| `Harness.open()` and `inspect()` | Open persisted state and inspect pending work before scheduling |
| `Conversation.submit()` and `Submission` | Track one admitted runtime request with a stable identity |
| `defineTask()` | Checkpoint bounded node construction and publication work |
| `defineDoc()` and `defineDocFamily()` | Store long-lived node generations and bounded manifests |
| `Conversation.entries()` and `context()` | Read retained history and the applicable model context through public scans |
| `viewState()` and watches | Present committed progress, not replace an audit or accounting ledger |

Keep one private Conversation for an Execution across its authorized invocations rather than creating a new provider identity for every context refresh.
A compact model context need not be a new storage Session.
Bind its model, role, permitted tools, environment, Mission, and prompt identity explicitly.
Do not reuse process-global role tokens as per-conversation authority or let registry defaults expand a role's tools.
In particular, do not install `CodingTools` wholesale because it includes arbitrary `bash`.

### Recovery and publication

Map Khala run IDs to the durable store, Conversation, Submission, and required task identities.
Preserve original-input fingerprints in Khala because Pi's request-ID deduplication does not validate changed same-type content.
Acquire exclusive storage ownership and reconcile Archive authority, pending effects, reservations, and writer state before enabling scheduling.
Submissions and progress waits can start the scheduler as well as `resume()`.
Read-only inspection must not start model work.

Use intent, effect, and outcome checkpoints for external operations.
A crash after an effect but before its result commit creates an uncertain effect, not permission to repeat it.
Safe tool replay skips `beforeTool`, so authorization and currentness checks must also run in the executed adapter.
Only operations with proven idempotency or reconciliation may declare replay safe.

Publish a completed node, its task outcome, and related manifest change in one Pi commit when they share a store.
Archive decisions and Pi commits are not one transaction.
Use stable outbox and invocation identities to reconcile cross-store progress, including a crash between source retention and its Archive reference.
Neither store may claim a source or completion that the other has not durably supplied.

### Accounting and shutdown

Every summary request and retry must have a Work-attributed reservation, invocation identity, purpose, and usage evidence through the accounting boundary.
Per-request attribution is required before background summaries may dispatch.
Pi usage totals are observations for Khala's ledger, not a second budget authority.
Do not charge a child's usage again through its parent's tool result.
Unknown provider spend remains uncertain until reconciled, even when a task can resume.

An ordinary `beforeRequest` or `beforeCompact` hook failure can be reported without stopping the request.
Those hooks cannot be the sole privacy, spending, or authorization gate.
Prove enforcement at an execution boundary before enabling model-driven memory work.
A foreground invocation must not hold the only capacity slot while waiting for a summarizer that needs it.

Work cancellation must cover pending summary tasks, background work, and queued manifest writes explicitly.
Ordinary conversation abort preserves background subtrees and queued writes, while `close()` preserves unfinished work for reopening.
A stale queued result must not restore revoked context after cancellation or scope change.
Termination confirmation and workspace release still follow the [lifecycle](lifecycle.md#cancellation-recovery-and-retention).

The supervisor must enforce exclusive writer ownership for each runtime store.
Select and verify persistence settings through public APIs, with explicit guarantees for process crashes and for host or power failure.
Keep interface attachment, supervisor lifetime, and OS process isolation as separate responsibilities.
Persisting a Harness does not replace those controls.

## Context preparation and cache behavior

Prepare requests in this conceptual order:

```text
Stable role instructions and permitted tools
Complete current Mission terms and applicable pinned guidance
Persisted chronological history view
Current revision, head, budget, and unresolved conditions
Authorized invocation task
```

Select evidence within scope before rendering it.
Record the source snapshot and freshness of live reads without claiming an atomic snapshot across stores.
The service continues to revalidate consequential actions against current authority.

Use one owner for active-context replacement.
Do not let native compaction and hierarchical memory independently replace the same context.
A request-local `beforeRequest` transform alone does not bound persisted active history or prove correct token estimation.
The experiment must coordinate stored context boundaries and long tool-using turns through public Pi operations.

Keep changing state after the stable prefix and preserve exact rendering between batches where authority permits reuse.
Do not preserve a stale or revoked prefix merely to obtain a cache hit.
Provider model, tool declarations, account scope, retention lifetime, and request serialization all affect reuse.
Choose cache policy from measured request cadence rather than assuming the reference's prices or five-minute lifetime apply everywhere.
