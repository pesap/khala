# `/khala` view

`/khala` is quiet and on demand.
It does not open automatically or print child
traffic.
Its Role settings view changes Khala's persisted role configuration,
not the User's active Pi model or settings.

The first view lists Work titles.
Each row is a Work, not a Mission.
Work is the
User's stable goal; after admission, its Mission is the bounded plan Khala
runs, and its Execution is one attempt under that Mission.
The picker hides succeeded and cancelled Work by default, keeps failed Work visible with a clear failure marker, and provides a history toggle for completed Work.
It uses the same minimalist fuzzy filtering pattern as Pi's model selector.
Work names are bounded before rendering and presented in aligned
Work, ID, state, and Execution columns.
Text labels and semantic colors together
communicate status.
The user-session footer shows a branded status such as
`khala: idle` or `khala: ◈ 2`.
The status view shows `Next`
for the immediate action required or performed by Khala, reports Work as
`stopped` with a cancellation or failure reason, and avoids repeating active
state labels.
It does not repeat revision, budget, or token metadata.
Evidence explicitly distinguishes active lifecycle state from
recorded activity.
It then provides three core sections and a conditional peer-review section:

1. Actions — actor-authorized actions that are currently available.
2. Evidence — Execution turn status, bounded Signals, review request, provider observations, and explicit missing evidence.
3. Peer-Review — provider comments from the current review request, when available.
4. Archive — append-ordered Archive records with selectable details.

Blocked Executions add a blocking-signal section.

A complete evidence walkthrough reads:

```text
Run a complete Khala evidence walkthrough
Work active
Mission in progress
Execution running
Runtime unreachable
PR: #43
Next: Executor runtime is unreachable. Recover it from Actions.
→ Actions → Evidence → Peer-Review → Archive
```

Provider review comments appear in the dedicated Peer-Review section.
After
polling, the Conclave can authorize a delivery without reopening the User
session; the delivery and any recovery failure remain visible in Archive.

Selection is pinned by Work ID.
The configured refresh key rereads the Work list while preserving the selected Work and filter.
The help panel lists refresh, history, settings, and navigation controls.
Navigation never writes.
Raw Executor output and
provider text are hidden until the User explicitly reads bounded evidence.
Evidence details use wrapped sections with clear headings, and provider
summaries are presented as clean text for scanning or copying.

Default interactions follow Pi selector conventions: type filters, Up/Down
move, Enter opens or confirms, and Backspace or Escape goes back or cancels.
Long detail pages support Up/Down, Page Up/Page Down, Home, and End scrolling.
`r` opens Role settings when the filter is empty.
`h` toggles history and `ctrl+r` refreshes the picker by default.
When provider comments are available, `c` opens
Peer-Review from the Work overview.
An unreachable Executor exposes runtime
recovery in Actions, and the Conclave can inspect and recover it without
opening the User session.
Role settings change the model and thinking level
for future role launches.
The Role settings and comments keys can be changed in
`khala.json`.
