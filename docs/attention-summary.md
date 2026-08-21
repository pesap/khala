# Attention summary

`/khala` and `Alt+K` show a compact, project-level attention view. The view is
read-only with respect to the User's session: it does not switch sessions, show
raw Executor rows, expose a writable Conclave session path, or display internal
runtime labels.

The view is derived from the authoritative Archive. It shows one top-level
option per actionable Work. Each option shows the Pull Request reference when
available, the Work name, and a dim lowercase status tag such as `[stalled]`,
`[failed]`, or `[review]`. A Work with active mission Executors also shows a
plain-text badge such as `[2 running]`; the badge is refreshed while the
selector is open and does not rely on color. Type to fuzzy-filter the mission
list. Up and Down wrap around the filtered missions, and Enter opens the
selected Work. Selecting
a Work opens a focused detail menu with its Mission ID, Pull Request, current
explanation, and available actions:

- **Review** — shows the current reviewable Pull Request URL. The Pull Request
  must belong to the current, finished Mission and the Work must not already
  have an accepted Outcome.
- **Try current worker again** — sends one identified continuation to a current
  idle worker. Khala checks the persisted Pi entry before recording the action
  as applied.
- **Continue with a new worker** — starts one new Executor for the same current
  immutable Mission after the previous Execution is durably failed. It does not
  create a successor Mission.
- **Ask worker to stop** — aborts the current worker and permits one bounded
  stop handoff. The worker must persist exactly one current blocked Signal with
  non-empty evidence.
- **Select another model** — lists authenticated Executor models other than the
  unavailable model. The model selector supports the same fuzzy filtering and
  wrapping Up/Down navigation as the mission selector. The selected model is
  recorded as a one-time override for this Mission recovery and does not change
  global configuration.
- **Try the same model again** — appears only while the failed model is
  currently available. It starts a new Executor for the same Mission without
  changing global configuration.
- **View attempts** — opens the current Mission's recorded Executor attempts. The selector uses compact, aligned attempt numbers, Executor names, and dim status tags. Up and Down wrap through the attempts; selecting one opens its Execution ID, failure details, model, launcher, timestamps, paths, session, recovery, prompt, and upstream metadata. Backspace returns to the Work actions.
- **Held Mission** — identifies the upstream Work for a dependency hold, or
  the conflicting Work for a peer conflict. Recovery actions stay hidden until
  the Conclave resolves the Coordination.
- **Dismiss** — records an append-only dismissal for the current condition. A
  changed Archive condition receives a new identity and can appear again.

Every worker action persists an idempotent request before delivery and one
outcome after delivery. Reopening the same condition does not send a duplicate
request after a durable outcome or an uncertain prior attempt.

Pressing Backspace in a Work or project action menu returns to the top-level
attention list; the menus do not need a separate return row. Pressing Backspace
in an attempt detail returns to the attempt list, and pressing it in the attempt
list returns to the Work actions. Escape still cancels the current selector.
Project-level recovery conditions remain separate from Work actions:

- A failed Conclave wake offers setup guidance when configuration is missing.
- Other failed Conclave wakes offer `/khala-recover`.
- Selecting a model from `/khala` starts the same-Mission recovery directly; no
  `/khala-recover` command is required afterward.

The view also reports stopped Work when a Submission or Mission was rejected,
or when automatic Conclave submission recovery was exhausted. A Work Outcome
always suppresses stopped and review attention for that Work.

The view does not infer user action from session transcripts. Retryable or raw
Execution failures without a current actionable condition, unknown runtime
state, supervision internals, participant identities, and raw Executor rows
stay hidden. Running Observers with a focusable pane appear only as a secondary
read-only option after Work and project options.

When no actionable condition exists, `/khala` reports the number of active Work
submissions and explicitly says that no user action is required. In
non-interactive modes it reports the same projection as a notification instead
of opening selectors. Project recovery and read-only Observer options use the
same short tagged selector rows.
