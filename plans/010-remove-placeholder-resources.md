# Plan 010: Remove placeholder packaged resources

> **Executor instructions**: Remove only resources confirmed to be scaffolding and not part of an intentional public example surface. Do not delete a user-facing Khala capability without checking package registration and documentation.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- package.json README.md skills prompts extensions/README.md extensions/pi-review/README.md` — expected: no output.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW/MED
- **Depends on**: none
- **Category**: docs | dx
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The npm manifest publishes every file in `skills/` and `prompts/`, but several resources are generic setup scaffolding rather than Khala functionality. Their placeholder names and unrelated instructions increase the public package surface and can mislead Pi users about supported workflows.

## Current state

- `package.json:18-22` registers `./skills` and `./prompts` as package resources.
- `skills/skill-1.md` and `skills/skill-2.md` are generic code-analysis/documentation stubs.
- `prompts/prompt-1.md` and `prompts/prompt-2.md` are generic project-setup/code-review prompts.
- `prompts/fresh-eyes.md`, `prompts/khala-review.md`, `prompts/khala-signal.md`, and `prompts/khala-validate.md` are named Khala workflows and must not be removed as part of this cleanup.
- `extensions/pi-review/README.md:13-15` explicitly describes Khala review integration as future work; do not present it as implemented.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Resource references | `rg -n 'skill-1|skill-2|prompt-1|prompt-2' . --glob '!node_modules/**' --glob '!dist/**'` | no intentional runtime/documentation dependency remains |
| Package preview | `npm pack --dry-run` | output contains only intended resources; no archive is written |
| Check | `npm run check` | exit 0 |

## Scope

**In scope**:
- Placeholder files under `skills/` and `prompts/`
- `README.md`, `extensions/README.md`, or `package.json` only where package-surface documentation requires it

**Out of scope**:
- Named Khala prompts and system prompts
- The pi-review extension implementation
- Adding replacement functionality not requested by current docs

## Steps

### Step 1: Confirm public-surface intent

Search all tracked files and package metadata for references. If the placeholder files are intentionally shipped examples, stop and report that finding rather than deleting them. If they are scaffolding, record the exact files to remove.

**Verify**: the reference search distinguishes intentional Khala resources from placeholders.

### Step 2: Remove or rename only confirmed scaffolding

Delete confirmed placeholder files, or replace them with clearly named Khala resources only if an existing documented capability needs them. Do not leave generic names registered in the package.

**Verify**: `rg -n 'skill-1|skill-2|prompt-1|prompt-2' . --glob '!node_modules/**' --glob '!dist/**'` returns no matches.

### Step 3: Validate package contents and docs

Run the package dry run and update only documentation that lists the public resource surface. Confirm the named Khala prompts remain included.

**Verify**: `npm pack --dry-run` and `npm run check` exit 0.

## Test plan

No source behavior tests are required. Validate package contents, resource discovery paths, and README links. If Pi has a package-resource listing command available, use it read-only.

## Done criteria

- [ ] Placeholder resources are removed or intentionally renamed.
- [ ] No stale references remain.
- [ ] Named Khala prompts remain available.
- [ ] Package dry run contains the intended public surface.
- [ ] `npm run check` exits 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if a placeholder is referenced by an installed Pi workflow or package contract.
- Stop if removing it would change a documented user capability; report instead.

## Maintenance notes

New bundled resources must have a Khala-specific name, description, and README entry before being added to the package manifest.
