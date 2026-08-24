# Khala bundled pi-clarify extension

This is Khala's bundled fork of [dodo-reach/pi-clarify](https://github.com/dodo-reach/pi-clarify).

It registers `/clarify` and rewrites rough prompts into precise technical prompts
before they are sent to Pi. The rewrite is placed in the editor so you can review
and edit it before sending.

Usage:

```text
/clarify make the cards not jump when I drag them
/clarify
make the cards not jump -clarify
```

The extension always uses Khala's configured Conclave model for the current
project. Configure that model from `/khala` → **Role settings**; `/clarify` has
no separate model-selection or model-pinning commands.

The extension retains the upstream MIT license in `LICENSE`.
