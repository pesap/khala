---
name: uv
description: Use uv for Python scripts with reproducible dependencies via `uv run`, `uv init --script`, `uv add --script`, and `uv lock --script`. Use when users ask to run Python scripts, add script dependencies, replace pip/venv flows, or make standalone scripts reproducible.
license: MIT
---

## Trigger conditions
- User asks how to run Python scripts, install script deps, or avoid manual venv management.
- User mentions `pip install`, `python script.py`, `venv`, or script reproducibility.
- User wants migration from legacy Python command flow to uv.

## Use when
- Running scripts with or without dependencies.
- Adding script dependencies inline (PEP 723 metadata).
- Locking script dependency resolution for reproducibility.
- Building executable scripts with uv shebang.

## Avoid when
- User/repo explicitly requires Poetry, conda, pipenv, or raw pip.
- Task is not Python script/dependency workflow related.
- Native extension packaging requires another backend/toolchain.

## Instructions
1. Detect context: standalone script vs project (`pyproject.toml`).
2. Prefer `uv run` for execution; use `--no-project` when in a project and script should not install/use the project.
3. Prefer inline script metadata for repeatable scripts:
   - initialize with `uv init --script`
   - add deps with `uv add --script`
4. Use `uv run --with ...` for ad-hoc one-off dependencies only.
5. For reproducibility, use `uv lock --script` and optionally `tool.uv.exclude-newer`.
6. For executable scripts, use shebang: `#!/usr/bin/env -S uv run --script`.
7. Report exact commands, assumptions, and caveats (project interaction, Python version, lockfile behavior).

## Command references
- `run.md` (`uv run`)
- `init-script.md` (`uv init --script`)
- `add-script.md` (`uv add --script`)
- `lock-script.md` (`uv lock --script`)

## Output
- Context (project vs standalone)
- Commands used
- Validation result + blockers
