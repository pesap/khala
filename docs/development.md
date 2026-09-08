# Development

## Try uncommitted changes

To test the current checkout without installing it into Pi, run:

```sh
npm ci --ignore-scripts
pi -e .
```

`pi -e .` loads the local package for the current Pi run only.

## Local validation

Install dependencies and run the local validation and packaging checks:

```sh
npm ci --ignore-scripts
npm run check
npm run test
npm run check:markdown
npm pack --dry-run
```

`npm run check` runs Oxlint, Biome, and TypeScript validation for the application, extensions, and custom lint tooling.
Oxlint limits checked JavaScript and TypeScript files to 700 lines, including comments and blank lines.
`tsconfig.tools.json` inherits the application’s strict compiler checks for `tools/**/*.ts`.
`npm run check:markdown` checks paragraph sentence boundaries and bullet length.
`npm run test` builds `dist` and runs every Node test in `test/`.
`scripts/copy-runtime-assets.mjs` copies package metadata, role prompts, and the demo fixture beside compiled entry points.
Tests use local port adapters and do not require provider credentials.
`test/native-role-workflow.test.js` runs real Pi child processes against a deterministic localhost model endpoint.
It exercises the registered Archive and action tools, signed Conclave authority, durable input requests, and supervisor restart without paid model calls.
`test/native-execution-workflow.test.js` exercises a real Executor edit, Git commit, isolated validation, review publication, supervisor restart, and successful outcome recording.
`test/native-tui-workflow.test.js` drives Pi in `tmux`, submits Work through the registered tool, opens the Work list, restarts Pi, runs `/khala-recover`, and verifies success in History after merge polling.
`test/native-crash-recovery.test.js` kills Pi during an Executor request, reconciles held usage through native selection, editor, and confirmation dialogs, then recovers the same Execution through review publication.
`test/native-cancellation.test.js` declines and confirms cancellation in Pi, verifies that the held model request stops, and checks that project recovery leaves Work cancelled.
`test/native-conclave-cancellation.test.js` cancels a pending Conclave before admission, reconciles its uncertain usage through Pi, and verifies that project recovery preserves cancellation.
`test/native-cancelled-recovery.test.js` selects Recover after cancellation, verifies that settled usage is retained, and follows a fresh Mission and Execution through review publication.
`test/native-failure.test.js` records an explicit failure through Pi's saved-draft editor, verifies that the waiting Executor stops, and checks that project recovery preserves the failure.
`test/native-input-amendment.test.js` supplies requested scope through the native saved-draft editor and verifies that the same Work reaches review with the amended Mission terms.
`test/native-budget-amendment.test.js` exhausts a Conclave allowance, rejects a cap below recorded usage, and confirms a budget increase through Pi before the same Work reaches review.
`test/native-review-correction.test.js` records review feedback through Pi and verifies that the same Execution commits, validates, and publishes a corrected head to the existing review request.
`test/native-preparation-recovery.test.js` retries a missing-lockfile failure through Pi, verifies that unsuccessful recovery remains visibly failed, and follows the same Mission to review after its target branch is repaired.
`test/native-cancelled-preparation-recovery.test.js` cancels failed preparation through Pi and recovers through fresh admission after the target branch is repaired.
`test/native-runtime-recovery.test.js` refreshes lost and reachable idle Executors in Pi, then uses Recover to continue the same Execution and persistent session through review publication.
`test/native-provider-closure.test.js` polls a closed review through Pi and verifies explicit failure, preserved closure evidence, and the failure reason in History.
`test/native-provider-feedback.test.js` follows provider feedback through Conclave authorization, correction by the same Executor, and publication of the corrected head before a second handoff.
`test/native-resumed-cancellation.test.js` cancels a held, authorized provider-feedback turn in Pi and verifies stopped runtime activity, settled usage, and cancellation preserved by project recovery.
`test/native-oracle-review.test.js` runs a native Oracle advisory before the Conclave explicitly hands off the same Execution, verifying recorded evidence and settled usage.
These tests use temporary model settings, Archive storage, local Git transport, and a deterministic code-host API fixture.
They require `tmux` and the validation isolation runtime, and make no paid model or external code-host calls.
`npm pack --dry-run` verifies the package contents without publishing.

For a focused test run after building:

```sh
npx tsc
node scripts/copy-runtime-assets.mjs
node --test test/mvp.test.js
```

The GitHub Actions workflow runs linting, the build-backed test suite, and
`npm pack --dry-run`: [CI workflow](../.github/workflows/ci.yaml).

## Repository layout

- `src/` — application implementation.
- `extensions/` — bundled Pi extensions.
- `system-prompts/` — role prompts loaded by child sessions.
- `skills/` — the packaged Khala tool-usage skill.
- `templates/` — repository templates used by the extension.
- `test/` — behavioral tests for the service, runtime, adapters, commands, and
  TUI.
- `docs/` — lifecycle, data model, supervision, design, operations, and
  navigation references.

The extension entry point registers Pi tools, commands, and lifecycle handlers.
The application service composes separate execution, recovery, decision, workspace-action, and effect-pump modules around shared invocation and runtime coordinators.
`extension-role.ts` enforces role capabilities and workspace access; `extension-results.ts` formats tool output and errors.
The runtime separates session orchestration, launch, persistent leases, process ownership, and RPC protocol handling into `runtime*.ts` modules.
`adapters.ts` exposes the workspace and code-host APIs; their implementations separate Git operations, validation isolation, provider response parsing, and review templates.
`archive.ts` exposes the Archive contracts and SQLite implementation, with storage initialization, record validation, and paginated queries in separate modules.
The MVP tests are grouped by admission, recovery, provider workflow, governance, and adapters; TUI tests separate navigation, evidence, and recovery behavior.

Start with [Foundations](foundations.md) and the [MVP reading map](mvp-design.md#reading-map-and-ownership), then read the owning contract, relevant source, and behavioral tests together.
Keep target requirements distinct from current implementation references and verify a requirement before describing it as implemented.
Update the rule in its authoritative document and link to it elsewhere instead of maintaining duplicate contracts.
Use [Operations](operations.md) for configuration, limits, and recovery.
Keep tests focused on observable behavior rather
than private implementation details.

## Packaging

The package exposes `src/index.ts` as its Pi extension entry point and includes
extensions, prompts, system prompts, templates, themes, assets, and packaged
skill.
Validate the package file list without publishing it:

```sh
npm pack --dry-run
```

Do not include credentials, raw child transcripts, or local SQLite archives in
changes or package artifacts.
