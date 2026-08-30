# Khala bundled pi-review extension

This is Khala's bundled fork of [earendil-works/pi-review](https://github.com/earendil-works/pi-review).

It registers the Pi commands `/review` and `/end-review` for scoped code reviews.

Run `/review` without arguments to choose a scope, then provide the base branch, commit, pull request, or paths requested by the selector.
Run `/review <target>` to pass a literal review target directly to the reviewer.
The supported selector scopes are:

- uncommitted changes
- base-branch diffs
- commits
- GitHub pull requests
- file or folder snapshots

The command waits for the current Pi agent activity to settle before starting the review.
Review mode is persisted in the session branch and follows `/tree` navigation.
`/end-review` clears the local mode indicator and leaves the findings in the session.
It does not edit files, commit, push, or turn review prose into a Khala Verdict.
The commands require a UI-capable Pi session, such as interactive or RPC mode.

The extension is currently a standalone Pi workflow.
Its review lifecycle can be adapted to submit Khala Work and consume evidence-bearing Signals in a later change.

The fork retains the upstream MIT license in `LICENSE`.
