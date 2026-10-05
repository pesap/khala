# Tool contracts

Tool schemas exposed by the current Pi session are authoritative for argument shape.
Use the tools only in the session role that exposes them.
Application permissions, Work state, and revision checks remain authoritative even when a tool is visible.
The application service supplies idempotency metadata for tool calls.
Repeating a completed tool call returns its prior result when the same command identity is available, not a second lifecycle decision.

## Contents

- [Tool contracts by session role](#tool-contracts-by-session-role)
- [Action reference](#action-reference)
- [Trusted-skill catalog](#trusted-skill-catalog)

## Tool contracts by session role

### `khala_submit_work`

Record complete User intent without waiting for admission.
Required fields are `title`, `objective`, and `acceptanceCriteria`.
Optional fields include `workId`, `context`, `scope`, `constraints`, `validation`, `allowedPaths`, and `maxTokens`.
Submission persists immediately and schedules Conclave processing asynchronously.
It does not admit a Mission, start an Executor, create a review request, or accept the Work.

Call this only after the user explicitly requests a new Khala Work or an explicit resubmission.
If an explicit Work request lacks required terms, ask the user instead of inventing them.
`validation` contains literal shell commands executed in the sandbox, not instructions for the Executor to translate.
Use exact repository commands and explicit paths where needed, without Markdown backticks or prose prefixes.
Read the Work again before claiming that admission is pending, an Executor has started, or no code has changed.

### `khala_read_archive`

Read the current Work and Mission terms plus at most ten recent authorized decision-evidence records.
Filter by `workId`, `missionId`, `executionId`, `kinds`, `states`, or time range.
Selected payload fields include Signal diagnoses, validation failures, preparation diagnostics, and assessments.
Inspect explicit omissions before deciding.
Start a new query with only the known Work ID:

```json
{"workId":"example-work"}
```

Replace `example-work` with the actual Work ID.
Every other field is optional.
Add only filters whose values are known and relevant.
Mission and Execution IDs are exact matches, not wildcard patterns.
Omit unused `from` and `to` fields instead of supplying empty strings.
Use complete timestamp bounds only when the investigation needs a time range.

When the packet provides an `omissions[].continuation`, copy that token exactly into `cursor` and preserve the same filters.
If the token is omitted or truncated, report the gap or use a narrower new query without a cursor.
Never manufacture a cursor, change its sequence numbers, or reuse it for another Work or filter set.
A cursor parse or filter mismatch is an argument error, not a reason to repeat the same call or create a fake initial cursor.
Restart with the minimal query without a cursor.
An empty record list is evidence only for the selected filters, not proof that the Work has no history.

The packet includes the Work `revision` and record `asOfSequence`.
These are separate reads, not an atomic snapshot.
Invocation accounting can advance the revision without changing the lifecycle decision.
The decision packet is capped at 24 KB of UTF-8 JSON.
Child sessions receive only records allowed by their binding.

### `khala_poll_provider`

Poll the current GitHub Pull Request or GitLab Merge Request.
It requires `workId` and `expectedWorkRevision`.
It records changed provider observations and confirmed merge evidence, then schedules applicable Conclave effects.
It does not merge or accept Work.
The hosting User session also polls active review requests autonomously while that session remains open.

### `khala_inspect_runtime`

Inspect runtime liveness without changing Archive state.
It requires `workId` and `expectedWorkRevision`.
Read the Archive immediately before inspection and use its current Work revision.
On a conflict, reread rather than reusing an old revision.
It can refresh displayed runtime state without writing an Archive record.
`idle` can mean that an active Execution is between turns.
`unreachable` requires the authorized `recover` action by the owning User or bound Conclave.
`unknown` can mean that a live child belongs to another Pi session and is not proof of a dead Executor.

### `khala_perform_action`

Perform one actor-authorized, revision-checked application action.
It requires `action`, `workId`, and `expectedWorkRevision`.
Action-specific values go in `input`.
The action and action-choice fields use the finite values in the schema.
Use the action names in the table below, not prose or model output.

### `khala_record_signal`

Record an evidence-bearing Executor `progress`, `blocked`, or `ready` Signal.
Each call requires `workId`, `kind`, `summary`, `evidence`, and `expectedWorkRevision`.
A `ready` Signal is valid only after the current sandbox has a reconciled draft review request and current validation evidence.

### `khala_record_assessment`

Record one bounded, read-only repository assessment from an Observer session.
It requires `workId`, `summary`, `evidence`, and `expectedWorkRevision`.

### `khala_run_oracle`

Request a bounded advisory Oracle review from a Conclave session.
It requires `workId`, `subject`, and `expectedWorkRevision`.
The Oracle has no tools and receives only its bounded packet.
The request is queued so the calling Conclave can finish before the Oracle uses a run slot.
The result is evidence, not acceptance.
Wait for the result wake and reread the Archive rather than treating the queued request as a completed review.

## Action reference

The current session role and Work state determine which actions are accepted.

| Action | Typical caller | Input |
| --- | --- | --- |
| `admit` | Conclave | none |
| `request-input` | Conclave | `reason`, optional `missing` |
| `amend-terms` | User | one or more pre-admission term fields |
| `retry-admission` | User | none; changing the Conclave model may be needed for the retry to succeed |
| `amend-mission` | Conclave | changed terms, `reason`, optional `evidence` |
| `launch-observer` | Conclave | none |
| `record-assessment` | Observer | `summary`, `evidence` |
| `start-execution` | Conclave | none, plus optional skill-selection fields |
| `record-signal` | Executor | `kind`, `summary`, `evidence` |
| `commit-sandbox` | Executor | none |
| `run-validation` | Executor | none |
| `create-review-request` | Executor | none |
| `run-oracle` | Conclave | `subject` |
| `verdict` | Conclave | `decision`, `reason`, `signalId`, plus optional skill-selection fields for `replace` |
| `deliver-feedback` | Conclave | optional `observationId` |
| `repair-ci` | Conclave | `observationId`, `evidence` with one-based failed-check indexes |
| `record-review` | User | `status`, optional `feedback` |
| `record-outcome` | Conclave | none |
| `cancel` | User | none |
| `recover` | Owning User or bound Conclave | none |
| `rename-work` | User | `title` |
| `amend-budget` | User | `maxTokens` |
| `reconcile-invocation` | User | `runId`, cumulative `usage`, `evidence` |
| `fail-work` | User or Conclave | `reason` when required by the schema |

`verdict.decision` is one of `continue`, `replace`, `handoff`, or `reject`.
The optional `skillIds` accepts at most three IDs from the trusted-skill catalog.
`skillInstructions` is limited to 4,000 characters, and `skillSelectionReason` is limited to 500 characters.
These fields apply to `start-execution` and replacement Verdicts only.
Use `signalId: "budget-exhausted"` for a budget-exhausted Execution.
A `continue` decision is rejected when the Execution has exhausted its allowance.

`record-review.status` is one of `changes-requested`, `merged`, or `closed`.
Provider feedback is delivered by observation ID.
The role prompt supplies decision policy, but the application service remains authoritative.

Do not invent or paste a provider comment into a different Work.

## Trusted-skill catalog

`khala_list_trusted_skills` and `khala_read_trusted_skill` are Conclave-only tools.
They expose only the global `trustedSkills` allowlist of Pi skills under `PI_CODING_AGENT_DIR/skills`.
The list defaults to empty, and project skills are not discovered.
Read selected catalog entries before passing their IDs and bounded, task-specific guidance with `start-execution` or a replacement Verdict.
Skill guidance is advisory and cannot change Mission terms, authority, permissions, or allowed paths.
See [Operations](../../../docs/operations.md#configuration-and-state-locations) for the catalog boundary.

`repair-ci` is available to the Conclave action schema but remains opt-in through global or trusted project configuration `enableCiRepair`, which defaults to `false`.
It authorizes one bounded continuation of the same idle Execution for selected current CI failures, using evidence indexes from the matching observation.
It is not a default retry path or permission to broaden the repair scope.
The application service remains authoritative for eligibility.

`reconcile-invocation.usage` contains nonnegative whole-number `inputTokens`, `outputTokens`, `cacheHitTokens`, and `cacheMissTokens` from final usage evidence.
Incomplete runtime receipts require all four counts and a nonblank evidence reference.
Complete durable receipts supply exact usage, and supplied counts must match.
The owning supervisor must confirm that the old writer has stopped before an incomplete invocation can settle.
After settlement, the authorized `recover` action or `/khala-recover` restores an interrupted Executor without creating another Execution.
