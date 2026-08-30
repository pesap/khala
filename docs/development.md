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

`npm run check` runs Oxlint, Biome, and TypeScript validation.
`npm run check:markdown` checks paragraph sentence boundaries and bullet length.
`npm run test` builds `dist` and runs every Node test in `test/`.
Tests use local port adapters and do not require provider credentials.
`npm pack --dry-run` verifies the package contents without publishing.

For a focused test run after building:

```sh
npx tsc
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

Start with [Architecture](architecture.md), then read the relevant source and
behavioral tests together.
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
