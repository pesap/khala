# infrasys Source Verification Protocol

How to verify API behavior against the installed `infrasys` package when skill
reference docs may be stale.

For which reference doc to read first, see the lookup table in
[SKILL.md](../SKILL.md).

## When to use this protocol

- Task references an API not documented in the skill references.
- Upstream `infrasys` version changed and you suspect API drift.
- Docs and observed behavior disagree.

## Canonical external sources (prefer in order)

1. **Installed package source code** (source of truth)
   - `infrasys.system`
   - `infrasys.time_series_models`
   - `infrasys.serialization`
   - `infrasys.cost_curves`
   - `infrasys.value_curves`
   - `infrasys.function_data`

2. **PyPI metadata**: <https://pypi.org/project/infrasys/>

## Locate installed source

```bash
uvx --from python --with infrasys python - <<'PY'
import infrasys.system as s
import infrasys.time_series_models as ts
import infrasys.serialization as ser
import infrasys.cost_curves as cc
print(s.__file__)
print(ts.__file__)
print(ser.__file__)
print(cc.__file__)
PY
```

## Verification workflow

1. **Extract symbols** — identify method/class names from the task.
2. **Search source** — use `def <name>` or `class <name>` in installed package
   files.
3. **Check signatures** — confirm parameter names, types, defaults.
4. **Cross-check docs** — compare with skill reference docs for mismatches.
5. **Record provenance** — state which file was decisive in your output.

## Quick API drift check

```bash
uvx --from python --with infrasys python scripts/check_api_symbols.py
```

If docs and source disagree, trust source and note the mismatch.
