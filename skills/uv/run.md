# uv run

Source: https://docs.astral.sh/uv/guides/scripts/

## Core usage

```bash
uv run script.py
uv run script.py arg1 arg2
uv run --python 3.12 script.py
echo 'print("hi")' | uv run -
```

## In a project

- `uv run` inside a directory with `pyproject.toml` installs/uses the project.
- If script should run independently from project deps:

```bash
uv run --no-project script.py
```

- `--no-project` must come before script name.

## Dependencies at run time (ad-hoc)

```bash
uv run --with rich script.py
uv run --with 'rich>12,<13' script.py
uv run --with rich --with requests script.py
```

Use this for one-off runs. For repeatable scripts, prefer inline metadata via
`uv add --script`.

## Important behavior with inline metadata

If script has `# /// script` metadata, project deps are ignored even when
running inside a project.

## Shebang executable

```python
#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///
```

Then:

```bash
chmod +x myscript
./myscript
```

## Notes

- `.pyw` on Windows runs with `pythonw` (GUI scripts).
- For syntax-only checks without `__pycache__`:

```bash
uv run python -m ast script.py >/dev/null
```
