# Plan 001: Upgrade vulnerable runtime dependencies

> **Executor instructions**: Follow this plan step by step. Do not use `npm audit fix` without reviewing the resulting manifest and lockfile diff.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- package.json package-lock.json` — expected: no output. If either file changed, compare the current dependency graph before proceeding.

## Status

- **Implementation status**: DONE
- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security | migration
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The runtime tree currently contains `brace-expansion@5.0.7`, reported by `npm audit --omit=dev --audit-level=high` as a high-severity denial-of-service vulnerability. It is pulled through `@earendil-works/pi-coding-agent@0.80.10` and `minimatch`. The direct Pi dependency is declared as a range even though repository instructions require exact direct dependency versions.

## Current state

- `package.json:47-51` declares `@earendil-works/pi-coding-agent` as `^0.80.0`, `@earendil-works/pi-tui` as `0.80.10`, `nanoid` as `6.0.0`, and `typebox` as `1.1.38`.
- `npm ls brace-expansion protobufjs --all` currently resolves `brace-expansion@5.0.6` under `@earendil-works/pi-coding-agent@0.80.10` and `protobufjs@7.6.4` under `@google/genai`.
- `AGENTS.md` requires direct external dependencies to be pinned to exact versions and requires `npm install --ignore-scripts` for hydration.

Do not copy audit URLs or any environment values into source files. Update dependencies rather than downgrading them.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Inspect advisories | `npm audit --omit=dev --json` | JSON identifies the current vulnerable chain and available fix metadata |
| Inspect releases | `npm view @earendil-works/pi-coding-agent versions --json` | Available releases are printed |
| Refresh dependencies | `npm install --ignore-scripts --save-exact @earendil-works/pi-coding-agent@<verified-fixed-version>` | exit 0; package and lockfile update |
| Check | `npm run check` | exit 0 |
| Audit | `npm audit --omit=dev --audit-level=high` | exit 0 with no high/critical runtime advisories |

## Scope

**In scope**:
- `package.json`
- `package-lock.json`
- Any source compatibility edits required by the verified patched Pi release

**Out of scope**:
- Unrelated TypeScript, Biome, or major-version migrations
- Suppressing the advisory with an unexplained override
- Downgrading any dependency

## Steps

### Step 1: Identify a patched compatible release

Inspect the audit JSON and the Pi package release metadata. Select the earliest release that removes the high advisory while remaining compatible with the APIs used by `src/` and `extensions/`. Check the installed package type declarations before changing code.

**Verify**: `npm audit --omit=dev --json` and `npm ls brace-expansion --all` show the selected dependency path and its version.

### Step 2: Pin and refresh the dependency

Change the Pi coding-agent dependency to the selected exact version. Refresh with `npm install --ignore-scripts`; do not run lifecycle scripts. Review the manifest and lockfile diff for unrelated upgrades. The compatible Pi 0.82.1 release still requests the vulnerable `brace-expansion` range, so the manifest carries a narrow exact `5.0.8` override for that transitive path rather than downgrading Pi or applying a broad audit override.

**Verify**: `git diff -- package.json package-lock.json` contains only the intended dependency and transitive updates, and `npm ls @earendil-works/pi-coding-agent brace-expansion --all` resolves the selected versions.

### Step 3: Resolve API drift if present

If TypeScript or Biome reports an API change, make only the compatibility edits required by the selected release. Preserve the existing Pi extension registration and role authority behavior.

**Verify**: `npm run check` exits 0.

### Step 4: Confirm the security result

Run the runtime audit and inspect the final tree. Moderate advisories may remain only if they are not reachable through the fixed path and are documented in the handoff.

**Verify**: `npm audit --omit=dev --audit-level=high` exits 0.

## Test plan

- Run the existing package test after the dependency update: `npm test`.
- Confirm the extension still registers by relying on the existing `/khala` and role-tool integration coverage in `test/khala.test.js`.

## Done criteria

- [x] Direct Pi dependency is exact-pinned.
- [x] No high/critical runtime audit advisory remains.
- [x] `npm run check` exits 0.
- [x] `npm test` exits 0.
- [x] Only dependency files and required compatibility files changed.
- [x] `plans/README.md` status row is updated.

## STOP conditions

- Stop if no patched compatible release is available.
- Stop if fixing the advisory requires a forced downgrade or an unreviewed broad override.
- Stop if the selected release changes the public Pi extension contract beyond a small compatibility edit.

## Maintenance notes

Re-run the runtime audit whenever the Pi package or lockfile changes. Keep direct dependencies exact-pinned and review transitive dependency changes as code.
