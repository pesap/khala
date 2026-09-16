<img src="./assets/khala-sigil.svg" alt="khala sigil" align="left" width="220px" height="220px" hspace="10"/>
<img align="left" alt="" width="0" height="220px" hspace="10"/>

#### khala
<p><small>Govern coding work, execute it in dedicated worktres and keep the evidence</small></p>

[![Managed by humans](https://img.shields.io/badge/managed%20by-humans-1f6feb)](https://github.com/pesap/khala)
[![CI](https://github.com/pesap/khala/actions/workflows/ci.yaml/badge.svg)](https://github.com/pesap/khala/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/pesap/khala)](https://github.com/pesap/khala/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE-MIT.txt)
[![Latest commit](https://img.shields.io/github/last-commit/pesap/khala?style=flat-square)](https://github.com/pesap/khala/commits)

<br clear="left">

[Why Khala](#khala) · [Features](#core-boundaries) · [Pi tools](src/index.ts) · [Quick start](#quick-start) · [Documentation](#explore-the-repository) · [Development](docs/development.md)


Khala is a Pi extension for governed coding work.
It records each assignment in an Archive, runs an Executor in a dedicated Git worktree, and keeps the evidence needed for review and recovery.

## Quick start

### Prerequisites

The current provider workflow requires:

- Node.js 22.19 or newer.
- A Pi installation whose configured child command reports version `0.85.0`.
- Linux and bubblewrap (`bwrap`) with the required user-namespace support.
- Git.
- Git credentials with write access to `origin`; current delivery pushes the Executor branch before creating a review request.
- An authenticated `gh` or `glab` session.
- A repository whose `origin` is hosted on `github.com` or `gitlab.com`.

### Install

Try a tagged release without installing it:

```sh
pi -e git:github.com/pesap/khala@v1.1.1
```

Install the latest tagged release for regular use:

```sh
pi install git:github.com/pesap/khala@v1.1.1
```

Pi installs packages globally by default.
Add `-l` to install Khala only for the current project:

```sh
pi install git:github.com/pesap/khala@v1.1.1 -l
```

### Configure

Start Pi in a trusted repository and open `/khala`.
Use Role settings to choose Conclave and Executor models.
Oracle and Observer are optional; configure them only for advisory review or repository context gathering.
The target branch defaults to `main`; in a trusted project, set `targetBranch` in `.pi/khala.json` to use another branch.

### Submit Work

Call `khala_submit_work` with a title, objective, and at least one acceptance criterion.
Add scope, constraints, validation commands, allowed paths, and a token cap when known.
If validation is omitted, the current implementation uses `npm run check`.

Khala then:

1. Persists the Work and submits it for Conclave admission.
2. Creates an immutable Mission and schedules an Executor.
3. Runs the Executor in a dedicated Git worktree.
4. Commits and validates the change, then creates or reconciles a draft Pull Request or Merge Request.
5. Presents the result for review and records provider feedback or merge evidence.
6. Records a Conclave Outcome after verified provider merge evidence.

See [Getting started](docs/getting-started.md) for the complete workflow, evidence views, and recovery steps.

A first request can look like this:

```json
{
  "title": "Document the current command",
  "objective": "Update README.md with the current command usage.",
  "acceptanceCriteria": [
    "README.md documents the command and its expected result."
  ],
  "validation": ["npm run check:markdown"],
  "allowedPaths": ["README.md"]
}
```

Call `khala_submit_work` with these fields from Pi.
The tool returns immediately; Conclave processing runs asynchronously.

## Core boundaries

- The User sets the objective, scope, acceptance criteria, allowed paths, budget, and review decisions.
- The Conclave admits Missions, authorizes bounded attempts, assesses feedback, and records Outcomes.
- The Executor changes files only in its dedicated worktree and under the Mission's allowed paths.
- The Observer gathers missing repository facts without writing files.
- The Oracle provides optional advisory review without tools.
- The Archive stores Work, Mission, Execution, and Record state; runtime, Git, provider, and model output remain evidence.
- Provider polling records observations and merge evidence; it does not merge code or accept Work automatically.

## Commands and tools

| Entry point | Purpose |
| --- | --- |
| `/khala` | Open the Work view and Role settings. |
| `/khala-recover` | Reconcile project state and persisted runtime bindings from the owning User session. |
| `/khala-demo` | Browse a packaged read-only Archive fixture. |
| `khala_submit_work` | Record complete User intent without waiting for admission. |
| `khala_read_archive` | Read bounded, role-authorized Work facts and records. |
| `khala_inspect_runtime` | Inspect runtime liveness without changing Archive state. |
| `khala_poll_provider` | Record changed provider observations and merge evidence. |
| `khala_perform_action` | Submit one actor-authorized lifecycle action. |
| `khala_record_signal`, `khala_record_assessment`, `khala_run_oracle` | Record role-bound evidence or request advisory review. |

See the packaged [tool-usage skill](skills/khala/SKILL.md) for the complete tool contract and action reference.

## Current limits

> [!WARNING]
> Current delivery is provider-only through draft GitHub Pull Requests and GitLab Merge Requests.
> Work becomes `succeeded` only after provider merge evidence and a Conclave Outcome.
> Local delivery and local acceptance are not available.
> GitHub provider-comment feedback is supported.
> GitLab status and merge observation are supported, but GitLab review comments are not delivered as normalized feedback.
> The hosting User Pi session owns the current service and provider polling; closing it stops child runtimes.
> Independent background continuation remains a target requirement.
> Current Pi child launches do not provide OS filesystem isolation.
> Bubblewrap applies to dependency hydration and declared validation, not Pi child launches or service-owned Git hooks.
> Do not treat provider credential files as inaccessible to an Executor child.

### Defaults

| Setting | Default |
| --- | --- |
| Work token budget | 20,000 tokens |
| Concurrent Executions | 2 |
| Concurrent role runs | 2 |
| Replacement correction limit | 3 |
| Review target branch | `main` |

The token allowance is an observed stopping limit, not a hard financial spending ceiling.

## Explore the repository

Use the guide that matches your task:

| Goal | Guide |
| --- | --- |
| Complete a first Work | [Getting started](docs/getting-started.md) |
| Understand the design | [Foundations](docs/foundations.md) and [MVP design](docs/mvp-design.md) |
| Follow states and recovery | [Lifecycle](docs/lifecycle.md) |
| Configure and operate Khala | [Operations](docs/operations.md) |
| Understand the application boundary | [Architecture](docs/architecture.md) |
| Inspect records and projections | [Data model](docs/data-model.md) |
| Review authority and isolation | [Security](docs/security.md) |
| Use the current Pi interface | [TUI navigation](docs/tui-navigation.md) and [Application actions](docs/supervision-tools.md) |
| Extend Pi integration | [Pi extensions](docs/pi-extensions.md) and [Role prompts](docs/role-prompts.md) |
| Use role-bound tools | [Khala tool-usage skill](skills/khala/SKILL.md) |
| Develop and validate changes | [Development](docs/development.md) |

## Development

The native workflow tests require Linux, bubblewrap (`bwrap`), and `tmux`.
Install dependencies and run the repository checks:

```sh
npm ci --ignore-scripts
npm run check
npm run test
npm run check:markdown
npm pack --dry-run
```

See [Development](docs/development.md) for targeted checks, test coverage, packaging, and troubleshooting.
See the [CI workflow](.github/workflows/ci.yaml) for the automated validation sequence.

## Bundled extensions

- [`pi-review`](extensions/pi-review/README.md) provides `/review` and `/end-review` for scoped code reviews.
- [`pi-clarify`](extensions/pi-clarify/README.md) provides `/clarify` and the `-clarify` marker for prompt rewriting.
- [`khala-demo`](extensions/khala-demo/README.md) provides `/khala-demo` for browsing a read-only Archive fixture.

## License

MIT.
See [LICENSE-MIT.txt](LICENSE-MIT.txt) for the full license text.
