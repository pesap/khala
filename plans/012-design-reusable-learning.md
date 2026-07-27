# Plan 012: Design reusable Observer Learning

> **Executor instructions**: Produce a design/spike for safely reusing repository Learning across Work. Do not broaden Archive visibility or change current Observer behavior in this plan.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-learning.ts src/khala-observer.ts src/khala-model.ts src/khala-work-format.ts src/khala-conclave.ts system-prompts/observer.md system-prompts/conclave.md` — expected: no output.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/007-archive-projections.md
- **Category**: direction
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

Observers currently produce durable Learning tied to one Work, and `listLearningRecords` only returns records for that exact Work. The Conclave prompt says to inspect relevant learning, but the implementation cannot reuse a verified repository lesson for another Work. Reuse could reduce repeated read-only observation while introducing freshness, scope, and authorization risks.

## Current state

- `src/khala-model.ts:150-160` defines `LearningRecord` with required `workId`, `executionId`, evidence, and source paths.
- `src/khala-learning.ts:116-123` filters Learning by exact `workId`.
- `src/khala-work.ts:202-205` launches an Observer when context is empty and no Work-specific Learning exists.
- `src/khala-work-format.ts:12-29` injects Work-specific Learning into an Executor mission.
- `system-prompts/observer.md` requires read-only evidence-backed Learning; `system-prompts/conclave.md` says equivalent learning must not be duplicated.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Tests | `npm test` | existing suite passes if a prototype is added |
| Contract search | `rg -n 'Learning|learning|sourcePaths|workId' src docs system-prompts` | all current assumptions are listed |

## Scope

**In scope**:
- Design document under `docs/` or `plans/`
- Read-only analysis of Learning queries, source paths, and role prompts
- Optional pure relevance-ranking prototype

**Out of scope**:
- Changing `LearningRecord` schema or Archive readers in this plan
- Granting cross-Work Archive access to Executors
- Automatic deletion or mutation of historical Learning
- Launching or closing Observers differently

## Steps

### Step 1: Define scope and visibility

Compare Work-specific Learning with repository/project-scoped Learning. Specify who may read each scope and how source paths, project paths, and sensitive findings are filtered before reuse.

**Verify**: design states whether a lesson can cross Work boundaries and names the authorization check at each reader.

### Step 2: Define freshness and equivalence

Specify how source paths, Git revision, timestamps, or explicit supersession determine whether Learning remains valid. Define how the Conclave detects equivalent lessons without relying on fuzzy model judgment alone.

**Verify**: design includes stale, conflicting, and duplicate lesson cases with expected outcomes.

### Step 3: Define projection and mission behavior

Use Plan 007's projection contract to describe a typed query for reusable Learning. Specify whether reused Learning satisfies missing Work context, whether an Observer still needs to verify it, and what evidence is included in the Executor mission.

**Verify**: design preserves the rule that an Executor cannot infer authority from a Learning record.

### Step 4: Produce implementation slices

List the smallest safe implementation sequence: schema/backfill if required, query, Conclave decision logic, prompt wording, tests, and rollback. Do not implement until the Maintainer approves the policy.

**Verify**: design contains machine-testable acceptance criteria and an explicit go/no-go decision.

## Test plan

For any pure prototype, test exact Work isolation, eligible cross-Work reuse, stale source rejection, conflicting lessons, duplicate detection, and empty results. Otherwise validate the design against existing tests and run no source mutation.

## Done criteria

- [ ] Cross-Work visibility and authorization are explicit.
- [ ] Freshness, conflict, and equivalence rules are defined.
- [ ] Observer and Executor authority remains unchanged.
- [ ] Implementation slices and rollback are listed.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if safe cross-Work visibility cannot be established from current Archive metadata.
- Stop if relevance depends only on an unverified model claim.
- Stop if the spike requires changing durable schema without an approved decision.

## Maintenance notes

Keep repository vocabulary aligned with `CONTEXT.md` and preserve all historical Learning records. A future implementation should build on the typed projection layer rather than adding another direct JSONL scan.
