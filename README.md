# Khala

Khala is a Pi-native governance extension for isolated coding work. It keeps the
User conversation quiet while a project Conclave admits Work, schedules a
bounded Executor, records evidence, and waits for provider-confirmed review
outcomes.

The Archive is authoritative. Runtime state, Git, providers, model output, and
TUI views are evidence only.

## Quick start

Requirements: Node.js 22.19 or newer, Pi, Git, and an authenticated `gh` or
`glab` session for review requests.

```sh
npm install
npm run check
pi -e ./src/index.ts
```

Create `~/.pi/agent/khala.json` with explicit model settings before submitting
Work:

```json
{
  "conclaveModel": "provider/conclave-model",
  "executorModel": "provider/executor-model",
  "oracleModel": "provider/oracle-model",
  "observerModel": "provider/observer-model",
  "conclaveThinking": "medium",
  "executorThinking": "high",
  "oracleThinking": "high",
  "observerThinking": "medium",
  "targetBranch": "main",
  "maxConcurrentExecutions": 2,
  "defaultWorkTokens": 20000
}
```

In Pi, submit complete intent with `khala_submit_work`, then use `/khala` to
inspect Work. Submission returns after SQLite persistence; Conclave processing
is scheduled independently.

## User workflow

1. Submit title, objective, and acceptance criteria. Scope, constraints,
   validation, context, and the Work token cap may be supplied explicitly.
2. The Conclave admits complete terms into one immutable Mission. Missing
   repository facts may launch one read-only Observer assessment.
3. FIFO scheduling reserves an Execution before launch, starts at most the
   configured number of Executions, and never exceeds the Work token cap.
4. The persistent parent supervisor launches the Executor from the durable
   outbox; a Conclave child never owns the Executor runtime. The Executor works
   in a Git worktree, creates a draft GitHub Pull Request or
   GitLab Merge Request, validates the change, and sends a `ready` Signal.
5. The Conclave may continue, replace, hand off, or reject the current
   Execution. Handoff enters User review; it is not acceptance.
6. User review evidence and provider merge evidence are recorded separately.
   Poll the provider with `khala_poll_provider` after recording review status.
   Only the Conclave can record the succeeded Work Outcome.

`/khala` is quiet and on demand. It opens a Work list, then stable `Overview`,
`Actions`, `Evidence`, and `History` sections. Navigation does not write the
Archive. Up/down, Enter, Escape, `/`, and `?` follow the default selector
interaction and can be changed with `filterKey` and `helpKey` in configuration.

## Application service

All Pi tools call the versioned application service. Its public operations are:

```text
submit_work(input, meta)
list_work(filter?, cursor?)
inspect_work(work_id)
available_actions(scope, revision?)
perform(action_command)
read_records(query?, cursor?)
```

Actor, expected revision, schema version, and idempotency command ID are checked
before every mutation. Revision conflicts require a reread. Records are bounded
projections; raw Executor transcripts and provider text are not shown by
navigation by default.

## Architecture

- `src/model.ts` defines domain contracts and discriminants.
- `src/archive.ts` implements the SQLite WAL Archive, projections, cursors,
  idempotency, and transactional outbox.
- `src/service.ts` owns lifecycle and actor authorization.
- `src/ports.ts` defines runtime, workspace, code-host, model, and Oracle ports.
- `src/adapters.ts` provides Git and GitHub/GitLab adapters.
- `src/runtime.ts` supervises isolated Pi JSON-RPC children with bounded RPC and
  agent-turn timeouts.
- Child role sessions inherit the parent project identity and carry a
  parent-signed role, Work, and Execution capability; Archive reads and
  mutations remain service-authorized.
- `src/tui.ts` provides the on-demand Work-first view.

The SQLite file is under `archiveRoot` (default `~/.pi/agent/khala`) and is
keyed by the resolved project path. It uses WAL mode and short `BEGIN IMMEDIATE`
transactions.

## Bundled extensions

- `pi-review` provides `/review` and `/end-review` with the upstream review
  selector interaction for uncommitted changes, branches, commits, pull
  requests, and snapshots.
- `pi-clarify` provides `/clarify` and the `-clarify` marker. It places the
  rewritten prompt in the editor for User review; it does not send the prompt.

## MVP exclusions

The MVP does not implement automatic merge, token top-up, semantic retry,
priority controls, dependencies, peer-conflict coordination, non-Git VCS, or
more than one active Execution per Mission.

## Development

```sh
npm run check
npm run build
node --test test/mvp.test.js
```

`npm run check` runs Oxlint with the generic anti-slop plugin, Biome formatting,
and TypeScript validation. Tests use local port adapters and do not require
provider credentials.
