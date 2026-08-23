# Bundled Pi extensions

The package registers the main Khala extension and two complementary Pi
extensions.

## `pi-review`

`/review` opens the familiar Pi selector interaction from `pi-review` and
supports:

- uncommitted changes;
- a base branch;
- a commit;
- a GitHub pull request reference;
- file or folder snapshots.

The review is a separate session workflow. It does not mutate Khala lifecycle
state or turn review prose into a Verdict. `/end-review` ends the local review
mode and leaves findings in the session for the User to act on.

## `pi-clarify`

`/clarify <idea>` and `/clarify` rewrite a rough prompt using the explicit
Conclave model. A `-clarify` marker intercepts the input, places the rewrite in
the editor, and waits for User review. The extension never silently sends the
rewritten prompt and never changes global Pi settings.
