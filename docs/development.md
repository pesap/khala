# Development

## Local validation

Install dependencies and run the same primary checks used by CI:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Oxlint, Biome, and TypeScript validation. `npm test` builds
`dist` and runs every Node test in `test/`. Tests use local port adapters and do
not require provider credentials.

For a focused test run after building:

```sh
npx tsc
node --test test/mvp.test.js
```

The GitHub Actions workflow runs these checks and validates the package with
`npm pack --dry-run`: [CI workflow](../.github/workflows/ci.yaml).

## Repository layout

- `src/` — application implementation.
- `extensions/` — bundled Pi extensions.
- `system-prompts/` — role prompts loaded by child sessions.
- `skills/` — the packaged Khala tool-usage skill.
- `templates/` — repository templates used by the extension.
- `test/` — behavioral tests for the service, runtime, adapters, commands, and
  TUI.
- `docs/` — lifecycle, data model, supervision, design, and navigation
  references.

Start with [Architecture](architecture.md), then read the relevant source and
behavioral tests together. Keep tests focused on observable behavior rather
than private implementation details.

## Packaging

The package exposes `src/index.ts` as its Pi extension entry point and includes
extensions, prompts, system prompts, templates, themes, assets, and packaged
skill. Validate the package file list without publishing it:

```sh
npm pack --dry-run
```

Do not include credentials, raw child transcripts, or local SQLite archives in
changes or package artifacts.
