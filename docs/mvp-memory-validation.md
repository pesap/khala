# Memory delivery and validation

## Purpose and gates

This MVP defines delivery slices and acceptance criteria for [expandable evidence memory](mvp-memory.md).
The [storage contract](mvp-memory-storage.md) defines the behavior under test.
[Development](development.md) owns repository commands, and the [LLM release gate](mvp-design.md#evidence-before-expanding) remains mandatory.

## Delivery slices

Each slice must leave a usable, independently testable path before the next one expands behavior.
Dependency changes require explicit approval, and no slice migrates Archives or transcripts automatically.

### Slice 1: Complete authorized retrieval

Provide complete pagination, exact permitted source and Mission-term paging, and nonduplicated packet content through the authorized application interface.
Enforce Work, Execution, and private-field restrictions.
This path requires no LLM summarizer.

Exit evidence is complete retrieval of retained sources under item and byte bounds, with rejection of forged or stale-scope continuations.
It becomes the deterministic baseline for every later comparison.

### Slice 2: Pi durable feasibility

Build a bounded runtime adapter trial using the pinned public Pi durable interface and deterministic local model responses.
Use synthetic sources and disposable, explicitly owned state rather than importing real histories.
Prove the original-source, node-lifetime, manifest-snapshot, scheduling, and accounting contracts before making durable the production runtime.

The trial must resolve:

- Durable storage ownership, persistent location, writer exclusion, and the selected process or host failure guarantee.
- Exact source lookup, bounded paging, index update watermarks, and the physical search projection.
- Role, tool, environment, model, and prompt bindings that survive reopening without inheriting broader defaults.
- Per-request usage attribution and reservation checks for generations, summaries, retries, and uncertain outcomes.
- Retention and required erasure through public interfaces, without private Pi-table edits.
- A single context-replacement policy with correct token estimation and bounded active history.

An unmet public-API requirement blocks the affected integration rather than authorizing a private interface, weaker guarantee, or alternative execution path.

### Slice 3: Restart-safe evidence recall

Provide [post-admission clarification request and User-answer actions](lifecycle.md#submission-and-clarification) through the authorized application interface.
Implement the [user scenario](mvp-memory.md#user-outcome) with exact retained sources, investigation checkpoints, deterministic search, and prepared recovery context.
Restore the same authorized Execution after interruption and make its previous observations and factual corrections discoverable.
Keep this slice within the bound Work and its declared visibility restrictions.

Exit evidence must show the attributed correction and superseded evidence, unchanged Mission terms, source reassembly, correct currentness, and bounded reads after a process restart.
Deterministic success establishes recoverability, not improved model recall.
Private-source capture requires an approved retention policy.

### Slice 4: Hierarchical context experiment

Add immutable summary-node generations, ready-node queues, a persisted view, and batched merges as a separately selected experimental policy.
Bound every summary request by Work invocation accounting and capacity.
Retain exact source expansion and deterministic search rather than forcing zoom-only retrieval.

Exit evidence includes deterministic tree and restart invariants plus the held-out comparison below.
Keep model-driven memory behavior off by default until the release gate passes.
A summary failure, stale result, or exhausted allowance must produce a truthful bounded outcome, not an unaccounted request or silent incomplete context.

### Slice 5: Explicitly approved reuse

Repository-wide recall and reusable guidance require separate approval after Work-scoped recall is validated.
Record exactly what may cross Work or Execution scope and who authorized that promotion.
Test new-Mission selection and withdrawal without changing already-pinned agreements.

## Deterministic acceptance

Use Node behavioral tests through public interfaces and local adapters under `test/`.
Use synthetic content with exact expected IDs, bytes, source digests, and authorization outcomes.
Do not depend on real providers or paid tokens for these tests.

| Area | Required cases | Observable result |
| --- | --- | --- |
| Record pagination | Multiple storage pages, byte-trimmed responses, intervening appends, restart | Every authorized body appears exactly once within the pinned snapshot |
| Terms and source fields | Text, arrays, and payloads spanning response budgets | Complete permitted content remains retrievable and is never labelled complete when clipped |
| UTF-8 and large sources | Multibyte text, long lines, paged arrays, artifact limits | Reassembled pages match the retained permitted-source digest |
| Visibility | Other Works, other Executions, fork ancestors, search snippets, counts, cached views | No forbidden content or existence detail is disclosed |
| Provenance | Mutable file paths, changed Git head, superseded claims | Source identity and historical applicability remain distinct from current validation |
| Summary inputs | Restricted contextual evidence, malicious source text, false completion claims | Inputs stay in scope and output cannot become authority or execute tools |
| Tree structure | Sparse backing IDs, sibling alignment, equal due values, unfinished nodes | Dense local coverage has no gaps or duplicates and only eligible reducing merges fit the view |
| View persistence | Restart before and after batch publication, renderer change | The recorded generation reopens exactly or is explicitly replaced |
| User correction intake | Active investigation, wrong actor or bindings, stale revision, resolved request, terminal Work, command replay, restart after answer commit | The authorized correction survives in the same Execution without amending terms, invalid new answers are rejected, and replay preserves one Record |
| Corrections and privacy | Correction during summary generation, withdrawal, expiry, historical snapshot access after redaction or erasure | A stale result cannot reintroduce superseded or forbidden content |
| Cross-store publication | Crash before and after source, reference, node, and receipt commits | Reconciliation preserves one identity without inventing an atomic transaction |
| Replay | Lost submission response, changed input with the same ID, effect before result commit | Deduplication checks original input and uncertain effects are reconciled before retry |
| Usage | Partial provider response, uncommitted response, nested usage, failed or stale summary | Known usage is charged once and unknown spend keeps its reservation |
| Capacity | Total concurrency one, foreground waiting on a summary, exhausted allowance | No deadlock or unreserved model dispatch occurs |
| Cancellation | Background summaries, queued writes, non-cooperative code, competing writer | Cancelled Work cannot resume through pending memory work and ownership is not released prematurely |
| Retrieval cost | Many records, large permitted payloads, stale search projection | Reads and retained process memory stay bounded without loading the complete history |

Compare minimal-budget merge ordering against the reference push algorithm across long append sequences.
Test larger view budgets separately for coverage, sibling alignment, and stable merge priority.
Measure pair age from its last ordinal and exercise oldest-first tie breaking.
These tests validate ordering and coverage, not cache savings or recall.

An erasure test must verify the declared physical disposition, including derived indexes and the approved backup policy.
Hiding a source, retiring a view, or resetting context is not a passing erasure test.
If the selected storage cannot meet that requirement through public interfaces, keep real-source capture blocked.

## Held-out evaluation

Evaluate a versioned set of at least 30 independent task cases with a separate development set for tuning.
Cases must test the actual coding and evidence outcomes, not preferences for longer or more confident answers.
Use new held-out cases to validate fixes rather than tuning on exposed failures.
Small exploratory runs cannot establish release readiness.

### Comparisons

| Arm | Context policy |
| --- | --- |
| A. Deterministic evidence baseline | Complete sources, deterministic search and evidence preparation, with native compaction |
| B. Cache-stable layout | A with stable context ordering and rendering |
| C. Hierarchical summaries | B with hierarchical context selection replacing native compaction |

Run all three arms on the same durable harness.
Keep models, tools, task allowances, datasets, sampling, and grading fixed for each paired comparison except for the named policy change.
A and B use identical, recorded native-compaction settings, including summarizer model, prompt, thresholds, and usage attribution.
C owns bounded handling of long tool rounds and overflow rather than running two policies against the same active context.
All arms receive the same eligible evidence, so hierarchy is not credited merely for receiving sources its baseline never got.

Evaluate runtime recovery separately on uninterrupted and forced-restart cases with identical prepared requests and compaction disabled.
When comparing runtime adapters, hold evidence preparation, tools, allowances, and request content fixed.
Keep those runtime-only fixtures within the model window so compactor differences cannot explain the result.

Include cases covering:

- Old rare facts, exact paths and errors, topic interleaving, and related facts scattered across time.
- Corrected assumptions, failed approaches, unresolved questions, and uncertain observations.
- Stale heads, conflicting sources, amended Missions, and applicable versus withdrawn guidance.
- Work and Execution access restrictions, malicious evidence, and unavailable or redacted sources.
- Interrupted builds, duplicate delivery attempts, exhausted reservations, and concurrency one.
- Warm, cold, and expired provider caches, long pauses, long tool rounds, and configured model changes.

Cross-Work cases must reject access without explicit sharing approval.
Guidance cases verify approved version pinning, new-Mission selection, and withdrawal semantics.

### Measurements and grading

Record model and provider IDs, runtime and prompt versions, retrieval and renderer versions, tool schemas, sampling, data version, sample size, and confidence intervals.
Report task success, critical errors, unsupported claims, and required-schema or format failures.
Also report exact-source retrieval success, repeated failed investigations, stale-evidence misuse, and unauthorized disclosure.
Measure p50/p95 end-to-end latency, retrieval round trips, process-tree memory, storage growth, and cost per successful task.
Include failed, retried, stale, and cancelled summary work in cost whenever usage is known, and report uncertain spend separately.

Use deterministic checks for exact outcomes and evidence correspondence where possible.
Any human judging must be blinded, rubric-based, and independently double-scored, with disagreements adjudicated.
Do not use the Conclave, summarizer, or external design reviewer as a self-grading release authority.
Preserve reproducible redacted failure cases without publishing raw private transcripts.

### Release decision

Require at least 95% held-out task success, zero critical errors, unsupported claims, and required-schema failures, and no quality regression greater than one percentage point against the same-harness baseline.
Critical errors include unauthorized disclosure, unsafe actions, fabricated evidence, and ignored explicit instructions.
Report uncertainty around the observed rates rather than treating 30 cases as proof of population-level reliability.
A cost reduction does not compensate for a failed quality or safety gate.
A passing design review, compilation, or deterministic fixture is not evidence that the LLM policy passes this gate.

## Validation reporting

Each slice reports changed behavior, exact commands, environments exercised, results, and unresolved requirements.
Follow [Development](development.md) for focused checks and repository validation rather than introducing another test runner.
Run an independent review after a significant slice and verify its findings locally before accepting them.
Keep design-review results separate from implementation tests and held-out model evaluation.
Record evidence for each acceptance criterion without treating documentation or design review as release validation.
