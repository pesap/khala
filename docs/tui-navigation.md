# TUI navigation

`/khala` opens an on-demand Work-first view.
Navigation reads the Archive and
runtime; it does not write lifecycle records.

## Work picker

The picker shows title, short Work ID, Work state, and Execution state.
It hides `succeeded` Work and stopped Work whose reason is `cancelled` by default.
Stopped Work with `stopReason: failed` remains visible and is marked for attention.
Use the history key to include completed and cancelled Work.
Use the
configured Role settings key to open model settings.
Role settings presents each role's current model and thinking level in a comparison table.
Enter opens the selected role's settings.

Default controls:

| Key | Action |
| --- | --- |
| Up / Down | Select a Work or item |
| Enter | Open the selected item |
| Backspace / Escape | Go back or close the selector |
| `r` | Open Role settings when the filter is empty |
| `c` | Open Peer-Review from a Work overview |
| `ctrl+r` | Refresh Work and preserve the current selection and filter |
| `h` | Toggle completed and cancelled Work when the filter is empty |
| `?` | Open picker help when the filter is empty |

The Role settings, comments, refresh, help, and history keys can be changed with
`roleSettingsKey`, `commentsKey`, `refreshKey`, `helpKey`, and `historyKey` in Khala configuration.

## Work overview

The overview presents the Work, Mission, Execution, actionable runtime state,
linked review request, current attention summary, and next action.
It labels GitHub requests as PR and GitLab requests as MR.
It links to:

- Actions — actions enabled for the current actor and revision.
- Evidence — relevant Archive records with sequence, kind, summary, actor, and
  time.
- Peer-Review — provider comments with author, timestamp, body, location, and
  URL.
- Archive — all Work records, newest first, with complete metadata and
  structured fields.

Empty values and sections are omitted.
Runtime `idle` can mean an active
Execution is between turns; it is not automatically a failure.

## Recovery

When an Executor is unreachable, Actions exposes Conclave-authorized recovery.
Recovery remains in one panel while it runs and ignores close keys
until the operation finishes.
The final result remains visible after the
operation completes.

Long detail pages support Up/Down, Page Up/Page Down, Home, and End scrolling.
The TUI does not infer authority from displayed state, automatically retry a
semantic decision, or merge a provider request.
Reread the Archive after a revision conflict.
