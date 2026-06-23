# Python syntax do / don't

Use these examples to enforce the python-developer contract without bloating `SKILL.md`.

## 1) Function signatures (subject positional, config keyword-only)

```python
# ✅ Do
from pathlib import Path

def resolve_path(
    path: Path,
    *,
    base_folder: Path,
    must_exist: bool = True,
) -> Path:
    ...

# ❌ Don't
# unclear subject + too many positional params
def resolve_path(raw_path: Path, folder_path: Path, must_exist: bool = True):
    ...
```

## 2) Structured returns (single typed object)

```python
# ✅ Do
from dataclasses import dataclass

@dataclass(slots=True)
class ParseResult:
    records: list[str]
    rejected: int


def parse_records(raw: str, *, strict: bool = True) -> ParseResult:
    records = [line.strip() for line in raw.splitlines() if line.strip()]
    if strict and not records:
        raise ValueError("no records parsed")
    return ParseResult(records=records, rejected=0)

# ❌ Don't
# loose tuple return without semantics
def parse_records(raw: str):
    ...
    return records, rejected
```

## 3) Exception handling (narrow, explicit)

```python
# ✅ Do
import json

try:
    payload = json.loads(raw)
except json.JSONDecodeError as exc:
    raise ValueError("invalid JSON payload") from exc

# ❌ Don't
# catch-all hides root cause
try:
    payload = json.loads(raw)
except Exception:
    return None
```

## 4) Async syntax (never block event loop)

```python
# ✅ Do
import asyncio

await asyncio.sleep(0.1)

# ❌ Don't
import time

time.sleep(0.1)
```

## 5) Logging and output (structured over print)

```python
# ✅ Do
import json
import logging

logger = logging.getLogger("cli-smoke")
logger.info(json.dumps({"event": "command_started", "command": "run", "model": "dense-lp"}))
logger.error(json.dumps({"event": "command_failed", "exit_code": 1, "stderr": "..."}))

# ❌ Don't
if result.returncode == 0:
    print("  ✓ ok")
    continue

failures += 1
print(f"  ✗ failed (exit {result.returncode})")
```

## 6) Naming and entrypoint style (explicit, non-magical)

```python
# ✅ Do

def parse_examples_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def run_example_cli_smoke() -> int:
    ...

# ❌ Don't

def _parse_examples_csv(raw: str):
    ...


if __name__ == "__main__":
    raise SystemExit(main())
```
