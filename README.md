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

In Pi, open `/khala` and choose **Role settings** to configure the model and
thinking level for Conclave, Executor, Observer, and Oracle. Settings persist to
`~/.pi/agent/khala.json` and apply to future launches; an existing Execution
keeps its persisted model and thinking level.

Then submit complete intent with `khala_submit_work`. Submission returns after
SQLite persistence; Conclave processing is scheduled independently.

Use `/fresh-eyes [scope or focus]` to review the current dirty diff and touched
files with the packaged fresh-eyes review prompt.

## User workflow

1. Submit title, objective, and acceptance criteria. Scope, constraints,
   validation, context, and the Work token cap may be supplied explicitly.
2. The Conclave admits complete terms into one immutable Mission. Missing
   repository facts may launch one read-only Observer assessment.
3. FIFO scheduling reserves an Execution before launch, starts at most the
   configured number of Executions, and never exceeds the Work token cap.
4. The persistent parent supervisor launches the Executor from the durable
   outbox; a Conclave child never owns the Executor runtime. A transient child
   startup exit receives one bounded retry before the outbox records durable
   failure evidence. The Executor works in a Git worktree, creates a draft
   GitHub Pull Request or GitLab Merge Request, validates the change, and sends
   a `ready` Signal.
5. The Conclave may continue, replace, hand off, or reject the current
   Execution. Handoff enters User review; it is not acceptance.
6. User review evidence and provider merge evidence are recorded separately.
   Poll the provider with `khala_poll_provider` after a review request is open.
   New GitHub review comments wake the Conclave, which may deliver bounded
   feedback to the same Execution without another User action. Only the
   Conclave can record the succeeded Work Outcome.

`/khala` is quiet and on demand. It opens a Work list; Work is the User's goal,
each admitted Work has one Mission, and each Mission may have an Execution.
The picker shows active Work by default, hides succeeded and cancelled Work,
and keeps failed Work visible. It presents title, short ID, Work state, and
Execution state in aligned columns. The Work overview shows only the Work,
Mission, Execution, actionable runtime state, next action, and links to Actions,
Evidence, and Archive. Actions lists enabled actions with short labels such as
`Recover`, `Rename`, and `Cancel`.

Evidence is a selectable Archive-derived record list with sequence, actual kind,
summary, actor, and time. It does not duplicate lifecycle, provider, review, CI,
error, or handoff sections. Provider comments appear as a selectable Evidence
entry when available. Archive lists every Work record newest first. Selecting a
record opens its complete metadata, full IDs, structured fields, and evidence
references. Empty values and sections are omitted. The panels use headings,
whitespace, aligned columns, plain text status labels, and a dimmed navigation
footer without decorative separators. The layout adapts to narrow terminals.

An unreachable Executor exposes recovery in `Actions`. Recovery stays in one
panel while it runs, ignores close keys until the operation finishes, and then
shows the final result. Navigation does not write the Archive. Up/down and Enter
select; Backspace or Escape navigates back or closes the selector. Press the
configured Role settings key in the Work picker to open Role settings. Press the configured comments key in the
Work overview or Evidence view to open Review comments. `r` and `c` can be
changed with `roleSettingsKey` and `commentsKey` in configuration. Use `Rename`
in Work actions to change the Work label without changing the admitted Mission
terms.

Token usage, including cache hits and misses, remains tracked on the Execution;
USD cost is not tracked without provider pricing and usage data.

## Application service

All Pi tools call the versioned application service. Its public operations are:

```text
submit_work(input, meta)
list_work(filter?, cursor?)
inspect_work(work_id)
inspect_runtime(work_id, meta?)
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
  agent-turn timeouts, retrying one transient startup exit before surfacing the
  failure.
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

Khala's root service also runs an unref'ed autonomous monitor. It polls active provider reviews and inspects active Executor runtimes without using the user's primary Pi session. GitHub review bodies, conversation comments, and inline review comments wake the shadow Conclave; feedback remains pending until delivery succeeds, and runtime failures wake Conclave recovery with Archive evidence.
