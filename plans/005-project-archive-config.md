# Plan 005: Honor trusted project archive configuration

> **Executor instructions**: Make the documented trusted-project configuration behavior real without allowing an untrusted project to redirect the Archive. Resolve trust explicitly; do not silently treat every `projectPath` as trusted.
>
> **Drift check (run first)**: `git diff --stat ca24cbe..HEAD -- src/khala-config.ts src/khala-conclave-directory.ts src/khala-archive.ts src/khala-conclave-storage-file.ts src/index.ts src/khala-executor.ts test/khala.test.js README.md` — expected: no output.

## Status

- **Priority**: P1
- **Effort**: M/L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug | config
- **Planned at**: commit `ca24cbe`, 2026-07-23

## Why this matters

The README promises that a trusted project can override individual Khala settings in `.pi/khala.json`, and `loadKhalaConfig` has a `projectTrusted` parameter. Archive path resolution ignores both: `getConclaveDirectory` always loads global configuration. This makes `archiveRoot` project overrides misleading and can cause operators to inspect or back up the wrong location.

## Current state

- `src/khala-config.ts:44-48` applies project configuration only when `projectTrusted` is true.
- `src/khala-conclave-directory.ts:5-7` hashes the project path but resolves the root from `loadKhalaConfig()` with no project path or trust signal.
- `src/khala-archive.ts:7-26` routes all Archive reads/writes through that directory helper.
- `src/khala-executor.ts:30-49` already receives `context.isProjectTrusted()` and uses it for launch configuration.
- `README.md:143-159` documents project overrides and trusted configuration.

The Archive is authoritative and project-scoped. The implementation must preserve that vocabulary and must not use a user-controlled project config to redirect storage unless Pi has declared the project trusted.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Check | `npm run check` | exit 0 |
| Test | `npm test` | all tests pass |
| Search | `rg -n 'getConclaveDirectory|getArchivePath|loadKhalaConfig' src test` | every caller has an explicit configuration policy |

## Scope

**In scope**:
- `src/khala-config.ts`
- `src/khala-conclave-directory.ts`
- `src/khala-archive.ts`
- Archive-backed callers that must pass effective configuration
- `src/index.ts`, `src/khala-executor.ts`, and relevant tests
- `README.md` only if the final trust contract needs clarification

**Out of scope**:
- Changing the project hash or Archive JSONL format
- Trusting project configuration in non-Pi library callers without an explicit option
- Changing worktree or launcher configuration semantics

## Steps

### Step 1: Decide and document the trust boundary in code

Trace every Archive call from Pi `ExtensionContext` and from standalone/test APIs. Choose one explicit design: either pass a resolved `archiveRoot`/effective config through the Archive dependency boundary, or add an explicit trusted configuration argument to Archive operations. The default standalone API must remain global-only unless the caller opts into project trust.

Add a short comment explaining why trust is explicit. Do not infer trust from path shape or existence of `.pi/khala.json`.

**Verify**: `rg -n 'loadKhalaConfig\(' src` shows no archive path silently applying project config without a trust decision; `npm run check` exits 0.

### Step 2: Implement effective archive-root resolution

Make `getConclaveDirectory` and `getArchivePath` use the selected effective archive root while continuing to hash the resolved project path. Thread the value through storage and tool boundaries where required. Preserve existing global behavior for tests and callers that do not provide trusted project context.

**Verify**: a unit/integration test with global and trusted project `archiveRoot` values writes to the expected distinct roots; an untrusted context uses the global root.

### Step 3: Update all Archive-backed flows

Update Conclave submission, Signal, Learning, Verdict, Counsel, execution registry, demo, and monitor paths so they use the same effective root for a given project operation. Avoid a mixture where reads use one root and writes another.

**Verify**: `npm test` passes, and a temporary-root test can read back a record through every affected flow.

### Step 4: Align documentation

If the API now requires explicit trust/config injection, update the Configuration section with the exact rule. If project `archiveRoot` must remain global-only for security, instead document that exception and remove the promise that individual project overrides include it; do not leave ambiguity.

**Verify**: `npm run check` and `git diff --check` exit 0.

## Test plan

Cover global config; trusted project override; untrusted project config ignored; read-after-write consistency; and existing `PI_CODING_AGENT_DIR` temporary-root behavior. Model tests after the configured Archive test in `test/khala.test.js:198-240`.

## Done criteria

- [ ] Trust policy is explicit at every archive-root decision.
- [ ] Trusted project overrides behave as documented, or the documented exception is explicit.
- [ ] All Archive readers and writers agree on the effective root.
- [ ] Project hashing remains unchanged.
- [ ] `npm run check` and `npm test` exit 0.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

- Stop if Pi cannot provide a trustworthy project-trust value at a required Archive boundary.
- Stop if preserving public standalone APIs requires silently trusting project files.
- Stop if changing the root would make existing archives unreachable without an explicit migration plan; report migration scope instead.

## Maintenance notes

Any new Archive-backed feature must receive the effective archive configuration from the same trusted boundary. Review project configuration changes for path redirection and data-loss implications.
