# Bundled Pi extensions

The package registers the main Khala extension and two complementary Pi
extensions.

## `pi-review`

`/review` opens the familiar Pi selector interaction from `pi-review` and supports:

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
