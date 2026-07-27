# Plan 009: Simplify and test the bundled review extension

> **Executor instructions**: Reduce duplicated review UI logic and establish focused regression coverage without changing `/review` or `/end-review` behavior.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- extensions/pi-review/review.ts biome.json package.json tsconfig.json test` — expected: no output.

## Status

- **Priority**: P2
- **Effort**: M/L
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt | tests | dx
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The bundled review extension is 1,803 lines and has high recent churn. The branch selector and commit selector duplicate almost the same fuzzy-filter, list construction, keyboard, and rendering code. Biome checks only `src/**/*.ts`, while TypeScript compiles the extension, and there are no dedicated review-extension tests. A small behavior change can therefore require duplicate edits with weak regression protection.

## Current state

- `extensions/pi-review/review.ts:965-1041` implements the branch fuzzy selector.
- `extensions/pi-review/review.ts:1064-1147` repeats the same selector implementation for commits.
- `extensions/pi-review/review.ts:1461-1549` registers `/review`; `:1619-1803` manages `/end-review` state and navigation in the same module.
- `biome.json:6-8` includes only `src/**/*.ts`.
- `package.json:42-45` checks with Biome and TypeScript and runs Node tests from `test/khala.test.js`.

Preserve existing Pi keybinding APIs and the role boundaries in `CONTEXT.md`; this is a structural refactor, not a review-policy change.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 and includes the extension in Biome coverage |
| Build | `npm run build` | exit 0 |
| Test | `npm test` | all tests pass |
| Search | `rg -n 'showBranchSelector|showCommitSelector|fuzzyFilter|session_tree' extensions/pi-review` | duplicated selector implementation is gone while behavior entry points remain |

## Scope

**In scope**:
- `extensions/pi-review/review.ts`
- New focused modules under `extensions/pi-review/` if needed
- `biome.json`
- `test/pi-review.test.js` or equivalent focused tests
- `tsconfig.json` only if required for testable extension module boundaries

**Out of scope**:
- Review rubric or output contract wording
- PR checkout policy
- Khala Work/Signal integration (Plan 011)
- Upstream fork synchronization

## Steps

### Step 1: Extract pure review-target helpers

Separate argument tokenization, PR reference parsing, folder path normalization, prompt construction, and target hinting from the Pi UI closure. Keep top-level imports only and preserve erasable TypeScript syntax. Export only helpers needed by tests or the extension.

**Verify**: `npm run check` exits 0; extracted helpers compile into `dist/extensions/pi-review`.

### Step 2: Extract the generic fuzzy selector

Create one selector helper/component parameterized by title, items, empty-state label, and selected-value mapping. It must preserve current filtering text, `tui.select.*` keybindings, cancel behavior, and selection ordering. Replace both branch and commit selector bodies with the shared helper.

**Verify**: `rg -n 'new SelectList|fuzzyFilter|Type to filter' extensions/pi-review` shows one shared implementation for the duplicated selector path; `npm run check` exits 0.

### Step 3: Add focused tests

Add Node tests for tokenization with quoted/escaped values, PR URL validation, repository-bound path resolution, target prompt construction, and selector-independent branch/commit mapping. Do not attempt to fake the whole Pi TUI unless a small existing test seam is available.

**Verify**: `npm test` passes all existing and new tests.

### Step 4: Put the extension under the same lint gate

Update Biome's include configuration so `extensions/pi-review/**/*.ts` is checked by `npm run check`. Fix only resulting actionable diagnostics; preserve intentional fork comments and use narrow Biome ignores when the API shape requires them.

**Verify**: `npm run check` reports both source and extension files and exits 0.

### Step 5: Review session lifecycle after extraction

Exercise `/review` and `/end-review` manually only if an interactive Pi environment is available. Confirm state restoration, PR checkout restoration, cancellation, and current-session mode are behaviorally unchanged.

**Verify**: `npm test` passes and `git diff --check` reports no whitespace errors.

## Test plan

Use pure helper tests for deterministic coverage. Keep existing integration tests unchanged unless a shared test helper is needed. Manually verify the interactive selector only when a controlled TUI is available; do not add network or GitHub credentials to tests.

## Done criteria

- [ ] Branch and commit selectors share one implementation.
- [ ] Review-target pure logic has focused tests.
- [ ] Biome checks the bundled extension.
- [ ] Review rubric, PR checkout, and session lifecycle behavior are unchanged.
- [ ] `npm run check`, `npm run build`, and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if extracting the selector changes Pi's keybinding or component lifecycle contract.
- Stop if the extension cannot be tested without importing private Pi internals; keep the split smaller and report the test boundary.
- Stop if the fork has drifted significantly from the excerpts; re-audit before refactoring.

## Maintenance notes

Keep review target resolution independent from TUI rendering so future review modes do not duplicate Git or selector logic. Review any future upstream fork sync for conflicts in extracted module boundaries.
