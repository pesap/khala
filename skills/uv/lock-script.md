# uv lock --script

Source: https://docs.astral.sh/uv/guides/scripts/

Lock dependencies for script reproducibility.

```bash
uv lock --script example.py
```

Creates adjacent lockfile:

- `example.py.lock`

## Behavior

- After lock exists, commands like `uv run --script`, `uv add --script`,
  `uv export --script`, and `uv tree --script` reuse/update locked deps as
  needed.
- Without lockfile, script commands still work; lockfile is just not created
  automatically.

## Extra reproducibility

In script metadata, constrain resolution date:

```python
# /// script
# dependencies = ["requests"]
# [tool.uv]
# exclude-newer = "2023-10-16T00:00:00Z"
# ///
```

Use RFC 3339 timestamp.
