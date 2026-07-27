<div align="center">

<img src="assets/khala-sigil.svg" alt="Khala sigil" width="150">

# Khala

### Govern coding work with a Conclave, execute it in isolated sandboxes, and keep the evidence.

[Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Documentation](#documentation) · [Contribute](#contribute)

[![License](https://img.shields.io/badge/license-MIT-8abeb7?style=flat-square)]
[![Latest commit](https://img.shields.io/github/last-commit/pesap/scratch?style=flat-square)](https://github.com/pesap/scratch/commits/main)

<!-- Add assets/khala-hero.png generated from docs/art-prompts.md here. -->

</div>

---

## Introduction

Khala is a [Pi coding-agent](https://github.com/earendil-works/pi) extension for
coordinating serious repository work across specialized agent roles.

A user describes Work. A project-scoped Conclave validates it and decides
whether it is ready to execute. An isolated Executor performs the mission in
a Git worktree and reports evidence-bearing Signals. The Conclave reviews the
evidence and records a Verdict. When context is missing, a read-only Observer
gathers it first. Every durable transition is written to an append-only Archive.

> The principle: agents may act, but only evidence changes the record.

Khala is intentionally narrow. It does not replace your VCS, terminal
multiplexer, model provider, or project database. It composes those boundaries
and makes the lifecycle visible and recoverable.

## Why Khala

- Bounded roles. User Sessions, the Conclave, Observers, and Executors have
  different authority and different tools.
- Isolated execution. Executors work in Git worktrees instead of the caller's
  checkout.
- Evidence before judgment. Signals carry summaries and concrete evidence;
  Verdicts must reference a Signal from the same execution.
- Durable coordination. The project Archive survives sessions, panes, and
  launcher failures.
- Recoverable lifecycle. Failed launches can return to the queue, and Retry
  creates a successor execution rather than rewriting history.
- Observable by default. The Khala monitor shows the Conclave, Executors,
  Observers, states, signals, sandboxes, and live launcher targets.

## How it works

```text
User Session
     │
     │  submit Work
     ▼
Project Archive ───────────────┐
     │                         │
     ▼                         │
  Conclave                     │ reads authoritative history
     │                         │
     ├── missing context ──► Observer ──► Learning ───┐
     │                                                │
     └── validated Work ───► Executor ──► Signal ─────┘
                                                   │
                                                   ▼
                                             Verdict
                                      continue · retry · finish · reject
```

The Archive is append-only. Current state is a projection of the latest record
for an entity; the complete history remains available for review and recovery.

## Features

- `/khala-work` loads the structured Work template.
- `/khala-triage` (also `/triage`) turns an issue into a WorkPacket, resolves uncertainty interactively, and sends approved Work to the Project Conclave.
- A dedicated, persisted project Conclave reviews and admits submitted Work under Mandate revision one.
- `/khala-demo` launches a three-lane lifecycle demonstration.
- `/khala` or `Ctrl+I` opens the session monitor.
- The bundled `pi-review` extension adds `/review` and `/end-review` for scoped code reviews.
- `khala_signal` records Executor progress, blocked, and finished evidence.
- `khala_verdict` records Conclave decisions; Retry materializes a successor Mission.
- Observers record repository Learning before an Executor starts when context is
  incomplete.
- Preservers can add source-backed Counsel without changing execution state.
- Zellij and tmux launchers are supported.
- Git worktrees provide Executor isolation.
- The Archive is stored as inspectable JSONL rather than hidden in a service.

## Install

Khala requires Node.js 22.19.0 or newer.

### From GitHub

```sh
pi install github:pesap/scratch
```

Run `npx --yes github:pesap/scratch` once to configure the launcher, worktree,
Pi commands, and Archive paths. The wizard writes global settings to
`~/.pi/agent/khala.json`; use `npx --yes github:pesap/scratch --project` for a
project override. Use `npx --yes github:pesap/scratch --dry-run` to preview the
resulting configuration.

### From a checkout

```sh
git clone https://github.com/pesap/scratch.git
cd scratch
npm install
npm run build
pi -e .
```

Khala is a Pi package. The package manifest registers the extension, prompts,
and theme resources.

## Quick start

1. Install Khala and open a project in Pi.
2. Run `/khala-triage <github-issue>` or `/khala-work`.
3. For triage, answer blocking questions and confirm the generated WorkPacket. Use
   `/khala-triage --approve <github-issue>` for independent submission.
4. For a manual Work, fill in the template. `Objective`, `Scope`, `Acceptance criteria`,
   `Plan`, and `Validation` are required.
5. The Work is sent to the Project Conclave for admission and launch.
6. Open `/khala` to watch the Conclave and the isolated Executor.
7. Inspect the Archive when you need the authoritative lifecycle history.

For a deterministic walkthrough, run `/khala-demo`. It creates three dummy Work
lanes: direct success, retry then success, and retry then rejection. The demo
does not modify application source.

## Roles

| Role          | Authority                                   | Responsibility                                             |
| ------------- | ------------------------------------------- | ---------------------------------------------------------- |
| User Session  | Submit Work and observe                     | Defines intent and chooses when to request coordination.   |
| Conclave      | Launch Observer/Executor and issue Verdicts | Governs the project Work lifecycle.                        |
| Observer      | Record Learning only                        | Gathers missing repository context in a read-only sandbox. |
| Executor      | Record Signals only                         | Performs one exact mission in an isolated sandbox.         |
| Preserver     | Record Counsel only                         | Provides bounded, source-backed repository advice.         |
| Maintainer    | Define intent and bounds                    | Provides project-level direction for the system.           |

The role system prompts live in `system-prompts/` and are injected into clean
role sessions. They are not user-invoked slash prompts.

## Configuration

Global defaults live in `~/.pi/agent/khala.json`. A trusted project can override
individual values in `.pi/khala.json`.

```json
{
  "worktreeRoot": "~/worktrees",
  "worktreeBranchPrefix": "khala/",
  "launcher": "zellij",
  "piCommand": ["pi", "--extension", "/path/to/khala"],
  "observerPiCommand": ["pi", "--extension", "/path/to/khala"],
  "conclaveModel": "provider/model",
  "observerModel": "provider/model",
  "archiveRoot": "~/.pi/agent/khala/conclaves"
}
```

`launcher` is `zellij` or `tmux` and defaults to `zellij`. Commands are passed
as argument arrays, not shell strings. Run the setup wizard to choose
`conclaveModel` and `observerModel` from the models reported by
`pi --list-models`. `observerModel` selects the read-only repository
observation model. The project `archiveRoot`
override is used only when Pi marks the project trusted; untrusted projects use
the global Archive root. All reads and writes for one trusted session use the
same selected root.

The package ships named Khala prompts and role system prompts. Generic packaged
placeholder prompts are intentionally not included.

## Documentation

- [Data model](docs/data-model.md) — Archive envelope, records, lifecycle
  statuses, validation, and append-only state.
- [Art direction and generation prompts](docs/art-prompts.md) — prompts and
  image specifications for the Khala artwork.
- [Context](CONTEXT.md) — project vocabulary and authority boundaries.
- [Work template](templates/khala-work.md) — the structured request format.
- [System prompts](system-prompts/) — role behavior and constraints.
- [Governed pi-review design](docs/design-governed-pi-review.md) — future Work/Executor/Signal flow.
- [Reusable Learning design](docs/design-reusable-observer-learning.md) — future cross-Work evidence rules.
- [Archive diagnostics design](docs/design-archive-diagnostics-recovery.md) — future read-only health tooling.
- [Bundled Pi extensions](extensions/) — extensions shipped with Khala, including `pi-review`.

## Development

```sh
npm install
npm run check
npm run build
npm test
```

`npm run check` runs Biome and TypeScript validation. Tests use local stubs and
do not require provider credentials or paid model calls.

The most important architectural seam is `src/khala-model.ts`: it is the single
source of truth for durable record shapes, discriminants, statuses, and guards.
Behavior modules import from it rather than defining their own persistence
models.

## Contributing

Keep changes focused and preserve the authority boundaries between User Sessions,
the Conclave, Observers, Executors, and the Archive. Add regressions to the
existing test suite, run `npm run check`, and run the relevant tests before
opening a pull request.

## License

MIT
