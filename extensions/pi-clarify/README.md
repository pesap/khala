# Khala bundled pi-clarify extension

This is Khala's bundled fork of [dodo-reach/pi-clarify](https://github.com/dodo-reach/pi-clarify).

It registers `/clarify` and rewrites rough prompts into precise technical prompts before they are sent to Pi.
The rewrite is placed in the editor so you can review and edit it before sending.
The extension uses Pi's public model registry completion API, so configured environment, stored, OAuth, and keyless provider authentication are resolved by Pi.
The command and marker require a UI-capable Pi session, such as interactive or RPC mode.
In print or JSON mode, `/clarify` reports that a UI is required and a `-clarify` marker is passed through unchanged.

Usage:

```text
/clarify make the cards not jump when I drag them
/clarify
make the cards not jump -clarify
```

The extension always uses Khala's configured Conclave model for the current
project.
Configure that model from `/khala` → Role settings; `/clarify` has
no separate model-selection or model-pinning commands.

The extension retains the upstream MIT license in `LICENSE`.
