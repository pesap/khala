# LiteLLM Setup

Khala can register a LiteLLM-compatible provider directly in Pi's own config,
so Pi's `/model` picker and `--list-models` see it like any other provider.
Khala's own `khala.json` setup wizard then discovers it through Pi.

## Quick Command

For first-time setup, run `khala litellm` from the project that should use the
provider. For scripted or direct setup, pass all flags explicitly:

```bash
khala litellm \
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

Interactive setup asks how the resolver should obtain the API key. Stored
values use Pi's `auth.json` API-key entry shape under a key specific to the
provider and key label, so different projects can select different keys.

| Mode                | What Khala writes                                                   | Runtime behavior                                   |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Paste the key now    | A literal string in a key-specific `~/.pi/agent/auth.json` entry with `0600` permissions | The resolver reads it; no shell env var is required |
| Run a shell command  | The command string, such as `!op read 'op://Personal/team/credential'` | The resolver runs the command on demand and uses stdout      |
| Skip                 | Nothing in `auth.json`                                               | The resolver reads the derived env var from the shell        |

For scripts, use the same modes with flags:

```bash
khala litellm \
  --provider team-litellm --base-url https://lite.example/v1 --key-env reeds-maint --model gpt-5.4-mini \
  --auth-mode=command --auth-command="!op read 'op://Personal/team-litellm/credential'" --yes
```

Available forms are `--auth-mode={skip,literal,command}` with either
`--auth-key=<value>` or `--auth-command='!cmd'`. Run `khala litellm --help`
for the full flag reference.

> [!IMPORTANT]
> Literal key values are never echoed to stdout or stderr. Shell-command mode
> is usually preferable when the key should stay in a password manager or
> keychain.

## Interactive Paths

Running `khala litellm` with no flags in a terminal offers up to three flows:

| Flow                          | Use when                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| New provider and key          | The proxy, model list, and reusable key label are new                    |
| New key for existing provider | The proxy exists, but the current project needs a fresh portal key label |
| Reuse an existing key         | Another project already registered this provider/key label               |

Choose **New key for existing provider** when the proxy and model list are
already registered but a fresh portal key label is needed. Khala keeps the
provider's existing model list and only writes a new key label and auth
entry.

Khala's write plan names the exact `.pi/khala/litellm.json` path and, for the
"new key" flows, asks whether to configure the current project. If the
provider/key label already has a stored key, Khala asks before overwriting
it.

## Reuse a Provider in Another Project

From the new project folder, run:

```bash
khala litellm
```

Choose **Reuse an existing key**. Khala lists reusable LiteLLM providers from
the shared Pi `models.json`/`auth.json` config and Khala's non-secret
key-label registry. The picker asks for the provider first, then the key
label, so the same LiteLLM provider can expose multiple reusable labels.

## Project Settings

Pass `--project-settings` (or answer yes when prompted) only when the
selected models should become this project's Pi defaults. This does not
change what `pi --list-models` prints — that command lists the shared
`~/.pi/agent/models.json` registry. Project model scope is controlled by the
`defaultProvider`, `defaultModel`, and `enabledModels` block inside the
current project's `.pi/settings.json`.

Khala writes `enabledModels` as provider-qualified entries such as:

```text
team-litellm/gpt-5.4-mini
```

That prevents Pi from resolving a same-named model from another provider.

## Model Metadata

When an API key is available during setup, Khala fetches LiteLLM's
`/model/info` endpoint so selected models get metadata such as context
window, cost, reasoning support, and input modalities instead of bare `{ id
}` entries. If the fetch fails, setup falls back to bare entries and still
writes the provider — metadata enrichment is best-effort only.

## Key Resolution at Runtime

In all auth modes, `models.json` keeps a stable resolver entry:

```text
!khala litellm print-key --provider <id>
```

(or, when `khala` is not resolvable on `PATH` — for example after an ad hoc
`npx github:pesap/khala` install — the equivalent `npx` invocation).

`khala litellm print-key --provider <id>` walks up from the current
directory to the nearest `.pi/khala/litellm.json`, reads the selected key
label for that provider, and resolves a value in this order:

1. The derived (or literal) environment variable.
2. A key-specific `auth.json` entry (`<provider>:<key-label>`).

Pi gives a provider-level `auth.json` credential precedence over this resolver.
Khala refuses setup while one exists for the selected provider so it cannot
silently defeat the project key label; remove that credential before configuring
LiteLLM through Khala.

Set `KHALA_LITELLM_RESOLVER_COMMAND` to override the command Khala writes
into `models.json` for key lookup.

## Base Install Commands

If the package is already installed, run the CLI directly:

```bash
khala litellm
```

Otherwise:

```bash
npx --yes --silent github:pesap/khala litellm
```

See [Install](../README.md#install) for how Khala itself gets installed into
Pi.
