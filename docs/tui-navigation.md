# TUI navigation

`/khala` opens an on-demand Work-first view. Navigation reads the Archive and
runtime; it does not write lifecycle records.

## Work picker

The picker shows title, short Work ID, Work state, and Execution state. It hides
`succeeded` Work and stopped Work whose reason is `cancelled`. Stopped Work with
`stopReason: failed` remains visible and is marked for attention. Use the
configured Role settings key to open model settings.

Default controls:

| Key | Action |
| --- | --- |
| Up / Down | Select a Work or item |
| Enter | Open the selected item |
| Backspace / Escape | Go back or close the selector |
| `r` | Open Role settings |
| `c` | Open Peer-Review from a Work overview |

The Role settings and comments keys can be changed with `roleSettingsKey` and
`commentsKey` in Khala configuration.

## Work overview

The overview presents the Work, Mission, Execution, actionable runtime state,
linked review request, and next action. It links to:

- Actions — actions enabled for the current actor and revision.
- Evidence — relevant Archive records with sequence, kind, summary, actor, and
  time.
- Peer-Review — provider comments with author, timestamp, body, location, and
  URL.
- Archive — all Work records, newest first, with complete metadata and
  structured fields.

Empty values and sections are omitted. Runtime `idle` can mean an active
Execution is between turns; it is not automatically a failure.

## Recovery

When an Executor is unreachable, Actions exposes Conclave-authorized recovery. Recovery remains in one panel while it runs and ignores close keys
until the operation finishes. The final result remains visible after the
operation completes.

The TUI does not infer authority from displayed state, automatically retry a
semantic decision, or merge a provider request. Reread the Archive after a
revision conflict.
