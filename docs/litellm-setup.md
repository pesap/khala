# LiteLLM Setup

Khala can register LiteLLM-compatible providers for Pi without storing a
separate secret store or prompting for raw provider credentials outside Pi's own
config shape.

> [!NOTE] The setup helper reads Pi state that already exists on disk. It checks
> `pi --list-models`, reads read-only `models.json` provider discovery from Pi's
> config directory, and shows LiteLLM-compatible aliases when they already
> exist.

## Quick Command

```bash
khala litellm --project \
  --provider team-litellm \
  --base-url https://lite.example/v1 \
  --key-env reeds-maint \
  --model gpt-5.4-mini
```

`--key-env` accepts a portal-style label, such as the name assigned to the key
in your LiteLLM admin portal. Khala derives the shell-canonical environment
variable from it:

```text
reeds-maint -> $REEDS_MAINT
```

If you pass a valid identifier such as `LITELLM_API_KEY`, derivation is a no-op.

## Auth Modes

Interactive setup asks how Pi should resolve the API key for the provider. Each
mode matches Pi's `auth.json` schema, so the resulting file is indistinguishable
from one written by `/login`.

| Mode                | What Khala writes                                                      | Runtime behavior                                   |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Paste the key once  | A literal string in `~/.pi/agent/auth.json` with `0600` permissions    | Pi reads it directly; no shell env var is required |
| Use a shell command | The command string, such as `!op read 'op://Personal/team/credential'` | Pi runs the command on demand and uses stdout      |
| Skip                | Nothing in `auth.json`                                                 | Pi reads the derived env var from the shell        |

For scripts, use the same modes with flags:

```bash
khala litellm \
  --auth-mode=command \
  --auth-command="!op read 'op://Personal/team/credential'"
```

Available forms are `--auth-mode={skip,literal,command}` with either
`--auth-key=<value>` or `--auth-command='!cmd'`. Run `khala litellm --help` for
the full surface.

> [!IMPORTANT] Literal key values are never echoed to stdout or stderr.
> Shell-command mode is usually preferable when the key should stay in a
> password manager or keychain.

## Interactive Paths

Interactive setup supports three common flows:

| Flow                          | Use when                                                                 |
| ----------------------------- | ------------------------------------------------------------------------ |
| New provider and key          | The proxy, model list, and reusable key label are new                    |
| New key for existing provider | The proxy exists, but the current project needs a fresh portal key label |
| Reuse existing key            | Another project should use an already registered provider/key label      |

Choose **New key for existing provider** when the proxy and model list are
already registered but a fresh portal key label is needed. Khala keeps the
provider config, asks for the new key label and secret, and stores it without
replacing the existing provider-level compatibility entry.

After setup, Khala shows the exact `.pi/khala/litellm.json` path and asks
whether to configure the current project. If you answer no, only the reusable
key label and auth entry are saved. If the provider/key label already has a
stored key, Khala asks before overwriting it.

## Reuse a Provider in Another Project

From the new project folder, run:

```bash
khala litellm
```

Choose **Reuse existing key**. Khala lists reusable LiteLLM providers from
shared Pi `models.json`/`auth.json` config and Khala's non-secret key-label
registry. The picker asks for the provider first, then the key label, so the
same LiteLLM provider can expose multiple reusable labels.

If you configure the project, Khala writes this project's `.pi` files without
asking you to paste the key again.

## Project Settings

Khala asks before changing `.pi/settings.json` in interactive runs. In scripts,
pass `--project-settings` only when the selected models should become this
project's Pi defaults.

This does not change what `pi --list-models` prints. That command lists the
shared `~/.pi/agent/models.json` registry. Project model scope is controlled by
the `defaultProvider`, `defaultModel`, and `enabledModels` block inside the
current project's `.pi/settings.json`.

Khala writes `enabledModels` as provider-qualified entries such as:

```text
team-litellm/gpt-5.4-mini
```

That prevents Pi from resolving a same-named model from another provider.

## Model Metadata

In all auth modes, `models.json` keeps a stable resolver entry:

```text
!khala litellm print-key --provider <id>
```

Each project records its selected key environment variable under
`.pi/khala/litellm.json`. When a key source is available, the picker also
fetches LiteLLM's `/model/info` endpoint so selected models get metadata such as
context window, costs, reasoning support, and input modalities instead of bare
`{ id }` entries.

## Base Install Commands

If the package is already installed, run the helper directly:

```bash
khala
```

You can also configure Pi directly:

```bash
pi install https://github.com/pesap/khala
pi install -l https://github.com/pesap/khala
```

The global command writes `~/.pi/agent/settings.json`; the local command writes
`.pi/settings.json` for the current project.
