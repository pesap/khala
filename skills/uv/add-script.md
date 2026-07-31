# uv add --script

Source: https://docs.astral.sh/uv/guides/scripts/

Add/update inline dependencies in a script (PEP 723 metadata).

```bash
uv add --script example.py 'requests<3' rich
```

This writes/updates:

```python
# /// script
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///
```

## Alternative package index

```bash
uv add --index "https://example.com/simple" --script example.py requests
```

Adds index metadata to script comments.

## Guidance

- Prefer this for persistent script dependencies.
- Use `uv run --with ...` only for one-off experimentation.
- If using `requires-python`, keep `dependencies` field present (can be empty
  array).
