# uv init --script

Source: https://docs.astral.sh/uv/guides/scripts/

Use this to create a script scaffold with inline metadata.

```bash
uv init --script example.py --python 3.12
```

## Why

- Starts with PEP 723-compatible metadata block.
- Makes script dependencies/version constraints declarative.

## Typical flow

1. Initialize:

```bash
uv init --script example.py --python 3.12
```

2. Add deps later:

```bash
uv add --script example.py requests rich
```

3. Run:

```bash
uv run example.py
```
