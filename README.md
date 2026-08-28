<div>

<img src="assets/khala-sigil.svg" alt="forge" align="left" width="192px" height="192px"/>
<img align="left" width="0" height="192px" hspace="10"/>

### khala
> Govern coding work with a Conclave, execute it in isolated sandboxes, and keep the evidence.
>
> [![Managed by humans](https://img.shields.io/badge/managed%20by-humans-1f6feb)](https://github.com/pesap/khala)
> [![CI](https://github.com/pesap/khala/actions/workflows/ci.yaml/badge.svg)](https://github.com/pesap/khala/actions/workflows/ci.yaml)
> [![Release](https://img.shields.io/github/v/release/pesap/khala)](https://github.com/pesap/khala/releases)
> [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE-MIT.txt)
> [![Latest commit](https://img.shields.io/github/last-commit/pesap/khala?style=flat-square)](https://github.com/pesap/khala/commits)
<br/>
<br/>
<br/>

<p align="center">
  <a href="#khala">Why Khala</a> ·
  <a href="#core-boundaries">Features</a> ·
  <a href="src/index.ts">Pi Tools</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#explore-the-repository">Documentation</a> ·
  <a href="docs/development.md">Development</a>
</p>


khala is a Pi-native governance extension for isolated coding work.
It keeps the
User conversation quiet while a Conclave admits Work, schedules a bounded
Executor in a Git worktree, records evidence, and waits for a
provider-confirmed review outcome.

The [Archive](docs/data-model.md) is authoritative.
Runtime state, Git,
providers, model output, and TUI views are evidence or projections only.

> [!IMPORTANT]
> Review-request workflows require Node.js 22.19 or newer, Pi, Git, and an
authenticated `gh` or `glab` session.

## Quick start

From a checkout:

```sh
npm install
npm run check
pi -e ./src/index.ts
```

In Pi:

1. Open `/khala` and configure Conclave, Executor, Observer, and Oracle models
   in Role settings.
2. Submit complete intent with `khala_submit_work`.
3. Reopen `/khala` to inspect Work through Actions, Evidence, Peer-Review,
   and Archive.

See [Getting started](docs/getting-started.md) for the complete first-Work
workflow and verification steps.

## How a Work reaches completion

```mermaid
flowchart LR
    U[User submits Work] --> C[Conclave admits Mission]
    C --> E[Executor works in Git worktree]
    E --> R[Draft PR or MR and ready Signal]
    R --> V[User reviews provider request]
    V --> M[Provider merge evidence]
    M --> O[Conclave records Outcome]
    O --> S[Succeeded Work]
```

A `ready` Signal, review handoff, provider approval, or provider merge is not
acceptance.
Only an explicit Conclave Outcome backed by verified merge evidence
succeeds Work.
See the [lifecycle reference](docs/lifecycle.md).

## Explore the repository

| Goal | Start here |
| --- | --- |
| Complete a first Work | [Getting started](docs/getting-started.md) |
| Understand states and recovery | [Lifecycle](docs/lifecycle.md) |
| Understand provider polling and effects | [Supervision tools](docs/supervision-tools.md) |
| Inspect records and runtime bindings | [Data model](docs/data-model.md) |
| Navigate the TUI | [TUI navigation](docs/tui-navigation.md) |
| Understand the design and limits | [MVP design](docs/mvp-design.md) and [glossary](docs/glossary.md) |
| Configure and recover Work | [Operations](docs/operations.md) |
| Develop or validate changes | [Development](docs/development.md) |
| Tune role behavior | [Role prompts](docs/role-prompts.md) |
| Extend Pi integration | [Pi extensions](docs/pi-extensions.md) |

<details>
<summary>Source map</summary>

- [`src/model.ts`](src/model.ts) — domain contracts and state discriminants.
- [`src/archive.ts`](src/archive.ts) — SQLite WAL Archive, projections,
  cursors, idempotency, and transactional outbox.
- [`src/service.ts`](src/service.ts) — lifecycle decisions, actor
  authorization, scheduling, effects, and supervision.
- [`src/runtime.ts`](src/runtime.ts) — isolated Pi JSON-RPC child sessions,
  bounded timeouts, process ownership, and transcript permissions.
- [`src/adapters.ts`](src/adapters.ts) — Git worktrees and GitHub/GitLab
  provider adapters.
- [`src/tui.ts`](src/tui.ts) — on-demand Work-first terminal interface.
- [`src/index.ts`](src/index.ts) — Pi tools, commands, role boundaries, and
  runtime wiring.
- [`system-prompts/`](system-prompts/) — role instructions for Conclave,
  Executor, Observer, and Oracle.
- [`skills/`](skills/) — tool-usage guidance packaged with Khala.

</details>

## Core boundaries

- The User submits intent and makes explicit review, rename, budget, failure,
  cancellation, and eligible recovery decisions.
- The Conclave admits Missions, schedules Executions, issues Verdicts, handles
  bounded provider feedback, and records Outcomes.
- The Executor changes only its immutable Mission in its isolated sandbox and
  reports evidence-bearing Signals.
- The Observer is read-only and records at most one bounded assessment when
  repository context is missing.
- The Oracle is advisory and has no tools.
- Provider polling and runtime monitoring record evidence; they do not merge or
  accept Work automatically.

## Bundled extensions

- [`pi-review`](extensions/pi-review/review.ts) provides `/review` and
  `/end-review` for reviewing uncommitted changes, branches, commits, pull
  requests, and snapshots.
- [`pi-clarify`](extensions/pi-clarify/clarify.ts) provides `/clarify` and the
  `-clarify` marker.
  It places a rewritten prompt in the editor for User review;
  it does not send the prompt.
