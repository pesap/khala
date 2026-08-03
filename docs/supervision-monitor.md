# Supervision monitor

The existing `/khala` session popup is Khala's minimum supervision monitor. It
shows the project Conclave, multiple asynchronous headless Executor rows,
read-only Observer rows, Work/Mission identity, sandbox, Signals, supervision
state, Coordination, upstream-base facts, budget evidence, and recovery state.

Executor rows are display-only. A Mission Executor has no zellij, tmux, or Herdr
pane and cannot be focused or sent pane input. Selecting an Executor shows
bounded facts projected from the Archive and persisted Conclave session. An
Observer may retain its configured zellij, tmux, or Herdr pane; the popup can
focus that observation pane without changing durable state.

Executor detail includes the exact upstream Work, Mission, Execution, remote,
branch, and base commit; stale or invalidated state; selected Conclave and
Executor models; advisory per-turn limits; latest observed cost; supervision
state (`connected`, `recovering`, `unavailable`, or `settled`); and significant
steering, Coordination, lifecycle, failure, recovery, or budget evidence.
Missing or zero pricing is `unavailable`; an overrun remains visible while work
continues.

Routine aligned assessment input and responses remain hidden from the
interactive Conclave view but stay in the persisted Pi session. The monitor
adds no supervision controls or keybindings. A direct User priority override is
made by speaking directly in the dedicated Conclave session; the Conclave must
bind it to the exact User source entry and it is valid only for peer conflict.
