# Bundled Pi extensions

Khala registers its bundled Pi extensions in `package.json` alongside the main
Khala extension. Pi loads them when the Khala package is installed.

## pi-clarify

`pi-clarify` rewrites rough prompts into precise technical prompts before they
are sent to the agent.

- `/clarify <idea>` rewrites the supplied idea.
- `/clarify` rewrites the current editor text.
- `-clarify` anywhere in a message rewrites that message and places the result
  in the editor instead of sending it.
The rewrite uses Khala's configured Conclave model for the current project.
There are no separate `/clarify model` commands.

The rewrite preserves concrete details and does not send the prompt until the
user reviews and submits the resulting editor text.

## pi-review

`pi-review` provides `/review` and `/end-review` for scoped code reviews of
uncommitted changes, branches, commits, GitHub pull requests, and file or folder
snapshots. Its review lifecycle remains a standalone workflow.

See the extension-specific READMEs in [`extensions/`](../extensions/) for
upstream attribution and license details.
