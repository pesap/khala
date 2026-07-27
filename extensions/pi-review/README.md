# Khala bundled pi-review extension

This is Khala's bundled fork of [earendil-works/pi-review](https://github.com/earendil-works/pi-review).

It registers the Pi commands `/review` and `/end-review` for scoped code reviews:

- uncommitted changes
- base-branch diffs
- commits
- GitHub pull requests
- file or folder snapshots

The extension is currently a standalone Pi workflow. Its review lifecycle can be
adapted to submit Khala Work and consume evidence-bearing Signals in a later
change.

The fork retains the upstream MIT license in `LICENSE`.
