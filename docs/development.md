# Development

Use this page for local development, checks, and benchmark workflows. The README
keeps only the shortest setup path.

## Setup

```bash
npm install
```

Run the main checks:

```bash
npm run smoke
```

Run the Pi integration smoke:

```bash
npm run test:pi
```

Use the current checkout while developing:

```bash
pi --no-extensions -e ./extensions/index.ts -p "/khala-health"
```

If a global URL install is also enabled, remove it to avoid duplicate extension
registration:

```bash
pi remove https://github.com/pesap/khala.git
```

## NPM Scripts

| Script | Purpose |
| --- | --- |
| `npm run smoke` | Run lint, Markdown/YAML/shell/spell checks, typecheck, tests, and benchmark CI |
| `npm run test` | Run typecheck and Node tests |
| `npm run test:node` | Run TypeScript test files with Node's test runner |
| `npm run test:pi` | Run the Pi integration smoke script |
| `npm run benchmark:harness` | Score the harness sandbox |
| `npm run benchmark:harness:ci` | Run the blocking-regression harness gate |
| `npm run benchmark:pi-drift` | Run live Pi drift loops |
| `npm run lint:md` | Lint README and docs Markdown |
| `npm run lint:spell` | Spell-check README, docs, and CI workflow text |

## Harness Benchmarks

Score saved candidate transcripts against the Khala harness and package
instructions:

```bash
npm run benchmark:harness
```

For deterministic harness automation, preflight suites before scoring and write
stable report files:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts \
  --preflight \
  benchmarks/harness-sandbox.json
```

See [harness-benchmark-sandbox.md](harness-benchmark-sandbox.md) for the
benchmark suite format, live Pi drift loops, resume behavior, and divergence
scoring.

## Source Map

| Path | Purpose |
| --- | --- |
| `extensions/` | Pi extension implementation |
| `commands/` | Slash-command workflow prompts |
| `workflows/` | Workflow specs queued into Pi messages |
| `runtime/` | Packaged defaults and runtime instructions |
| `skills/` | Packaged reusable skills |
| `khala/` | Harness and benchmark internals |
| `tests/` | Node test suites |
| `scripts/` | Test helpers, benchmark runners, and multiplexer handoff scripts |
