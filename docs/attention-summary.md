# `/khala` view

`/khala` is quiet and on demand. It does not open automatically, print child
traffic, or change the User model or settings.

The first view lists Work with:

- current lifecycle state;
- FIFO queue position when queued;
- reserved and maximum token allowance;
- the next action or disabled reason.

Selecting a Work opens four stable sections:

1. **Overview** — terms, state, revision, budget, Mission, Execution, and next
   action.
2. **Actions** — actor-authorized actions. Unavailable actions remain visible
   with a concise reason.
3. **Evidence** — bounded Signals, review request, and provider observations.
4. **History** — a pointer to append-ordered Archive records.

Selection is pinned by Work ID. Refresh rereads the Archive and preserves the
selected Work and filter. Navigation never writes. Raw Executor output and
provider text are hidden until the User explicitly reads bounded evidence.

Default interactions follow Pi selector conventions: Up/Down move, Enter opens
or confirms, Escape goes back or cancels, `/` starts a filter, and `?` opens help.
The filter and help keys can be changed in `khala.json`.
