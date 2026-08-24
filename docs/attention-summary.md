# `/khala` view

`/khala` is quiet and on demand. It does not open automatically, print child
traffic, or change the User model or settings.

The first view lists Work titles. Each row is a Work, not a Mission; after
admission, the Work has a Mission and may have an Execution. Selecting a Work
opens a compact status view that separately shows Work, Mission, and Execution
state, the Executor runtime state, and the next action. It does not repeat
revision, budget, or token metadata. Evidence explicitly distinguishes active
lifecycle state from recorded activity. It then provides three focused
sections:

1. **Actions** — actor-authorized actions that are currently available.
2. **Evidence** — Execution turn status, bounded Signals, review request, provider observations, and explicit missing evidence.
3. **History** — append-ordered Archive records with selectable details.

Selection is pinned by Work ID. Refresh rereads the Archive and preserves the
selected Work and filter. Navigation never writes. Raw Executor output and
provider text are hidden until the User explicitly reads bounded evidence.

Default interactions follow Pi selector conventions: Up/Down move, Enter opens
or confirms, Backspace or Escape goes back or cancels, `/` starts a filter, and `?` opens help.
An unreachable Executor exposes runtime recovery in Actions. The filter and help keys can be changed in `khala.json`.
