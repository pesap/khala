# Bundled Pi extensions

The package registers the main Khala extension and three complementary Pi
extensions.

## `pi-review`

`/review` opens the Pi review selector and supports:

- uncommitted changes;
- a base branch;
- a commit;
- a GitHub pull request reference;
- file or folder snapshots.

Pass `/review <target>` to bypass the selector and send a literal target to the reviewer.
The command waits for current agent activity to settle before starting.
Review mode is persisted in the session branch and follows session tree navigation.
The review is a separate session workflow.
It does not mutate Khala lifecycle state or turn review prose into a Verdict.
`/end-review` ends the local review mode and leaves findings in the session for the User to act on.
The commands require a UI-capable Pi session, such as interactive or RPC mode.

## `pi-clarify`

`/clarify <idea>` and `/clarify` rewrite a rough prompt using the configured Conclave model.
A `-clarify` marker intercepts the input, places the rewrite in the editor, and waits for User review.
The marker is a whole token, so it does not match words such as `pre-clarify` or `-clarify-now`.
The extension never silently sends the rewritten prompt and never changes global Pi settings.
The command and marker require a UI-capable Pi session, such as interactive or RPC mode.

## `khala-demo`

`/khala-demo` opens the packaged read-only demo Archive.
It includes historical Work by default so the fixture shows all representative Work and Execution states.
The demo Archive is separate from the live project Archive.
The command does not submit Work, mutate Archive state, start child sessions, or call models.
Each completed invocation opens a fresh view of the unchanged fixture.
A concurrent invocation reports that the demo is already open.
The command requires a UI-capable Pi session for interactive browsing.
In print or other non-TUI modes it displays the fixture dashboard as a notification.

## Read-only Archive API

Extensions can browse a static Archive through the package public entry point without constructing an ApplicationService.
`openKhalaArchive(path)` opens an existing SQLite Archive in read-only mode and returns `KhalaArchiveView`.
`KhalaArchiveView` exposes `listWork`, `inspectWork`, `readRecords`, and `close` only.
`readRecords` preserves Archive query filters and cursors.
`showKhalaArchive(archive, context, { includeHistory: true })` renders the same Work-first display without lifecycle actions or runtime inspection.
Call `close` in a `finally` block after the display completes.

```ts
import { openKhalaArchive, showKhalaArchive } from "@pesap/khala";

const archive = openKhalaArchive("data/fixtures/example.sqlite");
try {
  await showKhalaArchive(archive, context, { includeHistory: true });
} finally {
  archive.close();
}
```
